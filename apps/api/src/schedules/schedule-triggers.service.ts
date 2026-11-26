import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ViewOperations } from '@agent-os/agents';
import { LOGGER, type Logger } from '@agent-os/common';
import { ScheduleRuleSchema } from '@agent-os/contracts';
import {
  Db,
  type ScheduleRow,
  type ScheduleRunRow,
  SchedulesRepository,
} from '@agent-os/db';
import { CLOCK, type Clock, inSavepoint } from '@agent-os/runtime';
import { isUuid } from '../common/is-uuid';
import { ConversationsService } from '../chat/conversations.service';
import { IdentityDirectory } from '../identity/identity-directory';
import { nextTermAfter, type RuleInput, termsThrough } from './schedule-rule';
import { schedulesError } from './schedules.errors';

/** The delay between passes that left no work (KD-3): under a minute, so a term triggers in time (NFR-03). */
export const SCHEDULE_PASS_PERIOD_MS = 5_000;
/** Due schedules one pass claims; a full batch means work remains and the next pass runs at once. */
const SCHEDULE_PASS_BATCH = 20;

export const ruleInput = (row: ScheduleRow): RuleInput => ({
  rule: ScheduleRuleSchema.parse(row.rule),
  timeZone: row.timeZone,
  ruleSetAt: row.ruleSetAt,
});

/** The id is the owner's live root of a chat (`forkable` marks a chat root, not a trainer or a test run). */
export async function isLiveChat(
  views: Pick<ViewOperations, 'root'>,
  conversationId: string,
  ownerId: string,
): Promise<boolean> {
  if (!isUuid(conversationId)) return false;
  const root = await views.root(conversationId, ownerId);
  return root?.forkable === true;
}

/** The title of a trigger's new conversation: «{name} · {day}», the day in the schedule's zone and language (KD-6). */
function titleOf(schedule: ScheduleRow, dueAt: Date): string {
  const day = new Intl.DateTimeFormat(schedule.language, {
    day: 'numeric',
    month: 'short',
    timeZone: schedule.timeZone,
  }).format(dueAt);
  return `${schedule.name} · ${day}`;
}

/** What one trigger is: its term, whether it is manual, and the terms the server missed before it (FR-06). */
interface Term {
  readonly dueAt: Date;
  readonly manual: boolean;
  readonly missed: number;
}

/**
 * The trigger service (design-schedules.md, KD-1, KD-2, KD-4, Flow 1): the pass over due terms and the trigger
 * of a term — one transaction that holds the schedule, moves it to its next term, sends the instruction through
 * the chat's send in a savepoint and writes one history row. After the commit the runtime owns the work; the
 * schedule knows no statuses. «Run now» triggers through the same claim without moving the term.
 */
@Injectable()
export class ScheduleTriggersService {
  private readonly logger: Logger;

