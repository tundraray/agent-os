import type { SessionTask } from '../store/session-tasks.repository';
import {
  type DelegationCall,
  type DelegationDecision,
  type DelegationInput,
  decideDelegations,
  resultTable,
} from './delegation-rules';

const TEAM = [
  { name: 'gather', maxRuns: 20 },
  { name: 'answer', maxRuns: 1 },
  { name: 'general-purpose', maxRuns: 20 },
];

function task(number: number, status: SessionTask['status'], blockedBy: number[] = []): SessionTask {
  return {
    number,
    subject: `Задача ${number}`,
    description: `Описание ${number}`,
    activeForm: null,
    status,
    owner: null,
    blockedBy,
  };
}

/** The list: 1 pending, 2 completed, 3 pending and blocked by 1. */
const TASKS = { tasks: [task(1, 'pending'), task(2, 'completed'), task(3, 'pending', [1])], lastNumber: 3 };

const INPUT: DelegationInput = { calls: [], team: TEAM, singleRuns: new Map(), tasks: TASKS, childTooDeep: false };

function call(callId: string, args: DelegationCall['args']): DelegationCall {
  return { callId, args };
}

const items = (count: number) => Array.from({ length: count }, (_, index) => `пункт ${index + 1}`);

/** The decision as lines: `callId accepted <subagent> <form> <tasks> [task N]` or `callId <reason>: <text>`. */
function lines(decision: DelegationDecision): string[] {
  return [
    ...decision.accepted.map(
      (accepted) =>
        `${accepted.callId} accepted ${accepted.subagent} ${accepted.form.kind} ${
          accepted.form.kind === 'single' ? 1 : accepted.form.items.length
        }${accepted.listTask === null ? '' : ` task ${accepted.listTask}`}`,
    ),
    ...decision.refused.map((refused) => `${refused.callId} ${refused.reason}: ${refused.text}`),
  ];
}

// UC-7 (AC-18.4, AC-19.4, DC-2, DC-7): every wrong call of an answer is refused with its field and rule and starts
// nothing; UC-8 (AC-19.3): list items never spend maxRuns. A wrong rule here starts subagents the employee did not
// ask for, or a list that never runs.
describe('the task calls of one answer are refused with field and rule, or accepted', () => {
  it.each<[string, Partial<DelegationInput>, string[]]>([
    [
      'a subagent outside the record is refused with the names to call',
      { calls: [call('c1', { subagentType: 'review', description: 'Проверь' })] },
      ['c1 not_allowed: subagentType: there is no subagent "review"; call one of: gather, answer, general-purpose.'],
    ],
    [
      'a list of 101 items is refused with the limit and the count',
      { calls: [call('c1', { subagentType: 'gather', instruction: 'Собери', items: items(101) })] },
      ['c1 invalid_arguments: items: 101 items, more than the limit of 100 items in one call.'],
    ],
    [
      'an empty list is refused',
      { calls: [call('c1', { subagentType: 'gather', instruction: 'Собери', items: [] })] },
      ['c1 invalid_arguments: items: the list is empty.'],
    ],
    [
      'mixed forms are refused',
      { calls: [call('c1', { subagentType: 'gather', description: 'Собери', instruction: 'Собери', items: ['а'] })] },
      ['c1 invalid_arguments: description: give either description for one assignment, or instruction with items for a list, not both.'],
    ],
    [
      'no form is refused',
      { calls: [call('c1', { subagentType: 'gather' })] },
      ['c1 invalid_arguments: description: give description for one assignment, or instruction with items for a list.'],
    ],
    [
      'a task missing from the list is refused',
      { calls: [call('c1', { subagentType: 'gather', description: 'Собери', taskId: 9 })] },
      ['c1 invalid_arguments: taskId: There is no task 9.'],
    ],
    [
      'a completed task is refused',
      { calls: [call('c1', { subagentType: 'gather', description: 'Собери', taskId: 2 })] },
      ['c1 invalid_arguments: taskId: task 2 is completed already.'],
    ],
    [
      'a blocked task is refused with its blockers',
      { calls: [call('c1', { subagentType: 'gather', description: 'Собери', taskId: 3 })] },
      ['c1 invalid_arguments: taskId: Task 3 cannot become in_progress: it is blocked by 1, not completed yet.'],
    ],
    [
      'a task named by two calls of the answer is refused for both',
      {
        calls: [
          call('c1', { subagentType: 'gather', description: 'Собери', taskId: 1 }),
          call('c2', { subagentType: 'answer', description: 'Ответь', taskId: 1 }),
        ],
      },
      [
        'c1 invalid_arguments: taskId: task 1 is named by another task call of this answer.',
        'c2 invalid_arguments: taskId: task 1 is named by another task call of this answer.',
      ],
    ],
    [
      'the second single call over maxRuns in one answer is refused with the limit',
      {
        calls: [
          call('c1', { subagentType: 'answer', description: 'Ответь' }),
          call('c2', { subagentType: 'answer', description: 'Ответь ещё' }),
        ],
      },
      [
        'c1 accepted answer single 1',
        'c2 run_limit: subagentType: answer got 1 single assignments, the most it may get (1); give the work to another subagent.',
      ],
    ],
    [
      'two calls of the answer over 100 subagents together: the second is refused',
      {
        calls: [
          call('c1', { subagentType: 'gather', instruction: 'Собери', items: items(60) }),
          call('c2', { subagentType: 'gather', instruction: 'Проверь', items: items(60) }),
        ],
      },
      [
        'c1 accepted gather list 60',
        'c2 invalid_arguments: items: the task calls of one answer start at most 100 subagents together; this one would make 120.',
      ],
    ],
    [
      'a subagent past the depth limit is refused',
      { childTooDeep: true, calls: [call('c1', { subagentType: 'gather', description: 'Собери' })] },
      ['c1 depth_limit: A subagent here would be deeper than agents may go.'],
    ],
    [
      'a single call with a task of the list and general-purpose are accepted',
      {
        calls: [
          call('c1', { subagentType: 'gather', description: 'Собери', taskId: 1 }),
          call('c2', { subagentType: 'general-purpose', description: 'Сделай' }),
        ],
      },
      ['c1 accepted gather single 1 task 1', 'c2 accepted general-purpose single 1'],
    ],
    // UC-8, AC-19.3: 30 items to a subagent with maxRuns 20 start, and its single runs stay unspent.
    [
      'a list of 30 items to a subagent with maxRuns 20 is accepted',
      { calls: [call('c1', { subagentType: 'gather', instruction: 'Собери', items: items(30) })] },
      ['c1 accepted gather list 30'],
    ],
    [
      'after a list of 30 a single call to the same subagent is accepted',
      { singleRuns: new Map([['gather', 0]]), calls: [call('c1', { subagentType: 'gather', description: 'Собери' })] },
      ['c1 accepted gather single 1'],
    ],
    [
      'after 20 single runs a list to the same subagent is still accepted',
      {
        singleRuns: new Map([['gather', 20]]),
        calls: [call('c1', { subagentType: 'gather', instruction: 'Собери', items: items(3) })],
      },
      ['c1 accepted gather list 3'],
    ],
  ])('%s', (_, overrides, expected) => {
    expect(lines(decideDelegations({ ...INPUT, ...overrides }))).toEqual(expected);
  });
});

