import {
  type AgentHistoryEntry,
  AgentsError,
  type AgentView,
  type RunOrigin,
  type RunSnapshot,
  type WorkflowSnapshot,
} from '@agent-os/agents';

import { WorkflowsError } from './errors.js';
import { createWorkflowRuns, type WorkflowRunsOptions } from './runs.js';

const OWNER = 'owner-a';
const RUN = 'coordinator-1';
const WORKFLOW_ID = '0b7c6a52-3f5e-4d6a-9a43-2f1e8c0d9b11';
const MODEL = 'anthropic/claude-haiku-5-5';

const workflowOrigin: RunOrigin = {
  recordId: WORKFLOW_ID,
  kind: 'workflow',
  version: 3,
  name: 'Demo flow',
  author: { id: '5f0e2d1c-8b7a-4c69-9e58-d4c3b2a1f0e9', name: 'Аня' },
  builtinKey: null,
  executor: null,
};

function executor(name: string, maxRuns: number) {
  return {
    name,
    role: `${name} role`,
    prompt: `Be ${name}.`,
    servers: [],
    model: MODEL,
    maxTurns: 5,
    maxRuns,
    tools: [],
    source: null,
  };
}

const workflowSnapshot: WorkflowSnapshot = {
  kind: 'workflow',
  name: 'Demo flow',
  origin: workflowOrigin,
  content: {
    coordinator: { rules: '', model: MODEL, maxTurns: 20 },
    executors: [executor('gather', 2), executor('check', 1), executor('answer', 1)],
    finalExecutor: 'answer',
  },
};

function agentView(agentId: string, parentId: string | null, executorName: string | null): AgentView {
  return {
    agentId,
    parentId,
    rootId: 'chat-1',
    depth: parentId === null ? 0 : parentId === RUN ? 2 : 1,
    name: executorName ?? 'Demo flow',
    origin: executorName === null ? workflowOrigin : { ...workflowOrigin, executor: executorName },
    firstRun: false,
    description: `${executorName ?? 'run'} step`,
    model: MODEL,
    status: 'completed',
    failureReason: null,
    forkedFrom: null,
    createdAt: new Date('2026-11-14T10:00:00Z'),
    finishedAt: new Date('2026-11-14T10:05:00Z'),
  };
}

const chat = { ...agentView('chat-1', null, null), origin: null, name: 'Чат' };
const coordinator = { ...agentView(RUN, 'chat-1', null), depth: 1 };
const gather = agentView('gather-1', RUN, 'gather');
const grandchild = { ...agentView('fork-1', 'gather-1', 'gather'), depth: 3 };
const answer = agentView('answer-1', RUN, 'answer');

const briefTask: AgentHistoryEntry = {
  seq: 1,
  kind: 'task',
  createdAt: new Date('2026-11-14T10:00:00Z'),
  content: {
    text: JSON.stringify({
      question: 'Why did checkout errors rise on Monday?',
      boundaries: 'Last 7 days',
      result: 'A list of causes',
    }),
    record: null,
  },
};

function startAgentResult(seq: number, agent: string, refusalReason: 'run_limit' | 'not_allowed' | null) {
  const at = new Date(Date.UTC(2026, 10, 14, 10, seq));
  return {
    seq,
    kind: 'tool_result',
    createdAt: at,
    content: {
      callId: `call-${seq}`,
      tool: 'start_agent',
      server: null,
      args: { description: 'step', agent, prompt: 'Do it.' },
      outcome: refusalReason === null ? 'success' : 'refused',
      refusalReason,
      refusalDetail: null,
      text: null,
      startedAt: at.toISOString(),
      finishedAt: at.toISOString(),
    },
  } satisfies AgentHistoryEntry;
}

const coordinatorHistory: AgentHistoryEntry[] = [
  briefTask,
  startAgentResult(2, 'gather', null),
  startAgentResult(3, 'answer', null),
  startAgentResult(4, 'answer', 'run_limit'),
  startAgentResult(5, 'stranger', 'not_allowed'),
];

function runsOver(
  get: () => Promise<AgentView>,
  snapshot: RunSnapshot | null = workflowSnapshot,
): ReturnType<typeof createWorkflowRuns> {
  const sessions: WorkflowRunsOptions['sessions'] = {
    get,
    snapshot: async () => snapshot,
    list: async () => [chat, coordinator, gather, grandchild, answer],
    history: async ({ afterSeq = 0, limit }) =>
      coordinatorHistory.filter((entry) => entry.seq > afterSeq).slice(0, limit),
  };
  return createWorkflowRuns({ sessions });
}

// AC-16.1–AC-16.4, AC-16.6 (view): the run shows the record it started from, the team of its snapshot
// with roles, limits and the final executor, the coordinator's direct children as steps (`check` is in the
// team but not among the steps — not called), and one `run_limit` refusal as `{ executor, at }`; the
// `not_allowed` refusal of a name outside the team is not a limit refusal.
describe('runs.get maps a coordinator to WorkflowRun and refuses everything else alike', () => {
  it('maps the team, the steps with their executors and the run_limit refusal', async () => {
    const view = await runsOver(async () => coordinator).get(RUN, OWNER);

    expect(view).toEqual({
      origin: workflowOrigin,
      brief: {
        question: 'Why did checkout errors rise on Monday?',
        boundaries: 'Last 7 days',
        result: 'A list of causes',
      },
      coordinator,
      team: [
        { name: 'gather', role: 'gather role', maxRuns: 2, final: false },
        { name: 'check', role: 'check role', maxRuns: 1, final: false },
        { name: 'answer', role: 'answer role', maxRuns: 1, final: true },
      ],
      steps: [gather, answer],
      limitRefusals: [{ executor: 'answer', at: new Date('2026-11-14T10:04:00Z') }],
    });
  });

  // NFR-06: a run without a workflow snapshot, a missing and another owner's agent are refused alike.
  it.each<[string, () => Promise<AgentView>, RunSnapshot | null]>([
    [
      'an agent whose snapshot is not a workflow',
      async () => chat,
      { kind: 'executor', name: 'gather', origin: workflowOrigin, content: executor('gather', 2) },
    ],
    ['an agent without an agent snapshot', async () => chat, null],
    [
      'a missing or another owner’s agent (AGENT_NOT_FOUND from agents)',
      async () => {
        throw new AgentsError('AGENT_NOT_FOUND', `Agent ${RUN} is not found`);
      },
      workflowSnapshot,
    ],
  ])('refuses %s with RUN_NOT_FOUND', async (_case, get, snapshot) => {
    const refusal = await runsOver(get, snapshot)
      .get(RUN, OWNER)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(WorkflowsError);
    expect(refusal).toMatchObject({
      code: 'RUN_NOT_FOUND',
      message: 'Workflow run coordinator-1 is not found',
    });
  });
});
