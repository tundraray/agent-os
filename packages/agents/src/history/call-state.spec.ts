import { foldCalls } from './call-state';
import type { HistoryContent, HistoryEntry } from './history';

// Invariants 1, 2 (design-agents.md): the state of a call is which of its records exist — the rule the
// tool step, an interrupt, a stop and `history` all read a call by.

const AT = new Date('2026-11-20T10:00:00.000Z');
const SENT_AT = '2026-11-20T10:00:05.000Z';

type Content<K extends HistoryEntry['kind']> = HistoryContent<K>;

function entry<K extends HistoryEntry['kind']>(
  seq: number,
  kind: K,
  content: Content<K>,
): HistoryEntry {
  // The kind and its content are given together; TypeScript cannot correlate them across the union.
  return { seq, kind, createdAt: AT, content } as HistoryEntry;
}

const answer = (seq: number, ...callIds: string[]): HistoryEntry =>
  entry(seq, 'model_answer', {
    text: 'calling',
    toolCalls: callIds.map((callId) => ({
      callId,
      tool: 'purge',
      server: 'logs',
      args: { days: 30 },
    })),
  });
const confirmation = (seq: number, callId: string) =>
  entry(seq, 'tool_confirmation', { callId, questionId: `q-${callId}` });
const decision = (seq: number, callId: string, args?: unknown) =>
  entry(seq, 'tool_decision', {
    callId,
    approved: true,
    ...(args === undefined ? {} : { args }),
  });
const sent = (seq: number, callId: string, args?: unknown) =>
  entry(seq, 'tool_sent', {
    callId,
    startedAt: SENT_AT,
    ...(args === undefined ? {} : { args }),
  });
const attempt = (seq: number, callId: string, number: number) =>
  entry(seq, 'run_attempt', { callId, attempt: number });
const RESULT: Content<'tool_result'> = {
  callId: 'c1',
  tool: 'purge',
  server: 'logs',
  args: { days: 30 },
  outcome: 'success',
  refusalReason: null,
  refusalDetail: null,
  text: 'purged',
  startedAt: SENT_AT,
  finishedAt: '2026-11-20T10:00:06.000Z',
};

/** What the table compares: `<callId> <answer seq>/<position> <state> <args> sent=<…> attempts=<n>`. */
function lines(entries: readonly HistoryEntry[]): string[] {
  return foldCalls(entries).map(
    (call) =>
      `${call.callId} ${call.answerSeq}/${call.position} ${call.state} ${JSON.stringify(call.args)} ` +
      `sent=${call.sentAt ?? '-'} attempts=${call.attempts} result=${call.result?.outcome ?? '-'}`,
  );
}

describe('the state of a tool call is derived from the records its history holds', () => {
  it.each<[string, HistoryEntry[], string[]]>([
    ['an answer without calls has none', [answer(1)], []],
    [
      'a call with no record is requested, in answer and position order',
      [answer(2, 'c1', 'c2')],
      [
        'c1 2/0 requested {"days":30} sent=- attempts=0 result=-',
        'c2 2/1 requested {"days":30} sent=- attempts=0 result=-',
      ],
    ],
    [
      'a confirmation request without the intent awaits the employee',
      [answer(2, 'c1'), confirmation(3, 'c1')],
      ['c1 2/0 awaiting_confirmation {"days":30} sent=- attempts=0 result=-'],
    ],
    [
      'a decision alone sends nothing: the call still awaits',
      [answer(2, 'c1'), confirmation(3, 'c1'), decision(4, 'c1', { days: 7 })],
      ['c1 2/0 awaiting_confirmation {"days":30} sent=- attempts=0 result=-'],
    ],
    [
      'the intent without a result is sending, with the time it went out',
      [
        answer(2, 'c1'),
        confirmation(3, 'c1'),
        decision(4, 'c1'),
        sent(5, 'c1'),
      ],
      [`c1 2/0 sending {"days":30} sent=${SENT_AT} attempts=0 result=-`],
    ],
    [
      'the intent of an edited call carries the arguments that went out',
      [
        answer(2, 'c1'),
        confirmation(3, 'c1'),
        decision(4, 'c1', { days: 7 }),
        sent(5, 'c1', { days: 7 }),
      ],
      [`c1 2/0 sending {"days":7} sent=${SENT_AT} attempts=0 result=-`],
    ],
    [
      'a result closes the call whatever came before, and the other call of the answer stays open',
      [
        answer(2, 'c1', 'c2'),
        confirmation(3, 'c1'),
        sent(4, 'c1'),
        entry(5, 'tool_result', RESULT),
      ],
      [
        `c1 2/0 done {"days":30} sent=${SENT_AT} attempts=0 result=success`,
        'c2 2/1 requested {"days":30} sent=- attempts=0 result=-',
      ],
    ],
    [
      'run attempts are counted and do not make the call sending',
      [answer(2, 'c1'), attempt(3, 'c1', 1), attempt(4, 'c1', 2)],
      ['c1 2/0 requested {"days":30} sent=- attempts=2 result=-'],
    ],
    [
      'a record whose answer is not among the entries is skipped',
      [entry(1, 'tool_result', RESULT), sent(2, 'c9'), answer(3, 'c2')],
      ['c2 3/0 requested {"days":30} sent=- attempts=0 result=-'],
    ],
  ])('%s', (_, entries, expected) => {
    expect(lines(entries)).toEqual(expected);
  });
});
