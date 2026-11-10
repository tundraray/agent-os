import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '@agent-os/db';
import { systemClock } from '@agent-os/runtime';
import type { SourceRegistry, SourceSchema } from '@agent-os/sources';
import { z } from 'zod';
import type * as AgentRunHandlerModule from './agents/agent-run.handler.js';
import { definitionMemoryFingerprint } from './agents/fingerprint.js';
import { type ResultFormRegistry, TEXT_FORM } from './agents/result-forms.js';
import { agentToolsOf, type ToolRegistry } from './agents/tool-registry.js';
import { AgentProcessConfigSchema } from './config/agent-config.schema.js';
import type { GroupTable } from './calibration/group-table.js';
import { DEFAULT_MODEL_CATALOG, type ModelCatalog } from './config/model-catalog.js';
import { composeEngine, createEngine, type CreateEngineOptions } from './create-engine.js';
import type { EngineLogger, ResolveModel, RoleModel } from './ports.js';
import { shippedGroupTables } from './processes/shipped-group-tables.js';
import { deepResearchProcessV3 } from './processes/shipped-processes.js';
import { claimAssessmentAgent } from './research-flow/forms/claim-assessment.js';

/** What the assembly hands its consumers: both modules work as they are, the double only keeps the argument. */
const assembled = vi.hoisted(() => ({
  agentForms: undefined as ResultFormRegistry | undefined,
  agentTools: undefined as ToolRegistry | undefined,
}));
vi.mock('./agents/agent-run.handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentRunHandlerModule>();
  return {
    ...actual,
    createAgentRunHandlers: (deps: AgentRunHandlerModule.AgentRunHandlerDeps) => {
      assembled.agentForms = deps.registries.forms;
      assembled.agentTools = deps.registries.tools;
      return actual.createAgentRunHandlers(deps);
    },
  };
});
// UC-12 (first half), AC-26.2, AC-26.3, AC-25.3 (mode half), DC-14, DC-18, KD-8, `resolveModel`: creating the engine.
// Without connected sources the configuration's sources are not checked, creation passes with exactly one `warn`
// and the mode is `model_knowledge`; with one the DC-14 check refuses a pair outside the allowlist, the mode is
// `sources` and nothing is warned; a connected source that stops answering changes neither; a throwing `resolveModel`
// on any definition of any loaded configuration refuses creation with that definition's path.
// Defects caught: the DC-14 check run on an empty list; the warning missing, repeated or written with a source; the
// mode computed from source availability instead of the list; definition models resolved lazily or for the first
// configuration only.
// Boundary doubles: the runtime ports, the source registry and the model port by their narrow types; the database is
// never touched while the engine is created.

const CONNECTED = ['fixture'];
const OTHER_MODEL = 'anthropic/claude-other-model';

/** Fails any access: creating the engine and reading `sourceMode` must not reach the database. */
const untouchableDatabase = new Proxy(
  {},
  {
    get(_, property) {
      throw new Error(`the database was touched (${String(property)})`);
    },
  },
) as Database;

const notCalled = (port: string) => () => Promise.reject(new Error(`${port} was called while creating the engine`));

/** A model instance the engine only hands to the agent turns; nothing calls it while the engine is created. */
const modelDouble = (modelId: string): RoleModel => ({
  specificationVersion: 'v2',
  provider: 'test',
  modelId,
  supportedUrls: {},
  doGenerate: notCalled(`doGenerate of ${modelId}`),
  doStream: notCalled(`doStream of ${modelId}`),
});

/**
 * A registry whose allowlist holds every pair while `available`, and none once the source stops answering. Its tool has a
 * zod argument schema, because the load builds the value of `{{sources}}` from it.
 */
function registryDouble(allows: boolean) {
  const state = { available: true };
  const tool: { argsSchema: SourceSchema } = { argsSchema: z.strictObject({ from: z.string(), to: z.string() }) };
  const registry: CreateEngineOptions['sourceRegistry'] = {
    resolveTool: () =>
      allows && state.available ? ({ adapter: {}, tool } as ReturnType<SourceRegistry['resolveTool']>) : null,
    currentSnapshot: notCalled('currentSnapshot'),
  };
  return { registry, state };
}

function recordingLogger() {
  const warnings: string[] = [];
  const logger: EngineLogger = { log: () => undefined, warn: (message) => warnings.push(message), error: () => undefined };
  return { logger, warnings };
}

