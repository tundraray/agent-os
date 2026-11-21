import { type EndOfTurn, type EndOfTurnInput, endOfTurn } from './turn-rules';

// KD-2, «Конец хода», DC-3, DC-4 (final executor, design-runtime.md KD-5), Invariant 4, Notes 6: an
// answer without tool calls waits, is refused with a notice, or completes with a report.
const CHILD: EndOfTurnInput = {
  isRoot: false,
  unfinishedChildren: 0,
  pendingChildNotices: 0,
  finalExecutor: null,
  finalExecutorReport: null,
  text: 'my own answer',
  cutOff: false,
};

describe('the end of a turn waits, refuses or completes', () => {
  it.each<[string, EndOfTurnInput, EndOfTurn['kind'], string | null]>([
    ['the root session waits', { ...CHILD, isRoot: true }, 'wait', null],
    ['a child with an unfinished child waits', { ...CHILD, unfinishedChildren: 1 }, 'wait', null],
    ['a child with an undelivered child notice waits', { ...CHILD, pendingChildNotices: 1 }, 'wait', null],
    ['the final executor has no report yet: notice', { ...CHILD, finalExecutor: 'answer' }, 'notice', null],
    [
      "the final executor's completed report becomes the session's report",
      { ...CHILD, finalExecutor: 'answer', finalExecutorReport: { status: 'completed', text: 'final report' } },
      'complete',
      'final report',
    ],
    [
      "the final executor's failed report does not end the session",
      { ...CHILD, finalExecutor: 'answer', finalExecutorReport: { status: 'failed', text: null } },
      'notice',
      null,
    ],
    [
      "the final executor's stopped report does not end the session",
      { ...CHILD, finalExecutor: 'answer', finalExecutorReport: { status: 'stopped', text: null } },
      'notice',
      null,
    ],
    ['otherwise the answer text is the report', CHILD, 'complete', 'my own answer'],
  ])('%s', (_, input, kind, report) => {
    const outcome = endOfTurn(input);
    expect(outcome.kind).toBe(kind);
    if (outcome.kind === 'complete') expect(outcome.report).toBe(report);
    if (outcome.kind === 'notice') expect(outcome.text).toContain('"answer"');
  });
});

// agent-harness AC-01.1 (rule), KD-3, DC-1: a cut-off text is never a report; only an agent whose text would
// become its report gets the cut-off notice, the others behave as without the cut.
describe('a cut-off answer is not a report', () => {
  const CUT = { ...CHILD, cutOff: true };
  it.each<[string, EndOfTurnInput, EndOfTurn]>([
    [
      'an agent without an answer executor gets the cut-off notice',
      CUT,
      {
        kind: 'notice',
        text:
          'Your answer was cut off at the output length limit and is not accepted as your report. ' +
          'Write the report again, shorter, so that it fits in one answer.',
      },
    ],
    ['an agent with an unfinished child waits', { ...CUT, unfinishedChildren: 1 }, { kind: 'wait' }],
    ['the root session waits', { ...CUT, isRoot: true }, { kind: 'wait' }],
    [
      "a coordinator ends with its answer executor's completed report",
      { ...CUT, finalExecutor: 'answer', finalExecutorReport: { status: 'completed', text: 'final report' } },
      { kind: 'complete', report: 'final report' },
    ],
  ])('%s', (_, input, outcome) => {
    expect(endOfTurn(input)).toStrictEqual(outcome);
  });
});
