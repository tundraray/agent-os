import type { Database } from '@agent-os/db';
import type { Clock, HandlerRegistry } from '@agent-os/runtime';
import type { SourceRegistry } from '@agent-os/sources';
import { loadProcessConfig } from './config/load-process-config.js';
import { DEFAULT_MODEL_CATALOG, type ModelCatalog } from './config/model-catalog.js';
import { checkRoleModels, type ProcessConfig, type ProcessConfigRejection } from './config/process-config.schema.js';
import { createProcessSet } from './config/process-set.js';
import { checkProcessSources } from './config/source-check.js';
import { createContextBuilder } from './context/context-builder.js';
import { createControllerHandler } from './controller/controller.handler.js';
import { buildEngine, type Engine } from './engine.js';
import { createModelGateway } from './model/model-gateway.js';
import type { TokenCounter } from './model/token-counter.js';
import type { EngineLogger, ResolveModel, RoleModel } from './ports.js';
import type { EngineRuntimePorts } from './runs/start-investigation.js';
import { createSignalRegistry, type SignalKind } from './signals/signal-registry.js';

/** What the assembly point passes to {@link createEngine} (ADR-0004: settings and ports, no environment). */
export interface CreateEngineOptions {
  readonly database: Database;
  /** Runtime services; `handlers` receives the engine's task handlers before `Runtime.start`. */
  readonly runtime: EngineRuntimePorts & { readonly handlers: Pick<HandlerRegistry, 'register'> };
  /** Checks the configured sources (DC-14) and serves the gather capability: tools, argument schemas and snapshots. */
  readonly sourceRegistry: Pick<SourceRegistry, 'resolveTool' | 'currentSnapshot'>;
  /** `sourceId` of the sources connected in the deployment; empty runs every investigation on model knowledge (KD-8). */
  readonly connectedSources: readonly string[];
  /** Process configurations as data; each goes through the schema of `loadProcessConfig` (AC-12.3). */
  readonly processes: readonly unknown[];
  readonly resolveModel: ResolveModel;
  /** Counts the input of every role packet before its reservation (KD-4). */
  readonly tokenCounter: TokenCounter;
  /** Time and timers of the engine: `notAfter`, retry delays (the runtime's clock in tests). */
  readonly clock: Clock;
  /** The package's catalog by default. */
  readonly modelCatalog?: ModelCatalog;
  /**
   * Kinds of external signals `Engine.recordSignal` accepts, each with its payload schema; none by default. A new kind
   * is a new entry here, the decision input keeps its form (AC-04.2).
   */
  readonly signalKinds?: readonly SignalKind[];
  readonly logger: EngineLogger;
}

/** Creation refused: a configuration or a role model does not pass; `path` starts at the configuration's index. */
class ProcessConfigRejectedError extends Error {
  override readonly name = 'ProcessConfigRejectedError';
  readonly code = 'process_config_rejected';
  readonly path: readonly (string | number)[];

  constructor(rejection: ProcessConfigRejection, options?: ErrorOptions) {
    super(`process configuration rejected at ${rejection.path.join('.')}: ${rejection.message}`, options);
    this.path = rejection.path;
  }
}

const NO_SOURCES_WARNING =
  'no data source is connected: investigations will run on model knowledge, without evidence (sourceMode model_knowledge)';

const rejectedAt = (index: number, rejection: ProcessConfigRejection) =>
  new ProcessConfigRejectedError({ ...rejection, path: [index, ...rejection.path] });

function loadConfigs(processes: readonly unknown[], catalog: ModelCatalog): ProcessConfig[] {
  return processes.map((data, index) => {
    const loaded = loadProcessConfig(data);
    if (!loaded.ok) {
      throw rejectedAt(index, loaded.rejection);
    }
    const modelFault = checkRoleModels(loaded.config, catalog);
    if (modelFault !== null) {
      throw rejectedAt(index, modelFault);
    }
    return loaded.config;
  });
}

/**
 * Every role model of every configuration, resolved now: a throwing port refuses creation at the role's path, as a
 * model outside the catalog does (design-engine.md, `resolveModel`).
 */
function resolveRoleModels(configs: readonly ProcessConfig[], resolveModel: ResolveModel): Map<string, RoleModel> {
  const models = new Map<string, RoleModel>();
  for (const [index, config] of configs.entries()) {
    for (const [roleName, role] of Object.entries(config.roles)) {
      const path = [index, 'roles', roleName, 'model'];
      try {
        models.set(role.model, resolveModel(role.model));
      } catch (error) {
        const message = `resolveModel failed for ${role.model}: ${error instanceof Error ? error.message : String(error)}`;
        throw new ProcessConfigRejectedError({ code: 'process_config_rejected', path, message }, { cause: error });
      }
    }
  }
  return models;
}

/**
 * Builds the engine (design-engine.md, Contract Definitions). Throws with the configuration path when a configuration
 * fails the schema, a role model has no catalog entry or does not resolve, a `processId` + `version` pair repeats, or —
 * only with a connected source — a configured source is not allowed for `source.fetch` (DC-14). Without a connected
 * source it writes exactly one `warn` instead (DC-18). Registers the `research.controller` handler (KD-2). Reads neither
 * the environment nor the database.
 */
export function createEngine(options: CreateEngineOptions): Engine {
  const catalog = options.modelCatalog ?? DEFAULT_MODEL_CATALOG;
  const configs = loadConfigs(options.processes, catalog);
  const processSet = createProcessSet(configs);
  if (!processSet.ok) {
    throw new ProcessConfigRejectedError(processSet.rejection);
  }
  const sources = checkProcessSources({
    configs,
    registry: options.sourceRegistry,
    connectedSources: options.connectedSources,
  });
  if (!sources.ok) {
    throw new ProcessConfigRejectedError(sources.rejection);
  }
  const models = resolveRoleModels(configs, options.resolveModel);
  const signalKinds = createSignalRegistry(options.signalKinds ?? []);
  if (sources.warnNoSources) {
    options.logger.warn(NO_SOURCES_WARNING);
  }

  const { clock, tokenCounter, logger } = options;
  options.runtime.handlers.register(
    createControllerHandler({
      database: options.database,
      investigations: options.runtime.investigations,
      scheduler: options.runtime.scheduler,
      sourceRegistry: options.sourceRegistry,
      gateway: createModelGateway({ models, tokenCounter, catalog, clock, logger }),
      contextBuilder: createContextBuilder({ tokenCounter }),
      clock,
    }),
  );

  return buildEngine({
    database: options.database,
    runtime: options.runtime,
    processes: processSet.set,
    sourceMode: sources.sourceMode,
    models,
    signalKinds,
  });
}
