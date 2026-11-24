import type { AgentContent, RecordBody } from '@agent-os/contracts';
import { planCopy, type CopyInput } from './copy-rules';

const ANYA_MODEL = 'anthropic/sonnet';
const PLATFORM_MODEL = 'anthropic/haiku';
const BORIS_FIRST = 'anthropic/alpha';
const BORIS_SECOND = 'anthropic/beta';
const AGENT_SEEN = '00000000-0000-4000-8000-000000000001';
const AGENT_HIDDEN = '00000000-0000-4000-8000-000000000002';

function agent(fields: Partial<AgentContent> = {}): RecordBody {
  return {
    kind: 'agent',
    content: {
      prompt: 'Разбирай оплаты',
      servers: ['sentry'],
      model: ANYA_MODEL,
      maxTurns: 20,
      agents: [],
      tools: [],
      taskList: true,
      ...fields,
    },
  };
}

const subagent = {
  name: 'Сборщик',
  description: 'Собирает данные',
  prompt: 'Собери',
  servers: ['sentry', 'jira'],
  model: PLATFORM_MODEL,
  maxTurns: 10,
  maxRuns: 1,
  taskList: false,
};

const deepAgent: RecordBody = {
  kind: 'deep_agent',
  content: {
    prompt: 'Собери ответ командой',
    servers: [],
    model: ANYA_MODEL,
    maxTurns: 20,
    subagents: [subagent],
    finalSubagent: null,
    taskList: true,
    listDelegation: true,
    selfLearning: false,
    scripts: [],
  },
};

function copy(fields: Partial<CopyInput>): CopyInput {
  return {
    name: 'разбор оплат',
    body: agent(),
    takenNames: [],
    usableServers: ['sentry'],
    allowedModels: [ANYA_MODEL],
    defaultModel: PLATFORM_MODEL,
    visibleAgentIds: [AGENT_SEEN],
    language: 'ru',
    builtinKey: null,
    ...fields,
  };
}

const LONG_NAME = 'а'.repeat(80);

// Flow 3: AC-05.4, AC-05.5, DC-5, DC-6, DC-7; Failure Mode «missing config» (no allowed model).
describe("copy rule: a free name with the copy suffix, the copier's servers, each model replaced by the four steps of Flow 3, agents the copier does not see dropped and listed", () => {
  it.each<{ name: string; input: CopyInput; expected: unknown }>([
    {
      name: 'step 1: a model allowed to the copier stays',
      input: copy({}),
      expected: expect.objectContaining({ body: agent(), replacedModels: [] }),
    },
    {
      name: 'step 2: the platform model when allowed',
      input: copy({ allowedModels: [BORIS_FIRST, PLATFORM_MODEL] }),
      expected: expect.objectContaining({
        body: agent({ model: PLATFORM_MODEL }),
        replacedModels: [
          { subagent: null, from: ANYA_MODEL, to: PLATFORM_MODEL },
        ],
      }),
    },
    {
      name: 'AC-05.4: the first allowed model in «Мой доступ» order',
      input: copy({ allowedModels: [BORIS_FIRST, BORIS_SECOND] }),
      expected: expect.objectContaining({
        body: agent({ model: BORIS_FIRST }),
        replacedModels: [{ subagent: null, from: ANYA_MODEL, to: BORIS_FIRST }],
      }),
    },
    {
      name: 'AC-05.5: without allowed models the model stays',
      input: copy({ allowedModels: [] }),
      expected: expect.objectContaining({ body: agent(), replacedModels: [] }),
    },
    {
      name: 'a deep agent: each model replaced, servers the copier lacks dropped per subagent',
      input: copy({ body: deepAgent, allowedModels: [PLATFORM_MODEL] }),
      expected: expect.objectContaining({
        body: {
          kind: 'deep_agent',
          content: {
            ...deepAgent.content,
            model: PLATFORM_MODEL,
            subagents: [{ ...subagent, servers: ['sentry'] }],
          },
        },
        removedServers: [{ subagent: 'Сборщик', servers: ['jira'] }],
        replacedModels: [
          { subagent: null, from: ANYA_MODEL, to: PLATFORM_MODEL },
        ],
      }),
    },
    {
      name: 'DC-6: all servers become the servers usable to the copier',
      input: copy({
        body: agent({ servers: ['*'] }),
        usableServers: ['sentry', 'gitlab'],
      }),
      expected: expect.objectContaining({
        body: agent({ servers: ['sentry', 'gitlab'] }),
        removedServers: [],
      }),
    },
    {
      name: 'DC-7: agents the copier does not see are dropped and listed',
      input: copy({ body: agent({ agents: [AGENT_SEEN, AGENT_HIDDEN] }) }),
      expected: expect.objectContaining({
        body: agent({ agents: [AGENT_SEEN] }),
        removedAgents: [AGENT_HIDDEN],
      }),
    },
    {
      name: 'DC-5: the copy suffix',
      input: copy({}),
      expected: expect.objectContaining({ name: 'разбор оплат — копия' }),
    },
    {
      name: 'DC-5: the least free number, case aside',
      input: copy({
        takenNames: ['Разбор оплат — копия', 'разбор оплат — копия 3'],
      }),
      expected: expect.objectContaining({ name: 'разбор оплат — копия 2' }),
    },
    {
      name: 'DC-5: a long name is cut so the suffix fits in 80',
      input: copy({ name: LONG_NAME }),
      expected: expect.objectContaining({ name: `${'а'.repeat(72)} — копия` }),
    },
    {
      name: 'DC-5: a long name with a number is cut to 80',
      input: copy({
        name: LONG_NAME,
        takenNames: [`${'а'.repeat(72)} — копия`],
      }),
      expected: expect.objectContaining({
        name: `${'а'.repeat(70)} — копия 2`,
      }),
    },
    // i18n UC-3: AC-07.1, AC-07.2 (MC-8, MC-7), AC-06.4.
    {
      name: 'own record en: the copy mark in the copier’s language',
      input: copy({ language: 'en' }),
      expected: expect.objectContaining({ name: 'разбор оплат — copy' }),
    },
    {
      name: 'unrenamed Главный чат en → Main chat — copy',
      input: copy({ name: 'Главный чат', builtinKey: 'chat', language: 'en' }),
      expected: expect.objectContaining({ name: 'Main chat — copy' }),
    },
    {
      name: 'renamed built-in keeps the admin’s name',
      input: copy({
        name: 'Чат поддержки',
        builtinKey: 'chat',
        language: 'en',
      }),
      expected: expect.objectContaining({ name: 'Чат поддержки — copy' }),
    },
  ])('$name', ({ input, expected }) => {
    expect(planCopy(input)).toEqual(expected);
  });
});
