import type { z } from 'zod';

import type { McpAccessTable } from '../config.js';
import type { DefinitionCatalog } from '../definitions/catalog.js';
import {
  ALL_SERVERS,
  type AgentDefinition,
  type DefinitionHeader,
} from '../definitions/definition.js';
import type { McpClients, McpTool } from '../mcp/mcp-clients.js';
import type { JsonSchemaObject } from '../model/mastra-turn.js';
import type { AgentTool, SessionLimits, ToolDisplay } from './tool.js';
import { serverAllowed } from './tool-access.js';

/** The built-in tool whose description lists the definitions the session may start. */
const START_AGENT_TOOL = 'start_agent';

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
  /** Names of the built-in and registered tools, for the catalog check. */
  toolNames(): string[];
  /** A built-in or registered tool by its name. */
  toolOf(name: string): AgentTool | undefined;
  /** How a call of this tool reads for the employee; empty for a tool that is not known now. */
  display(tool: string, server: string | null): ToolDisplay;
  /**
   * The tools of one session (design-agents.md, «Инструменты»): the built-in and registered ones its
   * definition names, then the MCP tools of its servers that the owner may use — the same
   * `serverAllowed` the call checks (KD-5).
   */
  sessionTools(input: SessionToolsInput): SessionTool[];
}

export interface ToolRegistryOptions {
  /** The package's built-in tools (T3.4); the composition root hands them over. */
  readonly builtins: readonly AgentTool[];
  /** The description of `start_agent` for the headers of the definitions the session may start. */
  readonly describeStartAgent: (headers: readonly DefinitionHeader[]) => string;
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
  let sealed = false;

  function add(tool: AgentTool): void {
    if (tools.has(tool.name)) {
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

  function agentTool(name: string, input: SessionToolsInput): SessionTool {
    const tool = tools.get(name);
    if (tool === undefined) {
      throw new Error(`Definition ${input.definition.name} names tool ${name}, which is not registered`);
    }
    const description =
      name === START_AGENT_TOOL
        ? options.describeStartAgent(startableHeaders(input))
        : tool.description;
    return { kind: 'agent', name, description, inputSchema: tool.argsSchema, tool };
  }

  function mcpTools(input: SessionToolsInput): SessionTool[] {
    const { mcpServers } = input.definition;
    const servers = mcpServers.includes(ALL_SERVERS) ? options.serverIds : mcpServers;
    const allowed = servers.filter((serverId) => serverAllowed(options.access, input.ownerId, serverId));
    return options.mcpClients.toolsOf(allowed).map((mcp) => ({
      kind: 'mcp',
      name: mcp.name,
      description: mcp.description,
      inputSchema: mcp.inputSchema,
      mcp,
    }));
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
    toolOf: (name) => tools.get(name),
    display(tool, server) {
      if (server !== null) {
        return options.mcpClients.toolsOf([server]).find((mcp) => mcp.tool === tool)?.display ?? {};
      }
      const { title, argLabels } = tools.get(tool) ?? {};
      return {
        ...(title === undefined ? {} : { toolTitle: title }),
        ...(argLabels === undefined ? {} : { argLabels }),
      };
    },
    sessionTools(input) {
      return [...input.definition.tools.map((name) => agentTool(name, input)), ...mcpTools(input)];
    },
  };
}
