import type { RecordHeader, ResolvedRecord } from '@agent-os/contracts';

import {
  COORDINATOR_PROMPT,
  executorSnapshot,
  recordSnapshot,
  type RunDefinition,
  snapshotDefinition,
} from './snapshot-definition.js';
import type { WorkflowSnapshot } from './snapshot.js';

// AC-16.4, DC-7, AC-15.3 (rule): the definition a step hands the model comes from the snapshot alone —
// an agent's prompt, tools, servers and limit with the visible records of its `agents`; a coordinator's
// common text with the record's rules, the team as «имя (до N вызовов): роль», and who writes the
// answer; an executor taken from the workflow by its name.

const HAIKU = 'anthropic/claude-haiku-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
const AGENT_ID = '00000000-0000-4000-8000-000000000001';
const VISIBLE_ID = '00000000-0000-4000-8000-000000000002';
const HIDDEN_ID = '00000000-0000-4000-8000-000000000003';
const WORKFLOW_ID = '00000000-0000-4000-8000-000000000004';
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

function executor(
  name: string,
  maxRuns: number,
  role: string,
): WorkflowSnapshot['content']['executors'][number] {
  return {
    name,
    role,
    prompt: `You are ${name}.`,
    servers: name === 'gather' ? ['logs'] : [],
    model: HAIKU,
    maxTurns: 6,
    maxRuns,
    tools: [],
    source: null,
  };
}

function workflow(rules: string, finalExecutor: string | null): WorkflowSnapshot {
  return {
    kind: 'workflow',
    name: 'Глубокий ресерч',
    origin: {
      recordId: WORKFLOW_ID,
      kind: 'workflow',
      version: 3,
      name: 'Глубокий ресерч',
      author: null,
      builtinKey: 'deep-research',
      executor: null,
    },
    content: {
      coordinator: { rules, model: SONNET, maxTurns: 30 },
      executors: [
        executor('plan', 1, 'Делит вопрос на направления'),
        executor('gather', 5, 'Собирает данные по направлению'),
        executor('answer', 2, 'Пишет ответ'),
      ],
      finalExecutor,
      selfLearning: false,
    },
  };
}

const TEAM_LINES = [
  'plan (до 1 вызовов): Делит вопрос на направления',
  'gather (до 5 вызовов): Собирает данные по направлению',
  'answer (до 2 вызовов): Пишет ответ',
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
        finalExecutor: null,
      },
    },
    {
      case: 'a coordinator without rules and with a final executor',
      definition: () => snapshotDefinition(workflow('', 'answer')),
      expected: {
        name: 'Глубокий ресерч',
        prompt: `${COORDINATOR_PROMPT}\n\nThe answer is the report of answer: after it reports, reply with one short sentence and make no more calls.`,
        model: SONNET,
        maxTurns: 30,
        tools: ['start_agent', 'message_agent'],
        servers: [],
        startable: TEAM_LINES,
        finalExecutor: 'answer',
      },
    },
    {
      case: 'a coordinator with rules and without a final executor writes the answer itself',
      definition: () => snapshotDefinition(workflow('Start plan first.', null)),
      expected: {
        name: 'Глубокий ресерч',
        prompt: `${COORDINATOR_PROMPT}\n\nWhen the work is done, write the answer yourself as plain text without tool calls.\n\nRules of this workflow:\nStart plan first.`,
        model: SONNET,
        maxTurns: 30,
        tools: ['start_agent', 'message_agent'],
        servers: [],
        startable: TEAM_LINES,
        finalExecutor: null,
      },
    },
    {
      case: 'an executor taken from the workflow by its name',
      definition: () => {
        const snapshot = executorSnapshot(workflow('', 'answer'), 'gather');
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
        finalExecutor: null,
      },
    },
    {
      case: 'a name outside the team gives no executor',
      definition: () => {
        const snapshot = executorSnapshot(workflow('', 'answer'), 'review');
        return snapshot === null ? null : snapshotDefinition(snapshot);
      },
      expected: null,
    },
  ])('$case', ({ definition, expected }) => {
    expect(definition()).toEqual(expected);
  });

  it('an executor keeps the workflow origin with its own name', () => {
    expect(executorSnapshot(workflow('', 'answer'), 'gather')?.origin).toEqual({
      recordId: WORKFLOW_ID,
      kind: 'workflow',
      version: 3,
      name: 'Глубокий ресерч',
      author: null,
      builtinKey: 'deep-research',
      executor: 'gather',
    });
  });
});
