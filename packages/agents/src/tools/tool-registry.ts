import {
  ALL_SERVERS,
  McpServerModeSchema,
  type Script,
} from '@agent-os/contracts';
import {
  McpAccountsRepository,
  McpServersRepository,
  type McpServerRow,
} from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';

import type { AccessGate } from '../access-gate';
import { ACCESS_GATE } from '../agents.tokens';
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
 * `external` tool is chosen by the owner's rights alone — a tool of an MCP server (`mcp`), or `run_code` and
 * a saved script's tool (`tool`), which only call such tools.
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
  return isMcp(tool)
    ? { tool: tool.mcp.tool, server: tool.mcp.server }
    : { tool: tool.name, server: null };
}

/** The target of a requested name in a tool set; an unknown name stays as written, with no server. */
export function callTargetOf(
  tools: readonly SessionTool[],
  name: string,
): ToolTarget {
  const tool = tools.find((candidate) => candidate.name === name);
  return tool === undefined ? { tool: name, server: null } : callTarget(tool);
}

/** What a tool's `loggedArgs` keeps, or the whole arguments of a tool without it; a non-object is not logged then. */
function keptArgs(tool: AgentTool, args: unknown): unknown {
  if (tool.loggedArgs === undefined) return args;
  return typeof args === 'object' && args !== null
    ? tool.loggedArgs(args)
    : null;
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
  return typeof call.args === 'object' && call.args !== null
    ? { keys: Object.keys(call.args) }
    : null;
}

