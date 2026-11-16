import { type AgentsConfig, parseAgentsConfig } from './config.js';
import { checkCatalog, createCatalog } from './definitions/catalog.js';
import { type AgentDefinition, GENERAL_PURPOSE } from './definitions/definition.js';

// Runtime settings and the start check of the catalog (design-agents.md, «Сборка», «Определения»):
// a wrong setting or catalog stops the start, naming the variable or the definition.

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

const checkWith = (definitions: AgentDefinition[]) =>
  checkCatalog({ definitions: [GENERAL_PURPOSE, ...definitions], toolNames: BUILTIN_TOOLS });

describe('agents configuration and catalog refuse to start naming the variable or the name', () => {
  it.each<[string, () => unknown, RegExp]>([
    ['AGENT_MAX_DEPTH=0', () => parseAgentsConfig({ AGENT_MAX_DEPTH: '0' }), /AGENT_MAX_DEPTH/],
    [
      'CODE_RUN_MAX_CONCURRENT_PER_USER=0',
      () => parseAgentsConfig({ CODE_RUN_MAX_CONCURRENT_PER_USER: '0' }),
      /CODE_RUN_MAX_CONCURRENT_PER_USER/,
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
      // code-execution DC-1: `run_code` is in every session, so a definition must not name it
      'a definition naming run_code',
      () => checkWith([{ ...RESEARCHER, tools: ['start_agent', 'run_code'] }]),
      /researcher: names run_code in tools, which every session has/,
    ],
    [
      'an unknown agent',
      () => checkWith([{ ...RESEARCHER, agents: ['planner'] }]),
      /researcher.*planner/,
    ],
    [
      // DC-11: a server the registry does not hold passes; a name of the wrong form does not
      'a server name that is not a registry name',
      () => checkWith([{ ...RESEARCHER, mcpServers: ['Logs_1'] }]),
      /researcher.*Logs_1/,
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
      allowHttpUrls: true,
      codeRun: {
        timeoutMs: 30_000,
        memoryMb: 512,
        maxToolCalls: 50,
        maxConcurrent: 4,
        maxConcurrentPerUser: 2,
      },
    };

    const config = parseAgentsConfig({ AGENT_MAX_DEPTH: '' });

    expect(config).toEqual(expected);
    expect(() => checkWith([{ ...RESEARCHER, mcpServers: ['not-registered'] }])).not.toThrow();
  });
});
