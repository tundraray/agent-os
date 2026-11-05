import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { RESEARCH_METADATA_KEYS } from '@agent-os/contracts';
import type { Database, DatabaseConnection } from '@agent-os/db';
import type { Engine } from '@agent-os/engine';
import type { CancelTimer, Clock, Runtime } from '@agent-os/runtime';
import type { MastraDBMessage } from '@mastra/core/memory';
import type { Memory } from '@mastra/memory';
import { withFields } from '../common/log-fields.js';
import { RESEARCH_ENGINE } from '../engine/engine.tokens.js';
import {
  RESEARCH_DATABASE,
  RESEARCH_RUNTIME,
  RUNTIME_CLOCK,
} from '../research/research.tokens.js';
import { THREAD_MEMORY } from '../threads/thread-memory.provider.js';
import { ThreadRunRegistry } from '../threads/thread-run-registry.js';
import { ThreadsService } from '../threads/threads.service.js';
import { type LaunchRecord, nextLaunchState } from './launch-state.js';
import {
  type AnswerSourceRecord,
  buildResearchAnswer,
  citedEvidenceIds,
} from './research-answer.builder.js';
import { researchLaunchRepository as launches } from './research-launch.repository.js';
import { ResearchLaunchService } from './research-launch.service.js';
import { retryPauseMs } from './retry-pause.js';

/** Settings of the delivery loop, read by `ResearchChatModule` from the environment. */
export interface AnswerAppenderSettings {
  /** `RUNTIME_WORKERS`: the loop runs only with the runtime's workers. */
  readonly workers: boolean;
  /** `RUNTIME_POLL_MS`: the loop's period and the first retry pause. */
  readonly pollMs: number;
  /** `RESEARCH_APPEND_GIVE_UP_MS`. */
  readonly appendGiveUpMs: number;
  /** `RESEARCH_LAUNCH_RECOVERY_MS`. */
  readonly launchRecoveryMs: number;
}

/** Token of {@link AnswerAppenderSettings}. */
export const ANSWER_APPENDER_SETTINGS = Symbol('ANSWER_APPENDER_SETTINGS');

/** How one launch of a thread's queue ended in a pass: written or settled, or still waiting and holding the queue. */
type Delivery = 'settled' | 'waiting';

const AWAITING_ANSWER: ReadonlySet<LaunchRecord['state']> = new Set([
  'answer_pending',
  'answer_reappend',
]);

/**
 * The delivery loop `ResearchAnswerAppender` (design-chat-entry.md, KD-3, KD-4, Flow 3). Every `RUNTIME_POLL_MS` a
 * pass finishes launches left in `launching`, then writes the answers of `answer_pending` and `answer_reappend`
 * launches thread by thread in completion order: a thread with a chat run is skipped until the next pass, the row is
 * read again under the thread lock, the message `research-answer-<investigationId>` is saved through `Memory` and the
 * launch is `answered`. A failed write keeps the thread's later answers waiting, is retried after a pause doubling
 * from `RUNTIME_POLL_MS` up to 16 times it, and fails the launch `RESEARCH_APPEND_GIVE_UP_MS` after the first failure
 * (DC-4, invariant 5).
 */
@Injectable()
export class ResearchAnswerAppender {
  private readonly logger = new Logger(ResearchAnswerAppender.name);
  private readonly db: Database;
  /**
   * Consecutive failed writes per launch, in memory only: after a restart the pause grows from `RUNTIME_POLL_MS`
   * again, while the give-up window counts from the stored `appendFailedAt`.
   */
  private readonly failures = new Map<string, number>();
  private cancelTimer: CancelTimer | null = null;
  private running = false;
  /** The pass in flight; passes never overlap. */
  private pass: Promise<void> = Promise.resolve();

