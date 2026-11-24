import type { CallToolResult } from '@modelcontextprotocol/client';
import type { McpCallResponse } from './mcp-client';
import type { McpFailureReason } from './mcp-failure';
import { type McpOutcomeResult, scriptValueOf, toOutcome } from './mcp-outcome';

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
      result({
        isError: true,
        content: [{ type: 'text', text: 'unknown service' }],
      }),
      { outcome: 'tool_error', text: 'unknown service' },
    ],
    [
      'no content and no structured content is an empty result',
      result({}),
      { outcome: 'empty', text: '' },
    ],
    [
      // design-mcp-connect.md KD-5: no usable account is its own outcome, with the page to fix it on
      'no usable account of the owner is auth_required naming the server',
      { kind: 'auth_required' } satisfies McpCallResponse,
      {
        outcome: 'auth_required',
        text: 'An account of backoffice must be connected on the page «Мой доступ»',
      },
    ],
  ] as const)('%s', (_case, response, expected) => {
    expect(toOutcome(response, { server: SERVER, readOnly: false })).toEqual(
      expected,
    );
  });

  // agent-harness AC-03.1, AC-03.2, AC-04.2, DC-3, DC-4 (KD-4): a call with no answer names its reason; a changing
  // call whose request may have run is `unknown` and must not be repeated unchecked. A `run_code` script's call
  // goes through the same function (DC-5).
  const failed = (why: string) => `The call to backoffice failed: ${why}.`;
  const maybeDone = (why: string) =>
    `The call to backoffice got no answer: ${why}. The action may have been carried out. ` +
    'Do not repeat it before checking whether it was.';
  it.each<[boolean, McpFailureReason, McpOutcomeResult]>([
    [
      true,
      'timeout',
      {
        outcome: 'transport_failure',
        text: failed('the server did not answer in time (timeout)'),
        reason: 'timeout',
      },
    ],
    [
      true,
      'connection_lost',
      {
        outcome: 'transport_failure',
        text: failed('the connection to the server was lost'),
        reason: 'connection_lost',
      },
    ],
    [
      true,
      'protocol_error',
      {
        outcome: 'transport_failure',
        text: failed('the server answered outside the MCP protocol'),
        reason: 'protocol_error',
      },
    ],
    [
      true,
      'unauthorized',
      {
        outcome: 'transport_failure',
        text: failed("the server rejected the platform's credentials"),
        reason: 'unauthorized',
      },
    ],
    [
      true,
      'client_error',
      {
        outcome: 'transport_failure',
        text: failed('the MCP client failed to make the call'),
        reason: 'client_error',
      },
    ],
    [
      false,
      'timeout',
      {
        outcome: 'unknown',
        text: maybeDone('the server did not answer in time (timeout)'),
        reason: 'timeout',
      },
    ],
    [
      false,
      'connection_lost',
      {
        outcome: 'unknown',
        text: maybeDone('the connection to the server was lost'),
        reason: 'connection_lost',
      },
    ],
    [
      false,
      'protocol_error',
      {
        outcome: 'unknown',
        text: maybeDone('the server answered outside the MCP protocol'),
        reason: 'protocol_error',
      },
    ],
    [
      false,
      'unauthorized',
      {
        outcome: 'transport_failure',
        text: failed("the server rejected the platform's credentials"),
        reason: 'unauthorized',
      },
    ],
    [
      false,
      'client_error',
      {
        outcome: 'transport_failure',
        text: failed('the MCP client failed to make the call'),
        reason: 'client_error',
      },
    ],
  ])(
    'a call with no answer, readOnly %s, reason %s',
    (readOnly, reason, expected) => {
      expect(
        toOutcome({ kind: 'failure', reason }, { server: SERVER, readOnly }),
      ).toEqual(expected);
    },
  );

  // «API скрипта»: callTool returns structuredContent, else the text parsed as JSON, else the text.
  it.each<[string, CallToolResult, unknown]>([
    [
      'structured content is the value even beside text',
      {
        content: [{ type: 'text', text: '{"count":1}' }],
        structuredContent: { count: 2 },
      },
      { count: 2 },
    ],
    [
      'a JSON text is the parsed value',
      { content: [{ type: 'text', text: '[{"id":1}]' }] },
      [{ id: 1 }],
    ],
    [
      'a plain text is the text',
      { content: [{ type: 'text', text: 'two errors' }] },
      'two errors',
    ],
  ])('the script value: %s', (_case, callResult, expected) => {
    expect(scriptValueOf(callResult)).toEqual(expected);
  });
});
