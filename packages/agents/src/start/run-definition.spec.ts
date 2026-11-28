import {
  type AgentVersion,
  type DeepAgentContent,
  NOTEPAD_TOOLS,
  type RecordHeader,
} from '@agent-os/contracts';

import {
  DEEP_AGENT_RULES,
  LIST_DELEGATION_RULES,
  subagentStart,
} from '../deep/deep-definition';
import {
  agentLines,
  type RunDefinition,
  runDefinition,
  type RunStart,
} from './run-definition';

// AC-16.4, DC-7, AC-15.3 (rule); deep-agents KD-1, KD-2, AC-08.1; data-model design-agents.md KD-6: the
// definition a step hands the model comes from the run's version alone — an agent's prompt, tools, servers and
// limit; a deep agent's prompt with the platform rules after it, its own servers, the team as «имя (up to N
// runs): описание», and who writes the answer; a team member taken from the deep agent's version by its name,
// on its own model or else the deep agent's (KD-3).
// design-task-list.md KD-2: the task-list flag is the one of the run's own content. An agent's `start_agent`
// lines are the records of its `agents` its owner sees now.

/** design-notepad.md KD-3: a subagent has every notepad tool but the past documents. */
const SUBAGENT_NOTEPAD = NOTEPAD_TOOLS.filter(
  (tool) => tool !== 'notepad_past',
);

const HAIKU = 'anthropic/claude-haiku-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
const AGENT_ID = '00000000-0000-4000-8000-000000000001';
const VISIBLE_ID = '00000000-0000-4000-8000-000000000002';
const HIDDEN_ID = '00000000-0000-4000-8000-000000000003';
const DEEP_AGENT_ID = '00000000-0000-4000-8000-000000000004';
const DEEP_ID = '00000000-0000-4000-8000-000000000006';

const AGENT_VERSION: AgentVersion = {
  id: '00000000-0000-4000-8000-000000000007',
  agentId: AGENT_ID,
  number: 2,
  kind: 'agent',
  content: {
    prompt: 'You sort payments.',
    servers: ['billing'],
    model: null,
    maxTurns: 12,
    agents: [VISIBLE_ID, HIDDEN_ID, DEEP_ID],
    tools: ['start_agent', 'list_agents'],
    taskList: true,
    skills: [],
  },
};

function header(
  id: string,
  kind: RecordHeader['kind'],
  name: string,
): RecordHeader {
  return {
    id,
    kind,
    name,
    description: `${name}: описание`,
    version: 1,
    versionId: '00000000-0000-4000-8000-000000000008',
    builtinKey: null,
    author: null,
    mine: false,
    shared: false,
    offerInChat: false,
  };
}

function subagent(
  name: string,
  maxRuns: number,
  description: string,
  model: string | null = HAIKU,
): DeepAgentContent['subagents'][number] {
  return {
    name,
    description,
    prompt: `You are ${name}.`,
    servers: name === 'gather' ? ['logs'] : [],
    model,
    maxTurns: 6,
    maxRuns,
    taskList: name === 'gather',
  };
}

function deepAgent(
  finalSubagent: string | null,
  { taskList = true, listDelegation = true } = {},
): RunStart {
  return {
    version: {
      id: '00000000-0000-4000-8000-000000000009',
      agentId: DEEP_AGENT_ID,
      number: 3,
      kind: 'deep_agent',
      content: {
        prompt: 'Start plan first.',
        servers: ['tickets'],
        model: null,
        maxTurns: 30,
        subagents: [
          subagent('plan', 1, 'Делит вопрос на направления', null),
          subagent('gather', 5, 'Собирает данные по направлению'),
          subagent('answer', 2, 'Пишет ответ'),
        ],
        finalSubagent,
        taskList,
        listDelegation,
        selfLearning: false,
        scripts: [],
        skills: [],
      },
    },
    name: 'Глубокий ресерч',
    subagent: null,
    model: SONNET,
  };
}

const TEAM_LINES = [
  'plan (up to 1 runs): Делит вопрос на направления',
  'gather (up to 5 runs): Собирает данные по направлению',
  'answer (up to 2 runs): Пишет ответ',
  'general-purpose (up to 20 runs): A subagent with the deep agent’s own model and tools: call it for a separate piece of work no other subagent fits.',
];

const GENERAL_PURPOSE_PROMPT =
  'Do the assignment yourself with the tools you have. The deep agent that gave it sees only your last message, so put the whole result in it.';

/** The definition of a team member's start; `null` — the name is not in the team. */
function memberDefinition(deep: RunStart, name: string): RunDefinition | null {
  const run = subagentStart(deep, { subagent: name, name });
  return run === null ? null : runDefinition(run);
}

