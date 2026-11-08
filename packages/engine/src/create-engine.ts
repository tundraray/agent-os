import type { Database } from '@agent-os/db';
import type { Clock, EventConsumerRegistry, EvidenceReader, HandlerRegistry } from '@agent-os/runtime';
import type { SourceRegistry } from '@agent-os/sources';
import { z } from 'zod';
import { type AgentRegistries, checkAgentDefinitions } from './agents/definition-check.js';
import { type AgentRunTimings, createAgentRunHandlers } from './agents/agent-run.handler.js';
import { createAssessAgent } from './agents/assess-agent.js';
import { createDefinitionMemory, DEFAULT_MEMORY_ADMIN_ROLE } from './agents/definition-memory.js';
import { createResultFormRegistry, type ResultForm, SHIPPED_RESULT_FORMS } from './agents/result-forms.js';
import { CONFIGURATION_ACCESS_POLICY, type ToolAccessPolicy } from './agents/tool-access-policy.js';
import { BASE_TOOLS, createToolRegistry } from './agents/tool-registry.js';
import { createSynthesizeHandler } from './answer/synthesize.handler.js';
import { createAssess } from './assess/assess.js';
import { findGroupTable, type GroupTable, GroupTableSchema } from './calibration/group-table.js';
import { type AgentProcessConfig, type AgentTimings, isAgentsForm } from './config/agent-config.schema.js';
import { loadAnyProcessConfig } from './config/load-process-config.js';
import { DEFAULT_MODEL_CATALOG, type ModelCatalog } from './config/model-catalog.js';
import { type AnyProcessConfig, checkRoleModels, type ProcessConfigRejection } from './config/process-config.schema.js';
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
  /**
   * Process configurations as data, of either form (KD-7): one with the `agents` key goes through the agents schema,
   * any other through the schema of `loadProcessConfig` (AC-12.3).
   */
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
   * Catalog models `Engine.assess` and `Engine.assessAgent` may call, resolved through `resolveModel` at creation; none
   * by default. A model outside this list is refused with `model_unavailable` without a provider call, a process role's
   * or a definition's model included.
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
  /** `AGENT_TURN_MS`: how long one agent turn may take (DC-27); 60000 by default. */
  readonly turnMs?: number;
  /** `AGENT_DEADLINE_MARGIN_MS`: how much earlier a run's deadline is than its task's (DC-27); 90000 by default. */
  readonly deadlineMarginMs?: number;
  /** `AGENT_ATTEMPT_SLICE_MS`: how long an attempt of an agent run works before it yields its slot (KD-6); 300000 by default. */
  readonly attemptSliceMs?: number;
  /** `AGENT_BUSY_WAIT_MS`: how long a turn's reserve waits for other calls' reserves before the attempt yields; 30000 by default. */
  readonly busyWaitMs?: number;
  /** `RUNTIME_LEASE_MS` of the runtime: a child's deadline is its parent's minus one lease (DC-27); 30000 by default. */
  readonly leaseMs?: number;
  /** `AGENT_MEMORY_ADMIN_ROLE`: the role that writes and reads the definition memory's scope `deployment`; `agent-memory-admin` by default. */
  readonly memoryAdminRole?: string;
  /**
   * The rights port of agent tool calls (design-agent-core.md, «Порт прав»): asked on every call by the investigation's
   * owner, the tool and its source; a refusal is the outcome `access_denied`, and neither the tool nor the source is
   * called. Without it, what the process configuration allows is allowed (`CONFIGURATION_ACCESS_POLICY`).
   */
  readonly toolAccessPolicy?: ToolAccessPolicy;
  readonly logger: EngineLogger;
}

/** The design's and the runtime's defaults of the agent timings (design-agent-core.md, Runtime Settings). */
const DEFAULT_AGENT_TIMINGS: AgentRunTimings = {
  turnMs: 60_000,
  deadlineMarginMs: 90_000,
  attemptSliceMs: 300_000,
  busyWaitMs: 30_000,
  leaseMs: 30_000,
};

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

/** The models a configuration calls with their paths: the roles of the roles form, the definitions of the agents form. */
function modelsOf(config: AnyProcessConfig): { readonly model: string; readonly path: readonly string[] }[] {
  if (isAgentsForm(config)) {
    return Object.entries(config.agents).map(([agentName, definition]) => ({
      model: definition.model,
      path: ['agents', agentName, 'model'],
    }));
  }
  return Object.entries(config.roles).map(([roleName, role]) => ({
    model: role.model,
    path: ['roles', roleName, 'model'],
  }));
}

/** Every agent definition's model must have a catalog entry, as every role model must (`checkRoleModels`). */
function checkAgentModels(config: AgentProcessConfig, catalog: ModelCatalog): ProcessConfigRejection | null {
  const missing = modelsOf(config).find(({ model }) => !Object.hasOwn(catalog, model));
  return missing === undefined
    ? null
    : { code: 'process_config_rejected', path: missing.path, message: `${missing.model} is not in the model catalog` };
}