const shippedV3 = deepResearchProcessV3 as { agents: Record<string, Record<string, unknown>> } & Record<string, unknown>;

/** The shipped deep-research configuration as version 4 with the verifier on a model only this test resolves. */
const secondVersion = {
  ...shippedV3,
  version: 4,
  agents: { ...shippedV3.agents, verifier: { ...shippedV3.agents['verifier'], model: OTHER_MODEL } },
};

/** A group table the schema accepts. */
const VALID_TABLE = {
  model: 'anthropic/claude-haiku-5-5',
  agentFingerprint: '0123456789ab',
  definitionMemoryFingerprint: 'abcdef012345',
  scenarioSet: 'test',
  pairsFingerprint: 'ba9876543210',
  calibratedAt: '2026-11-07T00:00:00.000Z',
  groupCount: 3,
  profiles: [],
  groups: [],
  pairKinds: [],
};

const catalog: ModelCatalog = {
  ...DEFAULT_MODEL_CATALOG,
  [OTHER_MODEL]: DEFAULT_MODEL_CATALOG['anthropic/claude-haiku-5-5'],
};

function options(overrides: {
  connectedSources: readonly string[];
  registry: CreateEngineOptions['sourceRegistry'];
  logger: EngineLogger;
  resolveModel?: ResolveModel;
  groupTables?: readonly unknown[];
}): CreateEngineOptions {
  return {
    database: untouchableDatabase,
    runtime: {
      scheduler: { propose: notCalled('propose') },
      investigations: {
        create: notCalled('create'),
        listForThread: notCalled('listForThread'),
        cancel: notCalled('cancel'),
        closeInTx: notCalled('closeInTx'),
      },
      handlers: { register: () => undefined },
      eventConsumers: { register: () => undefined },
    },
    sourceRegistry: overrides.registry,
    connectedSources: overrides.connectedSources,
    processes: [deepResearchProcessV3, secondVersion],
    resolveModel: overrides.resolveModel ?? modelDouble,
    tokenCounter: { countTurnInputTokens: notCalled('countTurnInputTokens') },
    clock: systemClock,
    modelCatalog: catalog,
    ...(overrides.groupTables === undefined ? {} : { groupTables: overrides.groupTables }),
    logger: overrides.logger,
  };
}

function caught(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error('expected createEngine to throw');
}

describe('createEngine: the deployment sets the source mode once, and every definition model resolves at creation', () => {
  it.each<[string, readonly string[], boolean, 'sources' | 'model_knowledge', number]>([
    ['no connected source, configured sources outside the allowlist → model_knowledge, one warning', [], false, 'model_knowledge', 1],
    ['a connected source and allowlisted configured sources → sources, no warning', CONNECTED, true, 'sources', 0],
  ])('%s; a source that stops answering changes neither', (_, connectedSources, allows, mode, warnings) => {
    const { registry, state } = registryDouble(allows);
    const log = recordingLogger();

    const engine = createEngine(options({ connectedSources, registry, logger: log.logger }));
    expect(engine.sourceMode).toBe(mode);
    expect(log.warnings).toHaveLength(warnings);
    if (warnings === 1) {
      expect(log.warnings[0]).toMatch(/no data source is connected.*model knowledge/);
    }

    state.available = false;
    expect(engine.sourceMode).toBe(mode);
    expect(log.warnings).toHaveLength(warnings);
  });

  it.each<[string, readonly string[], boolean, ResolveModel | undefined, readonly unknown[] | undefined, readonly (string | number)[]]>([
    [
      'a connected source with a configured pair outside the allowlist (DC-14)',
      CONNECTED,
      false,
      undefined,
      undefined,
      [0, 'sources', 0],
    ],
    [
      'resolveModel throwing on a definition of the second loaded configuration',
      CONNECTED,
      true,
      (modelId) => {
        if (modelId === OTHER_MODEL) throw new Error(`no client for ${modelId}`);
        return modelDouble(modelId);
      },
      undefined,
      [1, 'agents', 'verifier', 'model'],
    ],
    // KD-3: a group table is data like a configuration; one the schema refuses never reaches a verification.
    [
      'a group table that fails its schema (a three-group table naming very_high)',
      CONNECTED,
      true,
      undefined,
      [VALID_TABLE, { ...VALID_TABLE, groups: [{ group: 'very_high', establishedPairs: 1, correctShare: 1 }] }],
      ['groupTables', 1],
    ],
  ])('refuses creation with the path for %s, and warns nothing', (_, connectedSources, allows, resolveModel, groupTables, path) => {
    const { registry } = registryDouble(allows);
    const log = recordingLogger();

    const error = caught(() => createEngine(options({ connectedSources, registry, logger: log.logger, resolveModel, groupTables })));

    expect(error).toMatchObject({ code: 'process_config_rejected', path });
    expect(log.warnings).toHaveLength(0);
  });
});