describe('runDefinition', () => {
  it.each<{
    case: string;
    definition: () => RunDefinition | null;
    expected: RunDefinition | null;
  }>([
    {
      case: 'an agent: its content under the run name and model, its agents by id',
      definition: () =>
        runDefinition({
          version: AGENT_VERSION,
          name: 'Разбор оплат',
          subagent: null,
          model: HAIKU,
        }),
      expected: {
        name: 'Разбор оплат',
        prompt: 'You sort payments.',
        model: HAIKU,
        maxTurns: 12,
        tools: ['start_agent', 'list_agents'],
        servers: ['billing'],
        startable: [],
        agents: [VISIBLE_ID, HIDDEN_ID, DEEP_ID],
        taskList: true,
        listDelegation: false,
        scripts: [],
      },
    },
    {
      case: 'a deep agent with a final subagent: its prompt, the rules with the list rules, then the final rule',
      definition: () => runDefinition(deepAgent('answer')),
      expected: {
        name: 'Глубокий ресерч',
        prompt: `Start plan first.\n\n${DEEP_AGENT_RULES}\n\n${LIST_DELEGATION_RULES}\n\nThe report document is written by answer, never by you. The answer is the last message of answer given a single task: after it has finished, end with a short text without tool calls.`,
        model: SONNET,
        maxTurns: 30,
        tools: ['task', ...NOTEPAD_TOOLS],
        servers: ['tickets'],
        startable: TEAM_LINES,
        agents: [],
        taskList: true,
        listDelegation: true,
        scripts: [],
      },
    },
    {
      // DC-6: without the list form the prompt has no rules about lists.
      case: 'a deep agent without a final subagent writes the answer itself; its task list and list form are off',
      definition: () =>
        runDefinition(
          deepAgent(null, { taskList: false, listDelegation: false }),
        ),
      expected: {
        name: 'Глубокий ресерч',
        prompt: `Start plan first.\n\n${DEEP_AGENT_RULES}\n\nWrite the full result for the employee as a notepad document marked as the report, a large one in parts; keep your last message short and name the document in it.\nWhen the work is done, end with a short message without tool calls.`,
        model: SONNET,
        maxTurns: 30,
        tools: ['task', ...NOTEPAD_TOOLS],
        servers: ['tickets'],
        startable: TEAM_LINES,
        agents: [],
        taskList: false,
        listDelegation: false,
        scripts: [],
      },
    },
    {
      case: 'a team member taken by its name, on its own model',
      definition: () => memberDefinition(deepAgent('answer'), 'gather'),
      expected: {
        name: 'gather',
        prompt: 'You are gather.',
        model: HAIKU,
        maxTurns: 6,
        tools: SUBAGENT_NOTEPAD,
        servers: ['logs'],
        startable: [],
        agents: [],
        taskList: true,
        listDelegation: false,
        scripts: [],
      },
    },
    {
      // KD-3 (R19): a member without a model runs on the deep agent's conversation model, not the system one.
      case: 'a team member without a model takes the deep agent’s',
      definition: () => memberDefinition(deepAgent('answer'), 'plan'),
      expected: {
        name: 'plan',
        prompt: 'You are plan.',
        model: SONNET,
        maxTurns: 6,
        tools: SUBAGENT_NOTEPAD,
        servers: [],
        startable: [],
        agents: [],
        taskList: false,
        listDelegation: false,
        scripts: [],
      },
    },
    {
      // FR-20: general-purpose works on the deep agent's model, servers and maxTurns.
      case: 'general-purpose taken from the deep agent',
      definition: () =>
        memberDefinition(deepAgent('answer'), 'general-purpose'),
      expected: {
        name: 'general-purpose',
        prompt: GENERAL_PURPOSE_PROMPT,
        model: SONNET,
        maxTurns: 30,
        tools: SUBAGENT_NOTEPAD,
        servers: ['tickets'],
        startable: [],
        agents: [],
        taskList: false,
        listDelegation: false,
        scripts: [],
      },
    },
    {
      case: 'a name outside the team gives no team member',
      definition: () => memberDefinition(deepAgent('answer'), 'review'),
      expected: null,
    },
  ])('$case', ({ definition, expected }) => {
    expect(definition()).toEqual(expected);
  });
});

describe('agentLines', () => {
  it('lists the records of the agents the owner sees as agents, in their order, never a deep agent', () => {
    const visible = [
      header(DEEP_ID, 'deep_agent', 'Ресерч'),
      header(VISIBLE_ID, 'agent', 'Сверка'),
    ];

    expect(agentLines(AGENT_VERSION.content.agents, visible)).toEqual([
      'Сверка (system) — Сверка: описание',
    ]);
  });
});
