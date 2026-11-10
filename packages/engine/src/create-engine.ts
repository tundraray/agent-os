import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '@agent-os/db';
import type { Clock, EventConsumerRegistry, HandlerRegistry } from '@agent-os/runtime';
import type { SourceRegistry } from '@agent-os/sources';
import { z } from 'zod';
import { type AgentRegistries, checkAgentDefinitions } from './agents/definition-check.js';
import { type AgentRunTimings, createAgentRunHandlers } from './agents/agent-run.handler.js';
import { createAssessAgent } from './agents/assess-agent.js';
import { createDefinitionMemory, DEFAULT_MEMORY_ADMIN_ROLE, readDeploymentEntries } from './agents/definition-memory.js';
import { definitionMemoryFingerprint } from './agents/fingerprint.js';
import { createResultFormRegistry, type ResultForm, SHIPPED_RESULT_FORMS } from './agents/result-forms.js';
import { CONFIGURATION_ACCESS_POLICY, type ToolAccessPolicy } from './agents/tool-access-policy.js';
import { BASE_TOOLS, createToolRegistry, type ToolRegistryEntry } from './agents/tool-registry.js';
import { createAssess } from './assess/assess.js';
import { findGroupTableByPair, type GroupTable, GroupTableSchema } from './calibration/group-table.js';
import { buildSourcesField } from './capabilities/sources-field.js';
import type { AgentProcessConfig, AgentTimings, ProcessConfigRejection } from './config/agent-config.schema.js';
import { loadProcessConfig } from './config/load-process-config.js';
import { DEFAULT_MODEL_CATALOG, type ModelCatalog } from './config/model-catalog.js';
import { createProcessSet, type ProcessSet } from './config/process-set.js';
import { checkProcessSources } from './config/source-check.js';
import { buildEngine, type Engine } from './engine.js';
import { AgentCalibrationMissingError } from './engine-errors.js';
import { createLifecycleConsumer } from './lifecycle/lifecycle.consumer.js';
import { createModelGateway } from './model/model-gateway.js';
import type { TokenCounter } from './model/token-counter.js';
import type { EngineLogger, ResolveModel, RoleModel } from './ports.js';
import { shippedGroupTables } from './processes/shipped-group-tables.js';
import { CLAIM_ASSESSMENT_FORM, claimAssessmentAgent } from './research-flow/forms/claim-assessment.js';
import { bindGroupTables, RESEARCH_FORMS } from './research-flow/research-forms.js';
import { RESEARCH_IMMEDIATE_TOOLS, RESEARCH_TOOLS, researchTaskTools } from './research-flow/research-tools.js';
import type { EngineRuntimePorts } from './runs/start-investigation.js';
import { postgresOutsideTaskTranscripts } from './transcripts/transcript-writes.js';

