import type { FailReason, RunOutcome } from '@agent-os/code-runner';
import { confirmedNamesOf, outcomeOfRun, runTexts } from './run-code';

const TEXTS = runTexts({
  timeoutMs: 30000,
  memoryMb: 512,
  maxToolCalls: 50,
  maxConcurrentPerUser: 2,
  resultMaxBytes: 16384,
});

function returned(value: string | null): RunOutcome {
  return { status: 'returned', value, output: 'printed' };
}

function failed(reason: FailReason, text: string | null, line: number | null): RunOutcome {
  return { status: 'failed', reason, text, line, output: 'printed' };
}

// DC-2, DC-13, «Error handling»: what the model gets for each value and each failure of a run.
describe('a run outcome becomes the model\'s outcome', () => {
  it.each([
    ['a string as it is', returned('"12 errors"'), 'success', '12 errors', 'printed'],
    ['undefined as empty', returned(null), 'empty', '', 'printed'],
    ['null as empty', returned('null'), 'empty', '', 'printed'],
    ['an empty string as empty', returned('""'), 'empty', '', 'printed'],
    ['an empty array as empty', returned('[]'), 'empty', '[]', 'printed'],
    ['an empty object as empty', returned('{}'), 'empty', '{}', 'printed'],
    ['a number as its JSON', returned('42'), 'success', '42', 'printed'],
    ['an object as its JSON', returned('{"api":3}'), 'success', '{"api":3}', 'printed'],
    ['a result that is not JSON as a broken protocol', returned('{oops'), 'tool_error', 'the executor broke the protocol', null],
    [
      'a syntax error with its message and line',
      failed('syntax', 'SyntaxError: unexpected token', 3),
      'tool_error',
      'syntax error: SyntaxError: unexpected token; line 3',
      null,
    ],
    [
      'an exception with its message and line',
      failed('exception', 'TypeError: x is not a function', 5),
      'tool_error',
      'exception: TypeError: x is not a function; line 5',
      null,
    ],
    ['a timeout', failed('timeout', null, null), 'tool_error', 'time limit exceeded (30 s)', null],
    ['a memory limit with a line', failed('memory', null, 7), 'tool_error', 'memory limit exceeded (512 MB); line 7', null],
    ['a large result', failed('result_too_large', null, null), 'tool_error', 'the result is larger than the limit (16384 bytes)', null],
    ['a result not JSON', failed('result_not_json', null, null), 'tool_error', 'the result cannot be converted to JSON', null],
    ['the call limit', failed('call_limit', null, null), 'tool_error', 'tool call limit exceeded (50)', null],
    ['a broken protocol', failed('protocol', null, null), 'tool_error', 'the executor broke the protocol', null],
    ['a crashed executor', failed('crashed', null, null), 'tool_error', 'the executor process crashed', null],
    [
      'a platform failure answering a request',
      failed('handler_failed', null, null),
      'tool_error',
      'platform failure while handling a call from the script',
      null,
    ],
    ['a busy executor', failed('busy', null, null), 'tool_error', 'the code executor is busy', null],
  ] as const)('gives %s', (_case, outcome, expectedOutcome, text, output) => {
    expect(outcomeOfRun(outcome, TEXTS)).toEqual({ kind: 'done', outcome: expectedOutcome, text, output });
  });
});

// DC-16, KD-10: a confirmed write run calls only the tools of the decided request's list.
describe('a confirmed write run takes its tool names only from the decided request', () => {
  it.each([
    [
      'the names of a list by the schema',
      {
        canCall: [
          { name: 'mcp__backoffice__create_incident_note', changes: true },
          { name: 'mcp__logs__search_logs', changes: false },
        ],
      },
      { ok: true, names: ['mcp__backoffice__create_incident_note', 'mcp__logs__search_logs'] },
    ],
    ['no names from an empty list', { canCall: [] }, { ok: true, names: [] }],
    ['an error when the request has no content', undefined, { ok: false, text: 'the decided request has no list of tools the script may call' }],
    [
      'an error when canCall is not an array',
      { canCall: 'mcp__logs__search_logs' },
      { ok: false, text: 'the decided request has no list of tools the script may call' },
    ],
  ] as const)('gives %s', (_case, confirmed, expected) => {
    expect(confirmedNamesOf(confirmed)).toEqual(expected);
  });
});
