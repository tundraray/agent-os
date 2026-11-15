import { type AgentHistoryEntry, AgentsError, type AgentView } from '@agent-os/agents';

import { WorkflowsError } from './errors.js';
import { createWorkflowRuns, type WorkflowRunsOptions } from './runs.js';

const OWNER = 'owner-a';
const RUN = 'coordinator-1';

function agentView(agentId: string, definition: string, parentId: string | null): AgentView {
  return {
    agentId,
    parentId,
    rootId: 'chat-1',
    depth: parentId === null ? 0 : 1,
    definition,
    description: `${definition} step`,
    model: 'anthropic/claude-haiku-5-5',
    status: 'completed',
    failureReason: null,
    forkedFrom: null,
    createdAt: new Date('2026-11-14T10:00:00Z'),
    finishedAt: new Date('2026-11-14T10:05:00Z'),
  };
}

const chat = agentView('chat-1', 'chat', null);
const coordinator = agentView(RUN, 'demo-flow', 'chat-1');
const plan = agentView('plan-1', 'demo-plan', RUN);
const gather = agentView('gather-1', 'demo-gather', RUN);
const grandchild = agentView('grandchild-1', 'general-purpose', 'gather-1');
const answer = agentView('answer-1', 'demo-answer', RUN);
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
  },
};

function sessionsFor(get: () => Promise<AgentView>): WorkflowRunsOptions['sessions'] {
  return {
    get,
    list: async () => [chat, coordinator, plan, gather, grandchild, answer],
    history: async () => [briefTask],
  };
}

function runsOver(get: () => Promise<AgentView>) {
  return createWorkflowRuns({
    sessions: sessionsFor(get),
    templates: [{ name: 'demo-flow', title: 'Demo flow', description: 'Use for the demo.' }],
  });
}

// UC-E4 (rule), NFR-06: the view carries the brief, the template, the coordinator and only its direct
// children in creation order; a missing, another owner's and a non-coordinator agent are refused alike.
describe('runs.get maps a coordinator to a run view and refuses everything else alike', () => {
  it('maps a coordinator with three children and a grandchild to the run view', async () => {
    const view = await runsOver(async () => coordinator).get(RUN, OWNER);

    expect(view).toEqual({
      agentId: 'coordinator-1',
      template: { name: 'demo-flow', title: 'Demo flow' },
      brief: {
        question: 'Why did checkout errors rise on Monday?',
        boundaries: 'Last 7 days',
        result: 'A list of causes',
      },
      coordinator,
      steps: [plan, gather, answer],
    });
  });

  it.each<[string, () => Promise<AgentView>]>([
    ['an agent whose definition is not a template', async () => agentView(RUN, 'chat', null)],
    [
      'a missing or another owner’s agent (AGENT_NOT_FOUND from agents)',
      async () => {
        throw new AgentsError('AGENT_NOT_FOUND', `Agent ${RUN} is not found`);
      },
    ],
  ])('refuses %s with RUN_NOT_FOUND', async (_case, get) => {
    const refusal = await runsOver(get)
      .get(RUN, OWNER)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(WorkflowsError);
    expect(refusal).toMatchObject({
      code: 'RUN_NOT_FOUND',
      message: 'Workflow run coordinator-1 is not found',
    });
  });
});