  constructor(
    @Inject(ANSWER_APPENDER_SETTINGS)
    private readonly settings: AnswerAppenderSettings,
    @Inject(RESEARCH_DATABASE) database: DatabaseConnection,
    @Inject(RESEARCH_ENGINE) private readonly engine: Engine,
    @Inject(RESEARCH_RUNTIME) private readonly runtime: Runtime,
    @Inject(RUNTIME_CLOCK) private readonly clock: Clock,
    @Inject(THREAD_MEMORY) private readonly memory: Memory,
    private readonly threads: ThreadsService,
    private readonly runs: ThreadRunRegistry,
    private readonly launchService: ResearchLaunchService,
  ) {
    this.db = database.db;
  }

  /** Starts the loop when the runtime's workers are on; call after `Runtime.start`. */
  start(): void {
    if (!this.settings.workers || this.running) return;
    this.running = true;
    this.schedule();
    this.logger.log(
      `Research answer loop started pollMs=${this.settings.pollMs}`,
    );
  }

  /** Stops the loop and waits for the pass in flight; call before `Runtime.stop`. */
  async stop(): Promise<void> {
    this.running = false;
    this.cancelTimer?.();
    this.cancelTimer = null;
    await this.pass;
  }

  /** One pass of the loop, after the pass in flight. Its errors are logged, not thrown. */
  runOnce(): Promise<void> {
    this.pass = this.pass.then(() => this.passOnce());
    return this.pass;
  }

  private schedule(): void {
    this.cancelTimer = this.clock.setTimer(this.settings.pollMs, () => {
      void this.runOnce().finally(() => {
        if (this.running) this.schedule();
      });
    });
  }

