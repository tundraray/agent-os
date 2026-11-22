import type { RecordHeader, ResolvedRecord } from '@agent-os/contracts';

import {
  DEEP_AGENT_RULES,
  LIST_DELEGATION_RULES,
  recordSnapshot,
  type RunDefinition,
  snapshotDefinition,
  subagentSnapshot,
} from './snapshot-definition';
import type { DeepAgentSnapshot } from './snapshot';

// AC-16.4, DC-7, AC-15.3 (rule); deep-agents KD-1, KD-2, AC-08.1: the definition a step hands the model
// comes from the snapshot alone — an agent's prompt, tools, servers and limit with the visible records of
// its `agents`; a deep agent's prompt with the platform rules after it, its own servers, the team as
// «имя (up to N runs): описание», and who writes the answer; a subagent taken from the deep agent by its
// name, learning on the servers of the deep agent and its whole team. design-task-list.md KD-2: the task-list
// flag is the one of the snapshot's own content — the agent's, the deep agent's, the subagent's.

const HAIKU = 'anthropic/claude-haiku-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
const AGENT_ID = '00000000-0000-4000-8000-000000000001';
const VISIBLE_ID = '00000000-0000-4000-8000-000000000002';
const HIDDEN_ID = '00000000-0000-4000-8000-000000000003';
const DEEP_AGENT_ID = '00000000-0000-4000-8000-000000000004';
const OWNER_ID = '00000000-0000-4000-8000-000000000005';

const AGENT_RECORD: ResolvedRecord = {
  id: AGENT_ID,
  kind: 'agent',
  name: 'Разбор оплат',
  description: 'Разбирает платежи',
  version: 2,
  builtinKey: null,
  author: { id: OWNER_ID, name: 'Аня', disabled: false },
  mine: false,
  shared: false,
  offerInChat: true,
  content: {
    prompt: 'You sort payments.',
    servers: ['billing'],
    model: HAIKU,
    maxTurns: 12,
    agents: [VISIBLE_ID, HIDDEN_ID],
    tools: ['start_agent', 'list_agents'],
    taskList: true,
  },
};

const VISIBLE_HEADERS: RecordHeader[] = [
  {
    id: VISIBLE_ID,
    kind: 'agent',
    name: 'Сверка',
    description: 'Сверяет выписки',
    version: 1,
    builtinKey: null,
    author: null,
    mine: false,
    shared: false,
    offerInChat: false,
  },
];

function subagent(
  name: string,
  maxRuns: number,
  description: string,
): DeepAgentSnapshot['content']['subagents'][number] {
  return {
    name,
    description,
    prompt: `You are ${name}.`,
    servers: name === 'gather' ? ['logs'] : [],
    model: HAIKU,
    maxTurns: 6,
    maxRuns,
    taskList: name === 'gather',
  };
}

function deepAgent(
  finalSubagent: string | null,
  { selfLearning = false, taskList = true, listDelegation = true } = {},
): DeepAgentSnapshot {
  return {
    kind: 'deep_agent',
    name: 'Глубокий ресерч',
    origin: {
      recordId: DEEP_AGENT_ID,
      kind: 'deep_agent',
      version: 3,
      name: 'Глубокий ресерч',
      author: null,
      builtinKey: 'deep-research',
      subagent: null,
    },
    content: {
      prompt: 'Start plan first.',
      servers: ['tickets'],
      model: SONNET,
      maxTurns: 30,
      subagents: [
        subagent('plan', 1, 'Делит вопрос на направления'),
        subagent('gather', 5, 'Собирает данные по направлению'),
        subagent('answer', 2, 'Пишет ответ'),
      ],
      finalSubagent,
      taskList,
      listDelegation,
      selfLearning,
    },
  };
}

const TEAM_LINES = [
  'plan (up to 1 runs): Делит вопрос на направления',
  'gather (up to 5 runs): Собирает данные по направлению',
  'answer (up to 2 runs): Пишет ответ',
  'general-purpose (up to 20 runs): A subagent with the deep agent’s own model and tools: call it for a separate piece of work no other subagent fits.',
];

