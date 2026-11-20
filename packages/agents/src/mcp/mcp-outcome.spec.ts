import type { CallToolResult } from '@modelcontextprotocol/client';
import type { McpCallResponse } from './mcp-client.js';
import { scriptValueOf, toOutcome } from './mcp-outcome.js';

// AC-13.1 (outcomes of a call): an MCP response becomes exactly one outcome with the server's whole text;
// what the model gets of a long text is decided by the runner (large-result.spec.ts).

const SERVER = 'backoffice';

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
      // design-mcp-connect.md KD-5: no usable account is its own outcome, with the page to fix it on
      'no usable account of the owner is auth_required naming the server',
      { kind: 'auth_required' } satisfies McpCallResponse,
      { outcome: 'auth_required', text: 'Нужно подключить аккаунт backoffice на странице «Мой доступ»' },
    ],
  ] as const)('%s', (_case, response, expected) => {
    expect(toOutcome(response, SERVER)).toEqual(expected);
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