// KD-7, KD-8, ADR-0009, ADR-0010: a probe configuration loads through the same creation, its definition models resolve
// at creation, and a result form reaches the registry only through the internal assembly `composeEngine` —
// `createEngine` has the shipped forms alone.
// Defects caught: a definition model resolved lazily; a form the public assembly lets in from outside the engine; a
// configured source left out of the DC-14 allowlist check.
describe('composeEngine: the result-form registry is assembled inside the engine', () => {
  const PROBE_FORM = { name: 'probe_record', version: 1, resultSchema: z.strictObject({ note: z.string() }) };
  const agentsConfig = {
    processId: 'agent-probe',
    version: 1,
    goal: 'Probe the agents form',
    sources: [],
    agents: {
      lead: {
        model: OTHER_MODEL,
        effort: 'low',
        prompt: 'Answer {{query}}.',
        tools: [],
        result: 'probe_record',
        limits: {
          maxTurns: 4,
          maxCallsPerTurn: 2,
          maxChildren: 0,
          runTokens: 300_000,
          deadlineMs: 600_000,
          windowTokens: 200_000,
          marginTokens: 1_000,
          maxOutputTokens: 2_000,
        },
      },
    },
    rootAgent: 'lead',
    agentLimits: { maxDepth: 1 },
    limits: { investigationTokens: { default: 300_000, max: 600_000 }, maxTasks: 5, maxToolCalls: 5 },
    answer: { sections: ['summary'] },
  };
  const withAgents = (resolveModel?: ResolveModel) => {
    const { registry } = registryDouble(true);
    const base = options({ connectedSources: CONNECTED, registry, logger: recordingLogger().logger, resolveModel });
    return { ...base, processes: [agentsConfig] };
  };

  it('creates the engine with an agents-form configuration whose form the internal assembly registers', () => {
    expect(composeEngine(withAgents(), { resultForms: [TEXT_FORM, PROBE_FORM] }).sourceMode).toBe('sources');
  });

  it.each<[string, () => unknown, readonly (string | number)[]]>([
    ['createEngine, which has only the shipped text form', () => createEngine(withAgents()), [0, 'agents', 'lead', 'result']],
    [
      'resolveModel throwing on the definition model',
      () =>
        composeEngine(
          withAgents((modelId) => {
            if (modelId === OTHER_MODEL) throw new Error(`no client for ${modelId}`);
            return modelDouble(modelId);
          }),
          { resultForms: [TEXT_FORM, PROBE_FORM] },
        ),
      [0, 'agents', 'lead', 'model'],
    ],
    [
      'a configured source outside the source.fetch allowlist with a connected source (DC-14)',
      () =>
        composeEngine(
          {
            ...withAgents(),
            processes: [{ ...agentsConfig, sources: [{ sourceId: 'fixture', toolName: 'search_logs' }] }],
            sourceRegistry: registryDouble(false).registry,
          },
          { resultForms: [TEXT_FORM, PROBE_FORM] },
        ),
      [0, 'sources', 0],
    ],
  ])('refuses the agents-form configuration through %s', (_case, create, path) => {
    expect(caught(create)).toMatchObject({ code: 'process_config_rejected', path });
  });
});

