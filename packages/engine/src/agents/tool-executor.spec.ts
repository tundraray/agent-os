import type { ProposeResult, TaskSpec } from '@agent-os/contracts';
import type { RuntimeTx } from '@agent-os/runtime';
import { z } from 'zod';
import { type AgentProcessConfig, AgentProcessConfigSchema } from '../config/agent-config.schema.js';
import { AGENT_RUN_WORKFLOW } from './agent-task-spec.js';
import type { ToolAccessRequest } from './tool-access-policy.js';
import type { CallContext, CallStep, ToolCallRow, ToolCallState, TransitionResult } from './tool-calls.repository.js';
import { createToolExecutor, type TurnExecution } from './tool-executor.js';
import { BASE_TOOLS, createToolRegistry } from './tool-registry.js';
import { TEXT_FORM } from './result-forms.js';
import type { AgentRunContext, ImmediateTool } from './tools/tool-context.js';

// AC-01.2 (the executor), AC-06.1, AC-10.1, DC-8 (the refusal), DC-12, DC-17, UC-11, UC-E1, invariants 5, 8, 10: a call
// that breaks the turn's limit, the definition, the schema, the rights, the tree's limits or the share is refused with
// the design's code and runs nothing — no tool, no source, no `propose`; `finish` next to other calls is refused and the
// others run; a refused admission of the child task ends the call `task_limit`, which frees its share.
// Defects caught: a tool outside the definition run; a source reached after `access_denied`; a child task proposed past
// a limit or the share; a `task_limit` call left `starting`, so its share stays taken; a child given a source its parent
// does not have.
// Boundary doubles: the call store (the guarded write, `TransitionResult` as `toolCallsRepository.transition` gives it),
// the tree reads, `propose`, the rights port and the immediate tools — the decision of the executor is what is checked,
// not their work (the repository and Postgres side is the repo e2e spec's).

const limits = {
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
  processId: 'agent-probe',
  version: 1,
  goal: 'Probe the executor',
  sources: [
    { sourceId: 'alpha', toolName: 'search' },
    { sourceId: 'beta', toolName: 'search' },
    { sourceId: 'gamma', toolName: 'search' },
  ],
  agents: {
    lead: {
      model: 'anthropic/claude-haiku-5-5',
      effort: 'low',
      prompt: 'Lead {{query}}.',
      tools: ['memory_read', 'memory_write', 'call_agent', 'probe_source'],
      calls: ['helper'],
      result: 'text',
      limits: { ...limits, runTokens: 300_000 },
    },
    helper: {
      model: 'anthropic/claude-haiku-5-5',
      effort: 'low',
      prompt: 'Help {{query}}.',
      tools: [],
      sources: ['beta', 'gamma'],
      result: 'text',
      limits,
    },
  },
  rootAgent: 'lead',
  agentLimits: { maxDepth: 2 },
  limits: { investigationTokens: { default: 300_000, max: 600_000 }, maxTasks: 5, maxToolCalls: 5 },
  answer: { sections: ['summary'] },
});

/** A tool that reaches a source: the rights port is asked for it by its source. */
const PROBE_SOURCE_ENTRY = {
  name: 'probe_source',
  description: 'Reads one source.',
  argsSchema: z.strictObject({ q: z.string() }),
  effect: 'read' as const,
  resultMaxBytes: 1_024,
};
const REGISTRY = createToolRegistry([...BASE_TOOLS, PROBE_SOURCE_ENTRY]);
const NOW = new Date('2026-11-08T12:00:00.000Z');
const RUN_TASK_ID = '00000000-0000-4000-8000-000000000001';

function run(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    runTaskId: RUN_TASK_ID,
    investigationId: '00000000-0000-4000-8000-0000000000aa',
    resourceId: 'owner-1',
    threadId: 'thread-1',
    agentName: 'lead',
    definition: CONFIG.agents.lead!,
    config: CONFIG,
    resultSchema: TEXT_FORM.resultSchema,
    depth: 0,
    shareTokens: 300_000,
    sources: ['alpha', 'beta'],
    notAfter: new Date(NOW.getTime() + 3_000_000),
    ...overrides,
  };
}

