import type { McpServerMode } from '@agent-os/contracts';
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type FetchLike,
  type RequestOptions,
  type Tool,
} from '@modelcontextprotocol/client';
import { type McpFailure, mcpFailureReason } from './mcp-failure';

export const CLIENT_INFO = { name: 'agent-os-agents', version: '1.0.0' } as const;

/** The credentials of one call: whose token goes to the server and how a rejected one is handled. */
export interface McpAuth {
  /** Decides what a rejected token means: `auth_required` for `oauth`, `unauthorized` for `shared`. */
  readonly mode: McpServerMode;
  /** The current bearer token, read before every request; `undefined` sends none. */
  token(): Promise<string | undefined>;
  /**
   * Called at most once per request, on a 401: makes the next `token()` return a new token, after which the
   * request is retried once. Without it a 401 fails the call.
   */
  onUnauthorized?(): Promise<void>;
}

export interface McpToolRequest {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface McpConnectionOptions {
  /** The server address from the registry. */
  readonly url: string;
  readonly auth: McpAuth;
  /** `MCP_CALL_TIMEOUT_MS`: bounds the whole call, the handshake included. */
  readonly timeoutMs: number;
  /** The step's signal. */
  readonly signal?: AbortSignal;
}

export interface McpCallToolOptions extends McpConnectionOptions {
  readonly request: McpToolRequest;
}

/** A call answered by the server (its `isError` included), or why it got no result. */
export type McpCallResponse = { readonly kind: 'result'; readonly result: CallToolResult } | McpFailure;

/** `fetch` bounded by one deadline for a whole OAuth exchange: a server check, a code exchange or a token refresh. */
export function deadlineFetch(timeoutMs: number): FetchLike {
  const deadline = AbortSignal.timeout(timeoutMs);
  return (url, init) =>
    fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
}

/** One deadline for the whole call: the timeout and the step's signal, whichever comes first. */
function callSignal(options: McpConnectionOptions): AbortSignal {
  const deadline = AbortSignal.timeout(options.timeoutMs);
  return options.signal === undefined ? deadline : AbortSignal.any([deadline, options.signal]);
}

/**
 * Opens a connection with the caller's credentials, runs `use` on it and closes it whatever happens, so no
 * token and no session outlives the call (KD-3, Invariant 1).
 */
async function withConnection<T>(
  options: McpConnectionOptions,
  use: (client: Client, request: RequestOptions) => Promise<T>,
): Promise<T> {
  const request: RequestOptions = { timeout: options.timeoutMs, signal: callSignal(options) };
  const client = new Client(CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(options.url), { authProvider: options.auth });
  try {
    await client.connect(transport, request);
    return await use(client, request);
  } finally {
    await client.close();
  }
}

/**
 * MCP over Streamable HTTP with a connection per call (KD-3): each call creates its client and transport,
 * does `initialize` and its request, and closes the connection. Nothing is kept between calls.
 */
export class McpClient {
  /** Lists the server's tools as the server listed them; any failure is an exception for the caller to classify. */
  async listTools(options: McpConnectionOptions): Promise<Tool[]> {
    return withConnection(options, async (client, request) => (await client.listTools(undefined, request)).tools);
  }

  /**
   * Calls a tool. A result, including one with `isError`, is returned as is; a client error comes back as the
   * outcome it maps to (`mcpFailureReason`). An error outside the client's classes is a defect and propagates.
   */
  async callTool(options: McpCallToolOptions): Promise<McpCallResponse> {
    const { name, arguments: args } = options.request;
    try {
      const result = await withConnection(options, (client, request) =>
        client.callTool({ name, arguments: { ...args } }, request),
      );
      return { kind: 'result', result };
    } catch (error) {
      return mcpFailureReason(error, options.auth.mode);
    }
  }
}