// KD-5, UC-2 (AC-19.2, DC-3 at the lowest level): a long table keeps every row and cuts the answers to an equal
// share within the limit, and its last line names the call whose full table read_tool_result reads.
describe('the table of a list delegation', () => {
  const rows = [
    { item: 'Москва', status: 'completed' as const, answer: 'а'.repeat(300), reason: null },
    { item: 'Казань', status: 'failed' as const, answer: null, reason: 'turn_limit' },
    { item: 'Тверь', status: 'cancelled' as const, answer: null, reason: null },
  ];

  it('fits whole under the limit', () => {
    const table = resultTable({ rows, answerFields: [], callId: 'call-1', maxChars: 20_000 });

    expect(table.cut).toBe(false);
    expect(table.text.split('\n')).toEqual([
      '| # | Item | Status | Answer or reason |',
      '| --- | --- | --- | --- |',
      `| 1 | Москва | completed | ${'а'.repeat(300)} |`,
      '| 2 | Казань | failed | turn_limit |',
      '| 3 | Тверь | cancelled |  |',
    ]);
  });

  it('is cut within the limit, every row kept, the full one named by the call', () => {
    const table = resultTable({ rows, answerFields: [], callId: 'call-1', maxChars: 300 });
    const text = table.text.split('\n');

    expect(table.cut).toBe(true);
    expect(table.text.length).toBeLessThanOrEqual(300);
    expect(text.slice(2, 5).map((row) => row.split(' | ').slice(0, 3).join(' | '))).toEqual([
      '| 1 | Москва | completed',
      '| 2 | Казань | failed',
      '| 3 | Тверь | cancelled',
    ]);
    expect(text.at(-1)).toBe(
      'The table is cut to 300 characters: each answer is shortened. Read the full table with read_tool_result (callId "call-1").',
    );
    expect(table.full).toContain('а'.repeat(300));
  });

  it('puts each answer field in its column and the reason of a failed row in its own', () => {
    const table = resultTable({
      rows: [
        { item: 'Москва', status: 'completed', answer: '{"вывод":"рост","источники":"логи"}', reason: null },
        { item: 'Казань', status: 'failed', answer: null, reason: 'turn_limit' },
      ],
      answerFields: ['вывод', 'источники'],
      callId: 'call-1',
      maxChars: 20_000,
    });

    expect(table.text.split('\n')).toEqual([
      '| # | Item | Status | вывод | источники | Reason |',
      '| --- | --- | --- | --- | --- | --- |',
      '| 1 | Москва | completed | рост | логи |  |',
      '| 2 | Казань | failed |  |  | turn_limit |',
    ]);
  });
});