  constructor(
    private readonly db: Db,
    @Inject(SchedulesRepository)
    private readonly schedules: SchedulesRepository,
    private readonly conversations: ConversationsService,
    @Inject(ViewOperations) private readonly views: ViewOperations,
    private readonly identity: IdentityDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'schedules.triggers' });
  }

  /**
   * One pass (KD-3, NFR-03): the due terms of active schedules, a batch from the earliest, each claimed on its own,
   * so a failure of one is logged and leaves the rest. `true` — the batch was full and some claim went through.
   */
  async pass(): Promise<boolean> {
    const startedAt = Date.now();
    const due = await this.schedules.listDue(
      this.clock.now(),
      SCHEDULE_PASS_BATCH,
    );
    let failed = 0;
    for (const schedule of due) {
      const claimStartedAt = Date.now();
      try {
        await this.claimDue(schedule);
      } catch (error) {
        failed += 1;
        // The whole claim rolled back: the term stays due and the next pass claims it again.
        this.logger.error('schedule claim failed', {
          scheduleId: schedule.id,
          ownerId: schedule.ownerId,
          dueAt: schedule.nextRunAt?.toISOString() ?? null,
          durationMs: Date.now() - claimStartedAt,
          error,
        });
      }
    }
    // A batch whose every claim failed made no progress: the next pass waits the period instead of spinning.
    const more = due.length === SCHEDULE_PASS_BATCH && failed < due.length;
    this.logger.info('schedule pass', {
      due: due.length,
      failed,
      more,
      durationMs: Date.now() - startedAt,
    });
    return more;
  }

  /**
   * «Run now» (FR-11): a manual trigger at this moment in any state; neither the state nor the next term change.
   * 409 `SCHEDULE_NOT_RUNNABLE` for a `this_conversation` schedule whose conversation is gone: nothing is written,
   * and its next term pauses it.
   */
  async runNow(scheduleId: string): Promise<ScheduleRunRow> {
    const dueAt = this.clock.now();
    return this.db.transaction(async () => {
      const held = await this.schedules.hold(scheduleId);
      if (held === undefined) throw schedulesError('SCHEDULE_NOT_FOUND');
      if (!(await this.targetAlive(held))) {
        this.logger.info('schedule run now refused: conversation gone', {
          scheduleId,
          ownerId: held.ownerId,
          conversationId: held.conversationId,
          dueAt: dueAt.toISOString(),
        });
        throw schedulesError('SCHEDULE_NOT_RUNNABLE');
      }
      return this.trigger(held, { dueAt, manual: true, missed: 0 });
    });
  }

  /**
   * Claims the due term of a schedule (KD-1): holds its row, and only while it still waits for this term moves it
   * to the next term after now — one trigger for the last of the missed terms, a `once` schedule completed by the
   * same move. A late claim writes nothing. A `this_conversation` schedule whose conversation is gone is paused
   * with no row (AC-09.1).
   */
  private async claimDue(due: ScheduleRow): Promise<void> {
    const expected = due.nextRunAt;
    if (expected === null) return;
    const startedAt = Date.now();
    const now = this.clock.now();
    const fields = {
      scheduleId: due.id,
      ownerId: due.ownerId,
      expectedDueAt: expected.toISOString(),
    };
    await this.db.transaction(async () => {
      const held = await this.schedules.hold(due.id);
      if (
        held?.state !== 'active' ||
        held.nextRunAt?.getTime() !== expected.getTime()
      ) {
        this.logger.info('schedule term already claimed', {
          ...fields,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      if (!(await this.targetAlive(held))) {
        await this.schedules.update(held.id, held.ownerId, {
          state: 'paused',
          pausedBecause: 'conversation_deleted',
          nextRunAt: null,
        });
        this.logger.info('schedule paused at its term: conversation gone', {
          ...fields,
          conversationId: held.conversationId,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      const input = ruleInput(held);
      const terms = termsThrough(input, expected, now);
      const dueAt = terms.at(-1) ?? expected;
      const next = nextTermAfter(input, now);
      await this.schedules.update(
        held.id,
        held.ownerId,
        next === null
          ? { state: 'completed', nextRunAt: null }
          : { state: 'active', nextRunAt: next },
      );
      await this.trigger(held, {
        dueAt,
        manual: false,
        missed: Math.max(terms.length - 1, 0),
      });
    });
  }

  /**
   * The trigger in the claim's transaction (KD-2, KD-4): a disabled owner sends nothing; otherwise the chat's send
   * of the instruction, chip and mark into the schedule's conversation or a new id, in a savepoint. A refusal or
   * another error after which the transaction goes on rolls back only the send's writes, and the row is written
   * without a conversation; an error that aborts the transaction is thrown and rolls the claim back.
   */
  private async trigger(
    schedule: ScheduleRow,
    term: Term,
  ): Promise<ScheduleRunRow> {
    const startedAt = Date.now();
    const { ownerId } = schedule;
    const fields = {
      scheduleId: schedule.id,
      ownerId,
      dueAt: term.dueAt.toISOString(),
      manual: term.manual,
      missed: term.missed,
      target: schedule.target,
      agentId: schedule.agentId,
      instructionLength: schedule.instruction.length,
    };
    let conversationId: string | null = null;
    if (await this.identity.isActive(ownerId)) {
      const target =
        schedule.target === 'this_conversation' &&
        schedule.conversationId !== null
          ? schedule.conversationId
          : randomUUID();
      const sent = await inSavepoint(this.db, () =>
        this.conversations.send(
          target,
          ownerId,
          schedule.instruction,
          schedule.agentId ?? undefined,
          {
            schedule: {
              scheduleId: schedule.id,
              name: schedule.name,
              manual: term.manual,
            },
            ...(schedule.target === 'new_conversation'
              ? { title: titleOf(schedule, term.dueAt) }
              : {}),
          },
        ),
      );
      if (sent.ok) conversationId = target;
      else
        this.logger.warn('schedule trigger refused: the send failed', {
          ...fields,
          conversationId: target,
          error: sent.error,
        });
    } else {
      this.logger.info('schedule trigger refused: owner disabled', fields);
    }
    const run = await this.schedules.insertRun({
      id: randomUUID(),
      scheduleId: schedule.id,
      dueAt: term.dueAt,
      manual: term.manual,
      conversationId,
    });
    this.logger.info('schedule triggered', {
      ...fields,
      runId: run.id,
      conversationId,
      durationMs: Date.now() - startedAt,
    });
    return run;
  }

  /** A `this_conversation` schedule needs its conversation alive as a chat; a new-conversation one always runs. */
  private async targetAlive(schedule: ScheduleRow): Promise<boolean> {
    if (schedule.target !== 'this_conversation') return true;
    return (
      schedule.conversationId !== null &&
      isLiveChat(this.views, schedule.conversationId, schedule.ownerId)
    );
  }
}
