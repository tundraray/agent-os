import type { Logger } from '@agent-os/common';
import {
  Client,
  SdkError,
  SdkErrorCode,
  type CallToolResult,
  type ToolAnnotations,
} from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpServerConfig } from '../config.js';
import type { JsonSchemaObject } from '../model/mastra-turn.js';
import { type McpFailureReason, McpStartupError, mcpFailureReason } from './mcp-failure.js';

/** Read buffer of the stdio transport: the limit of one response line. */
const MCP_STDIO_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

const CLIENT_INFO = { name: 'agent-os-agents', version: '1.0.0' } as const;

export interface McpRequestOptions {
  /** Bounds the whole request, the process start included. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface McpToolRequest {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** A call answered by the server (its `isError` included), or the reason it got no answer. */
export type McpCallResponse =
  | { readonly kind: 'result'; readonly result: CallToolResult }
  | { readonly kind: 'failure'; readonly reason: McpFailureReason };

/** One tool of the server's `tools/list`, as the server listed it. */
export interface McpListedTool {
  readonly name: string;
  /** The tool's human name: its `title`, or `annotations.title` when it has only that. */
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly annotations?: ToolAnnotations;
}

export interface McpClientOptions {
  /** Command, arguments and environment of the server process, from the servers file. */
  readonly server: McpServerConfig;
  readonly logger: Logger;
  /** Called when the connection drops; the next request starts a new process. */
  readonly onDisconnect?: () => void;
}

interface Connection {
  readonly client: Client;
}

/** A handshake that outlived its timeout: a slow start stays a `timeout`, not a startup failure. */
function isStartTimeout(error: unknown): error is SdkError {
  return error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout;
}

/**
 * Waits for the shared process start but stops waiting when this request's signal aborts, reporting it as
 * the SDK reports an aborted request. The start itself goes on for the other requests that share it.
 */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return pending;
  }
  const aborted = (): SdkError =>
    new SdkError(SdkErrorCode.RequestTimeout, 'The request was aborted while the server process started');
  if (signal.aborted) {
    return Promise.reject(aborted());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** The time left of a request's timeout after the process start; nothing left is a timeout. */
function remaining(options: McpRequestOptions, startedAt: number): number {
  const left = options.timeoutMs - (performance.now() - startedAt);
  if (left <= 0) {
    throw new SdkError(SdkErrorCode.RequestTimeout, 'The timeout elapsed while the server process started');
  }
  return left;
}

/**
 * One long-lived stdio process per MCP server, started on the first request. After the connection drops,
 * the next request starts a new process; concurrent requests share that single start.
 */
export class McpClient {
  private connection: Promise<Connection> | null = null;
  private closed = false;

  constructor(private readonly options: McpClientOptions) {}

  /** Lists the server's tools; any failure is an exception. */
  async listTools(options: McpRequestOptions): Promise<McpListedTool[]> {
    const startedAt = performance.now();
    const { client } = await untilAborted(this.connect(options), options.signal);
    const { tools } = await client.listTools(undefined, {
      timeout: remaining(options, startedAt),
      signal: options.signal,
    });
    return tools.map((tool) => {
      const title = tool.title ?? tool.annotations?.title;
      return {
        name: tool.name,
        ...(title === undefined ? {} : { title }),
        description: tool.description ?? '',
        inputSchema: { ...tool.inputSchema, type: 'object' },
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      };
    });
  }

  /**
   * Calls a tool. A result, including one with `isError`, is returned as is; a client error comes back as
   * the reason of the failure. A non-SDK exception is a defect and propagates.
   */
  async callTool(request: McpToolRequest, options: McpRequestOptions): Promise<McpCallResponse> {
    const startedAt = performance.now();
    try {
      const { client } = await untilAborted(this.connect(options), options.signal);
      const result = await client.callTool(
        { name: request.name, arguments: { ...request.arguments } },
        { timeout: remaining(options, startedAt), signal: options.signal },
      );
      return { kind: 'result', result };
    } catch (error) {
      return { kind: 'failure', reason: mcpFailureReason(error) };
    }
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
      return Promise.reject(new Error(`McpClient of server ${this.options.server.id} is closed`));
    }
    this.connection ??= this.open(options.timeoutMs);
    return this.connection;
  }

  private open(timeoutMs: number): Promise<Connection> {
    const opening: Promise<Connection> = this.start(timeoutMs, () => {
      this.forget(opening);
      this.options.onDisconnect?.();
    }).catch((error: unknown) => {
      this.forget(opening);
      throw isStartTimeout(error) ? error : new McpStartupError(error);
    });
    return opening;
  }

  private async start(timeoutMs: number, onClose: () => void): Promise<Connection> {
    const { server, logger } = this.options;
    const transport = new StdioClientTransport({
      command: server.command,
      args: [...server.args],
      env: { ...getDefaultEnvironment(), ...server.env },
      stderr: 'pipe',
      maxBufferSize: MCP_STDIO_MAX_BUFFER_BYTES,
    });
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      logger.debug('mcp server process stderr', { server: server.id, stderr: chunk.toString() });
    });
    const client = new Client(CLIENT_INFO);
    client.onclose = onClose;
    try {
      await client.connect(transport, { timeout: timeoutMs });
    } catch (error) {
      // The start failure is what the caller needs; a failing cleanup is only worth a trace.
      await client.close().catch((closeError: unknown) => {
        logger.debug('mcp server process cleanup after a failed start failed', {
          server: server.id,
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
