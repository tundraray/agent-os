import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  Server,
  WebStandardStreamableHTTPServerTransport,
  type CallToolResult,
} from '@modelcontextprotocol/server';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { backOfficeOf } from './backoffice';
import { canonicalJson } from './canonical-json';
import { createLogDataset, type LogDataset } from './dataset';
import type { ResultFaultRule } from './fault-schedule';
import { aggregateLogsTool } from './tools/aggregate-logs';
import { createIncidentNoteTool } from './tools/create-incident-note';
import type { FixtureTool } from './tools/fixture-tool';
import { getOrderTool } from './tools/get-order';
import { getTraceTool } from './tools/get-trace';
import { searchLogsTool } from './tools/search-logs';
import { searchOrdersTool } from './tools/search-orders';
import { searchTicketsTool } from './tools/search-tickets';
import { trackerTickets } from './tracker';
import type { DatasetVersion } from './versions';

const SOURCE_INFO_URI = 'fixture://source-info';
/** Above this many bytes of `structuredContent` JSON the result carries no `text` copy, so a page is not sent twice. */
const TEXT_COPY_MAX_BYTES = 1024 * 1024;
/** `wait_for_file` checks for its file this often and gives up after `WAIT_FOR_FILE_LIMIT_MS`. */
const WAIT_FOR_FILE_POLL_MS = 20;
const WAIT_FOR_FILE_LIMIT_MS = 60_000;

const SERVER_INFO = { name: 'agent-os-mcp-fixture', version: '1.0.0' };

/**
 * What a fixture source serves: the payment logs, the back office of the same dataset, or the
 * tracker's tickets.
 */
export const FixtureSourceSchema = z.enum(['logs', 'backoffice', 'tracker']);
export type FixtureSource = z.infer<typeof FixtureSourceSchema>;

const TOOLS: Readonly<Record<FixtureSource, readonly FixtureTool[]>> = {
  logs: [searchLogsTool, aggregateLogsTool, getTraceTool],
  backoffice: [searchOrdersTool, getOrderTool, createIncidentNoteTool],
  tracker: [searchTicketsTool],
};

/**
 * MCP server over one synthetic dataset, serving its logs, its back office or the tracker, built on the low-level `Server` so the
 * fixture controls every result byte: results are canonical JSON. `search_tickets`, `search_orders`, `get_order` and
 * `get_trace` list an `outputSchema` built from their result schema; the other tools declare none. Reading tools are
 * listed with `readOnlyHint: true`; the changing `create_incident_note` has no annotations (KD-4). Every source
 * reports the dataset's snapshot.
 */
export class FixtureServer {
  private readonly tools: FixtureTool[];

  constructor(
    private dataset: LogDataset,
    private readonly source: FixtureSource,
  ) {
    this.tools = [...TOOLS[source]];
  }

