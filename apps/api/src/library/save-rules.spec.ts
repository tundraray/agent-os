import type { AgentContent, RecordBody } from '@agent-os/contracts';
import {
  decideDelete,
  decideSave,
  type SaveChoices,
  type SaveDecision,
  type SaveInput,
} from './save-rules';

const HAIKU = 'anthropic/haiku';
const SONNET = 'anthropic/sonnet';
const AGENT_SEEN = '00000000-0000-4000-8000-000000000001';
const AGENT_HIDDEN = '00000000-0000-4000-8000-000000000002';

function agent(fields: Partial<AgentContent> = {}): RecordBody {
  return {
    kind: 'agent',
    content: {
      prompt: 'Разбирай оплаты',
      servers: ['sentry'],
      model: HAIKU,
      maxTurns: 20,
      agents: [],
      tools: [],
      taskList: true,
      skills: [],
      ...fields,
    },
  };
}

/** A deep agent whose subagents hold `subagentServers`, each with `subagentModel`. */
function deepAgent(
  subagentServers: string[][],
  subagentModel: string,
  selfLearning = false,
): RecordBody {
  return {
    kind: 'deep_agent',
    content: {
      prompt: 'Собери ответ командой',
      servers: [],
      model: HAIKU,
      maxTurns: 20,
      subagents: subagentServers.map((servers, index) => ({
        name: `Сборщик ${index + 1}`,
        description: 'Собирает данные',
        prompt: 'Собери',
        servers,
        model: subagentModel,
        maxTurns: 10,
        maxRuns: 1,
        taskList: false,
      })),
      finalSubagent: null,
      taskList: true,
      listDelegation: true,
      selfLearning,
      scripts: [],
      skills: [],
    },
  };
}

const employee: SaveChoices = {
  scope: 'employee',
  usableServers: ['sentry'],
  allowedModels: [HAIKU],
  visibleAgentIds: [AGENT_SEEN],
  visibleSkillIds: [],
};
const admin: SaveChoices = {
  scope: 'system',
  registryServers: ['sentry', 'gmail', 'jira'],
  catalogueModels: [HAIKU, SONNET],
  visibleAgentIds: [AGENT_SEEN],
  visibleSkillIds: [],
};

function save(fields: Partial<SaveInput>): SaveInput {
  return {
    name: 'разбор оплат',
    body: agent(),
    previous: null,
    takenNames: { own: [], system: [] },
    choices: employee,
    ...fields,
  };
}

const allowed: SaveDecision = { kind: 'allowed' };
const refused = (reason: string, path: string, values: string[]) => ({
  kind: 'refused',
  reason,
  path,
  values,
});
const nameTaken = (reason: string, name: string) => ({
  kind: 'name_taken',
  reason,
  path: 'name',
  values: [name],
});

