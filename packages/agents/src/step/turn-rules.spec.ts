import { type EndOfTurn, type EndOfTurnInput, endOfTurn } from './turn-rules.js';

// KD-2, «Конец хода», DC-3, DC-4 (final agent), Invariant 4, Notes 6: an answer without tool calls
// waits, is refused with a notice, or completes with a report.
const CHILD: EndOfTurnInput = {
  isRoot: false,
  unfinishedChildren: 0,
  pendingChildNotices: 0,
  finalAgent: null,
  finalAgentReport: null,
  text: 'my own answer',
};

describe('the end of a turn waits, refuses or completes', () => {
  it.each<[string, EndOfTurnInput, EndOfTurn['kind'], string | null]>([
    ['the root session waits', { ...CHILD, isRoot: true }, 'wait', null],
    ['a child with an unfinished child waits', { ...CHILD, unfinishedChildren: 1 }, 'wait', null],
    ['a child with an undelivered child notice waits', { ...CHILD, pendingChildNotices: 1 }, 'wait', null],
    ['the final agent has no report yet: notice', { ...CHILD, finalAgent: 'answer' }, 'notice', null],
    [
      "the final agent's completed report becomes the session's report",
      { ...CHILD, finalAgent: 'answer', finalAgentReport: { status: 'completed', text: 'final report' } },
      'complete',
      'final report',
    ],
    [
      "the final agent's failed report does not end the session",
      { ...CHILD, finalAgent: 'answer', finalAgentReport: { status: 'failed', text: null } },
      'notice',
      null,
    ],
    [
      "the final agent's stopped report does not end the session",
      { ...CHILD, finalAgent: 'answer', finalAgentReport: { status: 'stopped', text: null } },
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
