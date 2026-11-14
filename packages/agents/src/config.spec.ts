import { type AgentsConfig, parseAgentsConfig } from './config.js';
import { checkCatalog, createCatalog } from './definitions/catalog.js';
import { type AgentDefinition, GENERAL_PURPOSE } from './definitions/definition.js';

// Runtime settings and the start check of the catalog (design-agents.md, «Сборка», «Определения»):
// a wrong setting or catalog stops the start, naming the variable or the definition.

const LOGS_SERVER = { id: 'logs', command: 'node', args: ['fixture.js'], env: { MODE: 'logs' } };
const BACKOFFICE_SERVER = { id: 'backoffice', command: 'node', args: [], env: {} };
const SERVERS = [LOGS_SERVER, BACKOFFICE_SERVER];

const DEFAULT_MODEL = 'anthropic/claude-haiku-5-5';
const BUILTIN_TOOLS = ['start_agent', 'message_agent', 'list_agents', 'stop_agent'];

const RESEARCHER: AgentDefinition = {
  name: 'researcher',
  description: 'Researches a question in the logs.',
  prompt: 'Research.',
  tools: ['start_agent'],
  mcpServers: ['logs'],
  agents: ['general-purpose'],
  maxTurns: 10,
};

const checkWith = (definitions: AgentDefinition[], overrides: { defaultModel?: string } = {}) =>
  checkCatalog({
    definitions: [GENERAL_PURPOSE, ...definitions],
    toolNames: BUILTIN_TOOLS,
    serverIds: ['logs', 'backoffice'],
    pricedModels: [DEFAULT_MODEL],
    defaultModel: overrides.defaultModel ?? DEFAULT_MODEL,
  });

describe('agents configuration and catalog refuse to start naming the variable or the name', () => {
  it.each<[string, () => unknown, RegExp]>([
    ['AGENT_MAX_DEPTH=0', () => parseAgentsConfig({ AGENT_MAX_DEPTH: '0' }, SERVERS), /AGENT_MAX_DEPTH/],
    [
      'an access row names a server the servers file does not hold',
      () => parseAgentsConfig({ MCP_ACCESS_TABLE: '{"emp-1":["logs","crm"]}' }, SERVERS),
      /MCP_ACCESS_TABLE.*emp-1.*crm/,
    ],
    ['a servers file without servers', () => parseAgentsConfig({}, []), /MCP_SERVERS_FILE/],
    [
      'a repeated server id',
      () => parseAgentsConfig({}, [LOGS_SERVER, LOGS_SERVER]),
      /MCP_SERVERS_FILE.*logs/,
    ],
    [
      'a repeated definition name',
      () => {
        const catalog = createCatalog();
        catalog.register(RESEARCHER);
        catalog.register(RESEARCHER);
      },
      /researcher/,
    ],
    [
      'an unknown tool',
      () => checkWith([{ ...RESEARCHER, tools: ['send_email'] }]),
      /researcher.*send_email/,
    ],
    [
      'an unknown agent',
      () => checkWith([{ ...RESEARCHER, agents: ['planner'] }]),
      /researcher.*planner/,
    ],
    [
      'a definition model without a price',
      () => checkWith([{ ...RESEARCHER, model: 'anthropic/claude-opus-5-5' }]),
      /researcher.*claude-opus-5-5/,
    ],
    [
      'AGENT_DEFAULT_MODEL without a price',
      () => checkWith([], { defaultModel: 'anthropic/claude-sonnet-5-5' }),
      /AGENT_DEFAULT_MODEL/,
    ],
  ])('refuses %s', (_, start, problem) => {
    expect(start).toThrow(problem);
  });

  it('starts with the defaults of Runtime settings when everything is right', () => {
    const expected: AgentsConfig = {
      defaultModel: DEFAULT_MODEL,
      anthropicApiKey: '',
      anthropicBaseUrl: 'https://api.anthropic.com',
      maxOutputTokens: 16_000,
      maxDepth: 3,
      toolResultMaxBytes: 16_384,
      compactAtTokens: 200_000,
      mcpCallTimeoutMs: 60_000,
      mcpServers: SERVERS,
      mcpAccess: new Map(),
    };

    const config = parseAgentsConfig({ AGENT_MAX_DEPTH: '', MCP_ACCESS_TABLE: '' }, SERVERS);

    expect(config).toEqual(expected);
    expect(() => checkWith([RESEARCHER])).not.toThrow();
  });
});
