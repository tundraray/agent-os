import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import type {
  DeepResearchToolResult,
  ResearchDecision,
  ResearchLaunchView,
  StopResearchToolResult,
  ThreadResearchResponse,
} from '@agent-os/contracts';
import type { Database, DatabaseConnection } from '@agent-os/db';
import {
  deepResearchProcessV2,
  type Engine,
  type InvestigationView,
  loadProcessConfig,
} from '@agent-os/engine';
import type { Runtime } from '@agent-os/runtime';
import type { MastraDBMessage } from '@mastra/core/memory';
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
import { DEEP_RESEARCH_TOOL } from './research-turn.js';
import { STOPPABLE_STATES, stopTarget } from './stop-target.js';

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

/** A stop of the launch `launchKey` in the caller's thread (design-lifecycle.md, KD-4). */
export interface StopRequest extends LaunchThread {
  readonly launchKey: string;
}

/** A `stopResearch` call of an ordinary turn: the thread from the agent's memory and the key the model named, if any. */
export interface AgentStopRequest extends LaunchThread {
  readonly launchKey?: string;
}

/**
 * What a stop did. `launch` alone: the launch after the stop, `stopped` or as it already was. `not_found`: no such
 * launch in the caller's thread, or it is `discarded`. `stop_failed`: the lock, the cancel or the move to `stopped`
 * refused and the launch is unchanged; `launch` is `null` when the lock refused before the launch was read.
 */
export type StopLaunchResult =
  | { readonly launch: ResearchLaunchView; readonly error?: undefined }
  | { readonly launch: null; readonly error: 'not_found' }
  | {
      readonly launch: ResearchLaunchView | null;
      readonly error: 'stop_failed';
    };

/** A card decision the decision turn applies itself; a stop goes to `stopLaunch`. */
type CardDecision = {
  readonly action: Exclude<ResearchDecision['action'], 'stop'>;
  readonly launchKey: string;
};

/** What a decision found under the thread lock: a proposal to start outside it, or the result as it stands. */
type DecisionStep =
  | { readonly kind: 'start'; readonly row: LaunchRecord }
  | { readonly kind: 'done'; readonly result: DeepResearchToolResult };

const NOT_FOUND: DeepResearchToolResult = {
  launch: null,
  decisionError: 'not_found',
};

/** Id prefix of answer messages (`research-answer-<investigationId>`, invariant 4). */
const ANSWER_MESSAGE_PREFIX = 'research-answer-';

/** The `launchKey`s of the cards a stored message carries: its `deepResearch` calls (KD-1). */
function cardLaunchKeys(message: MastraDBMessage): string[] {
  return (message.content.parts ?? []).flatMap((part) =>
    part.type === 'tool-invocation' &&
    part.toolInvocation.toolName === DEEP_RESEARCH_TOOL
      ? [part.toolInvocation.toolCallId]
      : [],
  );
}

/** The investigation whose answer the stored message is, or none. */
function answeredInvestigationIds(message: MastraDBMessage): string[] {
  return message.id.startsWith(ANSWER_MESSAGE_PREFIX)
    ? [message.id.slice(ANSWER_MESSAGE_PREFIX.length)]
    : [];
}

