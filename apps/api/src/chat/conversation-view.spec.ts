import type { AgentConfirmation, AgentHistoryEntry, AgentView as AgentsAgentView } from '@agent-os/agents';
import type { StepMessage } from '@agent-os/runtime';
import {
  templateTitles,
  toAgentTree,
  toAgentView,
  toConfirmation,
  toHistoryEntry,
  toPending,
} from './conversation-view.js';

const CREATED = new Date('2026-11-14T10:00:00.000Z');
const RESOLVED = new Date('2026-11-14T10:05:00.000Z');
const TEMPLATES = templateTitles([
  { name: 'deep-research', title: 'Глубокий ресерч', description: 'Research a question in depth' },
]);

function agent(agentId: string, parentId: string | null, definition = 'general-purpose'): AgentsAgentView {
  return {
    agentId,
    parentId,
    rootId: 'root',
    depth: 0,
    definition,
    description: `agent ${agentId}`,
    model: 'claude-haiku',
    status: 'working',
    failureReason: null,
    forkedFrom: null,
    createdAt: CREATED,
    finishedAt: null,
  };
}

function confirmation(overrides: Partial<AgentConfirmation>): AgentConfirmation {
  return {
    decisionId: 'd1',
    agentId: 'a1',
    description: 'agent a1',
    kind: 'agents.tool_confirmation',
    tool: 'create_issue',
    server: 'jira',
    args: { summary: 'Bug' },
    content: { toolDescription: 'Creates an issue' },
    status: 'open',
    resolution: null,
    createdAt: CREATED,
    resolvedAt: null,
    ...overrides,
  };
}

function message(seq: number, kind: string, payload: unknown): StepMessage {
  return { messageId: `m${seq}`, seq, kind, sender: 'owner', payload, revive: false, createdAt: CREATED };
}

