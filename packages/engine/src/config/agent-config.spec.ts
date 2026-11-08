import { z } from 'zod';
import { checkAgentDefinitions } from '../agents/definition-check.js';
import { createResultFormRegistry, type ResultForm, TEXT_FORM } from '../agents/result-forms.js';
import { BASE_TOOLS, createToolRegistry } from '../agents/tool-registry.js';
import { deepResearchProcessV2 } from '../processes/shipped-processes.js';
import { loadAnyProcessConfig, loadProcessConfig } from './load-process-config.js';

// AC-01.1, AC-13.2 (UC-2, UC-13 — the load row), DC-1, DC-22 (the key), DC-28 (UC-15), ADR-0009, ADR-0010: the load of
// the agents form and its checks against the engine's registries are pure functions, no doubles.

const TIMINGS = { turnMs: 60_000, deadlineMarginMs: 90_000 };

const definition = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'anthropic/claude-haiku-5-5',
  effort: 'low',
  prompt: 'Investigate {{query}} toward {{goal}}.',
  tools: ['memory_read', 'memory_write', 'call_agent'],
  calls: ['helper'],
  result: 'text',
  limits: {
    maxTurns: 8,
    maxCallsPerTurn: 4,
    maxChildren: 2,
    runTokens: 300_000,
    deadlineMs: 600_000,
    windowTokens: 200_000,
    marginTokens: 1_000,
    maxOutputTokens: 2_000,
  },
  ...patch,
});

function agentsConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    processId: 'agent-probe',
    version: 1,
    goal: 'Find the cause of the failures',
    sources: [{ sourceId: 'fixture', toolName: 'search_logs' }],
    agents: {
      lead: definition(),
      helper: definition({ tools: ['memory_read'], calls: [], sources: ['fixture'] }),
    },
    rootAgent: 'lead',
    modelKnowledgeRoot: 'helper',
    agentLimits: { maxDepth: 2 },
    limits: { investigationTokens: { default: 1_000_000, max: 2_000_000 }, maxTasks: 20, maxToolCalls: 40 },
    answer: { sections: ['summary', 'established', 'unknown'] },
    ...overrides,
  };
}

function withAgent(name: string, patch: Record<string, unknown>): Record<string, unknown> {
  const base = agentsConfig();
  const agents = base['agents'] as Record<string, Record<string, unknown>>;
  return { ...base, agents: { ...agents, [name]: { ...agents[name], ...patch } } };
}

const limitsWith = (patch: Record<string, unknown>) => ({
  limits: { ...(definition()['limits'] as object), ...patch },
});

/** `count` definitions without callees, named `a0`, `a1`, … */
const leaves = (count: number): Record<string, unknown> =>
  Object.fromEntries([...Array(count).keys()].map((index) => [`a${index}`, definition({ calls: [] })]));