/** Bounds of a launch's token budget: `investigationTokens` of the shipped `deep-research` configuration. */
export function investigationTokenLimits(): { default: number; max: number } {
  const loaded = loadProcessConfig(deepResearchProcessV2);
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
   * A decision turn (KD-2, Flow 2): the row of `launchKey` in this owner's thread is read and changed under the
   * thread lock; a confirmed proposal starts outside it with its recorded goal and budget. A decision the row has no
   * edge for changes nothing and returns the current view without an error (DC-1); a row not in this thread of this
   * owner, or discarded, is `not_found`. A `stop` is `stopLaunch`, called before any lock is taken: the lock is not
   * reentrant (design-lifecycle.md, KD-4).
   */
  async decide(request: DecisionRequest): Promise<DeepResearchToolResult> {
    const { action, launchKey } = request.decision;
    if (action === 'stop') return this.stopDecision({ ...request, launchKey });
    const step = await this.threads.withOwnedThread(
      request.threadId,
      request.resourceId,
      () => this.applyDecision(request, { action, launchKey }),
    );
    if (step.kind === 'done') return step.result;
    const started = await this.start(step.row);
    return started.refused
      ? this.result(started.row, 'launch_failed')
      : this.result(started.row);
  }

  /**
   * The single stop operation (design-lifecycle.md, KD-4, Flow 1), with no model call: under the thread lock, after
   * the ownership check, the launch of `launchKey` in the caller's thread is read; a `running` or `answer_pending`
   * launch has its investigation cancelled and then moves to `stopped` with its end time, any other launch is returned
   * as it is. A missing or foreign thread is the threads API's 404, thrown. A refusal of the lock, the cancel or the
   * move is `stop_failed` with the launch unchanged; a retry cancels again (a no-op for an investigation that is no
   * longer `active`) and finishes the move.
   */
  async stopLaunch(request: StopRequest): Promise<StopLaunchResult> {
    try {
      return await this.threads.withOwnedThread(
        request.threadId,
        request.resourceId,
        () => this.stopUnderLock(request),
      );
    } catch (error) {
      // The ownership 404 is the caller's answer; anything else here is a refused lock or a failed read.
      if (error instanceof HttpException) throw error;
      this.logStopFailure(request, error);
      return { launch: null, error: 'stop_failed' };
    }
  }

  /**
   * The agent's stop (design-lifecycle.md, KD-4, Flow 2): the code chooses the launch among the thread's launches by
   * `stopTarget` — never the model beyond naming a key — and stops it with `stopLaunch`. A key that is not in this
   * thread of this owner is `not_found`; without a key, no running launch is `nothing_to_stop` and several are
   * `ambiguous` with their keys and goals, and nothing changes. When the lock refused before the launch was read, the
   * launch as the choice read it is the unchanged launch of `stop_failed`.
   */
  async stopResearch(
    request: AgentStopRequest,
  ): Promise<StopResearchToolResult> {
    const target = stopTarget(
      await launches.listByThread(this.db, request),
      request.launchKey,
    );
    if (target.kind === 'ambiguous') {
      return {
        launch: null,
        error: 'ambiguous',
        candidates: target.running.map(({ launchKey, goal }) => ({
          launchKey,
          goal,
        })),
      };
    }
    if (target.kind !== 'stop') return { launch: null, error: target.kind };
    const stopped = await this.stopLaunch({
      threadId: request.threadId,
      resourceId: request.resourceId,
      launchKey: target.launch.launchKey,
    });
    if (stopped.error === undefined) return { launch: stopped.launch };
    if (stopped.error === 'not_found')
      return { launch: null, error: 'not_found' };
    return {
      launch: stopped.launch ?? this.view(target.launch),
      error: 'stop_failed',
    };
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
   * The selection of a regenerated tail (KD-7, Flow 5), run by `discardRepliesAfter` before it deletes `tail`. Under
   * the thread lock every launch whose card is in the tail becomes `discarded` and its investigation is cancelled; a
   * launch whose card is outside the tail but whose answer is in it becomes `answer_reappend`, and the delivery loop
   * writes that answer again. A row already moved by an earlier selection whose delete failed stays as it is, and the
   * repeated cancel changes nothing in the runtime. An error (a refused cancel) propagates and cancels the delete.
   */
  async discardTail(
    thread: LaunchThread,
    tail: readonly MastraDBMessage[],
  ): Promise<void> {
    const cards = new Set(tail.flatMap(cardLaunchKeys));
    const investigationIds = tail.flatMap(answeredInvestigationIds);
    if (cards.size === 0 && investigationIds.length === 0) return;
    await this.threads.withOwnedThread(
      thread.threadId,
      thread.resourceId,
      async () => {
        const rows = await launches.listByCardsOrAnswers(this.db, thread, {
          launchKeys: [...cards],
          investigationIds,
        });
        const discarded: LaunchRecord[] = [];
        for (const row of rows) {
          if (cards.has(row.launchKey)) discarded.push(await this.discard(row));
          else await this.move(row, 'answer_removed', {});
        }
        for (const row of discarded) {
          if (row.state === 'discarded' && row.investigationId !== null) {
            await this.runtime.investigations.cancel(
              row.investigationId,
              row.resourceId,
            );
          }
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
  private async applyDecision(
    thread: LaunchThread,
    { action, launchKey }: CardDecision,
  ): Promise<DecisionStep> {
    const row = await launches.findByLaunchKey(this.db, thread, launchKey);
    if (row === undefined || row.state === 'discarded') {
      return { kind: 'done', result: NOT_FOUND };
    }
    const moved = await this.move(row, action, {});
    if (row.state !== 'proposed' || moved.state !== 'launching') {
      return { kind: 'done', result: this.result(moved) };
    }
    // Marked before the lock is released, so the loop's recovery never takes this start for a lost one.
    this.starting.add(moved.launchKey);
    return { kind: 'start', row: moved };
  }

  /** `stopLaunch` under the thread lock: the launch is read; a running one is cancelled, then moved. */
  private async stopUnderLock(request: StopRequest): Promise<StopLaunchResult> {
    const row = await launches.findByLaunchKey(
      this.db,
      request,
      request.launchKey,
    );
    if (row === undefined || row.state === 'discarded') {
      return { launch: null, error: 'not_found' };
    }
    if (!STOPPABLE_STATES.has(row.state) || row.investigationId === null) {
      return { launch: this.view(row) };
    }
    try {
      await this.runtime.investigations.cancel(
        row.investigationId,
        row.resourceId,
      );
      return { launch: this.view(await this.moveToStopped(row)) };
    } catch (error) {
      this.logStopFailure(request, error);
      return { launch: this.view(row), error: 'stop_failed' };
    }
  }

  /**
   * Moves the row to `stopped` from whatever stoppable state it reaches meanwhile: the answer consumer does not take
   * the thread lock, so a `running` row may become `answer_pending` between the read and the write. A row that left
   * the stoppable states (settled, already stopped) is returned as it stands.
   */
  private async moveToStopped(row: LaunchRecord): Promise<LaunchRecord> {
    let current = row;
    for (;;) {
      const moved = await this.move(current, 'stop', {
        finishedAt: new Date(),
      });
      if (moved.state === current.state || !STOPPABLE_STATES.has(moved.state)) {
        return moved;
      }
      current = moved;
    }
  }

  /**
   * The legacy decision turn with `stop` (a tab opened before the update): `stopLaunch`, answered as a
   * `DeepResearchToolResult`. When the lock refused before the launch was read, the launch is read outside it.
   */
  private async stopDecision(
    request: StopRequest,
  ): Promise<DeepResearchToolResult> {
    const stopped = await this.stopLaunch(request);
    if (stopped.error === undefined) return { launch: stopped.launch };
    if (stopped.error === 'not_found') return NOT_FOUND;
    if (stopped.launch !== null) {
      return { launch: stopped.launch, decisionError: 'stop_failed' };
    }
    const row = await launches.findByLaunchKey(
      this.db,
      request,
      request.launchKey,
    );
    return row === undefined ? NOT_FOUND : this.result(row, 'stop_failed');
  }

  private logStopFailure(request: StopRequest, error: unknown): void {
    this.logger.error(
      withFields('research stop failed', {
        launchKey: request.launchKey,
        threadId: request.threadId,
      }),
      error instanceof Error ? error.stack : undefined,
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
    if (running.state === 'discarded') {
      // A regenerate discarded the card while the start ran (Flow 2): the investigation just created goes with it.
      await this.runtime.investigations.cancel(
        started.investigationId,
        row.resourceId,
      );
      return { row: running, refused: false };
    }
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
   * Moves the row to `discarded` from whatever state it reaches meanwhile: the answer consumer does not take the thread
   * lock, so a `running` row may become `answer_pending` between the read and the write. A row with no `discard` edge
   * (settled, or already discarded) is returned as it stands.
   */
  private async discard(row: LaunchRecord): Promise<LaunchRecord> {
    let current = row;
    while (nextLaunchState(current, 'discard') !== null) {
      const moved = await this.move(current, 'discard', {});
      if (moved.state === current.state) return moved;
      current = moved;
    }
    return current;
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
