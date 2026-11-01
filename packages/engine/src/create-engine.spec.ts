import type { Database } from '@agent-os/db';
import { systemClock } from '@agent-os/runtime';
import type { SourceRegistry } from '@agent-os/sources';
import { DEFAULT_MODEL_CATALOG, type ModelCatalog } from './config/model-catalog.js';
import { createEngine, type CreateEngineOptions } from './create-engine.js';
import type { EngineLogger, ResolveModel, RoleModel } from './ports.js';
import { deepResearchProcessV1 } from './processes/shipped-processes.js';

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

/** The shipped deep-research configuration as version 2 with the verifier on a model only this test resolves. */
const secondVersion = {
  ...(deepResearchProcessV1 as Record<string, unknown>),
  version: 2,
  roles: {
    ...(deepResearchProcessV1 as { roles: Record<string, unknown> }).roles,
    verifier: {
      ...(deepResearchProcessV1 as { roles: { verifier: Record<string, unknown> } }).roles.verifier,
      model: OTHER_MODEL,
    },
  },
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
}): CreateEngineOptions {
  return {
    database: untouchableDatabase,
    runtime: {
      scheduler: { propose: notCalled('propose') },
      investigations: {
        create: notCalled('create'),
        listForThread: notCalled('listForThread'),
        cancel: notCalled('cancel'),
      },
      evidence: { get: notCalled('evidence.get') },
      handlers: { register: () => undefined },
    },
    sourceRegistry: overrides.registry,
    connectedSources: overrides.connectedSources,
    processes: [deepResearchProcessV1, secondVersion],
    resolveModel: overrides.resolveModel ?? modelDouble,
    tokenCounter: { countInputTokens: notCalled('countInputTokens') },
    clock: systemClock,
    modelCatalog: catalog,
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

  it.each<[string, readonly string[], boolean, ResolveModel | undefined, readonly (string | number)[]]>([
    [
      'a connected source with a configured pair outside the allowlist (DC-14)',
      CONNECTED,
      false,
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
      [1, 'roles', 'verifier', 'model'],
    ],
  ])('refuses creation with the path for %s, and warns nothing', (_, connectedSources, allows, resolveModel, path) => {
    const { registry } = registryDouble(allows);
    const log = recordingLogger();

    const error = caught(() => createEngine(options({ connectedSources, registry, logger: log.logger, resolveModel })));

    expect(error).toMatchObject({ code: 'process_config_rejected', path });
    expect(log.warnings).toHaveLength(0);
  });
});
