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