  private async passOnce(): Promise<void> {
    try {
      await this.launchService.recoverLaunching(
        new Date(this.clock.now().getTime() - this.settings.launchRecoveryMs),
      );
      await this.deliverAnswers();
    } catch (error) {
      this.logger.error(
        'research answer pass failed',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /** Each thread's waiting launches in completion order; the first one that waits holds the rest of its thread. */
  private async deliverAnswers(): Promise<void> {
    const byThread = new Map<string, LaunchRecord[]>();
    for (const row of await launches.listAwaitingAnswer(this.db)) {
      const queue = byThread.get(row.threadId) ?? [];
      queue.push(row);
      byThread.set(row.threadId, queue);
    }
    for (const queue of byThread.values()) {
      for (const row of queue) {
        if ((await this.deliver(row)) === 'waiting') break;
      }
    }
  }

  private async deliver(row: LaunchRecord): Promise<Delivery> {
    const now = this.clock.now();
    if (
      row.appendFailedAt !== null &&
      now.getTime() - row.appendFailedAt.getTime() >=
        this.settings.appendGiveUpMs
    ) {
      await this.giveUp(row);
      return 'settled';
    }
    if (row.nextAppendAt !== null && row.nextAppendAt > now) return 'waiting';
    // Taken before the run check (DC-3): a message sent after the check is stored after the answer, never before it.
    const createdAt = now;
    if (this.runs.hasRuns(row.threadId)) return 'waiting';
    try {
      await this.threads.withOwnedThread(row.threadId, row.resourceId, () =>
        this.write(row, createdAt),
      );
      this.failures.delete(row.launchKey);
      return 'settled';
    } catch (error) {
      // A deleted thread: its rows go with it (the `purge` hook), nothing to write.
      if (error instanceof NotFoundException) return 'waiting';
      return this.recordFailure(row, error);
    }
  }

  /** Under the thread lock: the row read again, the answer saved, the launch `answered` (invariant 3). */
  private async write(stale: LaunchRecord, createdAt: Date): Promise<void> {
    const row = await launches.findByLaunchKey(this.db, stale, stale.launchKey);
    // Stopped, discarded or written meanwhile (AC-21.1, AC-22.2).
    if (row === undefined || !AWAITING_ANSWER.has(row.state)) return;
    if (row.investigationId === null) {
      throw new Error(`launch ${row.launchKey} has no investigation`);
    }
    const message = await this.answerOf(row, row.investigationId);
    const answer: MastraDBMessage = {
      id: message.id,
      threadId: row.threadId,
      resourceId: row.resourceId,
      role: 'assistant',
      createdAt,
      content: {
        format: 2,
        parts: [{ type: 'text', text: message.text }],
        metadata: {
          [RESEARCH_METADATA_KEYS.researchAnswer]: message.researchAnswer,
        },
      },
    };
    await this.memory.saveMessages({ messages: [answer] });
    const answered = await launches.transition(this.db, {
      launchKey: row.launchKey,
      from: row.state,
      to: 'answered',
      set: {
        answeredAt: this.clock.now(),
        appendFailedAt: null,
        nextAppendAt: null,
      },
    });
    this.logger.log(
      withFields('research answer written', {
        launchKey: row.launchKey,
        threadId: row.threadId,
        investigationId: row.investigationId,
        state: answered?.state,
      }),
    );
  }

  /** The answer message of a completed investigation; without sources no evidence is read (KD-8). */
  private async answerOf(row: LaunchRecord, investigationId: string) {
    const read = await this.engine.readInvestigation({
      investigationId,
      resourceId: row.resourceId,
    });
    if (read.outcome !== 'found' || read.view.status !== 'completed') {
      throw new Error(
        `investigation ${investigationId} of launch ${row.launchKey} has no answer to deliver`,
      );
    }
    const { view } = read;
    const evidence = new Map<string, AnswerSourceRecord>();
    for (const evidenceId of citedEvidenceIds(view)) {
      const { record } = await this.runtime.evidence.get(
        evidenceId,
        row.resourceId,
      );
      evidence.set(evidenceId, {
        sourceId: record.provenance.sourceId,
        toolName: record.provenance.toolName,
        snapshot: record.provenance.snapshot,
        truncated: record.coverage.truncated,
      });
    }
    return buildResearchAnswer({
      view,
      launch: {
        launchKey: row.launchKey,
        goal: row.goal,
        launch:
          row.mode === 'explicit' && row.userMessageId !== null
            ? { messageId: row.userMessageId }
            : { toolCallId: row.launchKey },
      },
      evidence,
    });
  }

  /**
   * `RESEARCH_APPEND_GIVE_UP_MS` has passed since the first failed write: the launch is `failed` and its thread's
   * queue goes on (DC-4).
   */
  private async giveUp(row: LaunchRecord): Promise<void> {
    this.failures.delete(row.launchKey);
    const to = nextLaunchState(row, 'append_window_expired');
    const failed =
      to === null
        ? undefined
        : await launches.transition(this.db, {
            launchKey: row.launchKey,
            from: row.state,
            to,
            set: { nextAppendAt: null },
          });
    this.logger.error(
      withFields('research answer given up', {
        ...logFields(row),
        state: failed?.state,
      }),
    );
  }

  /** A failed write: the row keeps its state and waits for the next try after the growing pause. */
  private async recordFailure(
    row: LaunchRecord,
    error: unknown,
  ): Promise<Delivery> {
    const now = this.clock.now();
    const firstFailure = row.appendFailedAt ?? now;
    const failures = (this.failures.get(row.launchKey) ?? 0) + 1;
    this.failures.set(row.launchKey, failures);
    await launches.transition(this.db, {
      launchKey: row.launchKey,
      from: row.state,
      to: row.state,
      set: {
        appendFailedAt: firstFailure,
        nextAppendAt: new Date(
          now.getTime() + retryPauseMs(this.settings.pollMs, failures),
        ),
      },
    });
    this.logger.warn(
      withFields('research answer write failed', {
        ...logFields(row),
        failures,
        error: error instanceof Error ? error.name : 'unknown',
      }),
    );
    return 'waiting';
  }
}

/** The identifiers and state a log line of the loop may carry (plan rule 13). */
function logFields(row: LaunchRecord) {
  return {
    launchKey: row.launchKey,
    threadId: row.threadId,
    investigationId: row.investigationId ?? undefined,
    state: row.state,
  };
}