describe('agents-form configuration load', () => {
  it('loads a valid agents-form configuration by the agents key', () => {
    const loaded = loadAnyProcessConfig(agentsConfig(), TIMINGS);

    expect(loaded.ok).toBe(true);
    expect(loaded.ok && 'agents' in loaded.config ? Object.keys(loaded.config.agents) : []).toEqual([
      'lead',
      'helper',
    ]);
  });

  it.each([
    [
      'an unknown callee',
      withAgent('lead', { calls: ['ghost'] }),
      ['agents', 'lead', 'calls', 0],
      'agent lead: calls ghost, which is not among agents',
    ],
    [
      'rootAgent outside agents',
      agentsConfig({ rootAgent: 'ghost' }),
      ['rootAgent'],
      'rootAgent ghost is not among agents',
    ],
    [
      'modelKnowledgeRoot outside agents',
      agentsConfig({ modelKnowledgeRoot: 'ghost' }),
      ['modelKnowledgeRoot'],
      'modelKnowledgeRoot ghost is not among agents',
    ],
    [
      'a source outside the process',
      withAgent('helper', { sources: ['elsewhere'] }),
      ['agents', 'helper', 'sources', 0],
      'agent helper: source elsewhere is not a source of the process',
    ],
    [
      'calls without call_agent',
      withAgent('lead', { tools: ['memory_read'] }),
      ['agents', 'lead', 'tools'],
      'agent lead: calls agents without call_agent in tools',
    ],
    [
      'deadlineMs equal to the margin plus the turn',
      withAgent('helper', limitsWith({ deadlineMs: 150_000 })),
      ['agents', 'helper', 'limits', 'deadlineMs'],
      'agent helper: deadlineMs 150000 leaves no turn: ' +
        'it must exceed AGENT_DEADLINE_MARGIN_MS + AGENT_TURN_MS = 150000',
    ],
  ])('refuses %s, naming the agent and the field', (_case, data, path, message) => {
    expect(loadAnyProcessConfig(data, TIMINGS)).toEqual({
      ok: false,
      rejection: { code: 'process_config_rejected', path, message },
    });
  });

  it.each([
    ['an unknown key of the roles form', agentsConfig({ capabilities: ['plan'] }), ['capabilities']],
    ['an unknown key of a definition', withAgent('lead', { roles: {} }), ['agents', 'lead', 'roles']],
    [
      'a prompt field outside the closed list',
      withAgent('helper', { prompt: 'Answer {{question}}.' }),
      ['agents', 'helper', 'prompt'],
    ],
    [
      'an agent name of 41 characters',
      agentsConfig({ agents: { ['a'.repeat(41)]: definition({ calls: [] }) } }),
      ['agents', 'a'.repeat(41)],
    ],
    ['17 definitions', agentsConfig({ agents: leaves(17) }), ['agents']],
    ['maxDepth 6', agentsConfig({ agentLimits: { maxDepth: 6 } }), ['agentLimits', 'maxDepth']],
    ['maxTurns 65', withAgent('lead', limitsWith({ maxTurns: 65 })), ['agents', 'lead', 'limits', 'maxTurns']],
    [
      'maxCallsPerTurn 17',
      withAgent('lead', limitsWith({ maxCallsPerTurn: 17 })),
      ['agents', 'lead', 'limits', 'maxCallsPerTurn'],
    ],
    ['maxChildren 33', withAgent('lead', limitsWith({ maxChildren: 33 })), ['agents', 'lead', 'limits', 'maxChildren']],
    [
      'deadlineMs over an hour',
      withAgent('lead', limitsWith({ deadlineMs: 3_600_001 })),
      ['agents', 'lead', 'limits', 'deadlineMs'],
    ],
    ['finish listed in tools', withAgent('helper', { tools: ['finish'] }), ['agents', 'helper', 'tools']],
  ])('refuses %s at its path', (_case, data, path) => {
    const loaded = loadAnyProcessConfig(data, TIMINGS);

    expect(loaded.ok ? null : loaded.rejection.path).toEqual(path);
  });

  it('accepts the bounds of the definition limits and 16 definitions', () => {
    const bounds = limitsWith({ maxTurns: 64, maxCallsPerTurn: 16, maxChildren: 32, deadlineMs: 3_600_000 });
    const data = withAgent('lead', bounds);
    const sixteen = { ...data, agents: { ...(data['agents'] as object), ...leaves(14) } };

    expect(loadAnyProcessConfig(sixteen, TIMINGS).ok).toBe(true);
  });

  it('loads the shipped v2 as before', () => {
    expect(loadAnyProcessConfig(deepResearchProcessV2, TIMINGS)).toEqual(loadProcessConfig(deepResearchProcessV2));
    expect(loadProcessConfig(deepResearchProcessV2).ok).toBe(true);
  });
});

/** A form with all three placement constraints: only on the root, on one definition, and with three tools at most. */
const PLACED_FORM: ResultForm = {
  name: 'placed',
  version: 1,
  resultSchema: z.strictObject({ verdict: z.string() }),
  onlyOn: 'rootAgent',
  maxDefinitions: 1,
  toolsAllowed: ['memory_read', 'memory_write', 'call_agent'],
};

/** A form two definitions of one configuration may not share. */
const ONCE_FORM: ResultForm = { ...TEXT_FORM, name: 'once', maxDefinitions: 1 };

const REGISTRIES = {
  tools: createToolRegistry(BASE_TOOLS),
  forms: createResultFormRegistry([TEXT_FORM, PLACED_FORM, ONCE_FORM]),
};

/** Loads `data` and checks it against the registries, as `createEngine` does. */
function loadAgainstRegistries(data: unknown) {
  const loaded = loadAnyProcessConfig(data, TIMINGS);
  if (!loaded.ok || !('agents' in loaded.config)) {
    throw new Error('the fixture must load as the agents form');
  }
  return checkAgentDefinitions(loaded.config, REGISTRIES);
}

