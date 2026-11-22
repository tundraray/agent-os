import type { Logger } from '@agent-os/common';
import { ALL_SERVERS, McpServerModeSchema } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { z } from 'zod';

import type { AccessGate } from '../access-gate';
import { CHAT_LISTING_BUDGET, type ChatListing, chatListing } from '../chat-listing';
import { accountsOf } from '../mcp/mcp-accounts.repository';
import { type McpServerRow, enabledServersWithTools, findServers } from '../mcp/mcp-servers.repository';
import { type McpTool, storedMcpTools } from '../mcp/mcp-tool';
import { mcpToolDescription } from '../mcp/tool-shape';
import type { JsonSchemaObject } from '../model/mastra-turn';
import type { RecordLibrary } from '../start/record-library';
import type { RunSnapshot } from '../start/snapshot';
import { snapshotDefinition } from '../start/snapshot-definition';
import { sessions } from '../store/sessions.repository';
import { describeStartAgent, START_AGENT_TOOL } from './builtin/start-agent';
import { START_DEEP_AGENT_TOOL } from './builtin/start-deep-agent';
import type { AgentTool, ToolDisplay } from './tool';

/** The description of `start_deep_agent` at the root: the tool's own text, then the deep agents the chat offers. */
function describeStartDeepAgent(description: string, deepAgents: readonly string[]): string {
  const lines = deepAgents.length === 0 ? ['(none)'] : deepAgents.map((line) => `- ${line}`);
  return [description, 'Deep agents you may start:', ...lines].join('\n');
}

/**
 * A tool one session offers its model: its name, description and schema (an `AgentToolDefinition` of
 * the model call) plus what runs it — a built-in or registered tool, or a tool of an MCP server.
 */
export type SessionTool =
  | {
      readonly kind: 'agent';
      readonly name: string;
      readonly description: string;
      readonly inputSchema: z.ZodType<unknown>;
      readonly tool: AgentTool;
    }
  | {
      readonly kind: 'mcp';
      readonly name: string;
      readonly description: string;
      readonly inputSchema: JsonSchemaObject;
      readonly mcp: McpTool;
    };

/** The tool and the server of a call as the history and the confirmation request hold them. */
export interface ToolTarget {
  readonly tool: string;
  readonly server: string | null;
}

