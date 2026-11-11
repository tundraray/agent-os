import type { TaskSpec } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { InvestigationService, TaskScheduler } from '@agent-os/runtime';
import type { SourceRegistry } from '@agent-os/sources';
import { type DefinitionMemorySnapshot, takeDefinitionMemorySnapshot } from '../agents/definition-memory.js';
import type { ToolAccessPolicy } from '../agents/tool-access-policy.js';
import type { ResultFormRegistry } from '../agents/result-forms.js';
import { type AgentProcessConfig, AgentProcessConfigSchema } from '../config/agent-config.schema.js';
import type { ProcessSet } from '../config/process-set.js';
import type { SourceMode } from '../config/source-check.js';
import { type EngineRunRow, engineRunsRepository as runs } from './engine-runs.repository.js';
import {
  buildSourceCatalog,
  type CatalogCandidate,
  catalogSourceMode,
  type SourceCatalog,
  SourceCatalogSchema,
} from './source-catalog.js';
import { readSourceSnapshots, type SourceSnapshotDeps } from './source-snapshots.js';
import { ENGINE_REQUESTER_KEY, findShell, resolveTokenBudget, rootTaskSpec } from './start-rules.js';

/**
 * Runtime services the engine uses, narrowed to the methods it calls (an E2E child may wrap `propose`); `closeInTx`
 * is called by the `engine.lifecycle` consumer only.
 */
export interface EngineRuntimePorts {
  readonly scheduler: Pick<TaskScheduler, 'propose'>;
  readonly investigations: Pick<InvestigationService, 'create' | 'listForThread' | 'cancel' | 'closeInTx'>;
}

export interface StartInvestigationInput {
  readonly resourceId: string;
  readonly threadId: string;
  readonly query: string;
  readonly processId: string;
  /** Without it, the highest loaded version of the process (DC-15). */
  readonly version?: number;
  /** Identifies the launch for the user: a repeated start with it returns the recorded investigation. */
  readonly launchKey: string;
  /** Token budget of the investigation; the configuration's default without it. */
  readonly tokenBudget?: number;
}

export type StartInvestigationResult =
  | {
      readonly outcome: 'created' | 'existing';
      readonly investigationId: string;
      readonly controllerTaskId: string;
    }
  | { readonly outcome: 'rejected'; readonly code: 'process_unknown' | 'budget_out_of_range' };

/**
 * `sources`, `connectedSources` and `accessPolicy` build the catalog of a start; `sources`, `clock` and `logger` read
 * the slice of each catalog source (design-catalog-planning.md, KD-1, DC-3).
 */
export interface StartDeps extends EngineRuntimePorts, SourceSnapshotDeps {
  readonly database: Database;
  readonly processes: ProcessSet;
  readonly sources: Pick<SourceRegistry, 'currentSnapshot' | 'describeSource' | 'resolveTool'>;
  /** `sourceId` of the sources the deployment connected. */
  readonly connectedSources: readonly string[];
  /** Asked once per connected ceiling source about the owner's right to the source as a whole. */
  readonly accessPolicy: ToolAccessPolicy;
  /** The engine's result forms: a start takes the definition memory snapshot by them (DC-24). */
  readonly forms: ResultFormRegistry;
}

/** A start whose admitted state contradicts itself: a defect, never a refusal the caller could act on. */
class StartInvestigationError extends Error {
  override readonly name = 'StartInvestigationError';
}

interface Launch {
  readonly input: StartInvestigationInput;
  readonly config: AgentProcessConfig;
  readonly tokenBudget: number;
  /**
   * Built once per call, before the first write, with the slices of its sources; a repeated start of a recorded launch
   * builds none and asks the rights port nothing.
   */
  readonly sourceCatalog: SourceCatalog;
  /** The mode of the investigation by its catalog: an empty catalog runs on model knowledge (DC-10). */
  readonly sourceMode: SourceMode;
  /** The definition memory snapshot of the start, taken with the source slices (DC-24). */
  readonly definitionMemorySnapshot: DefinitionMemorySnapshot;
}

/**
 * `Engine.startInvestigation` (design-engine.md, Contract Definitions; KD-9, DC-15, DC-16, DC-19). Refusals come
 * before any write; the thread-ownership error of `InvestigationService.create` propagates unchanged. A new launch
 * records its source catalog and the mode it gives in its engine row (design-catalog-planning.md, KD-1, DC-3, DC-10),
 * each catalog source with the slice read at start (design-self-check.md, KD-7): a slice not read within 2 seconds or
 * failed is recorded empty and the start goes on; the row of a recorded launch is never rewritten.
 */
