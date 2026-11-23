import type { Tool } from '@modelcontextprotocol/client';
import { z } from 'zod';
import type { JsonSchemaObject } from '../model/mastra-turn';
import type { ToolDisplay } from '../tools/tool';

/** A schema property that carries a human title. */
const TitledSchema = z.object({ title: z.string().min(1) });

/** An MCP tool as the model sees it: `mcp__<server>__<tool>`, the server's description and schema. */
export interface McpTool {
  readonly name: string;
  readonly server: string;
  readonly tool: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  /**
   * True only when the server listed the tool with `readOnlyHint: true`; anything else, the hint
   * missing included, changes something (KD-4).
   */
  readonly readOnly: boolean;
  /** The server's title of the tool and of its arguments, for the employee. */
  readonly display: ToolDisplay;
  /**
   * The result shape the server declared (`outputSchema` of `tools/list`), stored as declared; absent when the
   * server declared none and in every list stored before shapes (tool-output-shapes KD-1).
   */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

/**
 * The stored form of an `McpTool` in `mcp_servers.tools` (a list of them): the tool set is built
 * from it without the network (KD-2).
 */
const StoredMcpToolSchema = z.object({
  name: z.string(),
  server: z.string(),
  tool: z.string(),
  description: z.string(),
  inputSchema: z.looseObject({ type: z.literal('object') }),
  readOnly: z.boolean(),
  display: z.object({
    toolTitle: z.string().optional(),
    argLabels: z.record(z.string(), z.string()).optional(),
  }),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

const StoredMcpToolsSchema = z.array(StoredMcpToolSchema).nullable();

/** The tool list of a server row: `null` while the server has none yet; a malformed list is a defect. */
export function storedMcpTools(tools: unknown): McpTool[] | null {
  return StoredMcpToolsSchema.parse(tools);
}

const MCP_TOOL_PREFIX = 'mcp';

export function mcpToolName(serverId: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}__${serverId}__${tool}`;
}

/** A tool as the server listed it; its human name is its `title`, or `annotations.title` when it has only that. */
export function toMcpTool(serverId: string, listed: Tool): McpTool {
  const title = listed.title ?? listed.annotations?.title;
  const inputSchema: JsonSchemaObject = {
    ...listed.inputSchema,
    type: 'object',
  };
  return {
    name: mcpToolName(serverId, listed.name),
    server: serverId,
    tool: listed.name,
    description: listed.description ?? '',
    inputSchema,
    readOnly: listed.annotations?.readOnlyHint === true,
    display: {
      ...(title === undefined ? {} : { toolTitle: title }),
      ...argLabelsOf(inputSchema),
    },
    ...(listed.outputSchema === undefined
      ? {}
      : { outputSchema: listed.outputSchema }),
  };
}

/** `argLabels` from the `title` of each property of the input schema; none when no property has one. */
function argLabelsOf(
  inputSchema: JsonSchemaObject,
): Pick<ToolDisplay, 'argLabels'> {
  const properties = z
    .record(z.string(), z.unknown())
    .safeParse(inputSchema['properties']);
  if (!properties.success) return {};
  const labels = Object.entries(properties.data).flatMap(([key, property]) => {
    const titled = TitledSchema.safeParse(property);
    return titled.success ? [[key, titled.data.title] as const] : [];
  });
  return labels.length === 0 ? {} : { argLabels: Object.fromEntries(labels) };
}
