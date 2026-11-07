import type { Database } from '@agent-os/db';
import type { Clock, EventConsumerRegistry, EvidenceReader, HandlerRegistry } from '@agent-os/runtime';
import type { SourceRegistry } from '@agent-os/sources';
import { z } from 'zod';
import { createSynthesizeHandler } from './answer/synthesize.handler.js';
import { createAssess } from './assess/assess.js';
import { findGroupTable, type GroupTable, GroupTableSchema } from './calibration/group-table.js';
import { loadProcessConfig } from './config/load-process-config.js';
import { DEFAULT_MODEL_CATALOG, type ModelCatalog } from './config/model-catalog.js';
import { checkRoleModels, type ProcessConfig, type ProcessConfigRejection } from './config/process-config.schema.js';
import { createProcessSet } from './config/process-set.js';
import { checkProcessSources } from './config/source-check.js';
import { createContextBuilder } from './context/context-builder.js';
import { createControllerHandler } from './controller/controller.handler.js';
import { buildEngine, type Engine } from './engine.js';
import { CalibrationMissingError } from './engine-errors.js';
import { createLifecycleConsumer } from './lifecycle/lifecycle.consumer.js';
import { createModelGateway } from './model/model-gateway.js';
import { promptVersion } from './model/prompt-version.js';
import type { TokenCounter } from './model/token-counter.js';
import type { EngineLogger, ResolveModel, RoleModel } from './ports.js';
import { shippedGroupTables } from './processes/shipped-group-tables.js';
import type { EngineRuntimePorts } from './runs/start-investigation.js';
import { createSignalRegistry, type SignalKind } from './signals/signal-registry.js';
import { postgresOutsideTaskTranscripts } from './transcripts/transcript-writes.js';
import { createVerifyHandler } from './verify/verify.handler.js';
import { createAnalyzeHandler } from './workers/analyze.handler.js';

