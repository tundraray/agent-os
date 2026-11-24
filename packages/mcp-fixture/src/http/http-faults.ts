import { setTimeout as sleep } from 'node:timers/promises';
import type { RequestId } from '@modelcontextprotocol/server';
import type { TransportFaultRule } from '../fault-schedule';

/** What the HTTP server does with a request: answer it, never answer (`hang`) or break the socket (`drop`). */
export type HttpAnswer = Response | 'hang' | 'drop';

const MALFORMED_BODY = 'fixture fault: this body is not JSON';

/**
 * Applies a transport fault rule to one `tools/call` over HTTP: `hang` and `drop_connection` act before
 * the server sees the call; the other modes let the server answer (`serve`) and then hold back or replace
 * its response.
 */
export async function answerWithFault(
  fault: TransportFaultRule,
  id: RequestId,
  serve: () => Promise<Response>,
): Promise<HttpAnswer> {
  switch (fault.mode) {
    case 'hang':
      return 'hang';
    case 'drop_connection':
      return 'drop';
    case 'late_response': {
      const response = await serve();
      await sleep(fault.ms);
      return response;
    }
    case 'jsonrpc_error':
      await serve();
      return Response.json({
        jsonrpc: '2.0',
        id,
        error: {
          code: fault.code,
          message:
            fault.message ?? `fixture fault: JSON-RPC error ${fault.code}`,
        },
      });
    case 'invalid_result':
      await serve();
      // `content` must be an array of content blocks, so the client's `CallToolResult` schema rejects this.
      return Response.json({
        jsonrpc: '2.0',
        id,
        result: { content: 'not a content array' },
      });
    case 'malformed_json':
      await serve();
      return new Response(MALFORMED_BODY, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
  }
}
