import {
  Client,
  SdkError,
  SdkErrorCode,
  type CallToolResult,
  type ReadResourceResult,
} from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { TransportFailure } from '../source-adapter.js';
import { classifyMcpError } from './mcp-error-classifier.js';
import { McpStartupError } from './mcp-startup-error.js';

/** Read buffer of the stdio transport: the limit of one response line (design-mcp-source.md, Settings). */
export const MCP_STDIO_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

const FIXTURE_ENV_PREFIX = 'FIXTURE_';
const CLIENT_INFO = { name: 'agent-os-sources', version: '1.0.0' } as const;

export interface McpSourceClientLogger {
  debug(message: string, fields: Readonly<Record<string, unknown>>): void;
}

export interface McpSourceClientOptions {
  /** Entry script of the source process, run with the current Node executable. */
  readonly serverPath: string;
  /** `FIXTURE_*` variables added to the inherited default environment; nothing else is passed. */
  readonly fixtureEnv: Readonly<Record<string, string>>;
  readonly logger: McpSourceClientLogger;
}

export interface McpRequestOptions {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface McpToolRequest {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type McpToolResponse = { readonly kind: 'result'; readonly result: CallToolResult } | TransportFailure;

interface Connection {
  readonly client: Client;
}

function assertFixtureEnv(env: Readonly<Record<string, string>>): void {
  const foreign = Object.keys(env).filter((key) => !key.startsWith(FIXTURE_ENV_PREFIX));
  if (foreign.length > 0) {
    throw new Error(`McpSourceClient passes only ${FIXTURE_ENV_PREFIX}* variables; got ${foreign.join(', ')}`);
  }
}

/**
 * A handshake that outlived its timeout: a slow start, not a wrong configuration. It stays a `RequestTimeout`
 * (K-6, or K-2 when the deadline capped the timeout) instead of becoming a startup failure (K-9).
 */
function isStartTimeout(error: unknown): error is SdkError {
  return error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout;
}

/**
 * Waits for the shared process start but stops waiting when this call's signal aborts, reporting it as the SDK
 * reports an aborted request (RequestTimeout); the caller reads the signal first (K-1). The start itself goes on
 * for the other calls that share it.
 */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = (): SdkError => new SdkError(SdkErrorCode.RequestTimeout, 'The call was aborted while the source process started');
  if (signal.aborted) {
    return Promise.reject(aborted());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * One long-lived source process per client, started on the first call. After the connection
 * drops, the next call starts a new process; concurrent calls share that single start.
 */
export class McpSourceClient {
  private connection: Promise<Connection> | null = null;
  private closed = false;

  constructor(private readonly options: McpSourceClientOptions) {
    assertFixtureEnv(options.fixtureEnv);
  }

  /**
   * Calls a tool. Client errors come back classified (K-3…K-9, K-13); a result, including one with
   * `isError`, is returned as is for the adapter. A non-SDK exception (K-14) propagates.
   */
  async callTool(request: McpToolRequest, options: McpRequestOptions): Promise<McpToolResponse> {
    const startedAt = performance.now();
    try {
      const { client } = await untilAborted(this.connect(options), options.signal);
      // `timeoutMs` bounds the whole call, process start included: the caller caps it by the deadline (K-2).
      const timeout = options.timeoutMs - (performance.now() - startedAt);
      if (timeout <= 0) {
        throw new SdkError(SdkErrorCode.RequestTimeout, 'The call timeout elapsed while the source process started');
      }
      const result = await client.callTool(
        { name: request.name, arguments: { ...request.arguments } },
        { timeout, signal: options.signal },
      );
      return { kind: 'result', result };
    } catch (error) {
      return classifyMcpError(error);
    }
  }

  /** Reads a resource; any failure is an exception. */
  async readResource(uri: string, options: McpRequestOptions): Promise<ReadResourceResult> {
    const { client } = await this.connect(options);
    return client.readResource({ uri }, { timeout: options.timeoutMs, signal: options.signal });
  }

  async close(): Promise<void> {
    this.closed = true;
    const connection = this.connection;
    this.connection = null;
    if (connection === null) {
      return;
    }
    const opened = await connection.catch(() => null);
    await opened?.client.close();
  }

  private connect(options: McpRequestOptions): Promise<Connection> {
    if (this.closed) {
      return Promise.reject(new Error('McpSourceClient is closed'));
    }
    this.connection ??= this.open(options.timeoutMs);
    return this.connection;
  }

  private open(timeoutMs: number): Promise<Connection> {
    const opening: Promise<Connection> = this.start(timeoutMs, () => this.forget(opening)).catch(
      (error: unknown) => {
        this.forget(opening);
        throw isStartTimeout(error) ? error : new McpStartupError(error);
      },
    );
    return opening;
  }

  private async start(timeoutMs: number, onClose: () => void): Promise<Connection> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.options.serverPath],
      env: { ...getDefaultEnvironment(), ...this.options.fixtureEnv },
      stderr: 'pipe',
      maxBufferSize: MCP_STDIO_MAX_BUFFER_BYTES,
    });
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      this.options.logger.debug('mcp source process stderr', { stderr: chunk.toString() });
    });
    const client = new Client(CLIENT_INFO);
    client.onclose = onClose;
    try {
      await client.connect(transport, { timeout: timeoutMs });
    } catch (error) {
      // The start failure is what the caller needs; a failing cleanup is only worth a trace.
      await client.close().catch((closeError: unknown) => {
        this.options.logger.debug('mcp source process cleanup after a failed start failed', {
          error: String(closeError),
        });
      });
      throw error;
    }
    return { client };
  }

  private forget(connection: Promise<Connection>): void {
    if (this.connection === connection) {
      this.connection = null;
    }
  }
}