function loadConfigs(
  processes: readonly unknown[],
  context: { readonly catalog: ModelCatalog; readonly timings: AgentTimings; readonly registries: AgentRegistries },
): AnyProcessConfig[] {
  return processes.map((data, index) => {
    const loaded = loadAnyProcessConfig(data, context.timings);
    if (!loaded.ok) {
      throw rejectedAt(index, loaded.rejection);
    }
    const config = loaded.config;
    const fault = isAgentsForm(config)
      ? (checkAgentDefinitions(config, context.registries) ?? checkAgentModels(config, context.catalog))
      : checkRoleModels(config, context.catalog);
    if (fault !== null) {
      throw rejectedAt(index, fault);
    }
    return config;
  });
}

/**
 * Every role or agent model of every configuration, resolved now: a throwing port refuses creation at the model's path,
 * as a model outside the catalog does (design-engine.md, `resolveModel`).
 */
function resolveProcessModels(
  configs: readonly AnyProcessConfig[],
  resolveModel: ResolveModel,
): Map<string, RoleModel> {
  const models = new Map<string, RoleModel>();
  for (const [index, config] of configs.entries()) {
    for (const { model, path } of modelsOf(config)) {
      try {
        models.set(model, resolveModel(model));
      } catch (error) {
        const message = `resolveModel failed for ${model}: ${error instanceof Error ? error.message : String(error)}`;
        throw new ProcessConfigRejectedError(
          { code: 'process_config_rejected', path: [index, ...path], message },
          { cause: error },
        );
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
function requireGroupTables(configs: readonly AnyProcessConfig[], tables: readonly GroupTable[]): void {
  for (const config of configs) {
    if (isAgentsForm(config) || !config.capabilities.includes('verify')) continue;
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

/** What the engine's internal assembly gets besides the options: the result forms of its registry (ADR-0010). */
export interface EngineComposition {
  readonly resultForms: readonly ResultForm[];
}

/**
 * Builds the engine (design-agent-core.md, KD-8) with the shipped result forms. It takes no forms: the registry is
 * assembled inside the engine, so `apps/api` and other packages cannot add to it (ADR-0010).
 */
export function createEngine(options: CreateEngineOptions): Engine {
  return composeEngine(options, { resultForms: SHIPPED_RESULT_FORMS });
}

/**
 * The engine's internal assembly (ADR-0010): `createEngine` passes it the shipped forms, and the engine's test harness
 * adds its probe form from the package's sources; `index.ts` does not export it.
 *
 * Builds the engine (design-engine.md, Contract Definitions). Throws with the configuration path when a configuration
 * fails the schema, a role or `assessModels` model has no catalog entry or does not resolve, a `processId` +
 * `version` pair repeats, a group table fails its schema, `requireCalibration` finds a verifying configuration without
 * its group table (`calibration_missing`), an agents-form definition names a tool or a result form outside the
 * registries, stands against its form's placement or has a window below its least view (DC-1, DC-28), or — only with
 * a connected source — a configured source is not
 * allowed for `source.fetch` (DC-14). Without a connected source it writes exactly one `warn` instead (DC-18). Registers the `research.controller` (KD-2), `research.analyze`,
 * `research.verify` and `research.synthesize` handlers, the `agent.root` and `agent.run` handlers of agent runs
 * (design-agent-core.md, KD-1) and the `engine.lifecycle` event consumer, which closes an investigation when its
 * controller task — or its root run — ends. Reads neither the environment nor the database.
 */
export function composeEngine(options: CreateEngineOptions, composition: EngineComposition): Engine {
  const catalog = options.modelCatalog ?? DEFAULT_MODEL_CATALOG;
  const registries: AgentRegistries = {
    tools: createToolRegistry(BASE_TOOLS),
    forms: createResultFormRegistry(composition.resultForms),
  };
  const timings: AgentRunTimings = {
    turnMs: options.turnMs ?? DEFAULT_AGENT_TIMINGS.turnMs,
    deadlineMarginMs: options.deadlineMarginMs ?? DEFAULT_AGENT_TIMINGS.deadlineMarginMs,
    attemptSliceMs: options.attemptSliceMs ?? DEFAULT_AGENT_TIMINGS.attemptSliceMs,
    busyWaitMs: options.busyWaitMs ?? DEFAULT_AGENT_TIMINGS.busyWaitMs,
    leaseMs: options.leaseMs ?? DEFAULT_AGENT_TIMINGS.leaseMs,
  };
  const configs = loadConfigs(options.processes, { catalog, timings, registries });
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
  const models = resolveProcessModels(configs, options.resolveModel);
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

  for (const handler of createAgentRunHandlers({
    database: options.database,
    scheduler: options.runtime.scheduler,
    investigations: options.runtime.investigations,
    gateway,
    registries,
    accessPolicy: options.toolAccessPolicy ?? CONFIGURATION_ACCESS_POLICY,
    timings,
    clock,
    logger,
  })) {
    options.runtime.handlers.register(handler);
  }

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
    assessAgent: createAssessAgent({
      models: assessModels,
      catalog,
      forms: registries.forms,
      tools: registries.tools,
      clock,
      logger,
      transcripts: postgresOutsideTaskTranscripts(options.database),
    }),
    forms: registries.forms,
    definitionMemory: createDefinitionMemory({
      database: options.database,
      processes: processSet.set,
      forms: registries.forms,
      adminRole: options.memoryAdminRole ?? DEFAULT_MEMORY_ADMIN_ROLE,
    }),
    sourceRegistry: options.sourceRegistry,
    clock,
    logger,
  });
}