const call = (callIndex: number, toolName: string, args: unknown): ToolCallRow => ({
  id: `call-${callIndex}`,
  investigationId: '00000000-0000-4000-8000-0000000000aa',
  runTaskId: RUN_TASK_ID,
  turn: 0,
  callIndex,
  toolName,
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

/** The call store double runs every step itself; the attempt's guard is never reached through the context. */
const UNUSED_CONTEXT = { investigationId: 'unused', taskId: RUN_TASK_ID } as unknown as CallContext;

interface Harness {
  /** Every step written, by call id, in order. */
  readonly steps: Map<string, CallStep[]>;
  readonly states: Map<string, ToolCallState>;
  readonly proposed: TaskSpec[];
  readonly accessRequests: ToolAccessRequest[];
  /** Calls of each immediate tool, by name. */
  readonly ran: string[];
  execute(calls: readonly ToolCallRow[], runOverrides?: Partial<AgentRunContext>): Promise<TurnExecution>;
}

function harness(options: {
  readonly occupiedTokens?: number;
  readonly childrenStarted?: number;
  readonly propose?: ProposeResult;
  readonly deny?: boolean;
} = {}): Harness {
  const steps = new Map<string, CallStep[]>();
  const states = new Map<string, ToolCallState>();
  const proposed: TaskSpec[] = [];
  const accessRequests: ToolAccessRequest[] = [];
  const ran: string[] = [];
  const rows = new Map<string, ToolCallRow>();
  const spyTool = (name: string): ImmediateTool => ({
    name,
    sourceOf: name === 'probe_source' ? () => 'alpha' : undefined,
    async run() {
      ran.push(name);
      return { to: 'done', outcome: 'success', result: { ok: true } };
    },
  });
  const executor = createToolExecutor({
    registry: REGISTRY,
    tools: new Map(['memory_read', 'memory_write', 'investigation_read', 'probe_source'].map((name) => [name, spyTool(name)])),
    accessPolicy: {
      decide(request) {
        accessRequests.push(request);
        return options.deny === true ? 'access_denied' : 'allowed';
      },
    },
    calls: {
      async transition(_ctx, request, decide): Promise<TransitionResult> {
        const row = rows.get(request.callId)!;
        if (!request.from.includes(row.state as ToolCallState)) return { outcome: 'not_in_state', call: row };
        const step = await decide({} as RuntimeTx, row);
        steps.set(row.id, [...(steps.get(row.id) ?? []), step]);
        states.set(row.id, step.to);
        const moved: ToolCallRow = {
          ...row,
          state: step.to,
          reason: 'reason' in step && step.reason !== undefined ? step.reason : row.reason,
          childTaskId: step.to === 'waiting' ? step.childTaskId : row.childTaskId,
          shareTokens: step.to === 'starting' ? step.shareTokens : row.shareTokens,
          taskSpec: step.to === 'starting' ? step.taskSpec : row.taskSpec,
        };
        rows.set(row.id, moved);
        return { outcome: 'written', call: moved };
      },
    },
    tree: {
      occupiedTokens: async () => options.occupiedTokens ?? 0,
      childrenStarted: async () => options.childrenStarted ?? 0,
    },
    scheduler: {
      async propose(spec) {
        proposed.push(spec);
        return options.propose ?? { outcome: 'created', taskId: '00000000-0000-4000-8000-0000000000c1', status: 'queued' };
      },
    },
    investigations: { listForThread: async () => [] },
    clock: { now: () => NOW },
    timings: { deadlineMarginMs: 90_000, leaseMs: 30_000 },
  });
  return {
    steps,
    states,
    proposed,
    accessRequests,
    ran,
    execute(calls, runOverrides) {
      for (const row of calls) rows.set(row.id, row);
      return executor.executeTurn(UNUSED_CONTEXT, run(runOverrides), calls);
    },
  };
}

const HELPER_CALL = { agent: 'helper', assignment: 'look into it' };
const ADMISSION_REFUSED: ProposeResult = { outcome: 'rejected', reason: 'budget_exhausted', details: { limit: 'tasks' } };

describe('вызов отклоняется кодом и ничего не исполняет', () => {
  it.each<[
    string,
    Parameters<typeof harness>[0],
    readonly ToolCallRow[],
    Partial<AgentRunContext>,
    { readonly call: string; readonly code: string; readonly ran: readonly string[]; readonly proposed: number },
  ]>([
    ['a tool the definition does not have', {}, [call(0, 'investigation_read', { view: 'plan' })], {}, { call: 'call-0', code: 'tool_not_in_definition', ran: [], proposed: 0 }],
    ['arguments off the schema', {}, [call(0, 'memory_read', { kind: 'gossip' })], {}, { call: 'call-0', code: 'invalid_arguments', ran: [], proposed: 0 }],
    [
      'a call past maxCallsPerTurn; the calls before it run',
      {},
      [call(0, 'memory_read', {}), call(1, 'memory_read', {}), call(2, 'memory_read', {}), call(3, 'memory_read', {})],
      {},
      { call: 'call-3', code: 'calls_per_turn_limit', ran: ['memory_read', 'memory_read', 'memory_read'], proposed: 0 },
    ],
    [
      'finish next to another call; the other call runs',
      {},
      [call(0, 'memory_read', {}), call(1, 'finish', { summary: 'done', refs: [] })],
      {},
      { call: 'call-1', code: 'finish_not_alone', ran: ['memory_read'], proposed: 0 },
    ],
    ['a call the rights port refuses: neither tool nor source is called', { deny: true }, [call(0, 'probe_source', { q: 'x' })], {}, { call: 'call-0', code: 'access_denied', ran: [], proposed: 0 }],
    ['call_agent of an agent outside calls', {}, [call(0, 'call_agent', { agent: 'lead', assignment: 'again' })], {}, { call: 'call-0', code: 'agent_not_callable', ran: [], proposed: 0 }],
    ['call_agent past maxDepth', {}, [call(0, 'call_agent', HELPER_CALL)], { depth: 2 }, { call: 'call-0', code: 'depth_limit', ran: [], proposed: 0 }],
    ['call_agent past maxChildren', { childrenStarted: 2 }, [call(0, 'call_agent', HELPER_CALL)], {}, { call: 'call-0', code: 'children_limit', ran: [], proposed: 0 }],
    [
      'call_agent with a rest one token short of a turn of the child',
      { occupiedTokens: 300_000 - 41_999 },
      [call(0, 'call_agent', HELPER_CALL)],
      {},
      { call: 'call-0', code: 'budget_exhausted', ran: [], proposed: 0 },
    ],
    [
      'call_agent whose task the runtime refuses to admit: task_limit after starting',
      { propose: ADMISSION_REFUSED },
      [call(0, 'call_agent', HELPER_CALL)],
      {},
      { call: 'call-0', code: 'task_limit', ran: [], proposed: 1 },
    ],
  ])('%s', async (_case, options, calls, runOverrides, expected) => {
    const h = harness(options);

    const executed = await h.execute(calls, runOverrides);

    expect(executed).toEqual({ outcome: 'executed', finish: null, waitFor: [] });
    const steps = h.steps.get(expected.call) ?? [];
    expect(steps.at(-1)).toMatchObject({ to: 'rejected', reason: expected.code });
    expect(h.states.get(expected.call)).toBe('rejected');
    expect(h.ran).toEqual(expected.ran);
    expect(h.proposed).toHaveLength(expected.proposed);
    if (expected.code === 'access_denied') {
      expect(steps.at(-1)).toMatchObject({ outcome: 'access_denied' });
      expect(h.accessRequests).toEqual([{ resourceId: 'owner-1', toolName: 'probe_source', sourceId: 'alpha' }]);
    }
    if (expected.code === 'task_limit') {
      // The share was recorded in `starting` and is released by the refusal: a refused call no longer counts (KD-4).
      expect(steps.map((step) => step.to)).toEqual(['starting', 'rejected']);
    }
  });

  it('источники дочернего — пересечение: the child task gets the share, the budget of the design and the shared sources only', async () => {
    const h = harness({ occupiedTokens: 250_000 });

    const executed = await h.execute([call(0, 'call_agent', HELPER_CALL)]);

    expect(executed).toEqual({ outcome: 'executed', finish: null, waitFor: ['00000000-0000-4000-8000-0000000000c1'] });
    expect(h.steps.get('call-0')?.map((step) => step.to)).toEqual(['starting', 'waiting']);
    expect(h.proposed).toEqual([
      expect.objectContaining({
        workflowType: AGENT_RUN_WORKFLOW,
        workflowVersion: 1,
        budget: { maxToolCalls: 1, maxRetries: 0, deadlineMs: 600_000, maxTokens: 50_000 },
        input: {
          agentName: 'helper',
          assignment: 'look into it',
          parent: { taskId: RUN_TASK_ID, callIndex: 0 },
          depth: 1,
          sources: ['beta'],
          notAfter: new Date(NOW.getTime() + 600_000 - 90_000).toISOString(),
        },
      }),
    ]);
  });
});
