import type { Database } from '@agent-os/db';
import { systemClock } from '@agent-os/runtime';
import type { SourceRegistry } from '@agent-os/sources';
import { DEFAULT_MODEL_CATALOG, type ModelCatalog } from './config/model-catalog.js';
import { createEngine, type CreateEngineOptions } from './create-engine.js';
import { promptVersion } from './model/prompt-version.js';
import type { EngineLogger, ResolveModel, RoleModel } from './ports.js';
import { deepResearchProcessV2 } from './processes/shipped-processes.js';

// UC-12 (first half), AC-26.2, AC-26.3, AC-25.3 (mode half), DC-14, DC-18, KD-8, `resolveModel`: creating the engine.
// Without connected sources the configuration's sources are not checked, creation passes with exactly one `warn`
// and the mode is `model_knowledge`; with one the DC-14 check refuses a pair outside the allowlist, the mode is
// `sources` and nothing is warned; a connected source that stops answering changes neither; a throwing `resolveModel`
// on any role of any loaded configuration refuses creation with that role's path.
// Defects caught: the DC-14 check run on an empty list; the warning missing, repeated or written with a source; the
// mode computed from source availability instead of the list; role models resolved lazily or for the first
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

/** A model instance the engine only hands to role agents; nothing calls it while the engine is created. */
const modelDouble = (modelId: string): RoleModel => ({
  specificationVersion: 'v2',
  provider: 'test',
  modelId,
  supportedUrls: {},
  doGenerate: notCalled(`doGenerate of ${modelId}`),
  doStream: notCalled(`doStream of ${modelId}`),
});

/** A registry whose allowlist holds every pair while `available`, and none once the source stops answering. */
function registryDouble(allows: boolean) {
  const state = { available: true };
  const registry: CreateEngineOptions['sourceRegistry'] = {
    resolveTool: () =>
      allows && state.available ? ({ adapter: {}, tool: {} } as ReturnType<SourceRegistry['resolveTool']>) : null,
    currentSnapshot: notCalled('currentSnapshot'),
  };
  return { registry, state };
}

function recordingLogger() {
  const warnings: string[] = [];
  const logger: EngineLogger = { log: () => undefined, warn: (message) => warnings.push(message), error: () => undefined };
  return { logger, warnings };
}

/** The shipped deep-research configuration as version 3 with the verifier on a model only this test resolves. */
const secondVersion = {
  ...(deepResearchProcessV2 as Record<string, unknown>),
  version: 3,
  roles: {
    ...(deepResearchProcessV2 as { roles: Record<string, unknown> }).roles,
    verifier: {
      ...(deepResearchProcessV2 as { roles: { verifier: Record<string, unknown> } }).roles.verifier,
      model: OTHER_MODEL,
    },
  },
};

/** A group table the schema accepts. */
const VALID_TABLE = {
  model: 'anthropic/claude-haiku-5-5',
  promptVersion: '0123456789ab',
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
  requireCalibration?: boolean;
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
      evidence: { get: notCalled('evidence.get') },
      handlers: { register: () => undefined },
      eventConsumers: { register: () => undefined },
    },
    sourceRegistry: overrides.registry,
    connectedSources: overrides.connectedSources,
    processes: [deepResearchProcessV2, secondVersion],
    resolveModel: overrides.resolveModel ?? modelDouble,
    tokenCounter: { countInputTokens: notCalled('countInputTokens') },
    clock: systemClock,
    modelCatalog: catalog,
    ...(overrides.groupTables === undefined ? {} : { groupTables: overrides.groupTables }),
    ...(overrides.requireCalibration === undefined ? {} : { requireCalibration: overrides.requireCalibration }),
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

describe('createEngine: the deployment sets the source mode once, and every role model resolves at creation', () => {
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
      'resolveModel throwing on a role of the second loaded configuration',
      CONNECTED,
      true,
      (modelId) => {
        if (modelId === OTHER_MODEL) throw new Error(`no client for ${modelId}`);
        return modelDouble(modelId);
      },
      undefined,
      [1, 'roles', 'verifier', 'model'],
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

// DC-2, Invariant 8, AC-06.2 (start side): with `requireCalibration` every loaded configuration with the `verify`
// capability needs the group table of its `verifier` model and prompt version; without the flag (the self-check
// program) creation passes and the claims get the lowest group (DC-11).
// Defects caught: a server assembly that starts without a table (groups silently lowest); a table matched by model
// only; the self-check program refused without a table.
describe('createEngine: the server start requires the group table of each verifier model and prompt version', () => {
  const VERIFIER_PROMPT = (deepResearchProcessV2 as { roles: { verifier: { prompt: string } } }).roles.verifier.prompt;
  const FINGERPRINT = promptVersion(VERIFIER_PROMPT);
  const tableFor = (model: string, version: string) => ({ ...VALID_TABLE, model, promptVersion: version });
  const SHIPPED_MODEL_TABLE = tableFor('anthropic/claude-haiku-5-5', FINGERPRINT);
  const SECOND_VERSION_TABLE = tableFor(OTHER_MODEL, FINGERPRINT);
  const OTHER_FINGERPRINT = FINGERPRINT === '000000000000' ? '111111111111' : '000000000000';

  it.each<[string, boolean | undefined, readonly unknown[], 'created' | { processId: string; version: number; model: string }]>([
    ['the flag and no table → refused for the first configuration', true, [], { processId: 'deep-research', version: 2, model: 'anthropic/claude-haiku-5-5' }],
    [
      'the flag and a table of the same model with another prompt fingerprint → refused',
      true,
      [tableFor('anthropic/claude-haiku-5-5', OTHER_FINGERPRINT), SECOND_VERSION_TABLE],
      { processId: 'deep-research', version: 2, model: 'anthropic/claude-haiku-5-5' },
    ],
    [
      'the flag, a table for the first configuration only → refused for the second',
      true,
      [SHIPPED_MODEL_TABLE],
      { processId: 'deep-research', version: 3, model: OTHER_MODEL },
    ],
    ['the flag and a matching table for each configuration → created', true, [SHIPPED_MODEL_TABLE, SECOND_VERSION_TABLE], 'created'],
    ['no flag and no table → created (DC-2, Invariant 8)', undefined, [], 'created'],
  ])('%s', (_, requireCalibration, groupTables, outcome) => {
    const { registry } = registryDouble(true);
    const log = recordingLogger();
    const create = () => createEngine(options({ connectedSources: CONNECTED, registry, logger: log.logger, groupTables, requireCalibration }));

    if (outcome === 'created') {
      expect(create().sourceMode).toBe('sources');
      return;
    }
    const error = caught(create);
    expect(error).toMatchObject({ code: 'calibration_missing', ...outcome, promptVersion: FINGERPRINT });
    expect((error as Error).message).toBe(
      `no group table for process ${outcome.processId} version ${outcome.version}: verifier model ${outcome.model}, ` +
        `prompt version ${FINGERPRINT}; build one with the calibrate command`,
    );
  });
});
