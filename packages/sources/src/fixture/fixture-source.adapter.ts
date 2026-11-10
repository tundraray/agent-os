import type { CallToolResult } from '@modelcontextprotocol/client';
import type { z } from 'zod';
import { McpSourceClient, type McpSourceClientLogger } from '../mcp/mcp-source-client.js';
import type {
  CallOutcome,
  NormalizedPage,
  SourceAdapter,
  SourceCall,
  SourceDescriptor,
  SourceToolDescriptor,
  TransportFailure,
} from '../source-adapter.js';
import type { FixtureSettings, SourcesSettings } from '../sources.settings.js';
import {
  AggregateLogsArgsSchema,
  AggregateLogsResultSchema,
  GetTraceArgsSchema,
  GetTraceResultSchema,
  SearchLogsArgsSchema,
  SearchLogsResultSchema,
  SourceInfoSchema,
} from './fixture-tools.schema.js';

export const FIXTURE_SOURCE_ID = 'fixture';
const SOURCE_INFO_URI = 'fixture://source-info';

/** K-11: `structuredContent` is missing or fails the tool's `resultSchema`. */
const RESULT_CONTRACT_VIOLATION: TransportFailure = {
  kind: 'transport',
  failureClass: 'transport_protocol',
  code: 'result_contract_violation',
  retryable: true,
  reconnect: false,
  cause: 'K-11',
};

export interface FixtureTool {
  readonly descriptor: SourceToolDescriptor;
  /** The normalized page, or null when the structured result breaks the tool's contract. */
  toPage(structuredContent: unknown): NormalizedPage | null;
}

export function fixtureTool<Result>(definition: {
  name: string;
  paginated: boolean;
  argsSchema: SourceToolDescriptor['argsSchema'];
  resultSchema: z.ZodType<Result>;
  normalize: (result: Result) => NormalizedPage;
}): FixtureTool {
  const { name, paginated, argsSchema, resultSchema, normalize } = definition;
  return {
    descriptor: { name, paginated, readOnly: true, argsSchema, resultSchema },
    toPage(structuredContent) {
      const parsed = resultSchema.safeParse(structuredContent);
      return parsed.success ? normalize(parsed.data) : null;
    },
  };
}

/** Units of `Coverage` per tool: design-mcp-source.md, SourceCall и CallOutcome. */
const FIXTURE_TOOLS: readonly FixtureTool[] = [
  fixtureTool({
    name: 'search_logs',
    paginated: true,
    argsSchema: SearchLogsArgsSchema,
    resultSchema: SearchLogsResultSchema,
    normalize: (result) => ({
      snapshot: result.snapshot,
      items: result.records,
      returned: result.records.length,
      totalMatched: result.totalMatched ?? null,
      totalRelation: result.totalRelation ?? null,
      nextCursor: result.nextCursor,
      exhausted: false,
    }),
  }),
  fixtureTool({
    name: 'aggregate_logs',
    paginated: false,
    argsSchema: AggregateLogsArgsSchema,
    resultSchema: AggregateLogsResultSchema,
    // The result's total counts records, not buckets; it stays in the content only.
    normalize: (result) => ({
      snapshot: result.snapshot,
      items: result.buckets,
      returned: result.buckets.length,
      totalMatched: null,
      totalRelation: null,
      nextCursor: null,
      exhausted: true,
    }),
  }),
  fixtureTool({
    name: 'get_trace',
    paginated: false,
    argsSchema: GetTraceArgsSchema,
    resultSchema: GetTraceResultSchema,
    normalize: (result) => ({
      snapshot: result.snapshot,
      items: result.records,
      returned: result.records.length,
      totalMatched: result.records.length,
      totalRelation: 'eq',
      nextCursor: null,
      exhausted: true,
    }),
  }),
];

export interface FixtureSourceAdapterOptions {
  /** Entry script of the fixture process (`fixtureServerPath` of `@agent-os/mcp-fixture`). */
  readonly serverPath: string;
  readonly settings: SourcesSettings;
  readonly logger: McpSourceClientLogger;
}

