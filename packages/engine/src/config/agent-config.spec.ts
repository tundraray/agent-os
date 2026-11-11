import type { ResolvedSourceTool, SourceRegistry, SourceSchema } from '@agent-os/sources';
import { z } from 'zod';
import { checkAgentDefinitions } from '../agents/definition-check.js';
import { createResultFormRegistry, type ResultForm, TEXT_FORM } from '../agents/result-forms.js';
import { BASE_TOOLS, createToolRegistry, type ToolRegistryEntry } from '../agents/tool-registry.js';
import { buildCatalogField } from '../capabilities/catalog-field.js';
import { buildSourcesField } from '../capabilities/sources-field.js';
import { deepResearchProcessV3 } from '../processes/shipped-processes.js';
import { RESEARCH_FORMS } from '../research-flow/research-forms.js';
import { RESEARCH_TOOLS } from '../research-flow/research-tools.js';
import { loadProcessConfig } from './load-process-config.js';

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
    const loaded = loadProcessConfig(agentsConfig(), TIMINGS);

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
    expect(loadProcessConfig(data, TIMINGS)).toEqual({
      ok: false,
      rejection: { code: 'process_config_rejected', path, message },
    });
  });

  it.each([
    ['an unknown top-level key', agentsConfig({ capabilities: ['plan'] }), ['capabilities']],
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
    // Fix cycle 2: a name `gather` refuses must not load and stand in {{sources}}.
    [
      'a sourceId gather would refuse',
      agentsConfig({ sources: [{ sourceId: 'jira:prod', toolName: 'search_logs' }] }),
      ['sources', 0, 'sourceId'],
    ],
    [
      'a toolName gather would refuse',
      agentsConfig({ sources: [{ sourceId: 'fixture', toolName: 'search logs' }] }),
      ['sources', 0, 'toolName'],
    ],
    ['a sourceId over 64 characters', agentsConfig({ sources: [{ sourceId: 'a'.repeat(65), toolName: 'search_logs' }] }), ['sources', 0, 'sourceId']],
  ])('refuses %s at its path', (_case, data, path) => {
    const loaded = loadProcessConfig(data, TIMINGS);

    expect(loaded.ok ? null : loaded.rejection.path).toEqual(path);
  });

  it('accepts the bounds of the definition limits and 16 definitions', () => {
    const bounds = limitsWith({ maxTurns: 64, maxCallsPerTurn: 16, maxChildren: 32, deadlineMs: 3_600_000 });
    const data = withAgent('lead', bounds);
    const sixteen = { ...data, agents: { ...(data['agents'] as object), ...leaves(14) } };

    expect(loadProcessConfig(sixteen, TIMINGS).ok).toBe(true);
  });

  // UC-15, AC-19.1, FR-19: the agents form is the only form. Defect caught: a file without `agents` loads, silently.
  it('refuses a file without agents with process_config_rejected', () => {
    const withoutAgents = {
      processId: 'deep-research',
      version: 3,
      goal: 'Find the cause of the incident.',
      sources: [],
      limits: { maxSteps: 12 },
      answer: { sections: ['summary', 'established'] },
    };

    const loaded = loadProcessConfig(withoutAgents, TIMINGS);

    expect(loaded).toMatchObject({ ok: false, rejection: { code: 'process_config_rejected' } });
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

/** A tool with the mark that allows `{{sources}}`, beside the base tools. */
const READS_SOURCES_TOOL: ToolRegistryEntry = {
  name: 'reads_sources',
  description: 'Reads the sources of this run',
  argsSchema: z.strictObject({}),
  effect: 'read',
  resultMaxBytes: 1_024,
  readsRunSources: true,
};

/** A tool with the mark that allows `{{catalog}}`, beside the base tools. */
const READS_CATALOG_TOOL: ToolRegistryEntry = {
  name: 'reads_catalog',
  description: 'Checks the plan against the catalog of this run',
  argsSchema: z.strictObject({}),
  effect: 'write',
  resultMaxBytes: 1_024,
  readsRunCatalog: true,
};

/** Bytes of the `sources` value of the one pair of `agentsConfig` by the filler of its argument schema. */
let schemaFiller = 0;
/** Bytes of the `catalog` value of the one source of `agentsConfig` by the filler of its description. */
let descriptionFiller = 0;
const fixtureArgs = (): SourceSchema => z.strictObject({}).describe('x'.repeat(schemaFiller));
const resolveFixture: SourceRegistry['resolveTool'] = () =>
  ({ adapter: {}, tool: { argsSchema: fixtureArgs() }, description: 'Searches the logs.' }) as ResolvedSourceTool;
const describeFixture: SourceRegistry['describeSource'] = () => 'd'.repeat(descriptionFiller);

const REGISTRIES = {
  tools: createToolRegistry([...BASE_TOOLS, READS_SOURCES_TOOL, READS_CATALOG_TOOL]),
  forms: createResultFormRegistry([TEXT_FORM, PLACED_FORM, ONCE_FORM]),
  resolveTool: resolveFixture,
  describeSource: describeFixture,
  buildSourcesField,
  buildCatalogField,
};

const FIXTURE_FIELD_INPUT = {
  configSources: [{ sourceId: 'fixture', toolName: 'search_logs' }],
  runSources: ['fixture'],
  resolveTool: resolveFixture,
  describeSource: describeFixture,
};

/** The filler that makes the value of the one pair of `agentsConfig` exactly `bytes` long. */
function setValueBytes(bytes: number): void {
  schemaFiller = 0;
  schemaFiller = bytes - Buffer.byteLength(buildSourcesField(FIXTURE_FIELD_INPUT), 'utf8');
}

/** The filler that makes the `{{catalog}}` value of the one source of `agentsConfig` exactly `bytes` long. */
function setCatalogBytes(bytes: number): void {
  descriptionFiller = 0;
  descriptionFiller = bytes - Buffer.byteLength(buildCatalogField(FIXTURE_FIELD_INPUT), 'utf8');
}

/** Loads `data` and checks it against the registries, as `createEngine` does. */
function loadAgainstRegistries(data: unknown) {
  const loaded = loadProcessConfig(data, TIMINGS);
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

  // KD-9, DC-31, DC-1, UC-2 (design-agent-core.md, «Поле шаблона sources»). Defects caught: the limit checked after the
  // window, so a value over the limit is reported at `limits.windowTokens`; the least view estimated without the value;
  // the field accepted on a definition that cannot gather; a role prompt accepting it.
  describe('the sources field', () => {
    const withField = (patch: Record<string, unknown> = {}) =>
      withAgent('helper', { prompt: 'Sources: {{sources}}', tools: ['reads_sources'], ...patch });
    const leastOf = (message: string | undefined) => Number(/takes up to (\d+) tokens/.exec(message ?? '')?.[1]);

    afterEach(() => {
      schemaFiller = 0;
    });

    it('accepts the field on a definition with a tool marked as reading the run sources', () => {
      expect(loadAgainstRegistries(withField())).toBeNull();
    });

    it('accepts the agents-form field at the schema, and the mark alone decides the definition', () => {
      const fault = loadAgainstRegistries(withField({ tools: ['memory_read'] }));

      expect(fault).toEqual({
        code: 'process_config_rejected',
        path: ['agents', 'helper', 'prompt'],
        message: 'agent helper: {{sources}} needs a tool that reads the sources of the run',
      });
    });

    it('accepts a longest value of 8192 bytes under a sufficient window', () => {
      setValueBytes(8_192);

      expect(loadAgainstRegistries(withField())).toBeNull();
    });

    it('refuses a value of 8193 bytes at the prompt, even when the window would refuse it too', () => {
      setValueBytes(8_193);

      expect(loadAgainstRegistries(withField(limitsWith({ windowTokens: 2_000 })))).toEqual({
        code: 'process_config_rejected',
        path: ['agents', 'helper', 'prompt'],
        message: 'agent helper: the longest {{sources}} value takes 8193 bytes, over 8192',
      });
    });

    it('measures the value on the sources the definition names, not on the pairs of the process', () => {
      setValueBytes(8_193);

      expect(loadAgainstRegistries(withField({ sources: [] }))).toBeNull();
    });

    it('adds the value at its limit to the least view', () => {
      setValueBytes(8_192);
      const narrow = limitsWith({ windowTokens: 2_000 });

      const withValue = leastOf(loadAgainstRegistries(withField(narrow))?.message);
      const withoutField = leastOf(loadAgainstRegistries(withField({ prompt: 'Sources: ', ...narrow }))?.message);

      // 8192 bytes at 3 bytes per token, rounded up on either side of the sum.
      expect([2_730, 2_731]).toContain(withValue - withoutField);
    });

    it('does not build the value for a template that does not name the field', () => {
      const unbuildable = {
        ...REGISTRIES,
        buildSourcesField: () => {
          throw new Error('the value must not be built');
        },
        buildCatalogField: () => {
          throw new Error('the value must not be built');
        },
      };
      const loaded = loadProcessConfig(withAgent('helper', { tools: ['reads_sources'] }), TIMINGS);
      if (!loaded.ok) throw new Error('the fixture must load');

      expect(checkAgentDefinitions(loaded.config, unbuildable)).toBeNull();
    });

  });

  // DC-4, AC-05.2 (the load rule), KD-3 (design-catalog-planning.md, «Поля шаблона»). Defects caught: `{{catalog}}`
  // accepted on an agent without the tool that checks the plan against the catalog; the limit of the catalog not checked,
  // so an oversized catalog reaches the plan agent; the least view estimated without the catalog; the loader not seeing
  // the declared sources (the value built from nothing), or failing when no source is connected.
  describe('the catalog field', () => {
    const withCatalog = (patch: Record<string, unknown> = {}) =>
      withAgent('helper', { prompt: 'Catalog: {{catalog}}', tools: ['reads_catalog'], ...patch });
    const leastOf = (message: string | undefined) => Number(/takes up to (\d+) tokens/.exec(message ?? '')?.[1]);

    afterEach(() => {
      descriptionFiller = 0;
    });

    it('accepts the field on a definition with a tool marked as reading the run catalog, the value at its limit', () => {
      setCatalogBytes(8_192);

      expect(loadAgainstRegistries(withCatalog())).toBeNull();
    });

    it.each([
      [
        'on a definition without a tool marked readsRunCatalog',
        () => withCatalog({ tools: ['reads_sources'] }),
        ['agents', 'helper', 'prompt'],
        'agent helper: {{catalog}} needs a tool that checks the plan against the catalog of the run',
      ],
      [
        'with a longest value of 8193 bytes, even when the window would refuse it too',
        () => {
          setCatalogBytes(8_193);
          return withCatalog(limitsWith({ windowTokens: 2_000 }));
        },
        ['agents', 'helper', 'prompt'],
        'agent helper: the longest {{catalog}} value takes 8193 bytes, over 8192',
      ],
    ])('refuses {{catalog}} %s', (_case, data, path, message) => {
      expect(loadAgainstRegistries(data())).toEqual({ code: 'process_config_rejected', path, message });
    });

    it('refuses {{catalog}} when the least view with its longest value does not fit the window', () => {
      setCatalogBytes(8_192);
      const leastWithout = leastOf(loadAgainstRegistries(withCatalog({ prompt: 'Catalog: ', ...limitsWith({ windowTokens: 2_000 }) }))?.message);
      // Room for the view without the value and 1 000 tokens more: the value at its limit takes about 2 730.
      const window = limitsWith({ windowTokens: leastWithout + 1_000 + 1_000 });

      expect(loadAgainstRegistries(withCatalog({ prompt: 'Catalog: ', ...window }))).toBeNull();
      expect(loadAgainstRegistries(withCatalog(window))?.path).toEqual(['agents', 'helper', 'limits', 'windowTokens']);
    });

    it('measures the value on the sources the definition names', () => {
      setCatalogBytes(8_193);

      expect(loadAgainstRegistries(withCatalog({ sources: [] }))).toBeNull();
    });

    it('loads with {{catalog}} when no source is connected', () => {
      const unconnected = {
        ...REGISTRIES,
        resolveTool: () => null,
        describeSource: (sourceId: string): string => {
          throw new Error(`source ${sourceId} is not declared`);
        },
      };
      const loaded = loadProcessConfig(withCatalog(), TIMINGS);
      if (!loaded.ok) throw new Error('the fixture must load');

      expect(checkAgentDefinitions(loaded.config, unconnected)).toBeNull();
    });
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

// UC-5, AC-13.1, AC-13.2, DC-4 (design-research-flow.md, FR-13): the broken variants of the shipped v3 against the
// engine's registries. Defects caught: a form of the research process without its placement constraint (`research_close`
// off the root, `answer_draft` off `modelKnowledgeRoot`, a second checker, a checker or an answer agent with tools).
describe('deep-research v3: the configuration is refused with the agent, the form and the constraint', () => {
  const SHIPPED_REGISTRIES = {
    tools: createToolRegistry([...BASE_TOOLS, ...RESEARCH_TOOLS]),
    forms: createResultFormRegistry([TEXT_FORM, ...RESEARCH_FORMS]),
    resolveTool: () => null,
    describeSource: (sourceId: string): string => {
      throw new Error(`source ${sourceId} is not declared`);
    },
    buildSourcesField,
    buildCatalogField,
  };
  const shipped = deepResearchProcessV3 as { agents: Record<string, Record<string, unknown>> };
  const v3With = (name: string, patch: Record<string, unknown>): Record<string, unknown> => ({
    ...shipped,
    agents: { ...shipped.agents, [name]: { ...shipped.agents[name], ...patch } },
  });

  it('refuses an unknown key of a definition at its path', () => {
    const loaded = loadProcessConfig(v3With('planner', { roles: {} }), TIMINGS);

    expect(loaded.ok ? null : loaded.rejection.path).toEqual(['agents', 'planner', 'roles']);
  });

  it.each([
    [
      'research_close on a definition that is not the root',
      v3With('worker', { result: 'research_close' }),
      ['agents', 'worker', 'result'],
      'agent worker: form research_close may stand only on rootAgent (onlyOn)',
    ],
    [
      'answer_draft on a definition that is not modelKnowledgeRoot',
      v3With('planner', { result: 'answer_draft' }),
      ['agents', 'planner', 'result'],
      'agent planner: form answer_draft may stand only on modelKnowledgeRoot (onlyOn)',
    ],
    [
      'two definitions with claim_assessment',
      v3With('synthesis', { result: 'claim_assessment' }),
      ['agents', 'verifier', 'result'],
      'agent verifier: form claim_assessment is named by 2 definitions, at most 1 (maxDefinitions)',
    ],
    [
      'a tool on the verifier',
      v3With('verifier', { tools: ['memory_read'] }),
      ['agents', 'verifier', 'tools'],
      'agent verifier: form claim_assessment does not allow tool memory_read (toolsAllowed)',
    ],
    [
      'a tool on the answer agent',
      v3With('synthesis', { tools: ['memory_read'] }),
      ['agents', 'synthesis', 'tools'],
      'agent synthesis: form answer_draft does not allow tool memory_read (toolsAllowed)',
    ],
    // DC-14, moved from research-flow INT-1 C: on the shipped v3 only worker and subworker read the run's sources.
    ...(['verifier', 'controller'] as const).map((agent): [string, Record<string, unknown>, (string | number)[], string] => [
      `{{sources}} in the template of ${agent}`,
      v3With(agent, { prompt: `${String(shipped.agents[agent]?.['prompt'])}
{{sources}}` }),
      ['agents', agent, 'prompt'],
      `agent ${agent}: {{sources}} needs a tool that reads the sources of the run`,
    ]),
  ])('refuses %s', (_case, data, path, message) => {
    const loaded = loadProcessConfig(data, TIMINGS);
    if (!loaded.ok || !('agents' in loaded.config)) {
      throw new Error('the variant must load as the agents form');
    }

    expect(checkAgentDefinitions(loaded.config, SHIPPED_REGISTRIES)).toEqual({
      code: 'process_config_rejected',
      path,
      message,
    });
  });
});
