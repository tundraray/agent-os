import type { ProposeResult, TaskSpec, TaskStatus } from '@agent-os/contracts';
import { TaskBudgetSchema } from '@agent-os/contracts';
import { type Clock, computeDedupKey, type RuntimeTx, type UpstreamTask } from '@agent-os/runtime';
import { z } from 'zod';
import { taskToolCallEnding } from '../../agents/child-failure.js';
import type { ToolAccessRequest } from '../../agents/tool-access-policy.js';
import type { CallContext, CallStep, ToolCallRow, ToolCallState, TransitionResult } from '../../agents/tool-calls.repository.js';
import { createToolExecutor } from '../../agents/tool-executor.js';
import { BASE_TOOLS, createToolRegistry } from '../../agents/tool-registry.js';
import { TEXT_FORM } from '../../agents/result-forms.js';
import type { AgentRunContext } from '../../agents/tools/tool-context.js';
import { gatherKeyFields } from '../../capabilities/gather-key.js';
import { type AgentProcessConfig, AgentProcessConfigSchema } from '../../config/agent-config.schema.js';
import { createGatherTool, GATHER_ENTRY, type GatherPage } from './gather.js';

// DC-11, AC-17.2, UC-E4 (the rule), design-research-flow.md «Инструменты возможностей»: the `source.fetch` task of a
// `gather`, its key, the `repeat` mark, the refusals and the result by the task's outcome.
// Defects caught: a source called twice for one request (the key depends on key order); a repeat subscribed to a `failed`
// task; `repeat` lost or put on the task's creator; `gather` taking a `maxChildren` slot; a task proposed with 1 s or less
// left; a source reached after a refusal.
// Boundary doubles: the call store, `propose`, the thread's task list, the source registry and the rights port.

const LIMITS = {
  maxTurns: 4,
  maxCallsPerTurn: 3,
  maxChildren: 2,
  runTokens: 80_000,
  deadlineMs: 600_000,
  windowTokens: 40_000,
  marginTokens: 1_000,
  maxOutputTokens: 2_000,
};

const CONFIG: AgentProcessConfig = AgentProcessConfigSchema.parse({
  processId: 'gather-probe',
  version: 1,
  goal: 'Probe gather',
  sources: [
    { sourceId: 'logs', toolName: 'search' },
    { sourceId: 'traces', toolName: 'search' },
    { sourceId: 'closed', toolName: 'search' },
  ],
  agents: {
    worker: {
      model: 'anthropic/claude-haiku-5-5',
      effort: 'low',
      prompt: 'Work {{query}}.',
      tools: ['gather'],
      result: 'text',
      limits: LIMITS,
    },
  },
  rootAgent: 'worker',
  agentLimits: { maxDepth: 2 },
  limits: { investigationTokens: { default: 300_000, max: 600_000 }, maxTasks: 5, maxToolCalls: 50 },
  answer: { sections: ['summary'] },
});

const REGISTRY = createToolRegistry([...BASE_TOOLS, GATHER_ENTRY]);
const NOW = new Date('2026-11-09T12:00:00.000Z');
const RUN_TASK_ID = '00000000-0000-4000-8000-000000000001';
const INVESTIGATION_ID = '00000000-0000-4000-8000-0000000000aa';
const NEW_TASK = '00000000-0000-4000-8000-0000000000c1';
const LIVE_TASK = '00000000-0000-4000-8000-0000000000c2';
const OLD_TASK = '00000000-0000-4000-8000-0000000000c3';
const SNAPSHOT = 'snapshot-1';
const REQUEST = { sourceId: 'logs', toolName: 'search', args: { query: 'error', size: 5 }, completeness: 'all' as const };

const CREATED: ProposeResult = { outcome: 'created', taskId: NEW_TASK, status: 'queued' };
const SUBSCRIBED: ProposeResult = { outcome: 'subscribed', taskId: LIVE_TASK, status: 'running' };

const row = (args: unknown): ToolCallRow => ({
  id: 'call-0',
  investigationId: INVESTIGATION_ID,
  runTaskId: RUN_TASK_ID,
  turn: 1,
  callIndex: 0,
  toolName: 'gather',
  arguments: args,
  state: 'requested',
  outcome: null,
  reason: null,
  startedAt: null,
  finishedAt: null,
  auditId: null,
  childTaskId: null,
  shareTokens: null,
  spentTokens: null,
  taskSpec: null,
  createdAt: NOW,
});

