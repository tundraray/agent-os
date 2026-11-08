import type { Investigation } from '@agent-os/contracts';
import { computeDedupKey } from '@agent-os/runtime';
import { type AgentTaskInput, runNotAfter } from '../agents/agent-task-spec.js';
import type { AgentProcessConfig } from '../config/agent-config.schema.js';
import { findShell, resolveTokenBudget, rootAgentOf, rootTaskSpec, type ShellRequest } from './start-rules.js';

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

// UC-13, DC-22: the root of an agents-form investigation is chosen by its mode — without sources the definition
// `modelKnowledgeRoot` when the key is set, otherwise `rootAgent`, in either mode.
// Defect caught: the wrong root in the mode without sources, or `modelKnowledgeRoot` used with sources.
describe('корень по режиму', () => {
  it.each([
    ['without sources, with the key: modelKnowledgeRoot', 'model_knowledge', 'helper', 'helper'],
    ['without sources, without the key: rootAgent', 'model_knowledge', undefined, 'lead'],
    ['with sources: rootAgent, the key aside', 'sources', 'helper', 'lead'],
  ] as const)('%s', (_case, sourceMode, modelKnowledgeRoot, expected) => {
    const config = { rootAgent: 'lead', ...(modelKnowledgeRoot === undefined ? {} : { modelKnowledgeRoot }) };

    expect(rootAgentOf(config, sourceMode)).toBe(expected);
  });
});

// DC-27, fix cycles 1 (D3) and 2 (M2): the root's task input bounds it by the recorded start plus the root's deadline,
// and the handler takes the root's effective `notAfter` from it less `AGENT_DEADLINE_MARGIN_MS`. The margin stays out of
// the task input, which `dedup_key` is computed from. Defects caught: a root whose task starts at once has no room for
// its forced end before its task deadline (the margin dropped); a repeated start after a change of the margin proposes
// another root task instead of being `subscribed` (the margin in the key).
describe('срок корня во входе задачи', () => {
  // Only the keys `rootTaskSpec` reads: the root, its deadline and the process sources.
  const config = {
    processId: 'agent-probe',
    rootAgent: 'lead',
    sources: [],
    agents: { lead: { limits: { deadlineMs: 600_000 } } },
  } as unknown as AgentProcessConfig;
  const LATER = new Date('2026-11-09T00:00:00.000Z');
  // The key of this root's task, its input without the margin.
  const ROOT_DEDUP_KEY = 'v1:6ad0822b05e86fd0813d06685ddea0bd4e93677c50cdaf8c49929a19519989a5';

  it.each([
    [90_000, '2026-11-08T10:08:30.000Z'],
    [120_000, '2026-11-08T10:08:00.000Z'],
  ])('margin %i: the same dedup key, the effective notAfter the recorded start plus the deadline less it', (margin, expected) => {
    const spec = rootTaskSpec({
      investigationId: '00000000-0000-4000-8000-000000000001',
      config,
      tokenBudget: 300_000,
      query: 'why do the builds fail',
      sourceMode: 'model_knowledge',
      createdAt: new Date('2026-11-08T10:00:00.000Z'),
    });
    const input = spec.input as AgentTaskInput;

    expect(input.notAfter).toBe('2026-11-08T10:10:00.000Z');
    expect(computeDedupKey(spec)).toBe(ROOT_DEDUP_KEY);
    const notAfter = runNotAfter({ taskDeadlineAt: LATER, deadlineMarginMs: margin, inputNotAfter: new Date(input.notAfter), parent: null });
    expect(notAfter.toISOString()).toBe(expected);
  });
});
