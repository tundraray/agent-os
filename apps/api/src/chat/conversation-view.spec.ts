import type {
  AgentConfirmation,
  AgentHistoryEntry,
  AgentView as AgentsAgentView,
  RunOrigin,
} from '@agent-os/agents';
import type { HistoryEntry } from '@agent-os/contracts';
import type { StepMessage } from '@agent-os/runtime';
import {
  toAgentTree,
  toAgentView,
  toConfirmation,
  toHistoryEntry,
  toPending,
} from './conversation-view';

const CREATED = new Date('2026-11-14T10:00:00.000Z');
const RESOLVED = new Date('2026-11-14T10:05:00.000Z');
const RECORD_ID = 'fb06f3c1-a1be-4167-9896-f0d0fba21a89';
const AUTHOR_ID = '0b4f1c2e-3d5a-4e6f-8a7b-9c0d1e2f3a4b';

/** A workflow step: a colleague's record, its executor named. */
const STEP_ORIGIN: RunOrigin = {
  recordId: RECORD_ID,
  kind: 'workflow',
  version: 3,
  name: 'Разбор инцидента',
  author: { id: AUTHOR_ID, name: 'Аня' },
  builtinKey: null,
  executor: 'gather',
};

function agent(agentId: string, parentId: string | null, origin: RunOrigin | null = null): AgentsAgentView {
  return {
    agentId,
    parentId,
    rootId: 'root',
    depth: 0,
    name: origin?.name ?? 'Главный чат',
    origin,
    firstRun: false,
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

// AC-17.3 (a decision request as the card shows it, with the asking agent's origin), AC-24.1 (the
// conversation's agent tree), KD-4: the conversation view's mapping of agents and runtime views; every
// Date is ISO.
describe('conversation view maps confirmations, the agent tree and the pending queue', () => {
  it.each([
    {
      name: 'an open MCP request of a workflow step, with the record it started from',
      input: confirmation({}),
      expected: {
        decisionId: 'd1',
        agentId: 'a1',
        description: 'agent a1',
        origin: STEP_ORIGIN,
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
        origin: STEP_ORIGIN,
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
      name: 'a brief of the root, which has no origin',
      input: confirmation({
        agentId: 'root',
        description: 'agent root',
        kind: 'workflows.brief',
        tool: 'start_workflow',
        server: null,
        args: { workflow: RECORD_ID, question: 'Q', boundaries: '', result: '' },
        content: { workflow: RECORD_ID, question: 'Q', boundaries: '', result: '' },
      }),
      expected: {
        decisionId: 'd1',
        agentId: 'root',
        description: 'agent root',
        origin: null,
        kind: 'workflows.brief',
        tool: 'start_workflow',
        server: null,
        args: { workflow: RECORD_ID, question: 'Q', boundaries: '', result: '' },
        content: { workflow: RECORD_ID, question: 'Q', boundaries: '', result: '' },
        status: 'open',
        resolution: null,
        createdAt: '2026-11-14T10:00:00.000Z',
        resolvedAt: null,
      },
    },
  ])('confirmation: $name', ({ input, expected }) => {
    const views = [agent('root', null), agent('a1', 'root', STEP_ORIGIN)];
    expect(toConfirmation(input, views)).toEqual(expected);
  });

  // AC-17.1, AC-15.6: the record a run started from, with its author and executor, and the first-run
  // mark; the author's `disabled`, which an origin read from a snapshot may carry, never reaches the web.
  it('agent: name, origin with author and executor, firstRun; no author.disabled; dates are ISO', () => {
    const origin = { ...STEP_ORIGIN, author: { id: AUTHOR_ID, name: 'Аня', disabled: true } };
    const step = { ...agent('s1', 'c1', origin), firstRun: true, finishedAt: RESOLVED };

    expect(toAgentView(step)).toEqual({
      agentId: 's1',
      parentId: 'c1',
      rootId: 'root',
      depth: 0,
      name: 'Разбор инцидента',
      origin: STEP_ORIGIN,
      firstRun: true,
      description: 'agent s1',
      model: 'claude-haiku',
      status: 'working',
      failureReason: null,
      forkedFrom: null,
      createdAt: '2026-11-14T10:00:00.000Z',
      finishedAt: '2026-11-14T10:05:00.000Z',
    });
  });

  it('tree: five agents with a grandchild, without the root, each level in creation order', () => {
    const views = [
      agent('root', null),
      agent('a', 'root'),
      agent('b', 'root'),
      agent('a1', 'a'),
      agent('c', 'root'),
    ];

    const ids = (nodes: ReturnType<typeof toAgentTree>): unknown =>
      nodes.map((node) => ({ id: node.agentId, children: ids(node.children) }));
    expect(ids(toAgentTree(views, 'root'))).toEqual([
      { id: 'a', children: [{ id: 'a1', children: [] }] },
      { id: 'b', children: [] },
      { id: 'c', children: [] },
    ]);
  });

  it('pending: messages in queue order with their sources, an interrupt left out', () => {
    const messages = [
      message(4, 'child_finished', { taskId: 'a', status: 'failed', durationMs: 10 }),
      message(1, 'user_message', { text: 'hello' }),
      message(3, 'interrupt', {}),
      message(2, 'agent_message', { text: 'from parent', fromAgentId: 'p' }),
    ];

    expect(toPending(messages, [agent('a', 'root')])).toEqual([
      { messageId: 'm1', source: 'user', text: 'hello', createdAt: '2026-11-14T10:00:00.000Z' },
      { messageId: 'm2', source: 'parent', text: 'from parent', createdAt: '2026-11-14T10:00:00.000Z' },
      {
        messageId: 'm4',
        source: 'report',
        agentDescription: 'agent a',
        status: 'failed',
        createdAt: '2026-11-14T10:00:00.000Z',
      },
    ]);
  });

  // AC-15.6 (the chip of a message), AC-14.4 (the refused model of a refusal): an entry keeps its
  // content and its date becomes ISO.
  it.each<{ name: string; entry: AgentHistoryEntry; expected: HistoryEntry }>([
    {
      name: 'a model answer keeps its tool calls',
      entry: {
        seq: 7,
        kind: 'model_answer',
        createdAt: CREATED,
        content: {
          text: 'Looking',
          toolCalls: [{ callId: 'c1', tool: 'search', server: null, args: { q: 'x' }, state: 'done' }],
        },
      },
      expected: {
        seq: 7,
        kind: 'model_answer',
        createdAt: '2026-11-14T10:00:00.000Z',
        content: {
          text: 'Looking',
          toolCalls: [{ callId: 'c1', tool: 'search', server: null, args: { q: 'x' }, state: 'done' }],
        },
      },
    },
    {
      name: 'a message keeps its record chip',
      entry: {
        seq: 3,
        kind: 'user_message',
        createdAt: CREATED,
        content: { text: 'Разбери', record: { id: RECORD_ID, kind: 'workflow', name: 'Разбор инцидента' } },
      },
      expected: {
        seq: 3,
        kind: 'user_message',
        createdAt: '2026-11-14T10:00:00.000Z',
        content: { text: 'Разбери', record: { id: RECORD_ID, kind: 'workflow', name: 'Разбор инцидента' } },
      },
    },
    {
      name: 'a refused start keeps the refused model',
      entry: {
        seq: 9,
        kind: 'tool_result',
        createdAt: CREATED,
        content: {
          callId: 'c2',
          tool: 'start_agent',
          server: null,
          args: { agent: RECORD_ID, prompt: 'p', description: 'd' },
          outcome: 'refused',
          refusalReason: 'model_not_allowed',
          refusalDetail: { model: 'anthropic/claude-opus-5-5' },
          text: null,
          startedAt: null,
          finishedAt: null,
        },
      },
      expected: {
        seq: 9,
        kind: 'tool_result',
        createdAt: '2026-11-14T10:00:00.000Z',
        content: {
          callId: 'c2',
          tool: 'start_agent',
          server: null,
          args: { agent: RECORD_ID, prompt: 'p', description: 'd' },
          outcome: 'refused',
          refusalReason: 'model_not_allowed',
          refusalDetail: { model: 'anthropic/claude-opus-5-5' },
          text: null,
          startedAt: null,
          finishedAt: null,
        },
      },
    },
  ])('history: $name', ({ entry, expected }) => {
    expect(toHistoryEntry(entry)).toEqual(expected);
  });
});