// KD-4, Flow 1: AC-06.1, AC-06.2, AC-07.1, AC-07.2, AC-07.3, DC-8, DC-9, DC-10; deep-agents KD-4, UC-2: AC-06.4 (the path and the values).
describe('save rule: names unique per owner and against system records, only added servers and agents checked, the model checked when the employee has one allowed, a refusal names the path and the values', () => {
  it.each<{ name: string; input: SaveInput; expected: unknown }>([
    {
      name: 'AC-06.1: the author has the name in another case and of another kind',
      input: save({
        name: 'Разбор Оплат',
        takenNames: { own: ['разбор оплат'], system: [] },
      }),
      expected: nameTaken('own', 'Разбор Оплат'),
    },
    {
      name: 'AC-06.2: a new record takes the name of a system record',
      input: save({
        name: 'General-Purpose',
        takenNames: { own: [], system: ['general-purpose'] },
      }),
      expected: nameTaken('system', 'General-Purpose'),
    },
    {
      name: 'DC-8: a save that keeps the name is not checked against system records',
      input: save({
        name: 'general-purpose',
        previous: { name: 'General-purpose', body: agent(), builtinKey: null },
        takenNames: { own: [], system: ['general-purpose'] },
      }),
      expected: allowed,
    },
    {
      name: 'DC-8: a rename to a system record name is refused',
      input: save({
        name: 'general-purpose',
        previous: { name: 'мой агент', body: agent(), builtinKey: null },
        takenNames: { own: [], system: ['general-purpose'] },
      }),
      expected: nameTaken('system', 'general-purpose'),
    },
    {
      // data-model «Таблицы каталога»: a record named `fork` could never be started by name.
      name: 'an employee record takes the name of the fork in any case',
      input: save({ name: 'Fork' }),
      expected: nameTaken('system', 'Fork'),
    },
    {
      name: 'a system record takes the name of the fork',
      input: save({ name: 'fork', choices: admin }),
      expected: nameTaken('own', 'fork'),
    },
    {
      name: 'AC-07.1: an added server the author may not use',
      input: save({ body: agent({ servers: ['sentry', 'gmail'] }) }),
      expected: refused('server_not_allowed', 'servers', ['gmail']),
    },
    {
      name: 'AC-06.4: a subagent server the author may not use is named by its path',
      input: save({ body: deepAgent([['sentry'], ['sentry', 'jira']], HAIKU) }),
      expected: refused('server_not_allowed', 'subagents.1.servers', ['jira']),
    },
    {
      name: 'AC-07.2: a server the author lost stays on a prompt edit',
      input: save({
        body: agent({ servers: ['sentry', 'jira'], prompt: 'Новый промпт' }),
        previous: {
          name: 'разбор оплат',
          body: agent({ servers: ['sentry', 'jira'] }),
          builtinKey: null,
        },
      }),
      expected: allowed,
    },
    {
      name: 'DC-10: all servers in an employee record',
      input: save({ body: agent({ servers: ['*'] }) }),
      expected: refused('all_servers_not_allowed', 'servers', ['*']),
    },
    {
      name: 'AC-06.4: all servers in a subagent of an employee record',
      input: save({ body: deepAgent([['sentry'], ['*']], HAIKU) }),
      expected: refused('all_servers_not_allowed', 'subagents.1.servers', [
        '*',
      ]),
    },
    {
      name: 'DC-9: a model not allowed while another one is',
      input: save({ body: agent({ model: SONNET }) }),
      expected: refused('model_not_allowed', 'model', [SONNET]),
    },
    {
      name: 'DC-9: a subagent model not allowed is named by its path',
      input: save({ body: deepAgent([['sentry']], SONNET) }),
      expected: refused('model_not_allowed', 'subagents.0.model', [SONNET]),
    },
    {
      name: 'DC-9: without allowed models the model is not checked',
      input: save({
        body: agent({ model: SONNET }),
        choices: { ...employee, allowedModels: [] },
      }),
      expected: allowed,
    },
    {
      name: 'an added agent the author does not see',
      input: save({ body: agent({ agents: [AGENT_SEEN, AGENT_HIDDEN] }) }),
      expected: refused('agent_not_visible', 'agents', [AGENT_HIDDEN]),
    },
    {
      name: 'an agent kept from before is not checked',
      input: save({
        body: agent({ agents: [AGENT_HIDDEN] }),
        previous: {
          name: 'разбор оплат',
          body: agent({ agents: [AGENT_HIDDEN] }),
          builtinKey: null,
        },
      }),
      expected: allowed,
    },
    {
      name: 'AC-07.3: an admin takes any registry server, all servers and any catalogue model',
      input: save({
        body: deepAgent([['gmail', 'jira'], ['*']], SONNET),
        choices: admin,
        previous: { name: 'разбор оплат', body: agent(), builtinKey: null },
      }),
      expected: allowed,
    },
    {
      name: 'self-learning AC-01.3: a default deep agent never learns, even by an admin',
      input: save({
        name: 'Глубокий агент',
        body: deepAgent([['sentry']], HAIKU, true),
        choices: admin,
        previous: {
          name: 'Глубокий агент',
          body: deepAgent([['sentry']], HAIKU),
          builtinKey: 'deep_agent',
        },
      }),
      expected: refused('builtin', 'selfLearning', []),
    },
    {
      name: 'AC-07.3: an admin takes all servers on a system record',
      input: save({ body: agent({ servers: ['*'] }), choices: admin }),
      expected: allowed,
    },
    {
      name: 'an admin may not add a server outside the registry',
      input: save({ body: agent({ servers: ['ghost'] }), choices: admin }),
      expected: refused('server_not_allowed', 'servers', ['ghost']),
    },
    {
      name: 'an admin may not add a model outside the catalogue',
      input: save({
        body: agent({ model: 'anthropic/ghost' }),
        choices: admin,
      }),
      expected: refused('model_not_allowed', 'model', ['anthropic/ghost']),
    },
    {
      name: 'a system record takes the name of another system record: reason own (the admin owns the system records)',
      input: save({
        name: 'Researcher',
        choices: admin,
        takenNames: { own: [], system: ['researcher'] },
      }),
      expected: nameTaken('own', 'Researcher'),
    },
  ])('$name', ({ input, expected }) => {
    expect(decideSave(input)).toEqual(expected);
  });
});

// AC-12.2; data-model design-agents.md KD-4, DC-22: no default agent can be deleted - one branch, any key.
describe('delete rule: a default agent is never deleted, any other agent is', () => {
  it.each<{ builtinKey: string | null; expected: unknown }>([
    { builtinKey: 'chat', expected: { kind: 'refused', reason: 'builtin' } },
    { builtinKey: null, expected: { kind: 'allowed' } },
  ])('key $builtinKey', ({ builtinKey, expected }) => {
    expect(decideDelete({ builtinKey })).toEqual(expected);
  });
});
