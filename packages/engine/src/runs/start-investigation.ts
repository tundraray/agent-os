import type { Database } from '@agent-os/db';
import type { InvestigationService, TaskScheduler } from '@agent-os/runtime';
import { ProcessConfigSchema, type ProcessConfig } from '../config/process-config.schema.js';
import type { ProcessSet } from '../config/process-set.js';
import type { SourceMode } from '../config/source-check.js';
import { type EngineRunRow, engineRunsRepository as runs } from './engine-runs.repository.js';
import { controllerTaskSpec, ENGINE_REQUESTER_KEY, findShell, resolveTokenBudget } from './start-rules.js';

/** Runtime services the engine uses, narrowed to the methods it calls (an E2E child may wrap `propose`). */
export interface EngineRuntimePorts {
  readonly scheduler: Pick<TaskScheduler, 'propose'>;
  readonly investigations: Pick<InvestigationService, 'create' | 'listForThread' | 'cancel'>;
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

export interface StartDeps extends EngineRuntimePorts {
  readonly database: Database;
  readonly processes: ProcessSet;
  readonly sourceMode: SourceMode;
}

/** A start whose admitted state contradicts itself: a defect, never a refusal the caller could act on. */
class StartInvestigationError extends Error {
  override readonly name = 'StartInvestigationError';
}

interface Launch {
  readonly input: StartInvestigationInput;
  readonly config: ProcessConfig;
  readonly tokenBudget: number;
}

/**
 * `Engine.startInvestigation` (design-engine.md, Contract Definitions; KD-9, DC-15, DC-16, DC-19). Refusals come
 * before any write; the thread-ownership error of `InvestigationService.create` propagates unchanged.
 */
export function startInvestigation(deps: StartDeps) {
  /** Proposes the run's controller task (again) and records its id; `subscribed` when it already exists. */
  async function proposeController(
    run: EngineRunRow,
    outcome: 'created' | 'existing',
  ): Promise<StartInvestigationResult> {
    const config = ProcessConfigSchema.parse(run.processConfig);
    const proposed = await deps.scheduler.propose(
      controllerTaskSpec({ investigationId: run.investigationId, config, tokenBudget: run.tokenBudget }),
      ENGINE_REQUESTER_KEY,
    );
    if (proposed.outcome === 'rejected') {
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
      sourceMode: deps.sourceMode,
      tokenBudget: request.tokenBudget,
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

  return async (input: StartInvestigationInput): Promise<StartInvestigationResult> => {
    const resolution = deps.processes.resolve(input.processId, input.version);
    if (!resolution.ok) {
      return { outcome: 'rejected', code: 'process_unknown' };
    }
    const budget = resolveTokenBudget(input.tokenBudget, resolution.config.limits.investigationTokens);
    if (!budget.ok) {
      return { outcome: 'rejected', code: 'budget_out_of_range' };
    }

    const recorded = await runs.findByLaunchKey(deps.database, input.resourceId, input.launchKey);
    if (recorded !== undefined) {
      return proposeController(recorded, 'existing');
    }
    return launch({ input, config: resolution.config, tokenBudget: budget.tokenBudget }, 1);
  };
}