  /**
   * Answers one Streamable HTTP request without a session: a fresh transport and protocol server per request
   * over this source's state (dataset, added tools), JSON responses instead of an SSE stream. `resultFault`
   * applies to the `tools/call` the request carries.
   */
  async handleHttp(
    request: Request,
    options: { parsedBody?: unknown; resultFault?: ResultFaultRule },
  ): Promise<Response> {
    const server = this.createServer(options.resultFault);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request, {
        parsedBody: options.parsedBody,
      });
    } finally {
      await server.close();
    }
  }

  /** Lists `tool` from now on, next to the source's own tools. */
  addTool(tool: FixtureTool): void {
    this.tools.push(tool);
  }

  private createServer(resultFault: ResultFaultRule | undefined): Server {
    const server = new Server(SERVER_INFO, {
      capabilities: { tools: {}, resources: {} },
    });
    server.setRequestHandler('tools/list', () => ({
      tools: this.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined
          ? {}
          : { outputSchema: tool.outputSchema }),
        ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
      })),
    }));
    server.setRequestHandler('tools/call', (request) =>
      this.callTool(
        server,
        request.params.name,
        request.params.arguments,
        resultFault,
      ),
    );
    server.setRequestHandler('resources/list', () => ({
      resources: [
        {
          uri: SOURCE_INFO_URI,
          name: 'source-info',
          mimeType: 'application/json',
        },
      ],
    }));
    server.setRequestHandler('resources/read', (request) => {
      if (request.params.uri !== SOURCE_INFO_URI) {
        throw new ResourceNotFoundError(request.params.uri);
      }
      const info = {
        snapshot: this.dataset.snapshot,
        datasetVersion: this.dataset.version,
        recordCount: this.recordCount(),
      };
      return {
        contents: [
          {
            uri: SOURCE_INFO_URI,
            mimeType: 'application/json',
            text: canonicalJson(info),
          },
        ],
      };
    });
    return server;
  }

  /** Items the source serves: log records, distinct orders or tickets. */
  private recordCount(): number {
    switch (this.source) {
      case 'logs':
        return this.dataset.recordCount;
      case 'backoffice':
        return backOfficeOf(this.dataset).orderCount;
      case 'tracker':
        return trackerTickets().length;
    }
  }

  private async callTool(
    server: Server,
    name: string,
    args: unknown,
    fault: ResultFaultRule | undefined,
  ): Promise<CallToolResult> {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Unknown tool: ${name}`,
      );
    }
    if (fault?.mode === 'delay_ms') {
      await sleep(fault.ms);
    }
    if (fault?.mode === 'wait_for_file' && !(await waitForFile(fault.path))) {
      return toolError(
        `fixture fault: ${fault.path} did not appear within ${WAIT_FOR_FILE_LIMIT_MS} ms`,
      );
    }
    if (fault?.mode === 'tool_error') {
      return toolError(fault.message ?? `fixture fault: ${name} failed`);
    }
    if (fault?.mode === 'tool_error_args') {
      // The text `McpServer` puts into `isError` when arguments fail its input schema.
      return toolError(
        `MCP error -32602: Input validation error: Invalid arguments for tool ${name}: rejected by fixture fault`,
      );
    }
    const outcome = tool.call(args, this.dataset);
    if (!outcome.ok) {
      return toolError(outcome.error);
    }
    if (fault?.mode === 'snapshot_flip') {
      this.dataset = flipped(this.dataset, fault.version);
    }
    const result =
      fault === undefined
        ? outcome.result
        : applyResultFault(outcome.result, fault);
    if (typeof result === 'string') {
      return toolError(result);
    }
    return server.projectCallToolResult(jsonResult(result), undefined);
  }
}

/** The `snapshot_flip` switch between `v1` and `v2`. */
function flipped(
  dataset: LogDataset,
  version: DatasetVersion | undefined,
): LogDataset {
  return createLogDataset(version ?? (dataset.version === 'v1' ? 'v2' : 'v1'));
}

/** True once the file at `path` exists; false when it does not appear within `WAIT_FOR_FILE_LIMIT_MS`. */
export async function waitForFile(path: string): Promise<boolean> {
  const deadline = Date.now() + WAIT_FOR_FILE_LIMIT_MS;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(WAIT_FOR_FILE_POLL_MS);
  }
  return true;
}

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/** `structuredContent` in canonical key order; the same JSON in `text` while it fits `TEXT_COPY_MAX_BYTES`. */
function jsonResult(result: Record<string, unknown>): CallToolResult {
  const json = canonicalJson(result);
  const structuredContent = JSON.parse(json) as Record<string, unknown>;
  const content: CallToolResult['content'] =
    Buffer.byteLength(json, 'utf8') <= TEXT_COPY_MAX_BYTES
      ? [{ type: 'text', text: json }]
      : [];
  return { structuredContent, content };
}

/** Result fields that hold the page's list (`records`, `buckets`, `orders` or `tickets`). */
const LIST_KEYS = ['records', 'buckets', 'orders', 'tickets'] as const;
const PAD_CHARACTER = 'x';

/**
 * Reshapes a tool result for a result fault; returns an error text when the fault cannot apply to this result.
 * Modes that do not change the result shape (`delay_ms`, `snapshot_flip`, `tool_error*`) return it unchanged.
 */
function applyResultFault(
  result: Record<string, unknown>,
  fault: ResultFaultRule,
): Record<string, unknown> | string {
  const listKey = LIST_KEYS.find((key) => Array.isArray(result[key]));
  const list = listKey === undefined ? [] : (result[listKey] as unknown[]);
  const withList = (items: unknown): Record<string, unknown> =>
    listKey === undefined ? { ...result } : { ...result, [listKey]: items };
  switch (fault.mode) {
    case 'empty':
      return endPage({ ...withList([]), totalMatched: 0 });
    case 'unknown_total': {
      const {
        totalMatched: _total,
        totalRelation: _relation,
        ...rest
      } = result;
      return rest;
    }
    case 'page_cap':
      return endPage(withList(list.slice(0, fault.records)));
    case 'total_cap':
      return { ...result, totalMatched: fault.total, totalRelation: 'gte' };
    case 'contract_violation':
      // Still a valid `CallToolResult`; only the page's list has the wrong type.
      return withList(`fixture fault: ${listKey ?? 'list'} is not a list`);
    case 'oversize':
      return padToBytes(result, list, fault.bytes);
    default:
      return result;
  }
}

/** Marks the page as the last one: `nextCursor` null where the tool pages. */
function endPage(result: Record<string, unknown>): Record<string, unknown> {
  return 'nextCursor' in result ? { ...result, nextCursor: null } : result;
}

/** Lengthens the first record's `message` so the canonical result JSON is `bytes` long. */
function padToBytes(
  result: Record<string, unknown>,
  records: unknown[],
  bytes: number,
): Record<string, unknown> | string {
  const [first, ...rest] = records;
  if (!isRecordWithMessage(first)) {
    return 'fixture fault: oversize needs a result with at least one record';
  }
  const missing = bytes - Buffer.byteLength(canonicalJson(result), 'utf8');
  if (missing <= 0) {
    return result;
  }
  return {
    ...result,
    records: [
      { ...first, message: first.message + PAD_CHARACTER.repeat(missing) },
      ...rest,
    ],
  };
}

function isRecordWithMessage(value: unknown): value is { message: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}
