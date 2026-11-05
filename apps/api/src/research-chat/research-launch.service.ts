import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  DeepResearchToolResult,
  ResearchDecision,
  ResearchLaunchView,
  ThreadResearchResponse,
} from '@agent-os/contracts';
import type { Database, DatabaseConnection } from '@agent-os/db';
import {
  deepResearchProcessV1,
  type Engine,
  type InvestigationView,
  loadProcessConfig,
} from '@agent-os/engine';
import type { Runtime } from '@agent-os/runtime';
import { withFields } from '../common/log-fields.js';
import { RESEARCH_ENGINE } from '../engine/engine.tokens.js';
import {
  RESEARCH_DATABASE,
  RESEARCH_RUNTIME,
} from '../research/research.tokens.js';
import { ThreadsService } from '../threads/threads.service.js';
import {
  type LaunchAction,
  type LaunchRecord,
  nextLaunchState,
  toLaunchView,
} from './launch-state.js';
import {
  type LaunchFields,
  type LaunchThread,
  researchLaunchRepository as launches,
} from './research-launch.repository.js';

/** The process a chat launch starts, at its highest loaded version (design-chat-entry.md, Contract Definitions). */
const PROCESS_ID = 'deep-research';

/** A `deepResearch` call of a mode or proposal turn: the thread, the call's id as `launchKey`, and the model's input. */
export interface LaunchRequest extends LaunchThread {
  readonly launchKey: string;
  readonly goal: string;
  readonly tokenBudget?: number;
}

/** A mode turn's call also names the user message that carried the mode. */
export interface ExplicitLaunchRequest extends LaunchRequest {
  readonly userMessageId: string;
}

/** A card decision of a decision turn in the thread of the turn (the turn's owner). */
export interface DecisionRequest extends LaunchThread {
  readonly decision: ResearchDecision;
}

/** What a decision found under the thread lock: a proposal to start outside it, or the result as it stands. */
type DecisionStep =
  | { readonly kind: 'start'; readonly row: LaunchRecord }
  | { readonly kind: 'done'; readonly result: DeepResearchToolResult };

/** States a stop cancels the investigation in (Flow 4). */
const STOPPABLE: ReadonlySet<LaunchRecord['state']> = new Set([
  'running',
  'answer_pending',
]);

const NOT_FOUND: DeepResearchToolResult = {
  launch: null,
  decisionError: 'not_found',
};

/** Bounds of a launch's token budget: `investigationTokens` of the shipped `deep-research` configuration. */
export function investigationTokenLimits(): { default: number; max: number } {
  const loaded = loadProcessConfig(deepResearchProcessV1);
  if (!loaded.ok) {
    throw new Error(
      `the shipped ${PROCESS_ID} configuration is refused: ${loaded.rejection.message}`,
    );
  }
  return loaded.config.limits.investigationTokens;
}

/** The controller's final status in the view, as the action it is for the launch row (KD-3 reconciliation). */
const FINISHED_ACTION: Readonly<
  Partial<Record<InvestigationView['status'], LaunchAction>>
> = {
  completed: 'task_succeeded',
  failed: 'task_failed',
  cancelled: 'task_cancelled',
};

/**
 * The only writer of launch rows outside the answer consumer and the delivery loop, and the only one that starts an
 * investigation from a chat (design-chat-entry.md, C3 api; KD-3, KD-8). Rows are written through the transitions of
 * `launch-state.ts`; a start runs outside the thread lock, because `InvestigationService.create` takes it itself and
 * the lock is not reentrant.
 */
@Injectable()
export class ResearchLaunchService {
  private readonly logger = new Logger(ResearchLaunchService.name);
  private readonly db: Database;
  private readonly defaultTokenBudget = investigationTokenLimits().default;
  /**
   * Launch keys whose start runs in this process. A confirmed proposal enters `launching` long after its row was
   * created, so recovery tells a lost start from a running one by this set, not by the row's age alone.
   */
  private readonly starting = new Set<string>();

  constructor(
    @Inject(RESEARCH_DATABASE) database: DatabaseConnection,
    @Inject(RESEARCH_ENGINE) private readonly engine: Engine,
    @Inject(RESEARCH_RUNTIME) private readonly runtime: Runtime,
    private readonly threads: ThreadsService,
  ) {
    this.db = database.db;
  }

  /** The thread's launches for the card; a missing or foreign thread is the threads API's 404. */
  async listForThread(thread: LaunchThread): Promise<ThreadResearchResponse> {
    await this.threads.getOwnedThread(thread.threadId, thread.resourceId);
    const rows = await launches.listByThread(this.db, thread);
    const sourceMode = this.engine.sourceMode;
    return { launches: rows.map((row) => toLaunchView(row, sourceMode)) };
  }