const CONTEXT = { investigationId: INVESTIGATION_ID, taskId: RUN_TASK_ID, signal: new AbortController().signal } as unknown as CallContext;
const CLOCK: Clock = { now: () => NOW, random: () => 0, setTimer: () => () => undefined };

/** The dedup key of the request over the snapshot, as the runtime computes it for its task. */
const keyOf = (request: typeof REQUEST, snapshot: string): string => computeDedupKey(gatherKeyFields(request, snapshot));

interface Options {
  /** What each `propose` answers, in order; `crash` throws, as a worker dying between `starting` and `waiting`. */
  readonly proposals?: readonly (ProposeResult | 'crash')[];
  readonly tasks?: readonly { readonly taskId: string; readonly dedupKey: string; readonly status: TaskStatus }[];
  readonly snapshot?: string | Error;
  readonly deny?: boolean;
  readonly msLeft?: number;
  readonly sources?: readonly string[];
  readonly allowlisted?: boolean;
}

function harness(options: Options = {}) {
  const steps: CallStep[] = [];
  const proposed: TaskSpec[] = [];
  const accessRequests: ToolAccessRequest[] = [];
  const snapshotReads: string[] = [];
  const warnings: unknown[] = [];
  const proposals = [...(options.proposals ?? [CREATED])];
  let current: ToolCallRow = row(REQUEST);
  const tool = createGatherTool({
    sources: {
      resolveTool: () =>
        options.allowlisted === false
          ? null
          : ({ adapter: {}, tool: { name: 'search', argsSchema: z.strictObject({ query: z.string(), size: z.number() }) } } as never),
      async currentSnapshot(sourceId) {
        snapshotReads.push(sourceId);
        if (options.snapshot instanceof Error) throw options.snapshot;
        return options.snapshot ?? SNAPSHOT;
      },
    },
    clock: CLOCK,
    logger: { warn: (...entry: unknown[]) => warnings.push(entry) } as never,
  });
  const executor = createToolExecutor({
    registry: REGISTRY,
    tools: new Map(),
    taskTools: new Map([[tool.name, tool]]),
    accessPolicy: {
      decide(request) {
        accessRequests.push(request);
        return options.deny === true ? 'access_denied' : 'allowed';
      },
    },
    calls: {
      async transition(_ctx, request, decide): Promise<TransitionResult> {
        if (!request.from.includes(current.state as ToolCallState)) return { outcome: 'not_in_state', call: current };
        const step = await decide({} as RuntimeTx, current);
        steps.push(step);
        current = {
          ...current,
          state: step.to,
          reason: 'reason' in step && step.reason !== undefined ? step.reason : current.reason,
          outcome: 'outcome' in step && step.to !== 'done' && step.to !== 'rejected' ? (step.outcome ?? current.outcome) : current.outcome,
          childTaskId: step.to === 'waiting' ? step.childTaskId : current.childTaskId,
          shareTokens: step.to === 'starting' ? step.shareTokens : current.shareTokens,
          taskSpec: step.to === 'starting' ? step.taskSpec : current.taskSpec,
        };
        return { outcome: 'written', call: current };
      },
    },
    tree: { occupiedTokens: async () => 0, childrenStarted: async () => 0 },
    scheduler: {
      async propose(spec) {
        proposed.push(spec);
        const next = proposals.shift() ?? CREATED;
        if (next === 'crash') throw new Error('worker lost');
        return next;
      },
    },
    investigations: {
      listForThread: async () => [{ investigationId: INVESTIGATION_ID, tasks: options.tasks ?? [] }] as never,
    },
    clock: CLOCK,
    timings: { deadlineMarginMs: 90_000, leaseMs: 30_000 },
  });
  const run: AgentRunContext = {
    runTaskId: RUN_TASK_ID,
    investigationId: INVESTIGATION_ID,
    resourceId: 'owner-1',
    threadId: 'thread-1',
    agentName: 'worker',
    definition: CONFIG.agents.worker!,
    config: CONFIG,
    resultSchema: TEXT_FORM.resultSchema,
    depth: 1,
    shareTokens: 80_000,
    sources: options.sources ?? ['logs', 'traces'],
    notAfter: new Date(NOW.getTime() + (options.msLeft ?? 600_000)),
  };
  return {
    steps,
    proposed,
    accessRequests,
    snapshotReads,
    warnings,
    tool,
    current: () => current,
    start(args: unknown = REQUEST) {
      current = row(args);
      return executor.executeTurn(CONTEXT, run, [current]);
    },
    /** A new attempt over the call as the previous one left it. */
    retry: () => executor.executeTurn(CONTEXT, run, [current]),
  };
}

