import { Inject, Injectable } from '@nestjs/common';
import { inRootLaunchSet, ViewOperations } from '@agent-os/agents';
import {
  type ChipRecord,
  RecordKindSchema,
  SCHEDULE_NAME_MAX_LENGTH,
  SCHEDULE_RUNS_PAGE_SIZE,
  type ScheduleAgent,
  type ScheduleBody,
  type ScheduleListResponse,
  type ScheduleNextRunRequest,
  type ScheduleNextRunResponse,
  ScheduleRuleSchema,
  type ScheduleRunView,
  type ScheduleRunsPage,
  SchedulePauseReasonSchema,
  ScheduleStateSchema,
  ScheduleTargetSchema,
  type ScheduleView,
} from '@agent-os/contracts';
import {
  AgentsRepository,
  Db,
  type OwnedScheduleRow,
  type ScheduleChange,
  type ScheduleRow,
  type ScheduleRunListRow,
  SchedulesRepository,
} from '@agent-os/db';
import { CLOCK, type Clock } from '@agent-os/runtime';
import { z } from 'zod';
import { isUuid } from '../common/is-uuid';
import {
  CursorTimeSchema,
  decodeCursor,
  encodeCursor,
} from '../common/opaque-cursor';
import { LibraryService } from '../library/library.service';
import { nextTermAfter, ruleProblem } from './schedule-rule';
import {
  isLiveChat,
  ruleInput,
  ScheduleTriggersService,
} from './schedule-triggers.service';
import { invalidSchedule, schedulesError } from './schedules.errors';

/** Resumable: not completed and not waiting for an answer in a deleted conversation (DC-4). */
const resumable = (schedule: ScheduleRow): boolean =>
  schedule.state !== 'completed' && schedule.pausedBecause === null;

/** One history row; a deleted conversation is not offered: its id is `null` (AC-08.2). */
const toRunView = ({
  run,
  conversationDeletedAt,
}: ScheduleRunListRow): ScheduleRunView => ({
  id: run.id,
  dueAt: run.dueAt.toISOString(),
  manual: run.manual,
  conversationId: conversationDeletedAt === null ? run.conversationId : null,
});

/** Position of the last row of a history page: `dueAt` in ms and `id`. */
const RunCursorSchema = z.strictObject({
  d: CursorTimeSchema,
  i: z.string().refine(isUuid),
});

function encodeRunCursor(row: ScheduleRunListRow): string {
  return encodeCursor({ d: row.run.dueAt.getTime(), i: row.run.id });
}

/** Parses a cursor of `encodeRunCursor`; anything else → 400 `INVALID_CURSOR`. */
function decodeRunCursor(cursor: string): { dueAt: Date; id: string } {
  const { d, i } = decodeCursor(cursor, RunCursorSchema, () =>
    schedulesError('INVALID_CURSOR'),
  );
  return { dueAt: new Date(d), id: i };
}

/**
 * The name of a schedule: the employee's, or the start of the instruction on one line, cut at the last word
 * boundary within the limit (a hard cut only inside one long word).
 */
function nameOf(body: ScheduleBody): string {
  if (body.name !== undefined && body.name !== '') return body.name;
  const chars = Array.from(body.instruction.replace(/\s+/g, ' ').trim());
  if (chars.length <= SCHEDULE_NAME_MAX_LENGTH) return chars.join('');
  const space = chars.lastIndexOf(' ', SCHEDULE_NAME_MAX_LENGTH);
  return chars.slice(0, space > 0 ? space : SCHEDULE_NAME_MAX_LENGTH).join('');
}

/** The rule as written, for comparing a stored one with a new one: jsonb does not keep the key order. */
const ruleKey = (rule: unknown): string =>
  JSON.stringify(ScheduleRuleSchema.parse(rule));

/**
 * An employee's schedules (design-schedules.md, C3 «маршруты расписаний», Flow 2): the routes. The owner is the
 * session's; another employee's schedule answers as a missing one, and so does an id that is not a UUID. The agent
 * passes the chip rule of a message, the conversation is the owner's live chat root. The next term is counted in
 * the transaction that writes the schedule; «Run now» goes to the trigger service.
 */
