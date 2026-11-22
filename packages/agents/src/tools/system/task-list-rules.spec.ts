import type { SessionTask } from '../../store/session-tasks.repository';
import {
  decideTaskChange,
  type TaskChange,
  type TaskChangeCall,
  type TaskListState,
  type TaskRefusal,
  type TaskUpdateArgs,
} from './task-list-rules';

// design-task-list.md UC-1: AC-12.2, AC-14.1 – AC-14.3, DC-1, DC-2, KD-1, KD-3, Contract «Инструменты». A new task
// takes the number after the last one given and never reuses one; a blocked task neither starts nor completes; an
// edge to itself, a cycle and a number not in the list are refused; deleting takes the task out of the blockers;
// one field given is one field changed; the 51st task is refused. A refusal names the field and the rule.

function task(number: number, status: SessionTask['status'], extra: Partial<SessionTask> = {}): SessionTask {
  return {
    number,
    subject: `Задача ${number}`,
    description: `Описание ${number}`,
    activeForm: null,
    status,
    owner: null,
    blockedBy: [],
    ...extra,
  };
}

/** Task 1 completed, 2 in progress, 3 pending and blocked by 2; task 4 was deleted, so the counter is at 4. */
const LIST: TaskListState = {
  tasks: [task(1, 'completed'), task(2, 'in_progress'), task(3, 'pending', { blockedBy: [2] })],
  lastNumber: 4,
};

function refusal(field: string, rule: string, text: string): TaskRefusal {
  return { kind: 'refused', field, rule, text };
}

function update(args: TaskUpdateArgs): TaskChangeCall {
  return { tool: 'update', args };
}

describe('task list rules', () => {
  it.each<[string, TaskListState, TaskChangeCall, TaskChange | TaskRefusal]>([
    [
      'the first task is number 1, pending',
      { tasks: [], lastNumber: 0 },
      { tool: 'create', args: { subject: 'Собрать логи', description: 'За неделю', activeForm: 'Собираю логи' } },
      {
        kind: 'change',
        written: [task(1, 'pending', { subject: 'Собрать логи', description: 'За неделю', activeForm: 'Собираю логи' })],
        deleted: [],
        lastNumber: 1,
        text: 'Task 1 created: Собрать логи',
        event: { action: 'created', number: 1, statusBefore: null, statusAfter: 'pending', fields: [] },
      },
    ],
    [
      "a deleted task's number is not given again (DC-1)",
      LIST,
      { tool: 'create', args: { subject: 'Задача 5', description: 'Описание 5' } },
      {
        kind: 'change',
        written: [task(5, 'pending')],
        deleted: [],
        lastNumber: 5,
        text: 'Task 5 created: Задача 5',
        event: { action: 'created', number: 5, statusBefore: null, statusAfter: 'pending', fields: [] },
      },
    ],
    [
      'the 51st task is refused',
      { tasks: Array.from({ length: 50 }, (_, index) => task(index + 1, 'pending')), lastNumber: 50 },
      { tool: 'create', args: { subject: 's', description: 'd' } },
      refusal(
        'task_create',
        'list_full',
        'The list already holds 50 tasks, the most it may hold: delete finished tasks first.',
      ),
    ],
    ['an unknown task', LIST, update({ taskId: 7, status: 'completed' }), refusal('taskId', 'unknown_task', 'There is no task 7.')],
    [
      'nothing to change',
      LIST,
      update({ taskId: 2 }),
      refusal('taskId', 'nothing_to_change', 'Nothing to change: give task 2 a status or a field.'),
    ],
    [
      'one field given is one field changed',
      LIST,
      update({ taskId: 2, owner: 'gather' }),
      {
        kind: 'change',
        written: [task(2, 'in_progress', { owner: 'gather' })],
        deleted: [],
        lastNumber: 4,
        text: 'Task 2 updated: owner',
        event: { action: 'updated', number: 2, statusBefore: 'in_progress', statusAfter: 'in_progress', fields: ['owner'] },
      },
    ],
    [
      'a task whose blockers are completed starts',
      { tasks: [task(1, 'completed'), task(2, 'pending', { blockedBy: [1] })], lastNumber: 2 },
      update({ taskId: 2, status: 'in_progress', activeForm: 'Делаю 2' }),
      {
        kind: 'change',
        written: [task(2, 'in_progress', { blockedBy: [1], activeForm: 'Делаю 2' })],
        deleted: [],
        lastNumber: 2,
        text: 'Task 2 updated: status pending → in_progress; activeForm',
        event: { action: 'updated', number: 2, statusBefore: 'pending', statusAfter: 'in_progress', fields: ['activeForm'] },
      },
    ],
    [
      'a blocked task does not start (AC-14.1)',
      LIST,
      update({ taskId: 3, status: 'in_progress' }),
      refusal('status', 'blocked', 'Task 3 cannot become in_progress: it is blocked by 2, not completed yet.'),
    ],
    [
      'a blocked task does not complete',
      LIST,
      update({ taskId: 3, status: 'completed' }),
      refusal('status', 'blocked', 'Task 3 cannot become completed: it is blocked by 2, not completed yet.'),
    ],
    [
      'a cycle through addBlockedBy',
      LIST,
      update({ taskId: 2, status: 'completed', addBlockedBy: [3] }),
      refusal(
        'addBlockedBy',
        'cycle',
        'addBlockedBy: task 3 already waits on task 2, so task 2 cannot wait on it; dependencies cannot form a cycle.',
      ),
    ],
    [
      'an edge to itself',
      LIST,
      update({ taskId: 2, addBlockedBy: [2] }),
      refusal('addBlockedBy', 'self_edge', 'addBlockedBy: a task cannot block itself.'),
    ],
    [
      'a cycle through addBlocks',
      LIST,
      update({ taskId: 3, addBlocks: [2] }),
      refusal(
        'addBlocks',
        'cycle',
        'addBlocks: task 3 already waits on task 2, so task 2 cannot wait on it; dependencies cannot form a cycle.',
      ),
    ],
    [
      'a number not in the list',
      LIST,
      update({ taskId: 3, addBlockedBy: [4] }),
      refusal('addBlockedBy', 'unknown_task', 'addBlockedBy: there is no task 4 in the list.'),
    ],
    [
      'addBlocks makes the other task wait, and a known edge is not added twice',
      LIST,
      update({ taskId: 1, addBlocks: [2, 3], addBlockedBy: [] }),
      {
        kind: 'change',
        written: [task(1, 'completed'), task(2, 'in_progress', { blockedBy: [1] }), task(3, 'pending', { blockedBy: [2, 1] })],
        deleted: [],
        lastNumber: 4,
        text: 'Task 1 updated: addBlockedBy; addBlocks',
        event: { action: 'updated', number: 1, statusBefore: 'completed', statusAfter: 'completed', fields: ['addBlockedBy', 'addBlocks'] },
      },
    ],
    [
      'deleting takes the task out of the blockers and ignores the other fields; the counter stays',
      LIST,
      update({ taskId: 2, status: 'deleted', subject: 'новая тема' }),
      {
        kind: 'change',
        written: [task(3, 'pending')],
        deleted: [2],
        lastNumber: 4,
        text: 'Task 2 deleted',
        event: { action: 'deleted', number: 2, statusBefore: 'in_progress', statusAfter: null, fields: [] },
      },
    ],
  ])('%s', (_, state, call, expected) => {
    expect(decideTaskChange(state, call)).toStrictEqual(expected);
  });
});
