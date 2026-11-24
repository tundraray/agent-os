import type { SessionTask } from '@agent-os/db';
import {
  type EndOfTurn,
  type EndOfTurnInput,
  endOfTurn,
  noticeContent,
} from './turn-rules';

// KD-2, «Конец хода», DC-3, DC-4 (final subagent, design-runtime.md KD-5), Invariant 4, Notes 6: an
// answer without tool calls waits, is refused with a notice, or completes with a report.
const CHILD: EndOfTurnInput = {
  unfinishedChildren: 0,
  pendingChildNotices: 0,
  finalSubagent: null,
  finalSubagentReport: null,
  openTasks: [],
  text: 'my own answer',
  cutOff: false,
  answerFields: [],
};

describe('the end of a turn waits, refuses or completes', () => {
  it.each<[string, EndOfTurnInput, EndOfTurn['kind'], string | null]>([
    [
      'a child with an unfinished child waits',
      { ...CHILD, unfinishedChildren: 1 },
      'wait',
      null,
    ],
    [
      'a child with an undelivered child notice waits',
      { ...CHILD, pendingChildNotices: 1 },
      'wait',
      null,
    ],
    [
      'the final subagent has no report yet: notice',
      { ...CHILD, finalSubagent: 'answer' },
      'notice',
      null,
    ],
    [
      "the final subagent's completed report becomes the session's report",
      {
        ...CHILD,
        finalSubagent: 'answer',
        finalSubagentReport: { status: 'completed', text: 'final report' },
      },
      'complete',
      'final report',
    ],
    [
      "the final subagent's failed report does not end the session",
      {
        ...CHILD,
        finalSubagent: 'answer',
        finalSubagentReport: { status: 'failed', text: null },
      },
      'notice',
      null,
    ],
    [
      "the final subagent's stopped report does not end the session",
      {
        ...CHILD,
        finalSubagent: 'answer',
        finalSubagentReport: { status: 'stopped', text: null },
      },
      'notice',
      null,
    ],
    [
      'otherwise the answer text is the report',
      CHILD,
      'complete',
      'my own answer',
    ],
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
    [
      'an agent with an unfinished child waits',
      { ...CUT, unfinishedChildren: 1 },
      { kind: 'wait' },
    ],
    [
      "a deep agent ends with its answer subagent's completed report",
      {
        ...CUT,
        finalSubagent: 'answer',
        finalSubagentReport: { status: 'completed', text: 'final report' },
      },
      { kind: 'complete', report: 'final report', document: null },
    ],
  ])('%s', (_, input, outcome) => {
    expect(endOfTurn(input)).toStrictEqual(outcome);
  });
});

