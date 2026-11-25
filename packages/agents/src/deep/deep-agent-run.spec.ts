import type { AgentVersion, RunOrigin } from '@agent-os/contracts';

import type { AgentView } from '../agent-view';
import { AgentsError } from '../errors';
import type { AgentHistoryEntry } from '../operations/agent-sessions';
import { type DeepAgentRunSessions, readDeepAgentRun } from './deep-agent-run';

const OWNER = 'owner-a';
const RUN = 'deep-agent-1';
const DEEP_AGENT_ID = '0b7c6a52-3f5e-4d6a-9a43-2f1e8c0d9b11';
const MODEL = 'anthropic/claude-haiku-5-5';

const deepAgentOrigin: RunOrigin = {
  recordId: DEEP_AGENT_ID,
  kind: 'deep_agent',
  version: 3,
  name: 'Demo research',
  author: { id: '5f0e2d1c-8b7a-4c69-9e58-d4c3b2a1f0e9', name: 'Аня' },
  builtinKey: null,
  subagent: null,
};

function subagent(name: string, maxRuns: number) {
  return {
    name,
    description: `${name} description`,
    prompt: `Be ${name}.`,
    servers: [],
    model: MODEL,
    maxTurns: 5,
    maxRuns,
    taskList: false,
  };
}

const deepAgentVersion: AgentVersion = {
  id: '7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6',
  agentId: DEEP_AGENT_ID,
  number: 3,
  kind: 'deep_agent',
  content: {
    prompt: 'Research.',
    servers: [],
    model: MODEL,
    maxTurns: 20,
    subagents: [
      subagent('gather', 2),
      subagent('check', 1),
      subagent('answer', 1),
    ],
    finalSubagent: 'answer',
    taskList: true,
    listDelegation: true,
    selfLearning: false,
    scripts: [],
  },
};

function agentView(
  agentId: string,
  parentId: string | null,
  subagentName: string | null,
): AgentView {
  return {
    agentId,
    parentId,
    rootId: 'chat-1',
    depth: parentId === null ? 0 : parentId === RUN ? 2 : 1,
    name: subagentName ?? 'Demo research',
    origin:
      subagentName === null
        ? deepAgentOrigin
        : { ...deepAgentOrigin, subagent: subagentName },
    firstRun: false,
    description: `${subagentName ?? 'run'} step`,
    model: MODEL,
    status: 'completed',
    failureReason: null,
    forkedFrom: null,
    createdAt: new Date('2026-11-14T10:00:00Z'),
    finishedAt: new Date('2026-11-14T10:05:00Z'),
  };
}

const chat = { ...agentView('chat-1', null, null), origin: null, name: 'Чат' };
const deepAgent = { ...agentView(RUN, 'chat-1', null), depth: 1 };
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
    schedule: null,
  },
};

function taskResult(
  seq: number,
  subagentType: string,
  refusalReason: 'run_limit' | null,
) {
  const at = new Date(Date.UTC(2026, 10, 14, 10, seq));
  return {
    seq,
    kind: 'tool_result',
    createdAt: at,
    content: {
      callId: `call-${seq}`,
      tool: 'task',
      server: null,
      args: { subagentType, description: 'Do it.' },
      outcome: refusalReason === null ? 'success' : 'refused',
      refusalReason,
      refusalDetail: null,
      text: null,
      startedAt: at.toISOString(),
      finishedAt: at.toISOString(),
    },
  } satisfies AgentHistoryEntry;
}

const deepAgentHistory: AgentHistoryEntry[] = [
  briefTask,
  taskResult(2, 'gather', null),
  taskResult(3, 'answer', null),
  taskResult(4, 'answer', 'run_limit'),
  taskResult(5, 'stranger', null),
];

/** What the run's task names: its version and the team member it is; `null` — not an agent. */
type RunVersion = Awaited<ReturnType<DeepAgentRunSessions['version']>>;

const deepAgentRun: RunVersion = { version: deepAgentVersion, subagent: null };

function sessionsOver(
  get: () => Promise<AgentView>,
  run: RunVersion = deepAgentRun,
): DeepAgentRunSessions {
  return {
    get,
    version: async () => run,
    list: async () => [chat, deepAgent, gather, grandchild, answer],
    history: async ({ afterSeq = 0, limit }) =>
      deepAgentHistory.filter((entry) => entry.seq > afterSeq).slice(0, limit),
  };
}

// DD «Маршруты» `/run` (view): the run shows the record it started from, the team of its version with
// limits and the final subagent, the deep agent's direct children as steps (`check` is in the team but not
// among the steps — not called), and one `run_limit` refusal as `{ subagent, at }`; the call of a temporary
// subagent (a name outside the team, data-model DC-26) is not a limit refusal.
describe('the run view maps a deep agent to DeepAgentRun and refuses everything else alike', () => {
  it('maps the team, the steps with their subagents and the run_limit refusal', async () => {
    const view = await readDeepAgentRun(
      sessionsOver(async () => deepAgent),
      RUN,
      OWNER,
    );

    expect(view).toEqual({
      origin: deepAgentOrigin,
      brief: {
        question: 'Why did checkout errors rise on Monday?',
        boundaries: 'Last 7 days',
        result: 'A list of causes',
      },
      deepAgent,
      team: [
        { name: 'gather', maxRuns: 2, final: false },
        { name: 'check', maxRuns: 1, final: false },
        { name: 'answer', maxRuns: 1, final: true },
      ],
      steps: [gather, answer],
      limitRefusals: [
        { subagent: 'answer', at: new Date('2026-11-14T10:04:00Z') },
      ],
    });
  });

  // Isolation: a team member on its deep agent's version, a task that is not an agent, a missing and another
  // owner's agent are refused alike.
  it.each<[string, () => Promise<AgentView>, RunVersion]>([
    [
      'a subagent',
      async () => gather,
      { version: deepAgentVersion, subagent: 'gather' },
    ],
    ['a task that is not an agent', async () => chat, null],
    [
      'a missing or another owner’s agent (AGENT_NOT_FOUND)',
      async () => {
        throw new AgentsError('AGENT_NOT_FOUND', `Agent ${RUN} is not found`);
      },
      deepAgentRun,
    ],
  ])('refuses %s with RUN_NOT_FOUND', async (_case, get, run) => {
    const refusal = await readDeepAgentRun(
      sessionsOver(get, run),
      RUN,
      OWNER,
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(AgentsError);
    expect(refusal).toMatchObject({
      code: 'RUN_NOT_FOUND',
      message: 'Deep agent run deep-agent-1 is not found',
    });
  });
});
