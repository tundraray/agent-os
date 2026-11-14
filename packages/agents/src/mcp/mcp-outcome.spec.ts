import type { CallToolResult } from '@modelcontextprotocol/client';
import type { McpCallResponse } from './mcp-client.js';
import { isReadOnly, toOutcome } from './mcp-outcome.js';

// AC-13.1 (outcomes of a call) and KD-4 (design-agents.md): an MCP response becomes exactly one outcome,
// and a tool is read-only only when its server listed `readOnlyHint: true` — otherwise a changing call
// could be repeated after a restart.

const MAX_BYTES = 16;

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
      { outcome: 'success', text: 'abcdefghijklmnop\n[truncated 10 bytes]' },
    ],
    [
      'the cut never splits a multi-byte character',
      // 'ж' is 2 bytes in UTF-8: 15 ASCII bytes + 'ж' crosses the 16-byte limit, so the whole 'ж' goes.
      result({ content: [{ type: 'text', text: 'abcdefghijklmnoжz' }] }),
      { outcome: 'success', text: 'abcdefghijklmno\n[truncated 3 bytes]' },
    ],
  ] as const)('%s', (_case, response, expected) => {
    expect(toOutcome(response, MAX_BYTES)).toEqual(expected);
  });

  it.each([
    ['readOnlyHint true is read-only', { readOnlyHint: true }, true],
    ['readOnlyHint false is changing', { readOnlyHint: false }, false],
    ['annotations without the hint are changing', { title: 'Create a note' }, false],
    ['no annotations are changing', undefined, false],
  ] as const)('%s', (_case, annotations, readOnly) => {
    expect(isReadOnly(annotations)).toBe(readOnly);
  });
});