export function callTarget(tool: SessionTool): ToolTarget {
  return tool.kind === 'mcp'
    ? { tool: tool.mcp.tool, server: tool.mcp.server }
    : { tool: tool.name, server: null };
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

/** The arguments of a call as the log may hold them: {@link keptArgs} of an agent tool, all of an MCP call. */
export function loggedArgs(tool: SessionTool, args: unknown): unknown {
  return tool.kind === 'agent' ? keptArgs(tool.tool, args) : args;
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

export interface SessionToolsInput {
  /** The session's snapshot, from the input of its task (ADR-0017). */
  readonly snapshot: RunSnapshot;
  readonly ownerId: string;
  readonly agentId: string;
  /** The session has no parent: a conversation's root, which alone gets the root's tools (KD-6). */
  readonly root: boolean;
}

export interface ToolRegistry {
  /** Adds a tool of an upper part before `start()`; a repeated name or a registration after `seal()` throws. */
  register(tool: AgentTool): void;
  /** Closes registration; `start()` calls it. */
  seal(): void;
  /** Names of the built-in and registered tools; `run_code` is not among them. */
  toolNames(): string[];
  /** A built-in or registered tool, or `run_code`, by its name. */
  toolOf(name: string): AgentTool | undefined;
  /**
   * How the given calls read for the employee, in their order: the server's titles of an MCP tool;
   * empty for a built-in tool and for an MCP tool that is not listed now. The servers are read in one query.
   */
  displays(calls: readonly ToolTarget[]): Promise<ToolDisplay[]>;
  /**
   * The tools the model is offered (design-agents.md, «Инструменты»; design-mcp-connect.md DC-1;
   * design-runtime.md KD-4, KD-6): the built-in ones the snapshot's definition names, the root's tools
   * (`start_deep_agent` and the tools `apps/api` registers) in a session without a parent only, the `everySession` tools
   * (`read_tool_result`, `search_tool_result`) and `run_code` in every session (code-execution KD-3), then the MCP tools of the snapshot's servers (`*` — all) that are enabled in the
   * registry, whose server–tool pair the gate allows the owner (one `AccessGate.tools` per set; a disabled
   * owner gets no MCP tool, and his model call fails the step) and, for an `oauth` server, that the owner
   * has an account on. At the root the descriptions of `start_agent` and `start_deep_agent` list the chat
   * listing, read from the library and the owner's sessions on every call; elsewhere `start_agent` lists
   * the snapshot's agents or team. Nothing is kept between steps (Invariant 3).
   */
  sessionTools(input: SessionToolsInput): Promise<SessionTool[]>;
  /**
   * The set a call is checked against: `sessionTools` without the owner's access filter, without the
   * account filter and without the chat listing in the descriptions. A call to a server the owner may not use is then refused `no_access` by the call check,
   * and a call the model asked for before the account went away gets `auth_required`, not
   * `tool_not_in_definition` (C3; design-mcp-connect.md DC-2).
   */
  checkTools(input: SessionToolsInput): Promise<SessionTool[]>;
  /**
   * The MCP tools of the enabled servers of the run's snapshot, before the owner's access filter and
   * without accounts: the set a `run_code` run checks its calls against, so a server the owner may not use
   * is `no_access`, not `tool_not_in_definition` (code-execution DC-6; ADR-0011).
   */
  definitionMcpTools(snapshot: RunSnapshot): Promise<SessionTool[]>;
}

export interface ToolRegistryOptions {
  /** The package's built-in tools (T3.4); the composition root hands them over. */
  readonly builtins: readonly AgentTool[];
  /** `run_code`: in every session, never named by a definition (code-execution KD-3, DC-1). */
  readonly runCode: AgentTool;
  /** The MCP registry, the accounts and the owner's session counts are read from it for every tool set (KD-2). */
  readonly database: Database;
  /** The one access check: the same in the tool set, in the call check and in the connections list. */
  readonly access: Pick<AccessGate, 'tools'>;
  /** The root's chat listing reads the owner's `listVisible` from it (KD-4). */
  readonly library: Pick<RecordLibrary, 'listVisible'>;
  /** Logs the chat listing of each root tool set. */
  readonly logger: Logger;
}

/** The registry of the tools a session may offer its model (C3, `ToolRunner` reads it). */
export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  const tools = new Map<string, AgentTool>();
  const { runCode, database, access, library } = options;
  const logger = options.logger.child({ service: 'agents.tools' });
  let sealed = false;

  function add(tool: AgentTool): void {
    if (tools.has(tool.name) || tool.name === runCode.name) {
      throw new Error(`Tool ${tool.name} is registered twice`);
    }
    tools.set(tool.name, tool);
  }
  options.builtins.forEach(add);

  /** The chat listing of the root's owner (KD-4): his `listVisible` and his session counts, read now. */
  async function rootListing(input: SessionToolsInput): Promise<ChatListing> {
    const startedAt = Date.now();
    const headers = await library.listVisible(input.ownerId);
    const sessionCounts = await sessions.recordCounts(database, input.ownerId);
    const listing = chatListing({ headers, sessionCounts, budget: CHAT_LISTING_BUDGET });
    logger.info('chat listing built', {
      ownerId: input.ownerId,
      agentId: input.agentId,
      visible: headers.length,
      described: listing.described,
      length: [...listing.agents, ...listing.deepAgents].reduce((sum, line) => sum + line.length, 0),
      durationMs: Date.now() - startedAt,
    });
    return listing;
  }

  function sessionToolOf(tool: AgentTool, description: string = tool.description): SessionTool {
    return { kind: 'agent', name: tool.name, description, inputSchema: tool.argsSchema, tool };
  }

  function registered(name: string, input: SessionToolsInput): AgentTool {
    const tool = tools.get(name);
    if (tool === undefined) {
      throw new Error(`Run ${input.snapshot.name} names tool ${name}, which is not registered`);
    }
    return tool;
  }

  /**
   * The description the session sees: `start_agent` lists whom it may start — the chat listing at the root,
   * the snapshot's agents or team elsewhere — and `start_deep_agent` the chat's deep agents. Without a listing
   * (the call check) the root keeps the tools' own descriptions.
   */
  function descriptionOf(tool: AgentTool, input: SessionToolsInput, listing: ChatListing | null): string {
    const canFork = input.snapshot.kind !== 'deep_agent';
    if (tool.name === START_AGENT_TOOL) {
      if (!input.root) return describeStartAgent(snapshotDefinition(input.snapshot).startable, canFork);
      if (listing !== null) return describeStartAgent(listing.agents, canFork);
    }
    if (tool.name === START_DEEP_AGENT_TOOL && listing !== null) {
      return describeStartDeepAgent(tool.description, listing.deepAgents);
    }
    return tool.description;
  }

  /**
   * The built-in tools the snapshot names, the root's tools at the root only, the tools of every session
   * (`everySession`), then `run_code` (KD-6).
   */
  function agentTools(input: SessionToolsInput, listing: ChatListing | null): SessionTool[] {
    const named = snapshotDefinition(input.snapshot).tools.map((name) => registered(name, input));
    const rootTools = input.root ? [...tools.values()].filter((tool) => tool.rootOnly === true) : [];
    const everySession = [...tools.values()].filter((tool) => tool.everySession === true);
    return [
      ...[...named, ...rootTools].map((tool) => sessionToolOf(tool, descriptionOf(tool, input, listing))),
      ...everySession.map((tool) => sessionToolOf(tool)),
      sessionToolOf(runCode),
    ];
  }

  function toolOf(name: string): AgentTool | undefined {
    return name === runCode.name ? runCode : tools.get(name);
  }

  /** Enabled registry servers the snapshot names; a name the registry does not hold gives nothing (DC-11). */
  function snapshotServers(snapshot: RunSnapshot): Promise<McpServerRow[]> {
    const { servers } = snapshotDefinition(snapshot);
    return enabledServersWithTools(database, servers.includes(ALL_SERVERS) ? ALL_SERVERS : servers);
  }

  function mcpToolsOf(rows: readonly McpServerRow[]): SessionTool[] {
    return rows.flatMap((row) =>
      (storedMcpTools(row.tools) ?? []).map(
        (mcp): SessionTool => ({
          kind: 'mcp',
          name: mcp.name,
          description: mcpToolDescription(mcp),
          inputSchema: mcp.inputSchema,
          mcp,
        }),
      ),
    );
  }

  /** The MCP tools of the given servers whose pair the gate allows the owner; none for a disabled owner. */
  async function allowedTools(rows: readonly McpServerRow[], ownerId: string): Promise<SessionTool[]> {
    if (rows.length === 0) return [];
    const answer = await access.tools(ownerId);
    if (answer.kind === 'owner_disabled') return [];
    return mcpToolsOf(rows).filter(
      (tool) => tool.kind === 'mcp' && answer.allows(tool.mcp.server, tool.mcp.tool),
    );
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
      add(tool);
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
    async sessionTools(input) {
      const listing = input.root ? await rootListing(input) : null;
      const rows = await withAccounts(await snapshotServers(input.snapshot), input.ownerId);
      return [...agentTools(input, listing), ...(await allowedTools(rows, input.ownerId))];
    },
    async checkTools(input) {
      return [...agentTools(input, null), ...mcpToolsOf(await snapshotServers(input.snapshot))];
    },
    definitionMcpTools: async (snapshot) => mcpToolsOf(await snapshotServers(snapshot)),
  };
}