  /** A turn without the mode: the agent only proposes; no investigation starts (KD-1, AC-19.5). */
  async propose(request: LaunchRequest): Promise<ResearchLaunchView> {
    const row = await this.threads.withOwnedThread(
      request.threadId,
      request.resourceId,
      () =>
        launches.insert(this.db, {
          ...request,
          mode: 'proposal',
          tokenBudget: request.tokenBudget ?? this.defaultTokenBudget,
          userMessageId: null,
        }),
    );
    this.logger.log(
      withFields('research launch proposed', {
        launchKey: row.launchKey,
        threadId: row.threadId,
        state: row.state,
      }),
    );
    return this.view(row);
  }

  /**
   * A mode turn (Flow 1): the row is written `launching` under the thread lock, the investigation starts outside it,
   * the row moves to `running`, then the start is reconciled with the investigation's view. A refused start leaves the
   * row `failed`; it is the result, not an exception, so the agent's turn ends.
   */
  async launch(request: ExplicitLaunchRequest): Promise<ResearchLaunchView> {
    const row = await this.threads.withOwnedThread(
      request.threadId,
      request.resourceId,
      () =>
        launches.insert(this.db, {
          ...request,
          mode: 'explicit',
          tokenBudget: request.tokenBudget ?? this.defaultTokenBudget,
        }),
    );
    return this.view((await this.start(row)).row);
  }

  /**
   * A decision turn (KD-2, Flow 2, Flow 4): the row of `launchKey` in this owner's thread is read and changed under the
   * thread lock; a confirmed proposal starts outside it with its recorded goal and budget. A decision the row has no
   * edge for changes nothing and returns the current view without an error (DC-1); a row not in this thread of this
   * owner, or discarded, is `not_found`.
   */
  async decide(request: DecisionRequest): Promise<DeepResearchToolResult> {
    const step = await this.threads.withOwnedThread(
      request.threadId,
      request.resourceId,
      () => this.applyDecision(request),
    );
    if (step.kind === 'done') return step.result;
    const started = await this.start(step.row);
    return started.refused
      ? this.result(started.row, 'launch_failed')
      : this.result(started.row);
  }

  /**
   * The next user message closes the thread's open proposals (DC-2); the caller decides that the message is one — not
   * a decision and not a repeat of the stored one.
   */
  async supersedeProposals(thread: LaunchThread): Promise<void> {
    await this.threads.withOwnedThread(
      thread.threadId,
      thread.resourceId,
      async () => {
        const rows = await launches.listByThread(this.db, thread);
        for (const row of rows) {
          if (row.state === 'proposed') await this.move(row, 'supersede', {});
        }
      },
    );
  }

  /**
   * Finishes launches left in `launching` by a failed process (KD-3): each row created before `cutoff` whose start is
   * not in flight in this process is started again with the same `launchKey` — the engine returns the investigation
   * a lost start already created — and ends `running`, or, when the start is refused, `failed` for an explicit launch
   * and `proposed` for a confirmed proposal.
   */
  async recoverLaunching(cutoff: Date): Promise<void> {
    const rows = await launches.listLaunchingCreatedBefore(this.db, cutoff);
    for (const row of rows) {
      if (this.starting.has(row.launchKey)) continue;
      this.logger.log(
        withFields('research launch recovered', {
          launchKey: row.launchKey,
          threadId: row.threadId,
          state: row.state,
        }),
      );
      await this.start(row);
    }
  }

  /** The decision's change under the thread lock; a confirm only moves the row to `launching`. */
  private async applyDecision(request: DecisionRequest): Promise<DecisionStep> {
    const { action, launchKey } = request.decision;
    const row = await launches.findByLaunchKey(this.db, request, launchKey);
    if (row === undefined || row.state === 'discarded') {
      return { kind: 'done', result: NOT_FOUND };
    }
    if (action === 'stop')
      return { kind: 'done', result: await this.stop(row) };
    const moved = await this.move(row, action, {});
    if (row.state !== 'proposed' || moved.state !== 'launching') {
      return { kind: 'done', result: this.result(moved) };
    }
    // Marked before the lock is released, so the loop's recovery never takes this start for a lost one.
    this.starting.add(moved.launchKey);
    return { kind: 'start', row: moved };
  }

  /**
   * A stop of a running launch (Flow 4): the investigation is cancelled, then the row is `stopped`. A refused cancel
   * leaves the row as it is and answers `stop_failed`.
   */
  private async stop(row: LaunchRecord): Promise<DeepResearchToolResult> {
    if (!STOPPABLE.has(row.state) || row.investigationId === null) {
      return this.result(row);
    }
    try {
      await this.runtime.investigations.cancel(
        row.investigationId,
        row.resourceId,
      );
    } catch (error) {
      this.logger.error(
        withFields('research stop failed', {
          launchKey: row.launchKey,
          threadId: row.threadId,
          investigationId: row.investigationId,
        }),
        error instanceof Error ? error.stack : undefined,
      );
      return this.result(row, 'stop_failed');
    }
    return this.result(
      await this.move(row, 'stop', { finishedAt: new Date() }),
    );
  }

