import type { AgentContent, RecordBody } from '@agent-os/contracts';
import {
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
      ...fields,
    },
  };
}

function workflow(
  executorServers: string[],
  executorModel: string,
): RecordBody {
  return {
    kind: 'workflow',
    content: {
      coordinator: { rules: '', model: HAIKU, maxTurns: 20 },
      executors: [
        {
          name: 'Сборщик',
          role: 'Собирает данные',
          prompt: 'Собери',
          servers: executorServers,
          model: executorModel,
          maxTurns: 10,
          maxRuns: 1,
          tools: [],
          source: null,
        },
      ],
      finalExecutor: null,
      selfLearning: false,
    },
  };
}

const employee: SaveChoices = {
  scope: 'employee',
  usableServers: ['sentry'],
  allowedModels: [HAIKU],
  visibleAgentIds: [AGENT_SEEN],
};
const admin: SaveChoices = {
  scope: 'system',
  registryServers: ['sentry', 'gmail', 'jira'],
  catalogueModels: [HAIKU, SONNET],
  visibleAgentIds: [AGENT_SEEN],
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
const refused = (reason: string) => ({ kind: 'refused', reason });
const nameTaken = (reason: string) => ({ kind: 'name_taken', reason });

// KD-4, Flow 1: AC-06.1, AC-06.2, AC-07.1, AC-07.2, AC-07.3, DC-8, DC-9, DC-10.
describe('save rule: names unique per owner and against system records, only added servers and agents checked, the model checked when the employee has one allowed', () => {
  it.each<{ name: string; input: SaveInput; expected: unknown }>([
    {
      name: 'AC-06.1: the author has the name in another case and of another kind',
      input: save({
        name: 'Разбор Оплат',
        takenNames: { own: ['разбор оплат'], system: [] },
      }),
      expected: nameTaken('own'),
    },
    {
      name: 'AC-06.2: a new record takes the name of a system record',
      input: save({
        name: 'General-Purpose',
        takenNames: { own: [], system: ['general-purpose'] },
      }),
      expected: nameTaken('system'),
    },
    {
      name: 'DC-8: a save that keeps the name is not checked against system records',
      input: save({
        name: 'general-purpose',
        previous: { name: 'General-purpose', body: agent() },
        takenNames: { own: [], system: ['general-purpose'] },
      }),
      expected: allowed,
    },
    {
      name: 'DC-8: a rename to a system record name is refused',
      input: save({
        name: 'general-purpose',
        previous: { name: 'мой агент', body: agent() },
        takenNames: { own: [], system: ['general-purpose'] },
      }),
      expected: nameTaken('system'),
    },
    {
      name: 'AC-07.1: an added server the author may not use',
      input: save({ body: agent({ servers: ['sentry', 'gmail'] }) }),
      expected: refused('server_not_allowed'),
    },
    {
      name: 'AC-07.1: an executor server the author may not use',
      input: save({ body: workflow(['gmail'], HAIKU) }),
      expected: refused('server_not_allowed'),
    },
    {
      name: 'AC-07.2: a server the author lost stays on a prompt edit',
      input: save({
        body: agent({ servers: ['sentry', 'jira'], prompt: 'Новый промпт' }),
        previous: {
          name: 'разбор оплат',
          body: agent({ servers: ['sentry', 'jira'] }),
        },
      }),
      expected: allowed,
    },
    {
      name: 'DC-10: all servers in an employee record',
      input: save({ body: agent({ servers: ['*'] }) }),
      expected: refused('all_servers_not_allowed'),
    },
    {
      name: 'DC-9: a model not allowed while another one is',
      input: save({ body: agent({ model: SONNET }) }),
      expected: refused('model_not_allowed'),
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
      expected: refused('agent_not_visible'),
    },
    {
      name: 'an agent kept from before is not checked',
      input: save({
        body: agent({ agents: [AGENT_HIDDEN] }),
        previous: {
          name: 'разбор оплат',
          body: agent({ agents: [AGENT_HIDDEN] }),
        },
      }),
      expected: allowed,
    },
    {
      name: 'AC-07.3: an admin takes any registry server, all servers and any catalogue model',
      input: save({
        body: workflow(['gmail', 'jira'], SONNET),
        choices: admin,
        previous: { name: 'разбор оплат', body: agent() },
      }),
      expected: allowed,
    },
    {
      name: 'AC-07.3: an admin takes all servers on a system record',
      input: save({ body: agent({ servers: ['*'] }), choices: admin }),
      expected: allowed,
    },
    {
      name: 'an admin may not add a server outside the registry',
      input: save({ body: agent({ servers: ['ghost'] }), choices: admin }),
      expected: refused('server_not_allowed'),
    },
    {
      name: 'an admin may not add a model outside the catalogue',
      input: save({
        body: agent({ model: 'anthropic/ghost' }),
        choices: admin,
      }),
      expected: refused('model_not_allowed'),
    },
    {
      name: 'a system record takes the name of another system record: reason own (the admin owns the system records)',
      input: save({
        name: 'Researcher',
        choices: admin,
        takenNames: { own: [], system: ['researcher'] },
      }),
      expected: nameTaken('own'),
    },
  ])('$name', ({ input, expected }) => {
    expect(decideSave(input)).toEqual(expected);
  });
});