describe('agents-form configuration against the registries', () => {
  it('accepts the configuration whose tools, forms and windows the registries allow', () => {
    expect(loadAgainstRegistries(withAgent('lead', { result: 'placed' }))).toBeNull();
    expect(loadAgainstRegistries(withAgent('lead', { result: 'once' }))).toBeNull();
  });

  it.each([
    [
      'a tool outside the registry',
      withAgent('helper', { tools: ['memory_read', 'web_search'] }),
      ['agents', 'helper', 'tools', 1],
      'agent helper: tool web_search is not in the tool registry',
    ],
    [
      'a result outside the form registry',
      withAgent('helper', { result: 'probe_record' }),
      ['agents', 'helper', 'result'],
      'agent helper: result form probe_record is not in the result-form registry',
    ],
    [
      'a form with onlyOn on another definition',
      withAgent('helper', { result: 'placed' }),
      ['agents', 'helper', 'result'],
      'agent helper: form placed may stand only on rootAgent (onlyOn)',
    ],
    [
      'a form named by more definitions than maxDefinitions',
      agentsConfig({
        agents: {
          lead: definition({ result: 'once' }),
          helper: definition({ tools: ['memory_read'], calls: [], result: 'once' }),
        },
      }),
      ['agents', 'lead', 'result'],
      'agent lead: form once is named by 2 definitions, at most 1 (maxDefinitions)',
    ],
    [
      'a form on a definition with a tool outside toolsAllowed',
      withAgent('lead', { result: 'placed', tools: ['memory_read', 'call_agent', 'investigation_read'] }),
      ['agents', 'lead', 'tools'],
      'agent lead: form placed does not allow tool investigation_read (toolsAllowed)',
    ],
  ])('refuses %s, naming the agent, the form and the constraint', (_case, data, path, message) => {
    const fault = loadAgainstRegistries(data);

    expect(fault).toEqual({ code: 'process_config_rejected', path, message });
  });

  // DC-1 with the divisor: the least view of `helper` (8 turns, 4 calls per turn, 2000 output tokens, a 30 000-byte
  // query and an 8000-character assignment at 3 bytes each) comes to about 35 000 tokens by the design's formula at
  // `BYTES_PER_TOKEN` = 3. A window of 60 000 holds it; 30 000 does not.
  // Defect caught: the estimate at 4 bytes per character, or bytes taken as tokens, refuses the 60 000 window.
  it('accepts a window that holds the least view of the session by the divisor', () => {
    expect(loadAgainstRegistries(withAgent('helper', limitsWith({ windowTokens: 60_000 })))).toBeNull();
  });

  it('refuses a window below the least view of the session', () => {
    const fault = loadAgainstRegistries(withAgent('helper', limitsWith({ windowTokens: 30_000 })));

    expect(fault?.path).toEqual(['agents', 'helper', 'limits', 'windowTokens']);
    expect(fault?.message).toMatch(
      /^agent helper: the least view of the session takes up to \d+ tokens, over windowTokens − marginTokens = 29000$/,
    );
  });

  // Fix cycle 1, D8: a root's opening is the investigation's question, up to 10 000 characters, while a called
  // definition's is an assignment of up to 8000. Defect caught: a root window that holds an 8000-character assignment
  // but not the 10 000-character question is accepted, and the root's first turn does not fit.
  it('estimates the opening of a root at the question bound and of a called definition at the assignment bound', () => {
    const leastOf = (message: string | undefined) => Number(/takes up to (\d+) tokens/.exec(message ?? '')?.[1]);
    const calledLeast = leastOf(loadAgainstRegistries(withAgent('leaf', definition(limitsWith({ windowTokens: 30_000 }))))?.message);
    const window = limitsWith({ windowTokens: calledLeast + 1_000 });

    const called = loadAgainstRegistries(withAgent('leaf', definition(window)));
    const root = loadAgainstRegistries(withAgent('lead', window));

    expect(called).toBeNull();
    expect(root?.path).toEqual(['agents', 'lead', 'limits', 'windowTokens']);
  });

  it('refuses a tool registry entry whose result limit is over 16 KiB', () => {
    const [memoryRead] = BASE_TOOLS;
    if (memoryRead === undefined) throw new Error('the base tools are empty');

    expect(() => createToolRegistry([{ ...memoryRead, resultMaxBytes: 16 * 1_024 + 1 }])).toThrow(
      'tool memory_read allows a result of 16385 bytes, over 16384',
    );
    expect(createToolRegistry([{ ...memoryRead, resultMaxBytes: 16 * 1_024 }]).has('memory_read')).toBe(true);
  });
});