  /**
   * Starts the investigation of a `launching` row and returns the row as it stands afterwards; `refused` when the
   * engine refused or failed the start.
   */
  private async start(
    row: LaunchRecord,
  ): Promise<{ row: LaunchRecord; refused: boolean }> {
    this.starting.add(row.launchKey);
    try {
      return await this.startAndRecord(row);
    } finally {
      this.starting.delete(row.launchKey);
    }
  }

  private async startAndRecord(
    row: LaunchRecord,
  ): Promise<{ row: LaunchRecord; refused: boolean }> {
    const started = await this.startInvestigation(row);
    if (started === null) {
      return {
        // A confirmed proposal goes back to its card unfinished; an explicit launch has failed.
        row: await this.move(
          row,
          'start_failed',
          row.mode === 'explicit' ? { finishedAt: new Date() } : {},
        ),
        refused: true,
      };
    }
    const running = await this.move(row, 'started', started);
    return {
      row:
        running.state === 'running'
          ? await this.reconcile(running, started.investigationId)
          : running,
      refused: false,
    };
  }

  /** The engine's start; `null` when it refused or failed (logged with the launch's identifiers only). */
  private async startInvestigation(
    row: LaunchRecord,
  ): Promise<{ investigationId: string; controllerTaskId: string } | null> {
    try {
      const result = await this.engine.startInvestigation({
        resourceId: row.resourceId,
        threadId: row.threadId,
        query: row.goal,
        processId: PROCESS_ID,
        launchKey: row.launchKey,
        tokenBudget: row.tokenBudget,
      });
      if (result.outcome !== 'rejected') {
        return {
          investigationId: result.investigationId,
          controllerTaskId: result.controllerTaskId,
        };
      }
      this.logger.warn(
        withFields('research start refused', {
          launchKey: row.launchKey,
          threadId: row.threadId,
          code: result.code,
        }),
      );
    } catch (error) {
      this.logger.error(
        withFields('research start failed', {
          launchKey: row.launchKey,
          threadId: row.threadId,
        }),
        error instanceof Error ? error.stack : undefined,
      );
    }
    return null;
  }

  /**
   * Copies the investigation's source mode into the row and, when the investigation already ended before the row
   * said `running`, gives the row its final state at once: an event delivered before the write is caught here (KD-3,
   * KD-8).
   */
  private async reconcile(
    row: LaunchRecord,
    investigationId: string,
  ): Promise<LaunchRecord> {
    const read = await this.engine.readInvestigation({
      investigationId,
      resourceId: row.resourceId,
    });
    if (read.outcome !== 'found') return row;
    const { view } = read;
    const copied =
      (await launches.copySourceMode(
        this.db,
        row.launchKey,
        view.sourceMode,
      )) ?? row;
    const finished = FINISHED_ACTION[view.status];
    return finished === undefined
      ? copied
      : this.move(copied, finished, { finishedAt: new Date() });
  }

  /**
   * Applies `action` to the row through the state machine with a conditional write. When the pair has no edge, or
   * another writer moved the row first, the row is returned as it now stands.
   */
  private async move(
    row: LaunchRecord,
    action: LaunchAction,
    set: LaunchFields,
  ): Promise<LaunchRecord> {
    const to = nextLaunchState(row, action);
    const moved =
      to === null
        ? undefined
        : await launches.transition(this.db, {
            launchKey: row.launchKey,
            from: row.state,
            to,
            set,
          });
    if (moved !== undefined) {
      this.logger.log(
        withFields('research launch moved', {
          launchKey: moved.launchKey,
          threadId: moved.threadId,
          investigationId: moved.investigationId ?? undefined,
          from: row.state,
          state: moved.state,
        }),
      );
      return moved;
    }
    return (await launches.findByLaunchKey(this.db, row, row.launchKey)) ?? row;
  }

  private view(row: LaunchRecord): ResearchLaunchView {
    return toLaunchView(row, this.engine.sourceMode);
  }

  /** The tool's result for a decision; a row discarded meanwhile has no view and is `not_found`. */
  private result(
    row: LaunchRecord,
    decisionError?: 'launch_failed' | 'stop_failed',
  ): DeepResearchToolResult {
    if (row.state === 'discarded') return NOT_FOUND;
    const launch = this.view(row);
    return decisionError === undefined ? { launch } : { launch, decisionError };
  }
}