/** The tools library: the registry of the tools a session may offer its model (C3, `ToolRunner` reads it). */
@Injectable()
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();
  /**
   * `run_code`, in every session and never named by a declaration (code-execution KD-3, DC-1), and the builder of
   * a saved script's tool; both run over the one code run.
   */
  private codeRun:
    | {
        readonly runCode: AgentTool;
        readonly scriptTool: (script: Script) => AgentTool;
      }
    | undefined;
  private sealed = false;

  constructor(
    /** The MCP registry and the accounts are read from it for every tool set (KD-2). */
    @Inject(McpServersRepository)
    private readonly mcpServerRows: McpServersRepository,
    @Inject(McpAccountsRepository)
    private readonly mcpAccountRows: McpAccountsRepository,
    /** The one access check: the same in the tool set, in the call check and in the connections list. */
    @Inject(ACCESS_GATE) private readonly access: Pick<AccessGate, 'tools'>,
  ) {}

  /**
   * Sets `run_code` and the builder of a script's tool, once: they are built over the registry, so they arrive
   * after the registry is made. A second call, or a name a registered tool already has, throws.
   */
  useCodeRun(
    runCode: AgentTool,
    scriptTool: (script: Script) => AgentTool,
  ): void {
    if (this.codeRun !== undefined)
      throw new Error(`Tool ${runCode.name} is set as run_code twice`);
    if (this.tools.has(runCode.name))
      throw new Error(`Tool ${runCode.name} is registered twice`);
    this.codeRun = { runCode, scriptTool };
  }

  /**
   * Adds a tool before `seal()` — the package's own system tools and those of an upper part alike; a repeated
   * name or a registration after `seal()` throws.
   */
  register(tool: AgentTool): void {
    if (this.sealed) {
      throw new Error(
        `Tool ${tool.name} is registered after start(): register tools before it`,
      );
    }
    if (this.tools.has(tool.name) || tool.name === this.codeRun?.runCode.name) {
      throw new Error(`Tool ${tool.name} is registered twice`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Closes registration; called when the agents start. */
  seal(): void {
    this.sealed = true;
  }

  /** Names of the registered tools; `run_code` is not among them. */
  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  /** A registered tool, or `run_code`, by its name; a script's tool is not among them. */
  toolOf(name: string): AgentTool | undefined {
    const { runCode } = this.codeRunTools();
    return name === runCode.name ? runCode : this.tools.get(name);
  }

  /**
   * How the given calls read for the employee, in their order: the server's titles of an MCP tool;
   * empty for a registered tool and for an MCP tool that is not listed now. The servers are read in one query.
   */
  async displays(calls: readonly ToolTarget[]): Promise<ToolDisplay[]> {
    const names = new Set(
      calls.flatMap(({ server }) => (server === null ? [] : [server])),
    );
    const rows = await this.mcpServerRows.findMany([...names]);
    const listed = new Map(
      rows.map((row) => [row.name, storedMcpTools(row.tools)]),
    );
    return calls.map(
      ({ tool, server }): ToolDisplay =>
        (server === null
          ? undefined
          : listed.get(server)?.find((mcp) => mcp.tool === tool)?.display) ??
        {},
    );
  }

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
  async toolsFor(
    ownerId: string,
    declaration: ToolDeclaration,
  ): Promise<SessionTool[]> {
    const rows = await this.withAccounts(
      await this.enabledServers(declaration.servers),
      ownerId,
    );
    return [
      ...this.registeredTools(declaration),
      ...(await this.allowedTools(rows, ownerId)),
    ];
  }

  /**
   * The set a call is checked against: `toolsFor` without the owner's access filter and without the account
   * filter. A call to a server the owner may not use is then refused `no_access` by the call check, and a call
   * the model asked for before the account went away gets `auth_required`, not `tool_not_in_definition` (C3;
   * design-mcp-connect.md DC-2).
   */
  async checkTools(declaration: ToolDeclaration): Promise<SessionTool[]> {
    return [
      ...this.registeredTools(declaration),
      ...mcpToolsOf(await this.enabledServers(declaration.servers)),
    ];
  }

  /**
   * The MCP tools of the enabled servers among the declared ones, before the owner's access filter and
   * without accounts: the set a `run_code` run checks its calls against, so a server the owner may not use
   * is `no_access`, not `tool_not_in_definition` (code-execution DC-6; ADR-0011).
   */
  async declaredMcpTools(
    servers: readonly string[],
  ): Promise<McpSessionTool[]> {
    return mcpToolsOf(await this.enabledServers(servers));
  }

  /** `run_code` and the script builder, which every tool set and every lookup by name needs: `useCodeRun` sets them before them. */
  private codeRunTools(): NonNullable<ToolRegistry['codeRun']> {
    if (this.codeRun === undefined) {
      throw new Error(
        'The tool registry is used before run_code was set: call useCodeRun() first',
      );
    }
    return this.codeRun;
  }

  private declared(name: string): AgentTool {
    const tool = this.tools.get(name);
    if (tool === undefined)
      throw new Error(
        `An agent declares tool ${name}, which is not registered`,
      );
    return tool;
  }

  /**
   * The declared tools, the root's tools for a root, the tools of every session, then `run_code` (KD-6) and the
   * tool of each script the declaration owns (self-learning scripts KD-4).
   */
  private registeredTools(declaration: ToolDeclaration): SessionTool[] {
    const { runCode, scriptTool } = this.codeRunTools();
    const all = [...this.tools.values()];
    const system = [
      ...declaration.system.map((name) => this.declared(name)),
      ...(declaration.root ? all.filter((tool) => tool.rootOnly === true) : []),
      ...all.filter((tool) => tool.everySession === true),
    ];
    return [
      ...system.map((tool) => systemTool(tool, declaration)),
      ...[runCode, ...declaration.scripts.map(scriptTool)].map(
        (tool): SessionTool => ({
          kind: 'external',
          name: tool.name,
          description: tool.description,
          inputSchema: tool.argsSchema,
          tool,
        }),
      ),
    ];
  }

  /** Enabled registry servers among the declared ones; a name the registry does not hold gives nothing (DC-11). */
  private enabledServers(servers: readonly string[]): Promise<McpServerRow[]> {
    return this.mcpServerRows.enabledWithTools(
      servers.includes(ALL_SERVERS) ? ALL_SERVERS : servers,
    );
  }

  /** The MCP tools of the given servers whose pair the gate allows the owner; none for a disabled owner. */
  private async allowedTools(
    rows: readonly McpServerRow[],
    ownerId: string,
  ): Promise<McpSessionTool[]> {
    if (rows.length === 0) return [];
    const answer = await this.access.tools(ownerId);
    if (answer.kind === 'owner_disabled') return [];
    return mcpToolsOf(rows).filter((tool) =>
      answer.allows(tool.mcp.server, tool.mcp.tool),
    );
  }

  /** Keeps a shared server, and an `oauth` server only when the owner has an account on it. */
  private async withAccounts(
    rows: McpServerRow[],
    ownerId: string,
  ): Promise<McpServerRow[]> {
    const isOAuth = (row: McpServerRow) =>
      row.mode === McpServerModeSchema.enum.oauth;
    if (!rows.some(isOAuth)) return rows;
    const connected = new Set(
      (await this.mcpAccountRows.listOwned(ownerId)).map(
        (account) => account.server,
      ),
    );
    return rows.filter((row) => !isOAuth(row) || connected.has(row.name));
  }
}

/** The tool as the declaring agent sees it: by its `describe`, or its own description and schema. */
function systemTool(
  tool: AgentTool,
  declaration: ToolDeclaration,
): SessionTool {
  const { description, argsSchema } = tool.describe?.(declaration) ?? tool;
  return {
    kind: 'system',
    name: tool.name,
    description,
    inputSchema: argsSchema ?? tool.argsSchema,
    tool,
  };
}

function mcpToolsOf(rows: readonly McpServerRow[]): McpSessionTool[] {
  return rows.flatMap((row) =>
    (storedMcpTools(row.tools) ?? []).map((mcp): McpSessionTool => ({
      kind: 'external',
      name: mcp.name,
      description: mcpToolDescription(mcp),
      inputSchema: mcp.inputSchema,
      mcp,
    })),
  );
}
