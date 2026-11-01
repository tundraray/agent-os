import type { Investigation } from '@agent-os/contracts';
import { findShell, resolveTokenBudget, type ShellRequest } from './start-rules.js';

// UC-E12, DC-19 (the rule), KD-9: a retried start takes the shell a failed start left — an investigation of the same
// thread and owner, with the same `query` and budget, without an engine row and without tasks — and nothing else.
// Defect caught: an investigation that already has its engine row (or differs in any field) is taken as a shell, so
// two launches share one investigation.
// Budget rows (beyond the skeleton): a token budget outside `investigationTokens` is refused before anything is
// written; without one the configuration's default is taken. Defect caught: a start with a budget out of range
// writes an investigation.

const SHELL_ID = '00000000-0000-4000-8000-000000000001';

const request: ShellRequest = {
  resourceId: 'user-a',
  threadId: 'thread-a',
  query: 'Why did checkout fail at 10:05?',
  maxTasks: 300,
  maxToolCalls: 3_000,
};

const shell: Investigation = {
  investigationId: SHELL_ID,
  resourceId: 'user-a',
  threadId: 'thread-a',
  query: 'Why did checkout fail at 10:05?',
  budget: { maxTasks: 300, maxToolCalls: 3_000 },
  status: 'active',
  createdAt: '2026-11-01T10:00:00.000Z',
  tasks: [],
};

const someTask = {
  taskId: '00000000-0000-4000-8000-0000000000aa',
  workflowType: 'research.controller',
  workflowVersion: 1,
  status: 'queued',
  dedupKey: 'v1:abc',
  outputRefs: [],
  outcome: null,
  coverage: null,
  failureReason: null,
  attempt: 0,
  toolCallsUsed: 0,
  retriesUsed: 0,
  subscribers: ['research.engine'],
} as const satisfies NonNullable<Investigation['tasks']>[number];

describe('findShell: a retried start takes only an untouched shell of the same launch request', () => {
  it.each<[string, Investigation, readonly string[], string | undefined]>([
    ['the matching shell without an engine row is taken', shell, [], SHELL_ID],
    ['an investigation of another thread is left alone', { ...shell, threadId: 'thread-b' }, [], undefined],
    ['an investigation of another owner is left alone', { ...shell, resourceId: 'user-b' }, [], undefined],
    ['an investigation with another query is left alone', { ...shell, query: 'Why did login fail?' }, [], undefined],
    [
      'an investigation with another maxTasks is left alone',
      { ...shell, budget: { maxTasks: 299, maxToolCalls: 3_000 } },
      [],
      undefined,
    ],
    [
      'an investigation with another maxToolCalls is left alone',
      { ...shell, budget: { maxTasks: 300, maxToolCalls: 2_999 } },
      [],
      undefined,
    ],
    ['an investigation that already has its engine row is left alone', shell, [SHELL_ID], undefined],
    ['an investigation with a task is left alone', { ...shell, tasks: [someTask] }, [], undefined],
    ['a cancelled investigation is left alone', { ...shell, status: 'cancelled' }, [], undefined],
  ])('%s', (_, candidate, withEngineRow, expected) => {
    expect(findShell([candidate], request, new Set(withEngineRow))?.investigationId).toBe(expected);
  });
});

describe('resolveTokenBudget: the token budget of a start stays inside investigationTokens', () => {
  const limits = { default: 3_000_000, max: 10_000_000 };

  it.each<[string, number | undefined, ReturnType<typeof resolveTokenBudget>]>([
    ['no budget takes the configured default', undefined, { ok: true, tokenBudget: 3_000_000 }],
    ['the upper bound itself is accepted', 10_000_000, { ok: true, tokenBudget: 10_000_000 }],
    ['the lower bound itself is accepted', 1, { ok: true, tokenBudget: 1 }],
    ['above the upper bound is refused', 10_000_001, { ok: false, code: 'budget_out_of_range' }],
    ['below the lower bound is refused', 0, { ok: false, code: 'budget_out_of_range' }],
    ['a fractional budget is refused', 1.5, { ok: false, code: 'budget_out_of_range' }],
  ])('%s', (_, requested, expected) => {
    expect(resolveTokenBudget(requested, limits)).toEqual(expected);
  });
});
