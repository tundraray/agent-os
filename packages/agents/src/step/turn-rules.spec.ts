import { type EndOfTurn, type EndOfTurnInput, endOfTurn, noticeContent } from './turn-rules';

// KD-2, «Конец хода», DC-3, DC-4 (final subagent, design-runtime.md KD-5), Invariant 4, Notes 6: an
// answer without tool calls waits, is refused with a notice, or completes with a report.
const CHILD: EndOfTurnInput = {
  isRoot: false,
  unfinishedChildren: 0,
  pendingChildNotices: 0,
  finalSubagent: null,
  finalSubagentReport: null,
  openPlanItems: [],
  text: 'my own answer',
  cutOff: false,
};

describe('the end of a turn waits, refuses or completes', () => {
  it.each<[string, EndOfTurnInput, EndOfTurn['kind'], string | null]>([
    ['the root session waits', { ...CHILD, isRoot: true }, 'wait', null],
    ['a child with an unfinished child waits', { ...CHILD, unfinishedChildren: 1 }, 'wait', null],
    ['a child with an undelivered child notice waits', { ...CHILD, pendingChildNotices: 1 }, 'wait', null],
    ['the final subagent has no report yet: notice', { ...CHILD, finalSubagent: 'answer' }, 'notice', null],
    [
      "the final subagent's completed report becomes the session's report",
      { ...CHILD, finalSubagent: 'answer', finalSubagentReport: { status: 'completed', text: 'final report' } },
      'complete',
      'final report',
    ],
    [
      "the final subagent's failed report does not end the session",
      { ...CHILD, finalSubagent: 'answer', finalSubagentReport: { status: 'failed', text: null } },
      'notice',
      null,
    ],
    [
      "the final subagent's stopped report does not end the session",
      { ...CHILD, finalSubagent: 'answer', finalSubagentReport: { status: 'stopped', text: null } },
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
      'an agent without an answer subagent gets the cut-off notice',
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
      "a deep agent ends with its answer subagent's completed report",
      { ...CUT, finalSubagent: 'answer', finalSubagentReport: { status: 'completed', text: 'final report' } },
      { kind: 'complete', report: 'final report' },
    ],
  ])('%s', (_, input, outcome) => {
    expect(endOfTurn(input)).toStrictEqual(outcome);
  });
});

// deep-agents UC-8, AC-09.1 (rule), AC-09.2, KD-5: a deep agent without children in work does not finish while a plan
// item is waiting or running; the branch stands after the wait for children and before the final subagent rule. The
// caller passes only the open items (waiting, running) of a deep agent's plan, and none for any other run.
describe('a deep agent with open plan items does not finish', () => {
  const COLLECT = { number: 1, text: 'собрать логи', status: 'running' } as const;
  const CHECK = { number: 2, text: 'сверить с заказами', status: 'waiting' } as const;
  /** The notice naming the open items, line by line, and their numbers. */
  const openNotice = (lines: readonly string[], numbers: readonly number[]): EndOfTurn => ({
    kind: 'notice',
    text: [
      'You cannot finish yet: these items of your plan are still open:',
      ...lines,
      'Do the work they name, or mark each done or cancelled with task_list, then answer.',
    ].join('\n'),
    openPlanItems: numbers,
  });
  it.each<[string, EndOfTurnInput, EndOfTurn]>([
    [
      'an item running: notice naming it',
      { ...CHILD, openPlanItems: [COLLECT] },
      openNotice(['1. [running] собрать логи'], [1]),
    ],
    [
      'an item waiting: notice naming it',
      { ...CHILD, openPlanItems: [CHECK] },
      openNotice(['2. [waiting] сверить с заказами'], [2]),
    ],
    [
      'every item done or cancelled (none open): the answer is the report',
      CHILD,
      { kind: 'complete', report: 'my own answer' },
    ],
    [
      'open items come before the final subagent rule, even after its completed report',
      {
        ...CHILD,
        openPlanItems: [COLLECT, CHECK],
        finalSubagent: 'answer',
        finalSubagentReport: { status: 'completed', text: 'final report' },
      },
      openNotice(['1. [running] собрать логи', '2. [waiting] сверить с заказами'], [1, 2]),
    ],
    [
      'an unfinished child still comes first: wait',
      { ...CHILD, openPlanItems: [COLLECT], unfinishedChildren: 1 },
      { kind: 'wait' },
    ],
    ['the root still waits', { ...CHILD, openPlanItems: [COLLECT], isRoot: true }, { kind: 'wait' }],
  ])('%s', (_, input, outcome) => {
    expect(endOfTurn(input)).toStrictEqual(outcome);
  });

  // uxrd.md MC-15, AC-05.1: the history entry carries what the feed line names, and only when it is the notice's reason.
  it.each<[string, EndOfTurnInput, { openPlanItems?: number[]; missingReport?: string }]>([
    ['open items: the notice entry carries their numbers', { ...CHILD, openPlanItems: [COLLECT, CHECK] }, { openPlanItems: [1, 2] }],
    [
      'no completed report of the final subagent: the notice entry names it',
      { ...CHILD, finalSubagent: 'answer', finalSubagentReport: { status: 'failed', text: null } },
      { missingReport: 'answer' },
    ],
    ['a cut-off answer: the notice entry carries nothing more', { ...CHILD, cutOff: true }, {}],
  ])('%s', (_, input, fields) => {
    const outcome = endOfTurn(input);
    if (outcome.kind !== 'notice') throw new Error(`expected a notice, got ${outcome.kind}`);
    expect(noticeContent(outcome)).toStrictEqual({ text: outcome.text, ...fields });
  });
});