// AC-13.2, DC-4, UC-5 (design-research-flow.md, FR-13): the shipped v3 loads — its windows hold the least view
// at `BYTES_PER_TOKEN` = 3 — and `createEngine` refuses an agents-form configuration with no definition of the form
// `claim_assessment`. The probe assembly `composeEngine` is not asked for it: the test above creates `agent-probe`
// without that form.
// Defects caught: the numbers of the design that do not pass the load; a checker-less configuration accepted (no group
// table key and no check); the requirement placed in the shared part of `composeEngine`.
describe('createEngine: the shipped deep-research v3', () => {
  const createWith = (processes: readonly unknown[]) => {
    const { registry } = registryDouble(true);
    const base = options({ connectedSources: CONNECTED, registry, logger: recordingLogger().logger });
    return createEngine({ ...base, processes });
  };

  it('creates the engine with the shipped v3', () => {
    expect(createWith([deepResearchProcessV3]).sourceMode).toBe('sources');
  });

  it('refuses an agents-form configuration without a definition of the form claim_assessment', () => {
    const shipped = deepResearchProcessV3 as { agents: Record<string, object> };
    const withoutChecker = { ...shipped, agents: { ...shipped.agents, verifier: { ...shipped.agents['verifier'], result: 'text' } } };

    expect(caught(() => createWith([withoutChecker]))).toMatchObject({
      code: 'process_config_rejected',
      path: [0, 'agents'],
    });
  });

  // Success Criteria «Группы уверенности v3 упорядочены», rule 12 of the plan: goes red on purpose after an edit of the
  // verifier's prompt or tools or of the form's version, which needs a new calibration.
  // Defects caught: a server on v3 started with a table calibrated for another verifier; the table not shipped.
  it('поставляемая таблица v3 подходит поставляемому проверяющему', () => {
    createWith([deepResearchProcessV3]);
    const bound = assembled.agentForms?.get('claim_assessment')?.bindings?.['groupTables']?.value as readonly GroupTable[];

    expect(bound.map(({ agentFingerprint, definitionMemoryFingerprint: memory }) => ({ agentFingerprint, memory }))).toContainEqual({
      agentFingerprint: claimAssessmentAgent(deepResearchProcessV3)?.agentFingerprint,
      memory: definitionMemoryFingerprint([]),
    });
  });

  // DC-30 (design-agent-core.md): the provider takes a tool's arguments only as one object at the root of its schema —
  // the first real-provider run of v3 got `400 tools.0.custom.input_schema.type: Field required` from the count of
  // `investigation_read`, whose union had `oneOf` at the root.
  // Defects caught: a tool of a shipped agent, `finish` with its result form among them, whose argument schema is a
  // union or not an object at the root.
  it('every tool of every shipped v3 agent takes one object at the root of its argument schema', () => {
    createWith([deepResearchProcessV3]);
    const { agents } = AgentProcessConfigSchema.parse(deepResearchProcessV3);
    const registry = assembled.agentTools;
    if (registry === undefined) throw new Error('the assembly registered no tools');

    const roots = Object.entries(agents).flatMap(([agent, definition]) => {
      const resultSchema = assembled.agentForms?.get(definition.result)?.resultSchema;
      if (resultSchema === undefined) throw new Error(`the assembly has no form ${definition.result}`);
      return agentToolsOf(definition.tools, { registry, resultSchema }).map((tool) => {
        const root = z.toJSONSchema(tool.inputSchema, { io: 'input' });
        return { tool: `${agent}.${tool.name}`, type: root.type, union: ['oneOf', 'anyOf', 'allOf'].filter((key) => key in root) };
      });
    });

    expect(roots.filter(({ type, union }) => type !== 'object' || union.length > 0)).toEqual([]);
    expect(roots.length).toBeGreaterThan(Object.keys(agents).length);
  });
});

