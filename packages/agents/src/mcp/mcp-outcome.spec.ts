import type { CallToolResult } from '@modelcontextprotocol/client';
import type { McpCallResponse } from './mcp-client.js';
import { scriptValueOf, toOutcome } from './mcp-outcome.js';

// AC-13.1 (outcomes of a call): an MCP response becomes exactly one outcome.
// DC-7, DC-8: a cut text ends with the cut note; only a success names readResult with its callId.

const MAX_BYTES = 16;
const CALL_ID = 'call-7';

function result(fields: Partial<CallToolResult>): McpCallResponse {
  return { kind: 'result', result: { content: [], ...fields } };
}

describe('an MCP response becomes one outcome and read-only comes only from readOnlyHint', () => {
  it.each([
    [
      'a text result is a success',
      result({ content: [{ type: 'text', text: 'two errors' }] }),
      { outcome: 'success', text: 'two errors' },
    ],
    [
      'a structured result without content blocks is a success',
      result({ structuredContent: { count: 2 } }),
      { outcome: 'success', text: '{"count":2}' },
    ],
    [
      'isError is a tool error, not a success',
      result({ isError: true, content: [{ type: 'text', text: 'unknown service' }] }),
      { outcome: 'tool_error', text: 'unknown service' },
    ],
    ['no content and no structured content is an empty result', result({}), { outcome: 'empty', text: '' }],
    [
      'a timeout is a transport failure with its reason',
      { kind: 'failure', reason: 'timeout' } satisfies McpCallResponse,
      { outcome: 'transport_failure', text: '', reason: 'timeout' },
    ],
    [
      'a lost connection is a transport failure with its reason',
      { kind: 'failure', reason: 'connection_lost' } satisfies McpCallResponse,
      { outcome: 'transport_failure', text: '', reason: 'connection_lost' },
    ],
    [
      'a protocol error is a transport failure with its reason',
      { kind: 'failure', reason: 'protocol_error' } satisfies McpCallResponse,
      { outcome: 'transport_failure', text: '', reason: 'protocol_error' },
    ],
    [
      'a text longer than the limit is cut at the limit with the number of cut bytes',
      result({ content: [{ type: 'text', text: 'abcdefghijklmnopqrstuvwxyz' }] }),
      {
        outcome: 'success',
        text: 'abcdefghijklmnop\nрезультат обрезан на 10 байт; полный — `readResult("call-7")` в `run_code`',
      },
    ],
    [
      'the cut never splits a multi-byte character',
      // 'ж' is 2 bytes in UTF-8: 15 ASCII bytes + 'ж' crosses the 16-byte limit, so the whole 'ж' goes.
      result({ content: [{ type: 'text', text: 'abcdefghijklmnoжz' }] }),
      {
        outcome: 'success',
        text: 'abcdefghijklmno\nрезультат обрезан на 3 байт; полный — `readResult("call-7")` в `run_code`',
      },
    ],
    [
      'a cut tool error says how much was cut but offers no full result',
      result({ isError: true, content: [{ type: 'text', text: 'abcdefghijklmnopqrstuvwxyz' }] }),
      { outcome: 'tool_error', text: 'abcdefghijklmnop\nрезультат обрезан на 10 байт' },
    ],
  ] as const)('%s', (_case, response, expected) => {
    expect(toOutcome(response, MAX_BYTES, CALL_ID)).toEqual(expected);
  });

  // «API скрипта»: callTool returns structuredContent, else the text parsed as JSON, else the text.
  it.each<[string, CallToolResult, unknown]>([
    [
      'structured content is the value even beside text',
      { content: [{ type: 'text', text: '{"count":1}' }], structuredContent: { count: 2 } },
      { count: 2 },
    ],
    ['a JSON text is the parsed value', { content: [{ type: 'text', text: '[{"id":1}]' }] }, [{ id: 1 }]],
    ['a plain text is the text', { content: [{ type: 'text', text: 'two errors' }] }, 'two errors'],
  ])('the script value: %s', (_case, callResult, expected) => {
    expect(scriptValueOf(callResult)).toEqual(expected);
  });
});