describe('snapshotDefinition', () => {
  it.each<{ case: string; definition: () => RunDefinition | null; expected: RunDefinition | null }>([
    {
      case: 'an agent: its content, and only the records of its agents the starter sees',
      definition: () => {
        const snapshot = recordSnapshot(AGENT_RECORD, VISIBLE_HEADERS, null);
        return snapshot === null ? null : snapshotDefinition(snapshot);
      },
      expected: {
        name: 'Разбор оплат',
        prompt: 'You sort payments.',
        model: HAIKU,
        maxTurns: 12,
        tools: ['start_agent', 'list_agents'],
        servers: ['billing'],
        startable: [`${VISIBLE_ID}: Сверка — Сверяет выписки`],
        finalSubagent: null,
        taskList: true,
        listDelegation: false,
      },
    },
    {
      case: 'a deep agent with a final subagent: its prompt, the rules with the list rules, then the final rule',
      definition: () => snapshotDefinition(deepAgent('answer')),
      expected: {
        name: 'Глубокий ресерч',
        prompt: `Start plan first.\n\n${DEEP_AGENT_RULES}\n\n${LIST_DELEGATION_RULES}\n\nThe answer is the last message of answer given a single task: after it has finished, end with a short text without tool calls.`,
        model: SONNET,
        maxTurns: 30,
        tools: ['task'],
        servers: ['tickets'],
        startable: TEAM_LINES,
        finalSubagent: 'answer',
        taskList: true,
        listDelegation: true,
      },
    },
    {
      // DC-6: without the list form the prompt has no rules about lists.
      case: 'a deep agent without a final subagent writes the answer itself; its task list and list form are off',
      definition: () => snapshotDefinition(deepAgent(null, { taskList: false, listDelegation: false })),
      expected: {
        name: 'Глубокий ресерч',
        prompt: `Start plan first.\n\n${DEEP_AGENT_RULES}\n\nWhen the work is done, write the answer yourself as plain text without tool calls.`,
        model: SONNET,
        maxTurns: 30,
        tools: ['task'],
        servers: ['tickets'],
        startable: TEAM_LINES,
        finalSubagent: null,
        taskList: false,
        listDelegation: false,
      },
    },
    {
      case: 'a subagent taken from the deep agent by its name',
      definition: () => {
        const snapshot = subagentSnapshot(deepAgent('answer'), 'gather');
        return snapshot === null ? null : snapshotDefinition(snapshot);
      },
      expected: {
        name: 'gather',
        prompt: 'You are gather.',
        model: HAIKU,
        maxTurns: 6,
        tools: [],
        servers: ['logs'],
        startable: [],
        finalSubagent: null,
        taskList: true,
        listDelegation: false,
      },
    },
    {
      // FR-20: general-purpose works on the deep agent's model, servers and maxTurns.
      case: 'general-purpose taken from the deep agent',
      definition: () => {
        const snapshot = subagentSnapshot(deepAgent('answer'), 'general-purpose');
        return snapshot === null ? null : snapshotDefinition(snapshot);
      },
      expected: {
        name: 'general-purpose',
        prompt:
          'Do the assignment yourself with the tools you have. The deep agent that gave it sees only your last message, so put the whole result in it.',
        model: SONNET,
        maxTurns: 30,
        tools: [],
        servers: ['tickets'],
        startable: [],
        finalSubagent: null,
        taskList: false,
        listDelegation: false,
      },
    },
    {
      case: 'a name outside the team gives no subagent',
      definition: () => {
        const snapshot = subagentSnapshot(deepAgent('answer'), 'review');
        return snapshot === null ? null : snapshotDefinition(snapshot);
      },
      expected: null,
    },
  ])('$case', ({ definition, expected }) => {
    expect(definition()).toEqual(expected);
  });

  it('a subagent of a learning deep agent keeps its origin with its own name and learns on the servers of the deep agent and the team', () => {
    const snapshot = subagentSnapshot(deepAgent('answer', { selfLearning: true }), 'gather');
    expect({ origin: snapshot?.origin, learning: snapshot?.learning }).toEqual({
      origin: {
        recordId: DEEP_AGENT_ID,
        kind: 'deep_agent',
        version: 3,
        name: 'Глубокий ресерч',
        author: null,
        builtinKey: 'deep-research',
        subagent: 'gather',
      },
      learning: { servers: ['tickets', 'logs'] },
    });
  });
});