// KD-5, KD-4 (design-research-flow.md), AC-14.2 (engine side): a start without a version takes the highest loaded one.
// The group tables are the `groupTables` option (the shipped ones without it) plus the JSON files of `groupTablesDir`,
// and the assembly binds those keyed by the pair of fingerprints to the form `claim_assessment`.
// Defects caught: a start without a version takes a lower one; an explicit version overridden by the highest; the
// catalog replacing the shipped tables or the option; a catalog table never reaching the form; a bad file of the
// catalog accepted, or refused without its name.
describe('createEngine: the start without a version and the tables', () => {
  const PROCESS_ID = 'deep-research';
  /** A budget version 3 allows (up to 10 000 000) and version 4 below does not (up to 500 000). */
  const BUDGET_ONLY_VERSION_3_ALLOWS = 1_000_000;
  const lowLimitVersion4 = {
    ...secondVersion,
    limits: {
      ...(shippedV3['limits'] as Record<string, unknown>),
      investigationTokens: { default: 300_000, max: 500_000 },
    },
  };

  const PAIR_TABLE = {
    model: VALID_TABLE.model,
    agentFingerprint: 'aaaaaaaaaaaa',
    definitionMemoryFingerprint: 'bbbbbbbbbbbb',
    scenarioSet: VALID_TABLE.scenarioSet,
    pairsFingerprint: VALID_TABLE.pairsFingerprint,
    calibratedAt: VALID_TABLE.calibratedAt,
    groupCount: 3,
    profiles: [],
    groups: [],
    pairKinds: [],
  };
  const CATALOG_PAIR_TABLE = { ...PAIR_TABLE, definitionMemoryFingerprint: 'cccccccccccc' };
  const memoryPrintOf = (table: GroupTable) => table.definitionMemoryFingerprint;

  let catalogDir: string;
  beforeEach(() => {
    catalogDir = mkdtempSync(join(tmpdir(), 'group-tables-'));
  });
  afterEach(() => {
    rmSync(catalogDir, { recursive: true, force: true });
  });

  const baseOptions = () =>
    options({ connectedSources: CONNECTED, registry: registryDouble(true).registry, logger: recordingLogger().logger });

  /** Which version a start resolved to: version 4 refuses the budget, version 3 goes on to the database, which fails any access. */
  async function startedVersion(version?: number): Promise<number> {
    const engine = createEngine({
      ...baseOptions(),
      processes: [deepResearchProcessV3, lowLimitVersion4],
    });
    const outcome = await engine
      .startInvestigation({
        resourceId: 'user-1',
        threadId: 'thread-1',
        query: 'query',
        processId: PROCESS_ID,
        launchKey: 'launch-1',
        tokenBudget: BUDGET_ONLY_VERSION_3_ALLOWS,
        ...(version === undefined ? {} : { version }),
      })
      .catch((error: unknown) => error);
    if (outcome instanceof Error && outcome.message.startsWith('the database was touched')) return 3;
    expect(outcome).toEqual({ outcome: 'rejected', code: 'budget_out_of_range' });
    return 4;
  }

  it.each<[string, number | undefined, number]>([
    ['no version → the highest loaded', undefined, 4],
    ['the explicit higher version → that version', 4, 4],
    ['the explicit lower version → that version', 3, 3],
  ])('%s', async (_, version, expected) => {
    await expect(startedVersion(version)).resolves.toBe(expected);
  });

  function assembleWith(setup: { groupTables?: readonly unknown[]; files: Readonly<Record<string, string>> }) {
    for (const [name, content] of Object.entries(setup.files)) {
      writeFileSync(join(catalogDir, name), content);
    }
    createEngine({
      ...baseOptions(),
      groupTablesDir: catalogDir,
      ...(setup.groupTables === undefined ? {} : { groupTables: setup.groupTables }),
    });
    const binding = assembled.agentForms?.get('claim_assessment')?.bindings?.['groupTables'];
    expect(binding?.kind).toBe('definition_pair_table');
    return binding?.value as readonly GroupTable[];
  }

  it('adds the catalog to the groupTables option, binds the tables to the form and ignores other files', () => {
    const bound = assembleWith({
      groupTables: [PAIR_TABLE],
      files: { 'pair.json': JSON.stringify(CATALOG_PAIR_TABLE), 'notes.txt': 'not a table' },
    });

    expect(bound.map(memoryPrintOf)).toEqual(['bbbbbbbbbbbb', 'cccccccccccc']);
  });

  it('adds the catalog to the shipped tables when there is no groupTables option', () => {
    const bound = assembleWith({ files: { 'pair.json': JSON.stringify(CATALOG_PAIR_TABLE) } });

    expect(bound.map(memoryPrintOf)).toEqual([...shippedGroupTables.map((table) => (table as GroupTable).definitionMemoryFingerprint), 'cccccccccccc']);
  });

  it.each<[string, string, string]>([
    ['a file that fails the schema', 'bad.json', JSON.stringify({ ...PAIR_TABLE, groupCount: 5 })],
    ['a file that is not JSON', 'broken.json', '{ not json'],
  ])('refuses creation with the file name for %s', (_, name, content) => {
    writeFileSync(join(catalogDir, name), content);

    expect(caught(() => createEngine({ ...baseOptions(), groupTablesDir: catalogDir }))).toMatchObject({
      code: 'process_config_rejected',
      path: ['groupTablesDir', name],
    });
  });

  it('refuses creation when the directory cannot be read', () => {
    expect(caught(() => createEngine({ ...baseOptions(), groupTablesDir: join(catalogDir, 'absent') }))).toMatchObject({
      code: 'process_config_rejected',
      path: ['groupTablesDir'],
    });
  });
});