/** What the assembly point passes to {@link createEngine} (ADR-0004: settings and ports, no environment). */
export interface CreateEngineOptions {
  readonly database: Database;
  /**
   * Runtime services; `handlers` receives the engine's task handlers and `eventConsumers` its `engine.lifecycle`
   * consumer before `Runtime.start`. `eventConsumers` is required: an assembly without it would leave
   * every finished investigation `active` (design-lifecycle.md, KD-1).
   */
  readonly runtime: EngineRuntimePorts & {
    readonly handlers: Pick<HandlerRegistry, 'register'>;
    readonly eventConsumers: Pick<EventConsumerRegistry, 'register'>;
  };
  /** Checks the configured sources (DC-14) and serves the gather capability: tools, argument schemas and snapshots. */
  readonly sourceRegistry: Pick<SourceRegistry, 'resolveTool' | 'currentSnapshot'>;
  /** `sourceId` of the sources connected in the deployment; empty runs every investigation on model knowledge (KD-8). */
  readonly connectedSources: readonly string[];
  /** Process configurations as data, each through `loadProcessConfig` (KD-7, AC-12.3). */
  readonly processes: readonly unknown[];
  readonly resolveModel: ResolveModel;
  /** Counts the input of every agent turn before its reservation (KD-4). */
  readonly tokenCounter: TokenCounter;
  /** Time and timers of the engine: `notAfter`, retry delays (the runtime's clock in tests). */
  readonly clock: Clock;
  /** The package's catalog by default. */
  readonly modelCatalog?: ModelCatalog;
  /**
   * Catalog models `Engine.assess` and `Engine.assessAgent` may call, resolved through `resolveModel` at creation; none
   * by default. A model outside this list is refused with `model_unavailable` without a provider call, a definition's
   * model included.
   */
  readonly assessModels?: readonly string[];
  /**
   * Group tables as data, each through `GroupTableSchema`; the shipped tables by default. They are bound to the form
   * `claim_assessment` by the pair of fingerprints (KD-4); a claim without its table gets the lowest group (DC-11).
   */
  readonly groupTables?: readonly unknown[];
  /** A directory whose `*.json` files are group tables added to `groupTables`, never replacing them; read at creation. */
  readonly groupTablesDir?: string;
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

/** The models a configuration calls with their paths: those of its definitions. */
function modelsOf(config: AgentProcessConfig): { readonly model: string; readonly path: readonly string[] }[] {
  return Object.entries(config.agents).map(([agentName, definition]) => ({
    model: definition.model,
    path: ['agents', agentName, 'model'],
  }));
}

/** Every agent definition's model must have a catalog entry, or its calls could not be priced. */
function checkAgentModels(config: AgentProcessConfig, catalog: ModelCatalog): ProcessConfigRejection | null {
  const missing = modelsOf(config).find(({ model }) => !Object.hasOwn(catalog, model));
  return missing === undefined
    ? null
    : { code: 'process_config_rejected', path: missing.path, message: `${missing.model} is not in the model catalog` };
}

/** Without a definition of the form `claim_assessment` there is no group-table key and no check of a claim (DC-4). */
function checkVerifierDefinition(config: AgentProcessConfig): ProcessConfigRejection | null {
  const hasVerifier = Object.values(config.agents).some((definition) => definition.result === CLAIM_ASSESSMENT_FORM.name);
  return hasVerifier
    ? null
    : { code: 'process_config_rejected', path: ['agents'], message: `no definition has the form ${CLAIM_ASSESSMENT_FORM.name}` };
}

function loadConfigs(
  processes: readonly unknown[],
  context: {
    readonly catalog: ModelCatalog;
    readonly timings: AgentTimings;
    readonly registries: AgentRegistries;
    readonly requireVerifier: boolean;
  },
): AgentProcessConfig[] {
  return processes.map((data, index) => {
    const loaded = loadProcessConfig(data, context.timings);
    if (!loaded.ok) {
      throw rejectedAt(index, loaded.rejection);
    }
    const config = loaded.config;
    const fault =
      checkAgentDefinitions(config, context.registries) ??
      checkAgentModels(config, context.catalog) ??
      (context.requireVerifier ? checkVerifierDefinition(config) : null);
    if (fault !== null) {
      throw rejectedAt(index, fault);
    }
    return config;
  });
}

/**
 * Every definition model of every configuration, resolved now: a throwing port refuses creation at the model's path,
 * as a model outside the catalog does (design-engine.md, `resolveModel`).
 */
function resolveProcessModels(
  configs: readonly AgentProcessConfig[],
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
 * The `assessModels`, resolved now and kept apart from the definition models: `Engine.assess` calls only these. A model
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

const tableRejected = (path: readonly (string | number)[], message: string, cause?: unknown) =>
  new ProcessConfigRejectedError({ code: 'process_config_rejected', path, message }, cause === undefined ? undefined : { cause });

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function parseGroupTable(data: unknown, path: readonly (string | number)[]): GroupTable {
  const parsed = GroupTableSchema.safeParse(data);
  if (!parsed.success) {
    throw tableRejected(path, `group table rejected: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function tableFileNames(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch (error) {
    throw tableRejected(['groupTablesDir'], `group tables directory ${directory} cannot be read: ${messageOf(error)}`, error);
  }
}

function readTableFile(file: string, path: readonly (string | number)[]): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw tableRejected(path, `group table file ${file} cannot be read: ${messageOf(error)}`, error);
  }
}

/**
 * The `groupTables` option (the shipped tables without it) followed by the tables of `groupTablesDir`, each through its
 * schema; one that does not pass refuses creation at `groupTables.<index>` or `groupTablesDir.<file name>`.
 */
function loadGroupTables(options: Pick<CreateEngineOptions, 'groupTables' | 'groupTablesDir'>): GroupTable[] {
  const given = (options.groupTables ?? shippedGroupTables).map((data, index) => parseGroupTable(data, ['groupTables', index]));
  const directory = options.groupTablesDir;
  if (directory === undefined) return given;
  const fromDirectory = tableFileNames(directory).map((name) => {
    const path = ['groupTablesDir', name];
    return parseGroupTable(readTableFile(join(directory, name), path), path);
  });
  return [...given, ...fromDirectory];
}

/**
 * `Engine.checkCalibration`: reads the memory of the checker agent of each process's highest loaded version. A probe
 * assembly's configuration has no checker agent, so it has no key to look up; `createEngine` refuses such a one.
 */
function createCalibrationCheck(deps: {
  readonly database: Database;
  readonly configs: readonly AgentProcessConfig[];
  readonly processes: ProcessSet;
  readonly tables: readonly GroupTable[];
}): () => Promise<void> {
  const processIds = [...new Set(deps.configs.map((config) => config.processId))];
  return async () => {
    for (const processId of processIds) {
      const resolved = deps.processes.resolve(processId);
      if (!resolved.ok) continue;
      const checker = claimAssessmentAgent(resolved.config);
      if (checker === null) continue;
      const entries = await readDeploymentEntries(deps.database, { processId, agentName: checker.agentName });
      const pair = { agentFingerprint: checker.agentFingerprint, definitionMemoryFingerprint: definitionMemoryFingerprint(entries) };
      if (findGroupTableByPair(deps.tables, pair) === undefined) {
        throw new AgentCalibrationMissingError({ processId, version: resolved.config.version, ...pair });
      }
    }
  };
}

/** What the engine's internal assembly gets besides the options: the result forms of its registry (ADR-0010). */
export interface EngineComposition {
  readonly resultForms: readonly ResultForm[];
  /** A configuration without a definition of the form `claim_assessment` is refused (DC-4). */
  readonly requireVerifier?: boolean;
  /** Tool entries beside the engine's: the engine's test harness adds its probe tool; `createEngine` passes none. */
  readonly tools?: readonly ToolRegistryEntry[];
}

/**
 * Builds the engine (design-agent-core.md, KD-8) with the base and the research process's result forms. It takes no
 * forms: the registry is assembled inside the engine, so `apps/api` and other packages cannot add to it (ADR-0010).
 * A configuration needs a definition of the form `claim_assessment` here, and only here: the probe assemblies of
 * `agent-core` have none.
 */
export function createEngine(options: CreateEngineOptions): Engine {
  return composeEngine(options, { resultForms: [...SHIPPED_RESULT_FORMS, ...RESEARCH_FORMS], requireVerifier: true });
}

/**
 * The engine's internal assembly (ADR-0010): `createEngine` passes it the engine's forms, and the engine's test harness
 * adds its probe form from the package's sources; `index.ts` does not export it.
 *
 * Builds the engine (design-engine.md, Contract Definitions). Throws with the configuration path when a configuration
 * fails the schema, a definition or `assessModels` model has no catalog entry or does not resolve, a `processId` +
 * `version` pair repeats, a group table or a file of `groupTablesDir` fails its schema, a definition names a tool or a
 * result form outside the registries, stands against its form's placement or has a window below its least view
 * (DC-1, DC-28), or — only with a connected source — a configured source is not allowed for `source.fetch` (DC-14).
 * Without a connected source it writes exactly one `warn` instead (DC-18). Registers the `agent.root` and `agent.run`
 * handlers of agent runs (design-agent-core.md, KD-1) and the `engine.lifecycle` event consumer, which closes an
 * investigation when its root run ends. Reads neither the environment nor the database; of the disk, only
 * `groupTablesDir`.
 */
export function composeEngine(options: CreateEngineOptions, composition: EngineComposition): Engine {
  const catalog = options.modelCatalog ?? DEFAULT_MODEL_CATALOG;
  const groupTables = loadGroupTables(options);
  const registries: AgentRegistries = {
    tools: createToolRegistry([...BASE_TOOLS, ...RESEARCH_TOOLS, ...(composition.tools ?? [])]),
    forms: createResultFormRegistry(bindGroupTables(composition.resultForms, groupTables)),
    // A closure: the registry of `apps/api` is a class, and its method needs its `this`.
    resolveTool: (request) => options.sourceRegistry.resolveTool(request),
    buildSourcesField,
  };
  const timings: AgentRunTimings = {
    turnMs: options.turnMs ?? DEFAULT_AGENT_TIMINGS.turnMs,
    deadlineMarginMs: options.deadlineMarginMs ?? DEFAULT_AGENT_TIMINGS.deadlineMarginMs,
    attemptSliceMs: options.attemptSliceMs ?? DEFAULT_AGENT_TIMINGS.attemptSliceMs,
    busyWaitMs: options.busyWaitMs ?? DEFAULT_AGENT_TIMINGS.busyWaitMs,
    leaseMs: options.leaseMs ?? DEFAULT_AGENT_TIMINGS.leaseMs,
  };
  const configs = loadConfigs(options.processes, {
    catalog,
    timings,
    registries,
    requireVerifier: composition.requireVerifier === true,
  });
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
  if (sources.warnNoSources) {
    options.logger.warn(NO_SOURCES_WARNING);
  }

  const { clock, tokenCounter, logger } = options;
  const gateway = createModelGateway({ models, tokenCounter, catalog, clock, logger });

  for (const handler of createAgentRunHandlers({
    database: options.database,
    scheduler: options.runtime.scheduler,
    investigations: options.runtime.investigations,
    gateway,
    registries,
    processTools: RESEARCH_IMMEDIATE_TOOLS,
    processTaskTools: researchTaskTools({ sources: options.sourceRegistry, clock, logger }),
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
    processes: processSet.set,
    sourceMode: sources.sourceMode,
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
    checkCalibration: createCalibrationCheck({ database: options.database, configs, processes: processSet.set, tables: groupTables }),
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