export function startInvestigation(deps: StartDeps) {
  /**
   * The main task of the recorded run: the root run `agent.root` with the investigation's question
   * (design-agent-core.md, «Операции движка»). It depends only on the recorded run.
   */
  async function mainTaskSpec(run: EngineRunRow): Promise<TaskSpec> {
    return rootTaskSpec({
      investigationId: run.investigationId,
      config: AgentProcessConfigSchema.parse(run.processConfig),
      tokenBudget: run.tokenBudget,
      query: await runs.readQuery(deps.database, run.investigationId),
      sourceMode: run.sourceMode as SourceMode,
      catalog: SourceCatalogSchema.parse(run.sourceCatalog),
      createdAt: run.createdAt,
    });
  }

  /**
   * Proposes the run's main task (again) and records its id as `controller_task_id`; `subscribed` when it already
   * exists.
   */
  async function proposeController(
    run: EngineRunRow,
    outcome: 'created' | 'existing',
  ): Promise<StartInvestigationResult> {
    const proposed = await deps.scheduler.propose(await mainTaskSpec(run), ENGINE_REQUESTER_KEY);
    if (proposed.outcome === 'rejected') {
      // A closed or stopped investigation takes no task any more (design-lifecycle.md, KD-1); its recorded controller
      // task is still the launch's, so a repeated start returns it as before the closure.
      if (proposed.reason === 'investigation_inactive' && run.controllerTaskId !== null) {
        return { outcome, investigationId: run.investigationId, controllerTaskId: run.controllerTaskId };
      }
      throw new StartInvestigationError(
        `controller task of investigation ${run.investigationId} refused: ${proposed.reason}`,
      );
    }
    if (run.controllerTaskId !== proposed.taskId) {
      await runs.setControllerTask(deps.database, run.investigationId, proposed.taskId);
    }
    return { outcome, investigationId: run.investigationId, controllerTaskId: proposed.taskId };
  }

  /** Takes the shell a failed start left, or creates the investigation; `shell` says which. */
  async function claimInvestigation({ input, config }: Launch): Promise<{ investigationId: string; shell: boolean }> {
    const budget = { maxTasks: config.limits.maxTasks, maxToolCalls: config.limits.maxToolCalls };
    const thread = await deps.investigations.listForThread(input.resourceId, input.threadId);
    const withEngineRow = await runs.withEngineRow(
      deps.database,
      thread.map((investigation) => investigation.investigationId),
    );
    const shell = findShell(thread, { ...input, ...budget }, withEngineRow);
    if (shell !== undefined) {
      return { investigationId: shell.investigationId, shell: true };
    }
    const created = await deps.investigations.create({
      resourceId: input.resourceId,
      threadId: input.threadId,
      query: input.query,
      budget,
    });
    return { investigationId: created.investigationId, shell: false };
  }

  /**
   * Records the engine row over a claimed investigation. A `launchKey` conflict means another call recorded this
   * launch: its run is returned and an investigation this call created is cancelled. An investigation conflict means
   * another start took the same shell: the search runs once more.
   */
  async function launch(request: Launch, searchesLeft: number): Promise<StartInvestigationResult> {
    const { input } = request;
    const claimed = await claimInvestigation(request);
    const inserted = await runs.insert(deps.database, {
      investigationId: claimed.investigationId,
      resourceId: input.resourceId,
      launchKey: input.launchKey,
      config: request.config,
      sourceMode: request.sourceMode,
      tokenBudget: request.tokenBudget,
      sourceCatalog: request.sourceCatalog,
      definitionMemorySnapshot: request.definitionMemorySnapshot,
    });
    if (inserted !== undefined) {
      return proposeController(inserted, 'created');
    }

    const recorded = await runs.findByLaunchKey(deps.database, input.resourceId, input.launchKey);
    if (recorded !== undefined) {
      if (!claimed.shell) {
        await deps.investigations.cancel(claimed.investigationId, input.resourceId);
      }
      return proposeController(recorded, 'existing');
    }
    if (claimed.shell && searchesLeft > 0) {
      return launch(request, searchesLeft - 1);
    }
    throw new StartInvestigationError(
      `engine row of investigation ${claimed.investigationId} conflicted without a run of launch ${input.launchKey}`,
    );
  }

  /** The catalog with the slice of each of its sources; an empty catalog reads none (DC-3, DC-10). */
  async function withSnapshots(candidates: readonly CatalogCandidate[]): Promise<SourceCatalog> {
    if (candidates.length === 0) return [];
    const snapshots = await readSourceSnapshots(
      deps,
      candidates.map((candidate) => candidate.sourceId),
    );
    return candidates.map((candidate) => ({ ...candidate, snapshot: snapshots[candidate.sourceId] ?? null }));
  }

  return async (input: StartInvestigationInput): Promise<StartInvestigationResult> => {
    const resolution = deps.processes.resolve(input.processId, input.version);
    if (!resolution.ok) {
      return { outcome: 'rejected', code: 'process_unknown' };
    }
    const config = resolution.config;
    const budget = resolveTokenBudget(input.tokenBudget, config.limits.investigationTokens);
    if (!budget.ok) {
      return { outcome: 'rejected', code: 'budget_out_of_range' };
    }

    const recorded = await runs.findByLaunchKey(deps.database, input.resourceId, input.launchKey);
    if (recorded !== undefined) {
      return proposeController(recorded, 'existing');
    }
    const candidates = await buildSourceCatalog(
      { sources: deps.sources, accessPolicy: deps.accessPolicy },
      { resourceId: input.resourceId, config, connectedSources: deps.connectedSources },
    );
    const sourceCatalog = await withSnapshots(candidates);
    const definitionMemorySnapshot = await takeDefinitionMemorySnapshot(deps.database, {
      config,
      forms: deps.forms,
      resourceId: input.resourceId,
    });
    return launch(
      {
        input,
        config,
        tokenBudget: budget.tokenBudget,
        sourceCatalog,
        sourceMode: catalogSourceMode(sourceCatalog),
        definitionMemorySnapshot,
      },
      1,
    );
  };
}
