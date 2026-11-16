import { McpServerModeSchema } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { z } from 'zod';

import type { DefinitionCatalog } from '../definitions/catalog.js';
import {
  ALL_SERVERS,
  type AgentDefinition,
  type DefinitionHeader,
  START_AGENT_TOOL,
} from '../definitions/definition.js';
import type { AccessGate } from '../access-gate.js';
import { accountsOf } from '../mcp/mcp-accounts.repository.js';
import { type McpServerRow, enabledServersWithTools, findServers } from '../mcp/mcp-servers.repository.js';
import { type McpTool, storedMcpTools } from '../mcp/mcp-tool.js';
import type { JsonSchemaObject } from '../model/mastra-turn.js';
import { describeStartAgent } from './builtin/start-agent.js';
import type { AgentTool, SessionLimits, ToolDisplay } from './tool.js';

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

/** The tool and the server of a call as `agent_tool_calls` and the confirmation request hold them. */
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

export interface SessionToolsInput {
  readonly definition: AgentDefinition;
  /** The session's limits; with them `start_agent` lists `limits.agents`, not `definition.agents`. */
  readonly limits: SessionLimits | null;
  readonly ownerId: string;
}

export interface ToolRegistry {
  /** Adds a tool of an upper part before `start()`; a repeated name or a registration after `seal()` throws. */
  register(tool: AgentTool): void;
  /** Closes registration; `start()` calls it. */
  seal(): void;
  /** Names of the built-in and registered tools, for the catalog check; `run_code` is not among them. */
  toolNames(): string[];
  /** A built-in or registered tool, or `run_code`, by its name. */
  toolOf(name: string): AgentTool | undefined;
  /**
   * How the given calls read for the employee, in their order; empty for a tool that is not known now.
   * The servers the calls name are read in one query.
   */
  displays(calls: readonly ToolTarget[]): Promise<ToolDisplay[]>;
  /**
   * The tools the model is offered (design-agents.md, «Инструменты»; design-mcp-connect.md DC-1): the
   * built-in and registered ones its definition names, `run_code` in every session (code-execution KD-3),
   * then the MCP tools of the definition's servers (`*` — all) that are enabled in the registry, whose
   * server–tool pair the gate allows the owner (one `AccessGate.tools` per set; a disabled owner gets no MCP
   * tool, and his model call fails the step) and, for an `oauth` server, that the owner has an account on.
   * Read from the database on every call: nothing is kept between steps (Invariant 3).
   */
  sessionTools(input: SessionToolsInput): Promise<SessionTool[]>;
  /**
   * The set a call is checked against: `sessionTools` without the owner's access filter and without the
   * account filter. A call to a server the owner may not use is then refused `no_access` by the call check,
   * and a call the model asked for before the account went away gets `auth_required`, not
   * `tool_not_in_definition` (C3; design-mcp-connect.md DC-2).
   */
  checkTools(input: SessionToolsInput): Promise<SessionTool[]>;
  /**
   * The MCP tools of the definition's enabled servers, before the owner's access filter and without
   * accounts: the snapshot a `run_code` run checks its calls against, so a server the owner may not use is
   * `no_access`, not `tool_not_in_definition` (code-execution DC-6).
   */
  definitionMcpTools(definition: AgentDefinition): Promise<SessionTool[]>;
}

export interface ToolRegistryOptions {
  /** The package's built-in tools (T3.4); the composition root hands them over. */
  readonly builtins: readonly AgentTool[];
  /** `run_code`: in every session, never named by a definition (code-execution KD-3, DC-1). */
  readonly runCode: AgentTool;
  readonly catalog: DefinitionCatalog;
  /** The MCP registry and the accounts are read from it for every tool set (KD-2). */
  readonly database: Database;
  /** The one access check: the same in the tool set, in the call check and in the connections list. */
  readonly access: Pick<AccessGate, 'tools'>;
}

/** The registry of the tools a session may offer its model (C3, `ToolRunner` reads it). */
export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  const tools = new Map<string, AgentTool>();
  const { runCode, database, access } = options;
  let sealed = false;

  function add(tool: AgentTool): void {
    if (tools.has(tool.name) || tool.name === runCode.name) {
      throw new Error(`Tool ${tool.name} is registered twice`);
    }
    tools.set(tool.name, tool);
  }
  options.builtins.forEach(add);

  function startableHeaders(input: SessionToolsInput): DefinitionHeader[] {
    const names = input.limits === null ? input.definition.agents : Object.keys(input.limits.agents);
    return names.flatMap((name) => {
      const definition = options.catalog.get(name);
      return definition === undefined
        ? []
        : [{ name: definition.name, description: definition.description }];
    });
  }

  function sessionToolOf(tool: AgentTool, description: string = tool.description): SessionTool {
    return { kind: 'agent', name: tool.name, description, inputSchema: tool.argsSchema, tool };
  }

  function agentTool(name: string, input: SessionToolsInput): SessionTool {
    const tool = tools.get(name);
    if (tool === undefined) {
      throw new Error(`Definition ${input.definition.name} names tool ${name}, which is not registered`);
    }
    return name === START_AGENT_TOOL
      ? sessionToolOf(tool, describeStartAgent(startableHeaders(input)))
      : sessionToolOf(tool);
  }

  /** The built-in and registered tools the definition names, then `run_code`. */
  function agentTools(input: SessionToolsInput): SessionTool[] {
    return [...input.definition.tools.map((name) => agentTool(name, input)), sessionToolOf(runCode)];
  }

  function toolOf(name: string): AgentTool | undefined {
    return name === runCode.name ? runCode : tools.get(name);
  }

  /** Enabled registry servers the definition names; a name the registry does not hold gives nothing (DC-11). */
  function definitionServers(definition: AgentDefinition): Promise<McpServerRow[]> {
    const { mcpServers } = definition;
    return enabledServersWithTools(database, mcpServers.includes(ALL_SERVERS) ? ALL_SERVERS : mcpServers);
  }

  function mcpToolsOf(rows: readonly McpServerRow[]): SessionTool[] {
    return rows.flatMap((row) =>
      (storedMcpTools(row.tools) ?? []).map(
        (mcp): SessionTool => ({
          kind: 'mcp',
          name: mcp.name,
          description: mcp.description,
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
      return calls.map(({ tool, server }): ToolDisplay => {
        if (server !== null) return listed.get(server)?.find((mcp) => mcp.tool === tool)?.display ?? {};
        const { title, argLabels } = toolOf(tool) ?? {};
        return {
          ...(title === undefined ? {} : { toolTitle: title }),
          ...(argLabels === undefined ? {} : { argLabels }),
        };
      });
    },
    async sessionTools(input) {
      const rows = await withAccounts(await definitionServers(input.definition), input.ownerId);
      return [...agentTools(input), ...(await allowedTools(rows, input.ownerId))];
    },
    async checkTools(input) {
      return [...agentTools(input), ...mcpToolsOf(await definitionServers(input.definition))];
    },
    definitionMcpTools: async (definition) => mcpToolsOf(await definitionServers(definition)),
  };
}