/** What a fixture process serves (`FIXTURE_SOURCE` of `@agent-os/mcp-fixture`). */
export type FixtureProcessSource = 'logs' | 'backoffice';

/**
 * Environment of a fixture process: what it serves, and the same scenario or dataset, rules file and call log for
 * every source, so two processes of one assembly build their data from one set and report one slice.
 */
function fixtureProcessEnv(fixture: FixtureSettings, source: FixtureProcessSource): Record<string, string> {
  return {
    FIXTURE_SOURCE: source,
    FIXTURE_DATASET: fixture.dataset,
    ...(fixture.scenario === null ? {} : { FIXTURE_SCENARIO: fixture.scenario }),
    ...(fixture.faultsPath === null ? {} : { FIXTURE_FAULTS: fixture.faultsPath }),
    ...(fixture.callLogPath === null ? {} : { FIXTURE_CALL_LOG: fixture.callLogPath }),
  };
}

function toolErrorText(result: CallToolResult): string {
  return result.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
}

/**
 * One long-lived fixture process serving `source` through the MCP client — started on the first call, never by
 * construction — and the normalization of each answer into `Coverage` units by the tool's contract. Each fixture
 * adapter owns one; the text the server reports about its tools is never read.
 */
export class FixtureProcess {
  private readonly tools: ReadonlyMap<string, FixtureTool>;
  private readonly client: McpSourceClient;
  private readonly snapshotTimeoutMs: number;

  constructor(
    private readonly source: FixtureProcessSource,
    tools: readonly FixtureTool[],
    options: FixtureSourceAdapterOptions,
  ) {
    this.tools = new Map(tools.map((tool) => [tool.descriptor.name, tool]));
    this.client = new McpSourceClient({
      serverPath: options.serverPath,
      fixtureEnv: fixtureProcessEnv(options.settings.fixture, source),
      logger: options.logger,
    });
    this.snapshotTimeoutMs = options.settings.callTimeoutMs;
  }

  async call(call: SourceCall): Promise<CallOutcome> {
    const tool = this.tools.get(call.toolName);
    if (tool === undefined) {
      // The executor resolves the tool against the adapter's descriptor first, so this is a defect.
      throw new Error(`fixture source ${this.source} has no tool ${call.toolName}`);
    }
    const args = call.cursor === null ? call.args : { ...call.args, cursor: call.cursor };
    const response = await this.client.callTool(
      { name: call.toolName, arguments: args },
      { timeoutMs: call.timeoutMs, signal: call.signal },
    );
    if (response.kind === 'transport') {
      return response;
    }
    const { result } = response;
    if (result.isError === true) {
      return { kind: 'tool_error', failureClass: 'tool_error', message: toolErrorText(result) };
    }
    const page = result.structuredContent === undefined ? null : tool.toPage(result.structuredContent);
    return page === null ? RESULT_CONTRACT_VIOLATION : { kind: 'page', page };
  }

  async currentSnapshot(signal: AbortSignal): Promise<string> {
    const resource = await this.client.readResource(SOURCE_INFO_URI, {
      timeoutMs: this.snapshotTimeoutMs,
      signal,
    });
    const [content] = resource.contents;
    if (content === undefined || !('text' in content)) {
      throw new Error(`${SOURCE_INFO_URI} returned no text content`);
    }
    return SourceInfoSchema.parse(JSON.parse(content.text)).snapshot;
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

/** The fixture MCP source of payment logs: a project-declared descriptor of three read-only tools. */
export class FixtureSourceAdapter implements SourceAdapter {
  readonly descriptor: SourceDescriptor = {
    sourceId: FIXTURE_SOURCE_ID,
    tools: FIXTURE_TOOLS.map((tool) => tool.descriptor),
  };
  private readonly process: FixtureProcess;

  constructor(options: FixtureSourceAdapterOptions) {
    this.process = new FixtureProcess('logs', FIXTURE_TOOLS, options);
  }

  call(call: SourceCall): Promise<CallOutcome> {
    return this.process.call(call);
  }

  currentSnapshot(signal: AbortSignal): Promise<string> {
    return this.process.currentSnapshot(signal);
  }

  close(): Promise<void> {
    return this.process.close();
  }
}
