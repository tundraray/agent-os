import type { Logger } from '@agent-os/common';
import type { McpServerConfig } from '../config.js';
import { z } from 'zod';
import type { JsonSchemaObject } from '../model/mastra-turn.js';
import type { ToolDisplay } from '../tools/tool.js';
import { type McpCallResponse, McpClient, type McpListedTool } from './mcp-client.js';
import { mcpFailureReason } from './mcp-failure.js';
import { isReadOnly } from './mcp-outcome.js';

/** A schema property that carries a human title. */
const TitledSchema = z.object({ title: z.string().min(1) });

/** An MCP tool as the model sees it: `mcp__<server>__<tool>`, the server's description and schema. */
export interface McpTool {
  readonly name: string;
  readonly server: string;
  readonly tool: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  /** True only when the server listed the tool with `readOnlyHint: true` (KD-4). */
  readonly readOnly: boolean;
  /** The server's title of the tool and of its arguments, for the employee. */
  readonly display: ToolDisplay;
}

export interface McpClients {
  /** Starts every server and reads its tools; a server that does not answer is logged and has no tools. */
  start(): Promise<void>;
  /** The tools of the given servers; an unknown server or one without a list contributes nothing. */
  toolsOf(serverIds: readonly string[]): McpTool[];
  /** Calls a tool outside any transaction, bounded by the call timeout and the step's signal. */
  call(
    serverId: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<McpCallResponse>;
  stop(): Promise<void>;
}

export interface McpClientsOptions {
  readonly servers: readonly McpServerConfig[];
  readonly logger: Logger;
  /** `MCP_CALL_TIMEOUT_MS`: the limit of one MCP request, the list of tools included. */
  readonly callTimeoutMs: number;
}

const MCP_TOOL_PREFIX = 'mcp';

export function mcpToolName(serverId: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}__${serverId}__${tool}`;
}

interface ServerEntry {
  readonly client: McpClient;
  /** The last list read; kept after a disconnect so the model still sees the tools. */
  tools: McpTool[] | null;
  /** The connection the list was read on is gone: the next call reads the list again first. */
  stale: boolean;
}

function toMcpTool(serverId: string, listed: McpListedTool): McpTool {
  return {
    name: mcpToolName(serverId, listed.name),
    server: serverId,
    tool: listed.name,
    description: listed.description,
    inputSchema: listed.inputSchema,
    readOnly: isReadOnly(listed.annotations),
    display: {
      ...(listed.title === undefined ? {} : { toolTitle: listed.title }),
      ...argLabelsOf(listed.inputSchema),
    },
  };
}

/** `argLabels` from the `title` of each property of the input schema; none when no property has one. */
function argLabelsOf(inputSchema: JsonSchemaObject): Pick<ToolDisplay, 'argLabels'> {
  const properties = z.record(z.string(), z.unknown()).safeParse(inputSchema['properties']);
  if (!properties.success) return {};
  const labels = Object.entries(properties.data).flatMap(([key, property]) => {
    const titled = TitledSchema.safeParse(property);
    return titled.success ? [[key, titled.data.title] as const] : [];
  });
  return labels.length === 0 ? {} : { argLabels: Object.fromEntries(labels) };
}

/**
 * One client per server of the servers file (KD-5): a long-lived stdio process each, the list of tools read
 * at start and again after a reconnect, the processes closed on `stop()`.
 */
export function createMcpClients(options: McpClientsOptions): McpClients {
  const { logger, callTimeoutMs } = options;
  const entries = new Map<string, ServerEntry>();
  for (const server of options.servers) {
    const entry: ServerEntry = {
      client: new McpClient({
        server,
        logger,
        onDisconnect: () => {
          entry.stale = true;
        },
      }),
      tools: null,
      stale: false,
    };
    entries.set(server.id, entry);
  }

  async function readTools(serverId: string, entry: ServerEntry, signal?: AbortSignal): Promise<void> {
    const listed = await entry.client.listTools({ timeoutMs: callTimeoutMs, signal });
    entry.tools = listed.map((tool) => toMcpTool(serverId, tool));
    entry.stale = false;
  }

  function entryOf(serverId: string): ServerEntry {
    const entry = entries.get(serverId);
    if (entry === undefined) {
      throw new Error(`MCP server ${serverId} is not in the servers file`);
    }
    return entry;
  }

  return {
    async start() {
      await Promise.all(
        [...entries].map(async ([serverId, entry]) => {
          try {
            await readTools(serverId, entry);
          } catch (error) {
            logger.warn('mcp server did not list its tools at start; it has no tools until a call reconnects it', {
              server: serverId,
              error: String(error),
            });
          }
        }),
      );
    },

    toolsOf(serverIds) {
      return serverIds.flatMap((serverId) => entries.get(serverId)?.tools ?? []);
    },

    async call(serverId, tool, args, signal) {
      const entry = entryOf(serverId);
      if (entry.tools === null || entry.stale) {
        try {
          await readTools(serverId, entry, signal);
        } catch (error) {
          return { kind: 'failure', reason: mcpFailureReason(error) };
        }
      }
      return entry.client.callTool({ name: tool, arguments: args }, { timeoutMs: callTimeoutMs, signal });
    },

    async stop() {
      await Promise.all([...entries.values()].map((entry) => entry.client.close()));
    },
  };
}
