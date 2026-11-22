import { ALL_SERVERS, McpServerModeSchema } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { z } from 'zod';

import type { AccessGate } from '../access-gate';
import { accountsOf } from '../mcp/mcp-accounts.repository';
import { type McpServerRow, enabledServersWithTools, findServers } from '../mcp/mcp-servers.repository';
import { type McpTool, storedMcpTools } from '../mcp/mcp-tool';
import { mcpToolDescription } from '../mcp/tool-shape';
import type { JsonSchemaObject } from '../model/mastra-turn';
import type { AgentTool, ToolDeclaration, ToolDisplay } from './tool';

/** What every tool of a session's set has: an `AgentToolDefinition` of the model call. */
interface OfferedTool {
  /** The name the model sees. */
  readonly name: string;
  readonly description: string;
}

/** A tool of an MCP server in a session's set. */
export type McpSessionTool = OfferedTool & {
  readonly kind: 'external';
  readonly inputSchema: JsonSchemaObject;
  readonly mcp: McpTool;
};

/**
 * A tool one session offers its model, and what runs it. `kind` says whose it is: a `system` tool is the
 * platform's own — the agent declares it by name, or gets it as a root or as every session does; an
 * `external` tool is chosen by the owner's rights alone — a tool of an MCP server (`mcp`), or `run_code`
 * (`tool`), which only calls such tools.
 */
export type SessionTool =
  | (OfferedTool & {
      readonly kind: 'system' | 'external';
      readonly inputSchema: z.ZodType<unknown>;
      readonly tool: AgentTool;
    })
  | McpSessionTool;

export function isMcp(tool: SessionTool): tool is McpSessionTool {
  return 'mcp' in tool;
}

/** The tool and the server of a call as the history and the confirmation request hold them. */
export interface ToolTarget {
  readonly tool: string;
  readonly server: string | null;
}

export function callTarget(tool: SessionTool): ToolTarget {
  return isMcp(tool) ? { tool: tool.mcp.tool, server: tool.mcp.server } : { tool: tool.name, server: null };
}

/** The target of a requested name in a tool set; an unknown name stays as written, with no server. */
export function callTargetOf(tools: readonly SessionTool[], name: string): ToolTarget {
  const tool = tools.find((candidate) => candidate.name === name);
  return tool === undefined ? { tool: name, server: null } : callTarget(tool);
}

/** What a tool's `loggedArgs` keeps, or the whole arguments of a tool without it; a non-object is not logged then. */
function keptArgs(tool: AgentTool, args: unknown): unknown {
  if (tool.loggedArgs === undefined) return args;
  return typeof args === 'object' && args !== null ? tool.loggedArgs(args) : null;
}

/** The arguments of a call as the log may hold them: {@link keptArgs} of a registered tool, all of an MCP call. */
export function loggedArgs(tool: SessionTool, args: unknown): unknown {
  return isMcp(tool) ? args : keptArgs(tool.tool, args);
}

/**
 * `loggedArgs` of a requested name: the session set's tool, else the registered tool of that name — a call to
 * a tool the session was not offered (`create_record` from a deep agent) keeps that tool's rule — and for a
 * name nobody registered only the argument keys, since nothing says what its arguments may hold.
 */
export function loggedArgsOf(
  tools: readonly SessionTool[],
  toolOf: ToolRegistry['toolOf'],
  call: { readonly name: string; readonly args: unknown },
): unknown {
  const offered = tools.find((candidate) => candidate.name === call.name);
  if (offered !== undefined) return loggedArgs(offered, call.args);
  const registered = toolOf(call.name);
  if (registered !== undefined) return keptArgs(registered, call.args);
  return typeof call.args === 'object' && call.args !== null ? { keys: Object.keys(call.args) } : null;
}

export interface ToolRegistry {
  /**
   * Adds a tool before `start()` — the package's own system tools and those of an upper part alike; a repeated
   * name or a registration after `seal()` throws.
   */
  register(tool: AgentTool): void;
  /** Closes registration; `start()` calls it. */
  seal(): void;
  /** Names of the registered tools; `run_code` is not among them. */
  toolNames(): string[];
  /** A registered tool, or `run_code`, by its name. */
  toolOf(name: string): AgentTool | undefined;
  /**
   * How the given calls read for the employee, in their order: the server's titles of an MCP tool;
   * empty for a registered tool and for an MCP tool that is not listed now. The servers are read in one query.
   */
  displays(calls: readonly ToolTarget[]): Promise<ToolDisplay[]>;
  /**
   * The one entry of the library: the tools of a session, for the owner of its task and what its agent
   * declares (design-agents.md, «Инструменты»; design-mcp-connect.md DC-1; design-runtime.md KD-4, KD-6).
   *
   * - The system tools are added by the declaration: the ones it names, in its order; the `rootOnly` tools for
   *   a root; the `everySession` tools (`read_tool_result`, `search_tool_result`). A tool with `describe` reads
   *   as it says for this declaration.
   * - The external tools are chosen by the owner's rights alone: `run_code` in every session (code-execution
   *   KD-3), then the MCP tools of the declared servers (`*` — all) that are enabled in the registry, whose
   *   server–tool pair the gate allows the owner (one `AccessGate.tools` per set; a disabled owner gets no MCP
   *   tool, and his model call fails the step) and, for an `oauth` server, that the owner has an account on.
   *
   * Nothing is kept between steps (Invariant 3).
   */
  toolsFor(ownerId: string, declaration: ToolDeclaration): Promise<SessionTool[]>;
  /**
   * The set a call is checked against: `toolsFor` without the owner's access filter and without the account
   * filter. A call to a server the owner may not use is then refused `no_access` by the call check, and a call
   * the model asked for before the account went away gets `auth_required`, not `tool_not_in_definition` (C3;
   * design-mcp-connect.md DC-2).
   */
  checkTools(declaration: ToolDeclaration): Promise<SessionTool[]>;
  /**
   * The MCP tools of the enabled servers among the declared ones, before the owner's access filter and
   * without accounts: the set a `run_code` run checks its calls against, so a server the owner may not use
   * is `no_access`, not `tool_not_in_definition` (code-execution DC-6; ADR-0011).
   */
  declaredMcpTools(servers: readonly string[]): Promise<McpSessionTool[]>;
}

