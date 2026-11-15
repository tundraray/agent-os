import type { z } from 'zod';

import type { McpAccessTable } from '../config.js';
import type { DefinitionCatalog } from '../definitions/catalog.js';
import {
  ALL_SERVERS,
  type AgentDefinition,
  type DefinitionHeader,
  START_AGENT_TOOL,
} from '../definitions/definition.js';
import type { McpClients, McpTool } from '../mcp/mcp-clients.js';
import type { JsonSchemaObject } from '../model/mastra-turn.js';
import { describeStartAgent } from './builtin/start-agent.js';
import type { AgentTool, SessionLimits, ToolDisplay } from './tool.js';
import { serverAllowed } from './tool-access.js';

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
export function callTarget(tool: SessionTool): { tool: string; server: string | null } {
  return tool.kind === 'mcp'
    ? { tool: tool.mcp.tool, server: tool.mcp.server }
    : { tool: tool.name, server: null };
}

/** The target of a requested name in a tool set; an unknown name stays as written, with no server. */
export function callTargetOf(tools: readonly SessionTool[], name: string): { tool: string; server: string | null } {
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
  /** How a call of this tool reads for the employee; empty for a tool that is not known now. */
  display(tool: string, server: string | null): ToolDisplay;
  /**
   * The tools of one session (design-agents.md, «Инструменты»): the built-in and registered ones its
   * definition names, `run_code` in every session (code-execution KD-3), then the MCP tools of its
   * servers that the owner may use — the same `serverAllowed` the call checks (KD-5).
   */
  sessionTools(input: SessionToolsInput): SessionTool[];
  /**
   * The MCP tools of every server the definition names, before the owner's access filter: the snapshot
   * a `run_code` run checks its calls against, so a server the owner may not use is `no_access`, not
   * `tool_not_in_definition` (code-execution DC-6).
   */
  definitionMcpTools(definition: AgentDefinition): SessionTool[];
}

export interface ToolRegistryOptions {
  /** The package's built-in tools (T3.4); the composition root hands them over. */
  readonly builtins: readonly AgentTool[];
  /** `run_code`: in every session, never named by a definition (code-execution KD-3, DC-1). */
  readonly runCode: AgentTool;
  readonly mcpClients: McpClients;
  readonly catalog: DefinitionCatalog;
  /** `MCP_ACCESS_TABLE`. */
  readonly access: McpAccessTable;
  /** Ids of the servers in `MCP_SERVERS_FILE`: what `mcpServers: ['*']` means. */
  readonly serverIds: readonly string[];
}

/** The registry of the tools a session may offer its model (C3, `ToolRunner` reads it). */
export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  const tools = new Map<string, AgentTool>();
  const { runCode } = options;
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

  function toolOf(name: string): AgentTool | undefined {
    return name === runCode.name ? runCode : tools.get(name);
  }

  function definitionServers(definition: AgentDefinition): readonly string[] {
    const { mcpServers } = definition;
    return mcpServers.includes(ALL_SERVERS) ? options.serverIds : mcpServers;
  }

  function mcpToolsOf(serverIds: readonly string[]): SessionTool[] {
    return options.mcpClients.toolsOf(serverIds).map((mcp) => ({
      kind: 'mcp',
      name: mcp.name,
      description: mcp.description,
      inputSchema: mcp.inputSchema,
      mcp,
    }));
  }

  function mcpTools(input: SessionToolsInput): SessionTool[] {
    const servers = definitionServers(input.definition);
    return mcpToolsOf(servers.filter((serverId) => serverAllowed(options.access, input.ownerId, serverId)));
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
    display(tool, server) {
      if (server !== null) {
        return options.mcpClients.toolsOf([server]).find((mcp) => mcp.tool === tool)?.display ?? {};
      }
      const { title, argLabels } = toolOf(tool) ?? {};
      return {
        ...(title === undefined ? {} : { toolTitle: title }),
        ...(argLabels === undefined ? {} : { argLabels }),
      };
    },
    sessionTools(input) {
      return [
        ...input.definition.tools.map((name) => agentTool(name, input)),
        sessionToolOf(runCode),
        ...mcpTools(input),
      ];
    },
    definitionMcpTools: (definition) => mcpToolsOf(definitionServers(definition)),
  };
}
