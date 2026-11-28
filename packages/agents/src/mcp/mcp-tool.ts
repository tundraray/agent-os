import type { McpServerRow } from '@agent-os/db';
import type { Tool } from '@modelcontextprotocol/client';
import { z } from 'zod';
import type { JsonSchemaObject } from '../model/mastra-turn';
import type { ToolDisplay } from '../tools/tool';

/** A schema property that carries a human title. */
const TitledSchema = z.object({ title: z.string().min(1) });

/** A tool as the server listed it, kept in `mcp_servers.tools` (a list of them): no admin setting in it. */
export interface ListedMcpTool {
  readonly name: string;
  readonly server: string;
  readonly tool: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  /** The server's mark: `readOnlyHint` as listed, `null` when the server gave none (access-levels KD-2). */
  readonly readOnly: boolean | null;
  /** The server's title of the tool and of its arguments, for the employee. */
  readonly display: ToolDisplay;
  /**
   * The result shape the server declared (`outputSchema` of `tools/list`), stored as declared; absent when the
   * server declared none (tool-output-shapes KD-1).
   */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

/**
 * An MCP tool as the platform uses it: `mcp__<server>__<tool>`, the server's description and schema, and the
 * admin's settings applied (access-levels KD-2).
 */
export interface McpTool extends Omit<ListedMcpTool, 'readOnly'> {
  /**
   * The effective class: the admin's correction, else «changes» while the tool is new, else the server's mark;
   * a tool without a mark changes something. Confirmation, read runs and schedules read only this.
   */
  readonly readOnly: boolean;
  /** The server's mark as listed. */
  readonly serverReadOnly: boolean | null;
  /** The admin corrected the class. */
  readonly overridden: boolean;
  /** `false` — the admin switched the tool off for everyone. */
  readonly enabled: boolean;
  /** A refresh of the list added it and the admin has not marked the server's new tools reviewed since. */
  readonly isNew: boolean;
}

/** What of a server row the tool list is read from. */
export type McpServerTools = Pick<
  McpServerRow,
  'tools' | 'toolSettings' | 'newTools'
>;

const StoredMcpToolSchema = z.object({
  name: z.string(),
  server: z.string(),
  tool: z.string(),
  description: z.string(),
  inputSchema: z.looseObject({ type: z.literal('object') }),
  readOnly: z.boolean().nullable(),
  display: z.object({
    toolTitle: z.string().optional(),
    argLabels: z.record(z.string(), z.string()).optional(),
  }),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

const StoredMcpToolsSchema = z.array(StoredMcpToolSchema).nullable();

/**
 * The one reading of a server's tool list (access-levels KD-2): `null` while the server has none yet; each tool
 * with the admin's settings applied, disabled tools included. A malformed list is a defect.
 */
export function storedMcpTools(row: McpServerTools): McpTool[] | null {
  const listed = StoredMcpToolsSchema.parse(row.tools);
  if (listed === null) return null;
  const added = new Set(row.newTools);
  return listed.map((tool) => {
    const setting = row.toolSettings[tool.tool] ?? {};
    const isNew = added.has(tool.tool);
    return {
      ...tool,
      readOnly: setting.readOnly ?? (!isNew && tool.readOnly === true),
      serverReadOnly: tool.readOnly,
      overridden: setting.readOnly !== undefined,
      enabled: setting.enabled !== false,
      isNew,
    };
  });
}

/**
 * The new marks after a refresh: the names it added join the earlier marks, and a mark of a tool the server no
 * longer lists is dropped. Only the admin's «Отметить просмотренными» clears them.
 */
export function newToolsAfterRefresh(
  marked: readonly string[],
  added: readonly string[],
  listed: readonly string[],
): string[] {
  const isNew = new Set([...marked, ...added]);
  return listed.filter((name) => isNew.has(name));
}

const MCP_TOOL_PREFIX = 'mcp';

export function mcpToolName(serverId: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}__${serverId}__${tool}`;
}

/** A tool as the server listed it; its human name is its `title`, or `annotations.title` when it has only that. */
export function toMcpTool(serverId: string, listed: Tool): ListedMcpTool {
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
    readOnly: listed.annotations?.readOnlyHint ?? null,
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