export interface ToolRegistryOptions {
  /** `run_code`: in every session, never named by a declaration (code-execution KD-3, DC-1). */
  readonly runCode: AgentTool;
  /** The MCP registry and the accounts are read from it for every tool set (KD-2). */
  readonly database: Database;
  /** The one access check: the same in the tool set, in the call check and in the connections list. */
  readonly access: Pick<AccessGate, 'tools'>;
}

/** The tools library: the registry of the tools a session may offer its model (C3, `ToolRunner` reads it). */
export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  const tools = new Map<string, AgentTool>();
  const { runCode, database, access } = options;
  let sealed = false;

  function declared(name: string): AgentTool {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`An agent declares tool ${name}, which is not registered`);
    return tool;
  }

  /** The tool as the declaring agent sees it: by its `describe`, or its own description and schema. */
  function systemTool(tool: AgentTool, declaration: ToolDeclaration): SessionTool {
    const { description, argsSchema } = tool.describe?.(declaration) ?? tool;
    return { kind: 'system', name: tool.name, description, inputSchema: argsSchema ?? tool.argsSchema, tool };
  }

  /** The declared tools, the root's tools for a root, the tools of every session, then `run_code` (KD-6). */
  function registeredTools(declaration: ToolDeclaration): SessionTool[] {
    const all = [...tools.values()];
    const system = [
      ...declaration.system.map(declared),
      ...(declaration.root ? all.filter((tool) => tool.rootOnly === true) : []),
      ...all.filter((tool) => tool.everySession === true),
    ];
    return [
      ...system.map((tool) => systemTool(tool, declaration)),
      {
        kind: 'external',
        name: runCode.name,
        description: runCode.description,
        inputSchema: runCode.argsSchema,
        tool: runCode,
      },
    ];
  }

  function toolOf(name: string): AgentTool | undefined {
    return name === runCode.name ? runCode : tools.get(name);
  }

  /** Enabled registry servers among the declared ones; a name the registry does not hold gives nothing (DC-11). */
  function enabledServers(servers: readonly string[]): Promise<McpServerRow[]> {
    return enabledServersWithTools(database, servers.includes(ALL_SERVERS) ? ALL_SERVERS : servers);
  }

  function mcpToolsOf(rows: readonly McpServerRow[]): McpSessionTool[] {
    return rows.flatMap((row) =>
      (storedMcpTools(row.tools) ?? []).map(
        (mcp): McpSessionTool => ({
          kind: 'external',
          name: mcp.name,
          description: mcpToolDescription(mcp),
          inputSchema: mcp.inputSchema,
          mcp,
        }),
      ),
    );
  }

  /** The MCP tools of the given servers whose pair the gate allows the owner; none for a disabled owner. */
  async function allowedTools(rows: readonly McpServerRow[], ownerId: string): Promise<McpSessionTool[]> {
    if (rows.length === 0) return [];
    const answer = await access.tools(ownerId);
    if (answer.kind === 'owner_disabled') return [];
    return mcpToolsOf(rows).filter((tool) => answer.allows(tool.mcp.server, tool.mcp.tool));
  }

  /** Keeps a shared server, and an `oauth` server only when the owner has an account on it. */
  async function withAccounts(rows: McpServerRow[], ownerId: string): Promise<McpServerRow[]> {
    const isOAuth = (row: McpServerRow) => row.mode === McpServerModeSchema.enum.oauth;
    if (!rows.some(isOAuth)) return rows;
    const connected = new Set((await accountsOf(database, ownerId)).map((account) => account.server));
    return rows.filter((row) => !isOAuth(row) || connected.has(row.name));
  }

  return {
    register(tool) {
      if (sealed) {
        throw new Error(`Tool ${tool.name} is registered after start(): register tools before it`);
      }
      if (tools.has(tool.name) || tool.name === runCode.name) {
        throw new Error(`Tool ${tool.name} is registered twice`);
      }
      tools.set(tool.name, tool);
    },
    seal() {
      sealed = true;
    },
    toolNames: () => [...tools.keys()],
    toolOf,
    async displays(calls) {
      const names = new Set(calls.flatMap(({ server }) => (server === null ? [] : [server])));
      const rows = await findServers(database, [...names]);
      const listed = new Map(rows.map((row) => [row.name, storedMcpTools(row.tools)]));
      return calls.map(
        ({ tool, server }): ToolDisplay =>
          (server === null ? undefined : listed.get(server)?.find((mcp) => mcp.tool === tool)?.display) ?? {},
      );
    },
    async toolsFor(ownerId, declaration) {
      const rows = await withAccounts(await enabledServers(declaration.servers), ownerId);
      return [...registeredTools(declaration), ...(await allowedTools(rows, ownerId))];
    },
    async checkTools(declaration) {
      return [...registeredTools(declaration), ...mcpToolsOf(await enabledServers(declaration.servers))];
    },
    declaredMcpTools: async (servers) => mcpToolsOf(await enabledServers(servers)),
  };
}