@Injectable()
export class SchedulesService {
  constructor(
    private readonly db: Db,
    @Inject(SchedulesRepository)
    private readonly schedules: SchedulesRepository,
    @Inject(AgentsRepository) private readonly agents: AgentsRepository,
    private readonly library: LibraryService,
    @Inject(ViewOperations) private readonly views: ViewOperations,
    private readonly triggers: ScheduleTriggersService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Every schedule of the owner: active by the next term, then paused, then completed. */
  async list(ownerId: string): Promise<ScheduleListResponse> {
    const rows = await this.schedules.listOwned(ownerId);
    return {
      schedules: await Promise.all(rows.map((row) => this.toView(row))),
    };
  }

  /** Flow 2: checks the rule, the conversation and the agent, then writes the schedule with its next term. */
  async create(ownerId: string, body: ScheduleBody): Promise<ScheduleView> {
    const now = this.clock.now();
    this.checkRule(body, now);
    if (body.conversationId !== null)
      await this.liveConversation(body.conversationId, ownerId);
    else if (body.target === 'this_conversation')
      throw schedulesError('THREAD_NOT_FOUND');
    await this.checkAgent(ownerId, body.agentId);
    const id = await this.db.transaction(async () => {
      const nextRunAt = this.firstTerm(body, now);
      const row = await this.schedules.insert({
        ownerId,
        name: nameOf(body),
        instruction: body.instruction,
        agentId: body.agentId,
        rule: body.rule,
        timeZone: body.timeZone,
        language: body.language,
        target: body.target,
        conversationId: body.conversationId,
        state: 'active',
        pausedBecause: null,
        nextRunAt,
        ruleSetAt: now,
      });
      return row.id;
    });
    return this.get(id, ownerId);
  }

  /** The nearest term from now of a rule; nothing is written. */
  nextRun(request: ScheduleNextRunRequest): ScheduleNextRunResponse {
    const now = this.clock.now();
    this.checkRule(request, now);
    return { nextRunAt: this.firstTerm(request, now).toISOString() };
  }

  async get(id: string, ownerId: string): Promise<ScheduleView> {
    return this.toView(await this.owned(id, ownerId));
  }

  /**
   * Changes the schedule (AC-10.1, FR-09): its conversation never changes, a `this_conversation` answer needs it
   * alive; the next term is counted again from now, a completed schedule with a term ahead is active again, and
   * a pause for a deleted conversation is lifted by answering in a new one (`resume` restarts it).
   */
  async update(
    id: string,
    ownerId: string,
    body: ScheduleBody,
  ): Promise<ScheduleView> {
    const { schedule } = await this.owned(id, ownerId);
    const now = this.clock.now();
    this.checkRule(body, now);
    if (body.conversationId !== schedule.conversationId)
      throw invalidSchedule(
        'conversationId: the conversation of a schedule never changes',
      );
    if (body.target === 'this_conversation') {
      if (body.conversationId === null)
        throw schedulesError('THREAD_NOT_FOUND');
      await this.liveConversation(body.conversationId, ownerId);
    }
    await this.checkAgent(ownerId, body.agentId);
    const ruleChanged =
      ruleKey(schedule.rule) !== ruleKey(body.rule) ||
      schedule.timeZone !== body.timeZone;
    const ruleSetAt = ruleChanged ? now : schedule.ruleSetAt;
    const paused = schedule.state === 'paused';
    await this.db.transaction(() =>
      this.schedules.update(id, ownerId, {
        name: nameOf(body),
        instruction: body.instruction,
        agentId: body.agentId,
        rule: body.rule,
        timeZone: body.timeZone,
        language: body.language,
        target: body.target,
        state: paused ? 'paused' : 'active',
        pausedBecause: null,
        nextRunAt: paused ? null : this.firstTerm({ ...body, ruleSetAt }, now),
        ruleSetAt,
      }),
    );
    return this.get(id, ownerId);
  }

  /** Pauses an active schedule; the conversations of its triggers are left alone, a completed schedule does not change. */
  async pause(id: string, ownerId: string): Promise<ScheduleView> {
    const { schedule } = await this.owned(id, ownerId);
    if (schedule.state === 'active')
      await this.change(id, ownerId, { state: 'paused', nextRunAt: null });
    return this.get(id, ownerId);
  }

  /**
   * Resumes a paused schedule from its nearest future term (AC-02.2): 409 `SCHEDULE_NOT_RUNNABLE` for a
   * completed one and for one waiting for an answer in a deleted conversation (DC-4). A `once` schedule whose
   * term passed while it was paused is completed: a term on pause is not caught up.
   */
  async resume(id: string, ownerId: string): Promise<ScheduleView> {
    const { schedule } = await this.owned(id, ownerId);
    if (!resumable(schedule)) throw schedulesError('SCHEDULE_NOT_RUNNABLE');
    if (schedule.state === 'paused') {
      const next = nextTermAfter(ruleInput(schedule), this.clock.now());
      await this.change(
        id,
        ownerId,
        next === null
          ? { state: 'completed', nextRunAt: null }
          : { state: 'active', nextRunAt: next },
      );
    }
    return this.get(id, ownerId);
  }

  /** Deletes the schedule with its history; the conversations of its runs stay (AC-02.3). */
  async delete(id: string, ownerId: string): Promise<void> {
    const deleted = isUuid(id) && (await this.schedules.delete(id, ownerId));
    if (!deleted) throw schedulesError('SCHEDULE_NOT_FOUND');
  }

  /** A page of the schedule's history, latest terms first (`SCHEDULE_RUNS_PAGE_SIZE`, `nextCursor`). */
  async runs(
    id: string,
    ownerId: string,
    cursor?: string,
  ): Promise<ScheduleRunsPage> {
    await this.owned(id, ownerId);
    const after = cursor === undefined ? undefined : decodeRunCursor(cursor);
    const rows = await this.schedules.runsPage(
      id,
      SCHEDULE_RUNS_PAGE_SIZE + 1,
      after,
    );
    const page = rows.slice(0, SCHEDULE_RUNS_PAGE_SIZE);
    const last = page.at(-1);
    return {
      runs: page.map(toRunView),
      nextCursor:
        rows.length > SCHEDULE_RUNS_PAGE_SIZE && last
          ? encodeRunCursor(last)
          : null,
    };
  }

  /** «Run now» (FR-11, DC-4): the trigger service's manual trigger of the owner's schedule. */
  async runNow(id: string, ownerId: string): Promise<ScheduleRunView> {
    await this.owned(id, ownerId);
    const run = await this.triggers.runNow(id);
    return toRunView({ run, conversationDeletedAt: null });
  }

  /** The chip of the schedule's agent by the chip rule now (AC-01.3); `null` — it does not pass. */
  private async agentChip(
    ownerId: string,
    agentId: string,
  ): Promise<ChipRecord | null> {
    const resolved = await this.library.resolve(ownerId, agentId);
    if (resolved === null || !inRootLaunchSet(resolved)) return null;
    return { id: resolved.id, kind: resolved.kind, name: resolved.name };
  }

  /** The owner's schedule; a malformed, missing or foreign id is `SCHEDULE_NOT_FOUND`. */
  private async owned(id: string, ownerId: string): Promise<OwnedScheduleRow> {
    const row = isUuid(id)
      ? await this.schedules.findOwned(id, ownerId)
      : undefined;
    if (row === undefined) throw schedulesError('SCHEDULE_NOT_FOUND');
    return row;
  }

  private async change(
    id: string,
    ownerId: string,
    change: ScheduleChange,
  ): Promise<void> {
    await this.db.transaction(() => this.schedules.update(id, ownerId, change));
  }

  /** 400 `VALIDATION_FAILED` for a rule a schedule may not have (DC-2). */
  private checkRule(
    { rule, timeZone }: Pick<ScheduleBody, 'rule' | 'timeZone'>,
    now: Date,
  ): void {
    const problem = ruleProblem(rule, timeZone, now);
    if (problem !== null) throw invalidSchedule(problem);
  }

  /** The first term after `now` of a rule `checkRule` passed; `ruleSetAt` defaults to now. */
  private firstTerm(
    {
      rule,
      timeZone,
      ruleSetAt,
    }: Pick<ScheduleBody, 'rule' | 'timeZone'> & { ruleSetAt?: Date },
    now: Date,
  ): Date {
    const term = nextTermAfter(
      { rule, timeZone, ruleSetAt: ruleSetAt ?? now },
      now,
    );
    if (term === null) throw invalidSchedule('rule: the time is in the past');
    return term;
  }

  /**
   * The owner's live chat conversation; a malformed, missing, deleted or foreign id is `THREAD_NOT_FOUND` (DC-1),
   * and so is a root that is not a chat (a trainer or a test run): its root refuses the trigger's message.
   */
  private async liveConversation(
    conversationId: string,
    ownerId: string,
  ): Promise<void> {
    if (!(await isLiveChat(this.views, conversationId, ownerId)))
      throw schedulesError('THREAD_NOT_FOUND');
  }

  /** The chip rule of a message (AC-01.3): an agent the owner's chat may not start is `RECORD_NOT_FOUND`. */
  private async checkAgent(
    ownerId: string,
    agentId: string | null,
  ): Promise<void> {
    if (agentId !== null && (await this.agentChip(ownerId, agentId)) === null)
      throw schedulesError('RECORD_NOT_FOUND');
  }

  /** The schedule's agent: its chip and whether the chip rule passes now (UXRD SH-05). */
  private async agentOf(
    ownerId: string,
    agentId: string | null,
  ): Promise<ScheduleAgent | null> {
    if (agentId === null) return null;
    const chip = await this.agentChip(ownerId, agentId);
    if (chip !== null) return { ...chip, available: true };
    const row = await this.agents.findAny(agentId);
    if (row === undefined)
      throw new Error(`Schedule agent ${agentId} has no row`);
    return {
      id: row.id,
      kind: RecordKindSchema.parse(row.kind),
      name: row.name,
      available: false,
    };
  }

  private async toView({
    schedule,
    conversationTitle,
    conversationDeletedAt,
  }: OwnedScheduleRow): Promise<ScheduleView> {
    const { ownerId } = schedule;
    const [agent, lastRun] = await Promise.all([
      this.agentOf(ownerId, schedule.agentId),
      this.schedules.lastRun(schedule.id),
    ]);
    return {
      id: schedule.id,
      name: schedule.name,
      instruction: schedule.instruction,
      rule: ScheduleRuleSchema.parse(schedule.rule),
      timeZone: schedule.timeZone,
      target: ScheduleTargetSchema.parse(schedule.target),
      createdAt: schedule.createdAt.toISOString(),
      agent,
      conversation:
        schedule.conversationId === null
          ? null
          : {
              id: schedule.conversationId,
              title: conversationTitle ?? '',
              deleted: conversationDeletedAt !== null,
            },
      state: ScheduleStateSchema.parse(schedule.state),
      pausedBecause: SchedulePauseReasonSchema.nullable().parse(
        schedule.pausedBecause,
      ),
      nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
      lastRun: lastRun === undefined ? null : toRunView(lastRun),
    };
  }
}
