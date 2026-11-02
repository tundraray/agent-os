import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
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
import { withFields } from '../common/log-fields.js';
import { RESEARCH_ENGINE } from '../engine/engine.tokens.js';
import { RESEARCH_DATABASE } from '../research/research.tokens.js';
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

  constructor(
    @Inject(RESEARCH_DATABASE) database: DatabaseConnection,
    @Inject(RESEARCH_ENGINE) private readonly engine: Engine,
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
    return this.view(await this.start(row));
  }

  /** Starts the investigation of a `launching` row and returns the row as it stands afterwards. */
  private async start(row: LaunchRecord): Promise<LaunchRecord> {
    const started = await this.startInvestigation(row);
    if (started === null) {
      return this.move(row, 'start_failed', { finishedAt: new Date() });
    }
    const running = await this.move(row, 'started', started);
    return running.state === 'running'
      ? this.reconcile(running, started.investigationId)
      : running;
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
}