// AC-17.3 (a decision request as the card shows it), AC-24.1 (the conversation's agent tree), KD-4,
// design v1.2 A-1: the conversation view's mapping of agents and runtime views; every Date is ISO.
describe('conversation view maps confirmations, the agent tree and the pending queue', () => {
  it.each([
    {
      name: 'an open MCP request',
      input: confirmation({}),
      expected: {
        decisionId: 'd1',
        agentId: 'a1',
        description: 'agent a1',
        kind: 'agents.tool_confirmation',
        tool: 'create_issue',
        server: 'jira',
        args: { summary: 'Bug' },
        content: { toolDescription: 'Creates an issue' },
        status: 'open',
        resolution: null,
        createdAt: '2026-11-14T10:00:00.000Z',
        resolvedAt: null,
      },
    },
    {
      name: 'a resolved MCP request with the arguments the call ran with',
      input: confirmation({
        status: 'resolved',
        resolution: { approve: true, args: { summary: 'Bug' } },
        resolvedAt: RESOLVED,
      }),
      expected: {
        decisionId: 'd1',
        agentId: 'a1',
        description: 'agent a1',
        kind: 'agents.tool_confirmation',
        tool: 'create_issue',
        server: 'jira',
        args: { summary: 'Bug' },
        content: { toolDescription: 'Creates an issue' },
        status: 'resolved',
        resolution: { approve: true, args: { summary: 'Bug' } },
        createdAt: '2026-11-14T10:00:00.000Z',
        resolvedAt: '2026-11-14T10:05:00.000Z',
      },
    },
    {
      name: 'a brief with its template title',
      input: confirmation({
        kind: 'workflows.brief',
        tool: 'start_workflow',
        server: null,
        args: { template: 'deep-research', question: 'Q', boundaries: '', result: '' },
        content: { title: 'Глубокий ресерч', question: 'Q', boundaries: '', result: '' },
      }),
      expected: {
        decisionId: 'd1',
        agentId: 'a1',
        description: 'agent a1',
        kind: 'workflows.brief',
        tool: 'start_workflow',
        server: null,
        args: { template: 'deep-research', question: 'Q', boundaries: '', result: '' },
        content: { title: 'Глубокий ресерч', question: 'Q', boundaries: '', result: '' },
        status: 'open',
        resolution: null,
        createdAt: '2026-11-14T10:00:00.000Z',
        resolvedAt: null,
        templateTitle: 'Глубокий ресерч',
      },
    },
  ])('confirmation: $name', ({ input, expected }) => {
    expect(toConfirmation(input, TEMPLATES)).toEqual(expected);
  });

  it('agent: a workflow coordinator carries its template, an ordinary agent has no such field; dates are ISO', () => {
    const finished = { ...agent('c1', 'root', 'deep-research'), finishedAt: RESOLVED };

    expect(toAgentView(finished, TEMPLATES)).toEqual({
      agentId: 'c1',
      parentId: 'root',
      rootId: 'root',
      depth: 0,
      definition: 'deep-research',
      description: 'agent c1',
      model: 'claude-haiku',
      status: 'working',
      failureReason: null,
      forkedFrom: null,
      createdAt: '2026-11-14T10:00:00.000Z',
      finishedAt: '2026-11-14T10:05:00.000Z',
      template: { name: 'deep-research', title: 'Глубокий ресерч' },
    });
    expect(toAgentView(agent('a1', 'root'), TEMPLATES)).not.toHaveProperty('template');
  });

  it('tree: five agents with a grandchild, without the root, each level in creation order', () => {
    const views = [
      agent('root', null, 'chat'),
      agent('a', 'root'),
      agent('b', 'root'),
      agent('a1', 'a'),
      agent('c', 'root'),
    ].map((view) => toAgentView(view, TEMPLATES));

    const ids = (nodes: ReturnType<typeof toAgentTree>): unknown =>
      nodes.map((node) => ({ id: node.agentId, children: ids(node.children) }));
    expect(ids(toAgentTree(views, 'root'))).toEqual([
      { id: 'a', children: [{ id: 'a1', children: [] }] },
      { id: 'b', children: [] },
      { id: 'c', children: [] },
    ]);
  });

  it('pending: four message kinds in queue order with their sources and the interrupt mark', () => {
    const messages = [
      message(4, 'child_finished', { taskId: 'a', status: 'failed', durationMs: 10 }),
      message(1, 'user_message', { text: 'hello' }),
      message(3, 'interrupt', {}),
      message(2, 'agent_message', { text: 'from parent', fromAgentId: 'p' }),
    ];

    expect(toPending(messages, [agent('a', 'root')])).toEqual([
      { messageId: 'm1', source: 'user', interrupt: false, text: 'hello', createdAt: '2026-11-14T10:00:00.000Z' },
      { messageId: 'm2', source: 'parent', interrupt: false, text: 'from parent', createdAt: '2026-11-14T10:00:00.000Z' },
      { messageId: 'm3', source: 'user', interrupt: true, text: '', createdAt: '2026-11-14T10:00:00.000Z' },
      {
        messageId: 'm4',
        source: 'report',
        interrupt: false,
        agentDescription: 'agent a',
        status: 'failed',
        createdAt: '2026-11-14T10:00:00.000Z',
      },
    ]);
  });

  it('history: an entry keeps its content and its date becomes ISO', () => {
    const entry: AgentHistoryEntry = {
      seq: 7,
      kind: 'model_answer',
      createdAt: CREATED,
      content: {
        text: 'Looking',
        toolCalls: [{ callId: 'c1', tool: 'search', server: null, args: { q: 'x' }, state: 'done' }],
      },
    };

    expect(toHistoryEntry(entry)).toEqual({
      seq: 7,
      kind: 'model_answer',
      createdAt: '2026-11-14T10:00:00.000Z',
      content: {
        text: 'Looking',
        toolCalls: [{ callId: 'c1', tool: 'search', server: null, args: { q: 'x' }, state: 'done' }],
      },
    });
  });
});