/** What the assembly point passes to {@link createEngine} (ADR-0004: settings and ports, no environment). */
export interface CreateEngineOptions {
  readonly database: Database;
  /**
   * Runtime services; `handlers` receives the engine's task handlers and `eventConsumers` its `engine.lifecycle`
   * consumer before `Runtime.start`, `evidence` serves the workers the content of their gather task's evidence, and the
   * synthesis, the answer message and `Engine.readAnswerMessage` the provenance of the cited evidence. `eventConsumers` is required: an assembly without it would leave
   * every finished investigation `active` (design-lifecycle.md, KD-1).
   */
  readonly runtime: EngineRuntimePorts & {
    readonly handlers: Pick<HandlerRegistry, 'register'>;
    readonly eventConsumers: Pick<EventConsumerRegistry, 'register'>;
    readonly evidence: Pick<EvidenceReader, 'get'>;
  };
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
  /**
   * Catalog models `Engine.assess` may call, resolved through `resolveModel` at creation; none by default. A model
   * outside this list is refused with `model_unavailable` without a provider call, a process role's model included.
   */
  readonly assessModels?: readonly string[];
  /**
   * Group tables as data, each through `GroupTableSchema`; the shipped tables by default. A verification takes the table
   * of its frozen configuration's `verifier` model and prompt version; without one its claims get the lowest group (KD-3, DC-11).
   */
  readonly groupTables?: readonly unknown[];
  /**
   * The server start passes it: creation is refused with `calibration_missing` when a loaded configuration with the
   * `verify` capability has no table for its `verifier` model and prompt version (DC-2). The self-check program does not:
   * it starts without a table and its claims get the lowest group (DC-11).
   */
  readonly requireCalibration?: boolean;
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
 * The `assessModels`, resolved now and kept apart from the role models: `Engine.assess` calls only these. A model
 * outside the catalog or a throwing port refuses creation at `assessModels.<index>`.
 */
function resolveAssessModels(
  assessModels: readonly string[],
  catalog: ModelCatalog,
  resolveModel: ResolveModel,
): Map<string, RoleModel> {
  const models = new Map<string, RoleModel>();
  for (const [index, model] of assessModels.entries()) {
    const path = ['assessModels', index];
    if (catalog[model] === undefined) {
      const message = `${model} is not in the model catalog`;
      throw new ProcessConfigRejectedError({ code: 'process_config_rejected', path, message });
    }
    try {
      models.set(model, resolveModel(model));
    } catch (error) {
      const message = `resolveModel failed for ${model}: ${error instanceof Error ? error.message : String(error)}`;
      throw new ProcessConfigRejectedError({ code: 'process_config_rejected', path, message }, { cause: error });
    }
  }
  return models;
}

/** The group tables, each through its schema; a table that does not pass refuses creation at `groupTables.<index>`. */
function loadGroupTables(tables: readonly unknown[]): GroupTable[] {
  return tables.map((data, index) => {
    const parsed = GroupTableSchema.safeParse(data);
    if (!parsed.success) {
      const message = `group table rejected: ${z.prettifyError(parsed.error)}`;
      throw new ProcessConfigRejectedError({ code: 'process_config_rejected', path: ['groupTables', index], message });
    }
    return parsed.data;
  });
}

/** Under `requireCalibration`: every configuration that verifies has the table of its `verifier` model and prompt (DC-2). */
function requireGroupTables(configs: readonly ProcessConfig[], tables: readonly GroupTable[]): void {
  for (const config of configs) {
    if (!config.capabilities.includes('verify')) continue;
    const verifier = config.roles.verifier;
    if (findGroupTable(tables, verifier) === undefined) {
      throw new CalibrationMissingError({
        processId: config.processId,
        version: config.version,
        model: verifier.model,
        promptVersion: promptVersion(verifier.prompt),
      });
    }
  }
}

/**
 * Builds the engine (design-engine.md, Contract Definitions). Throws with the configuration path when a configuration
 * fails the schema, a role or `assessModels` model has no catalog entry or does not resolve, a `processId` +
 * `version` pair repeats, a group table fails its schema, `requireCalibration` finds a verifying configuration without
 * its group table (`calibration_missing`), or — only with a connected source — a configured source is not
 * allowed for `source.fetch` (DC-14). Without a connected source it writes exactly one `warn` instead (DC-18). Registers the `research.controller` (KD-2), `research.analyze`,
 * `research.verify` and `research.synthesize` handlers and the `engine.lifecycle` event consumer, which closes an
 * investigation when its controller task ends. Reads neither the environment nor the database.
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
  const assessModels = resolveAssessModels(options.assessModels ?? [], catalog, options.resolveModel);
  const groupTables = loadGroupTables(options.groupTables ?? shippedGroupTables);
  if (options.requireCalibration === true) {
    requireGroupTables(configs, groupTables);
  }
  const signalKinds = createSignalRegistry(options.signalKinds ?? []);
  if (sources.warnNoSources) {
    options.logger.warn(NO_SOURCES_WARNING);
  }

  const { clock, tokenCounter, logger } = options;
  const gateway = createModelGateway({ models, tokenCounter, catalog, clock, logger });
  const contextBuilder = createContextBuilder({ tokenCounter, logger });
  options.runtime.handlers.register(
    createControllerHandler({
      database: options.database,
      investigations: options.runtime.investigations,
      scheduler: options.runtime.scheduler,
      sourceRegistry: options.sourceRegistry,
      evidence: options.runtime.evidence,
      gateway,
      contextBuilder,
      clock,
      logger,
    }),
  );
  options.runtime.handlers.register(
    createAnalyzeHandler({
      database: options.database,
      investigations: options.runtime.investigations,
      evidence: options.runtime.evidence,
      gateway,
      contextBuilder,
      clock,
    }),
  );
  options.runtime.handlers.register(
    createVerifyHandler({
      database: options.database,
      investigations: options.runtime.investigations,
      evidence: options.runtime.evidence,
      gateway,
      contextBuilder,
      groupTables,
      clock,
    }),
  );
  options.runtime.handlers.register(
    createSynthesizeHandler({
      database: options.database,
      investigations: options.runtime.investigations,
      evidence: options.runtime.evidence,
      gateway,
      contextBuilder,
      clock,
    }),
  );

  options.runtime.eventConsumers.register(createLifecycleConsumer(options.runtime.investigations));

  return buildEngine({
    database: options.database,
    runtime: options.runtime,
    evidence: options.runtime.evidence,
    processes: processSet.set,
    sourceMode: sources.sourceMode,
    models,
    signalKinds,
    assess: createAssess({
      models: assessModels,
      catalog,
      clock,
      logger,
      transcripts: postgresOutsideTaskTranscripts(options.database),
    }),
    sourceRegistry: options.sourceRegistry,
    clock,
    logger,
  });
}
