import type { FailureClass } from '@agent-os/contracts';

/**
 * Runtime schema of a tool's arguments or result. Structural, so a zod schema satisfies it
 * without this port depending on a particular validation library.
 */
export interface SourceSchema<T = unknown> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown };
}

export interface SourceToolDescriptor {
  readonly name: string;
  /** The tool takes and returns a cursor. A tool with `paginated: false` is always `exhausted`. */
  readonly paginated: boolean;
  /** Declared by the project; the registry refuses an allowlisted tool that is not read-only. */
  readonly readOnly: boolean;
  readonly argsSchema: SourceSchema;
  readonly resultSchema: SourceSchema;
}

export interface SourceDescriptor {
  readonly sourceId: string;
  readonly tools: readonly SourceToolDescriptor[];
}

export interface SourceCall {
  readonly toolName: string;
  /** Arguments that already passed the tool's `argsSchema`; the cursor travels separately. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly cursor: string | null;
  /** The attempt's signal (`ctx.signal`). */
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export type TotalRelation = 'eq' | 'gte';

export interface NormalizedPage {
  readonly snapshot: string;
  readonly items: readonly unknown[];
  readonly returned: number;
  /** Null when the source does not report a total; never 0 in place of "unknown". */
  readonly totalMatched: number | null;
  readonly totalRelation: TotalRelation | null;
  readonly nextCursor: string | null;
  /** The source claims it returned the whole answer to the request. */
  readonly exhausted: boolean;
}

/** Codes of transport and protocol failures (design-mcp-source.md, Error Handling, K-3…K-13). */
export type TransportFailureCode =
  | 'config_or_protocol_mismatch'
  | 'server_internal_error'
  | 'protocol_error'
  | 'connection_lost'
  | 'timeout'
  | 'invalid_result'
  | 'http_status'
  | 'result_contract_violation'
  | 'unclassified_client_error';

/** The classification row that decided the outcome, such as `K-5`. */
export type ClassificationRow = `K-${number}`;

export interface TransportFailure {
  readonly kind: 'transport';
  readonly failureClass: Extract<FailureClass, 'transport_protocol'>;
  readonly code: TransportFailureCode;
  readonly retryable: boolean;
  /** The source process must be restarted before the retry. */
  readonly reconnect: boolean;
  readonly cause: ClassificationRow;
}

export interface ToolErrorOutcome {
  readonly kind: 'tool_error';
  readonly failureClass: Extract<FailureClass, 'tool_error'>;
  readonly message: string;
}

export interface PageOutcome {
  readonly kind: 'page';
  readonly page: NormalizedPage;
}

/** An already classified result of one source call. Source failures are values; a defect is an exception. */
export type CallOutcome = PageOutcome | ToolErrorOutcome | TransportFailure;

export interface SourceAdapter {
  readonly descriptor: SourceDescriptor;
  call(call: SourceCall): Promise<CallOutcome>;
  /** The source's current data snapshot (1..200 chars). Timeout, abort and failure are exceptions. */
  currentSnapshot(signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
}