const crashing = async (h: ReturnType<typeof harness>) => {
  await expect(h.start()).rejects.toThrow('worker lost');
  expect(h.current().state).toBe('starting');
};

describe('gather: спецификация, повтор и результат по исходу', () => {
  it('the key does not depend on the order of the arguments, and depends on the arguments and on the snapshot', async () => {
    const first = harness();
    await first.start();
    const reordered = harness();
    await reordered.start({ ...REQUEST, args: { size: 5, query: 'error' } });
    const otherArgs = harness();
    await otherArgs.start({ ...REQUEST, args: { query: 'timeout', size: 5 } });
    const otherSnapshot = harness({ snapshot: 'snapshot-2' });
    await otherSnapshot.start();

    const key = computeDedupKey(first.proposed[0]!);
    expect(computeDedupKey(reordered.proposed[0]!)).toBe(key);
    expect(computeDedupKey(otherArgs.proposed[0]!)).not.toBe(key);
    expect(computeDedupKey(otherSnapshot.proposed[0]!)).not.toBe(key);
  });

  it('proposes the source.fetch task of the request: pinned snapshot, the source.fetch budget, the time left, no tokens', async () => {
    const h = harness({ msLeft: 120_000 });

    const executed = await h.start();

    expect(executed).toEqual({ outcome: 'executed', finish: null, waitFor: [NEW_TASK] });
    expect(h.proposed).toEqual([
      expect.objectContaining({
        investigationId: INVESTIGATION_ID,
        workflowType: 'source.fetch',
        workflowVersion: 1,
        input: { sourceId: 'logs', toolName: 'search', args: { query: 'error', size: 5 } },
        inputRefs: [{ kind: 'source', ref: 'logs', snapshot: SNAPSHOT }],
        dependsOn: [],
        budget: { maxToolCalls: 20, maxRetries: 3, deadlineMs: 120_000, maxTokens: 0 },
      }),
    ]);
    expect(h.proposed[0]!.expectedOutput.completeness).toBe('all');
  });

  it('takes no maxChildren slot: the call has no share, and the slots count the calls with one', async () => {
    const h = harness();

    await h.start();

    expect(h.steps.map((step) => step.to)).toEqual(['starting', 'waiting']);
    expect(h.steps[0]).toMatchObject({ shareTokens: null });
    expect(h.current().shareTokens).toBeNull();
  });

  describe('refusals: nothing is proposed', () => {
    it.each<[string, Options, unknown, { readonly outcome: string; readonly reason: string; readonly snapshotReads: number }]>([
      ['the rights port refuses', { deny: true }, REQUEST, { outcome: 'access_denied', reason: 'access_denied', snapshotReads: 0 }],
      ['the source is not among the run sources', { sources: ['traces'] }, REQUEST, { outcome: 'access_denied', reason: 'access_denied', snapshotReads: 0 }],
      ['the tool is not a tool of the source', {}, { ...REQUEST, toolName: 'delete' }, { outcome: 'access_denied', reason: 'access_denied', snapshotReads: 0 }],
      ['the allowlist does not hold the tool', { allowlisted: false }, REQUEST, { outcome: 'access_denied', reason: 'access_denied', snapshotReads: 0 }],
      ['the arguments break the tool schema', {}, { ...REQUEST, args: { query: 7 } }, { outcome: 'rejected', reason: 'invalid_arguments', snapshotReads: 0 }],
    ])('%s', async (_case, options, args, expected) => {
      const h = harness(options);

      const executed = await h.start(args);

      expect(executed).toEqual({ outcome: 'executed', finish: null, waitFor: [] });
      expect(h.proposed).toEqual([]);
      expect(h.snapshotReads).toHaveLength(expected.snapshotReads);
      expect(h.steps).toEqual([expect.objectContaining({ to: 'rejected', outcome: expected.outcome, reason: expected.reason })]);
      expect(h.current().state).toBe('rejected');
    });

    it('the refusal of the rights port is asked by the source of the call', async () => {
      const h = harness({ deny: true });

      await h.start();

      expect(h.accessRequests).toEqual([{ resourceId: 'owner-1', toolName: 'gather', sourceId: 'logs' }]);
    });
  });

  it('an unreadable snapshot ends the call source_unavailable with one warning and no task', async () => {
    const h = harness({ snapshot: new TypeError('adapter down') });

    await h.start();

    expect(h.proposed).toEqual([]);
    expect(h.steps).toEqual([expect.objectContaining({ to: 'done', outcome: 'tool_error', reason: 'source_unavailable', sourceId: 'logs' })]);
    expect(h.warnings).toHaveLength(1);
  });

  describe('repeat', () => {
    const live = (status: TaskStatus) => [{ taskId: LIVE_TASK, dedupKey: keyOf(REQUEST, SNAPSHOT), status }];

    it.each<TaskStatus>(['queued', 'running', 'waiting', 'succeeded'])('a %s task of the same key marks the call at requested -> starting', async (status) => {
      const h = harness({ tasks: live(status), proposals: [SUBSCRIBED] });

      await h.start();

      expect(h.steps[0]).toMatchObject({ to: 'starting', outcome: { repeat: true } });
      expect(h.steps[1]).toEqual({ to: 'waiting', childTaskId: LIVE_TASK });
      expect(h.current().outcome).toEqual({ repeat: true });
    });

    it('a retry after a crash before waiting keeps the mark of the search', async () => {
      const h = harness({ tasks: live('running'), proposals: ['crash'] });
      await crashing(h);

      const executed = await h.retry();

      expect(executed).toEqual({ outcome: 'executed', finish: null, waitFor: [LIVE_TASK] });
      expect(h.current()).toMatchObject({ state: 'waiting', childTaskId: LIVE_TASK, outcome: { repeat: true } });
    });

    it('an empty search and a first propose answered subscribed mark the call at starting -> waiting', async () => {
      const h = harness({ proposals: [SUBSCRIBED] });

      await h.start();

      expect(h.steps[0]).not.toHaveProperty('outcome');
      expect(h.steps[1]).toEqual({ to: 'waiting', childTaskId: LIVE_TASK, outcome: { repeat: true } });
    });

    it('a retry that gets subscribed cannot tell the task from its own: no mark', async () => {
      const h = harness({ proposals: ['crash', SUBSCRIBED] });
      await crashing(h);

      await h.retry();

      expect(h.current()).toMatchObject({ state: 'waiting', childTaskId: LIVE_TASK, outcome: null });
    });

    it('the creator of the task carries no mark', async () => {
      const h = harness();

      await h.start();

      expect(h.current()).toMatchObject({ state: 'waiting', childTaskId: NEW_TASK, outcome: null });
    });

    it.each<TaskStatus>(['failed', 'cancelled'])('a %s task of the same key gets a new task and no mark, on a retry too', async (status) => {
      const tasks = [{ taskId: OLD_TASK, dedupKey: keyOf(REQUEST, SNAPSHOT), status }];
      const h = harness({ tasks, proposals: ['crash', CREATED] });
      await crashing(h);

      await h.retry();

      expect(h.proposed).toHaveLength(2);
      expect(h.current()).toMatchObject({ state: 'waiting', childTaskId: NEW_TASK, outcome: null });
    });
  });

  describe('the rest of the time until notAfter', () => {
    it('exactly 1000 ms left: no new task, source_unavailable', async () => {
      const h = harness({ msLeft: 1_000 });

      await h.start();

      expect(h.proposed).toEqual([]);
      expect(h.steps).toEqual([expect.objectContaining({ to: 'done', reason: 'source_unavailable' })]);
    });

    it('1001 ms left: the task is proposed with that deadline', async () => {
      const h = harness({ msLeft: 1_001 });

      await h.start();

      expect(h.proposed[0]!.budget.deadlineMs).toBe(1_001);
      expect(h.current().state).toBe('waiting');
    });

    it('a live task with no time left is still waited for: repeat, and a deadline the schema takes', async () => {
      const h = harness({ msLeft: 200, tasks: [{ taskId: LIVE_TASK, dedupKey: keyOf(REQUEST, SNAPSHOT), status: 'running' }], proposals: [SUBSCRIBED] });

      await h.start();

      expect(TaskBudgetSchema.safeParse(h.proposed[0]!.budget).success).toBe(true);
      expect(h.proposed[0]!.budget.deadlineMs).toBe(1_000);
      expect(h.current()).toMatchObject({ state: 'waiting', childTaskId: LIVE_TASK, outcome: { repeat: true } });
    });
  });

  describe('the result by the outcome of the task', () => {
    const PAGE_1 = '00000000-0000-4000-8000-0000000000e1';
    const PAGE_2 = '00000000-0000-4000-8000-0000000000e2';
    const pageOf = (pageId: string, returned: number, truncated: boolean, cursor: string | null): GatherPage => ({
      pageId,
      provenance: { sourceId: 'logs', toolName: 'search', normalizedArgs: { query: 'error', size: 5, cursor }, snapshot: SNAPSHOT },
      coverage: { completeness: truncated ? 'partial' : 'complete', totalMatched: 12, totalRelation: 'eq', returned, truncated, continuation: truncated ? 'c2' : null },
    });
    const upstream = (status: TaskStatus, outputRefs: readonly string[]): UpstreamTask => ({
      taskId: NEW_TASK,
      kind: 'waits_for',
      status,
      outputRefs: [...outputRefs],
      failure: null,
    });
    const toolOver = (pages: readonly GatherPage[]) =>
      createGatherTool({
        sources: { resolveTool: () => null, currentSnapshot: async () => SNAPSHOT },
        clock: CLOCK,
        logger: { warn: () => undefined } as never,
        pages: { read: async () => pages },
      });
    const endingOf = (pages: readonly GatherPage[], child: UpstreamTask, repeat: boolean) =>
      toolOver(pages).ending({ tx: {} as RuntimeTx, call: row(REQUEST), child, repeat });

    it.each<[string, readonly GatherPage[], UpstreamTask, boolean, unknown]>([
      [
        'one page, complete',
        [pageOf(PAGE_1, 5, false, null)],
        upstream('succeeded', [PAGE_1]),
        false,
        { to: 'done', outcome: 'success', result: { page: PAGE_1, query: { query: 'error', size: 5 }, returned: 5, truncated: false } },
      ],
      [
        'a repeat carries the mark on the same page',
        [pageOf(PAGE_1, 5, false, null)],
        upstream('succeeded', [PAGE_1]),
        true,
        { to: 'done', outcome: 'success', result: { page: PAGE_1, query: { query: 'error', size: 5 }, returned: 5, truncated: false, repeat: true } },
      ],
      [
        'two pages in the task order, the last one truncated: the records of both, truncated',
        [pageOf(PAGE_2, 7, true, 'c1'), pageOf(PAGE_1, 5, false, null)],
        upstream('succeeded', [PAGE_1, PAGE_2]),
        false,
        { to: 'done', outcome: 'success', result: { page: PAGE_1, morePages: [PAGE_2], query: { query: 'error', size: 5 }, returned: 12, truncated: true } },
      ],
      [
        'no records',
        [pageOf(PAGE_1, 0, false, null)],
        upstream('succeeded', [PAGE_1]),
        false,
        { to: 'done', outcome: 'empty', result: { page: PAGE_1, query: { query: 'error', size: 5 }, returned: 0, truncated: false } },
      ],
      ['a failed task', [], upstream('failed', []), false, { to: 'done', outcome: 'tool_error', reason: 'source_unavailable', result: { reason: 'source_unavailable' } }],
      ['a cancelled task', [], upstream('cancelled', []), false, { to: 'done', outcome: 'tool_error', reason: 'source_unavailable', result: { reason: 'source_unavailable' } }],
    ])('%s', async (_case, pages, child, repeat, expected) => {
      await expect(endingOf(pages, child, repeat)).resolves.toEqual(expected);
    });

    it('the wake reads the mark from the row of the call and names the source for the audit', async () => {
      const tool = toolOver([pageOf(PAGE_1, 5, false, null)]);
      const child = upstream('succeeded', [PAGE_1]);

      const marked = await taskToolCallEnding({} as RuntimeTx, { call: { ...row(REQUEST), outcome: { repeat: true } }, child, tool });
      const unmarked = await taskToolCallEnding({} as RuntimeTx, { call: row(REQUEST), child, tool });

      expect(marked).toMatchObject({ sourceId: 'logs', result: { page: PAGE_1, repeat: true } });
      expect(unmarked).toMatchObject({ sourceId: 'logs', result: { page: PAGE_1 } });
      expect((unmarked as { result: object }).result).not.toHaveProperty('repeat');
    });

    it('a query that does not fit the result is cut, and the result stays within its limit', async () => {
      const huge = { query: 'x'.repeat(40_000) };
      const page: GatherPage = { ...pageOf(PAGE_1, 5, false, null), provenance: { normalizedArgs: { ...huge, cursor: null } } };

      const ended = await endingOf([page], upstream('succeeded', [PAGE_1]), false);

      expect(Buffer.byteLength(JSON.stringify((ended as { result: unknown }).result), 'utf8')).toBeLessThanOrEqual(GATHER_ENTRY.resultMaxBytes);
      expect(ended).toMatchObject({ to: 'done', outcome: 'success', result: { page: PAGE_1, returned: 5, queryCut: true } });
    });
  });
});