// design-task-list.md AC-14.4, KD-4: an agent other than the main chat does not finish its turn while a task is
// pending or in_progress; the branch stands after the wait for children and before the final subagent rule. The
// caller passes only the open tasks (pending, in_progress) of a session with a task list.
describe('an agent with open tasks does not finish its turn', () => {
  const COLLECT: SessionTask = {
    number: 1,
    subject: 'Собрать логи',
    description: 'Логи оплат за неделю',
    activeForm: 'Собираю логи',
    status: 'in_progress',
    owner: null,
    blockedBy: [],
  };
  const CHECK: SessionTask = {
    number: 2,
    subject: 'Сверить с заказами',
    description: 'Сверить оплаты с заказами',
    activeForm: null,
    status: 'pending',
    owner: 'gather',
    blockedBy: [1],
  };
  /** The notice naming the open tasks, line by line, and their numbers. */
  const openNotice = (
    lines: readonly string[],
    numbers: readonly number[],
  ): EndOfTurn => ({
    kind: 'notice',
    text: [
      'You cannot finish yet: these tasks of your list are still open:',
      ...lines,
      'Do the work they name and mark each completed with task_update, or delete the ones no longer needed; then answer.',
    ].join('\n'),
    openTasks: numbers,
  });
  it.each<[string, EndOfTurnInput, EndOfTurn]>([
    [
      'a task in progress: notice naming it by its active form',
      { ...CHILD, openTasks: [COLLECT] },
      openNotice(['1. [in_progress] Собираю логи'], [1]),
    ],
    [
      'a pending task: notice naming it with its blockers and label',
      { ...CHILD, openTasks: [CHECK] },
      openNotice(
        ['2. [pending] Сверить с заказами; blocked by 1; owner gather'],
        [2],
      ),
    ],
    [
      'no open task: the answer is the report',
      CHILD,
      { kind: 'complete', report: 'my own answer', document: null },
    ],
    [
      'open tasks come before the final subagent rule, even after its completed report',
      {
        ...CHILD,
        openTasks: [COLLECT, CHECK],
        finalSubagent: 'answer',
        finalSubagentReport: { status: 'completed', text: 'final report' },
      },
      openNotice(
        [
          '1. [in_progress] Собираю логи',
          '2. [pending] Сверить с заказами; blocked by 1; owner gather',
        ],
        [1, 2],
      ),
    ],
    [
      'an unfinished child still comes first: wait',
      { ...CHILD, openTasks: [COLLECT], unfinishedChildren: 1 },
      { kind: 'wait' },
    ],
  ])('%s', (_, input, outcome) => {
    expect(endOfTurn(input)).toStrictEqual(outcome);
  });

  // uxrd.md MC-15: the history entry carries what the feed line names, and only when it is the notice's reason.
  it.each<
    [string, EndOfTurnInput, { openTasks?: number[]; missingReport?: string }]
  >([
    [
      'open tasks: the notice entry carries their numbers',
      { ...CHILD, openTasks: [COLLECT, CHECK] },
      { openTasks: [1, 2] },
    ],
    [
      'no completed report of the final subagent: the notice entry names it',
      {
        ...CHILD,
        finalSubagent: 'answer',
        finalSubagentReport: { status: 'failed', text: null },
      },
      { missingReport: 'answer' },
    ],
    [
      'a cut-off answer: the notice entry carries nothing more',
      { ...CHILD, cutOff: true },
      {},
    ],
  ])('%s', (_, input, fields) => {
    const outcome = endOfTurn(input);
    if (outcome.kind !== 'notice')
      throw new Error(`expected a notice, got ${outcome.kind}`);
    expect(noticeContent(outcome)).toStrictEqual({
      text: outcome.text,
      ...fields,
    });
  });
});

// deep-agents/design-task.md UC-6, AC-21.1 (KD-7): a subagent asked for answer fields finishes only with one JSON
// object holding a non-empty string in each and nothing more; the notice names what is missing and what is extra.
// AC-21.2 — a subagent that never fixes it fails on its maxTurns — is the turn limit of the model step.
describe('a subagent asked for answer fields', () => {
  const FIELDS = { ...CHILD, answerFields: ['вывод', 'источники'] };
  const RULE =
    'Your answer must be one JSON object and nothing else, with a non-empty string in each of these fields: вывод, источники.';
  it.each<[string, EndOfTurnInput, EndOfTurn]>([
    [
      'finishes with both fields',
      { ...FIELDS, text: '{"вывод":"рост ошибок","источники":"логи оплат"}' },
      {
        kind: 'complete',
        report: '{"вывод":"рост ошибок","источники":"логи оплат"}',
        document: null,
      },
    ],
    [
      'gets a notice naming the missing field and the extra one',
      { ...FIELDS, text: '{"вывод":"рост ошибок","комментарий":"нет"}' },
      {
        kind: 'notice',
        text: `${RULE} Missing or empty: источники. Not asked for: комментарий.`,
      },
    ],
    [
      'gets a notice for an empty field',
      { ...FIELDS, text: '{"вывод":"рост ошибок","источники":" "}' },
      { kind: 'notice', text: `${RULE} Missing or empty: источники.` },
    ],
    [
      'gets a notice for free text',
      { ...FIELDS, text: 'рост ошибок' },
      { kind: 'notice', text: `${RULE} Your answer is not JSON.` },
    ],
  ])('%s', (_, input, outcome) => {
    expect(endOfTurn(input)).toStrictEqual(outcome);
  });
});
