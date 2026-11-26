import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ACCESS_GATE,
  type AccessGate,
  AgentsError,
  ControlOperations,
  inRootLaunchSet,
  type ModelVerdict,
  OwnerDisabledError,
  StartOperations,
  ViewOperations,
} from '@agent-os/agents';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  AgentMessageKindSchema,
  type ChipRecord,
  RecordKindSchema,
  SCHEDULE_NAME_MAX_LENGTH,
  SCHEDULE_RUNS_PAGE_SIZE,
  type ScheduleAgent,
  type ScheduleBody,
  type ScheduleListResponse,
  type ScheduleMark,
  type ScheduleNextRunRequest,
  type ScheduleNextRunResponse,
  ScheduleRuleSchema,
  type ScheduleRunView,
  ScheduleRunOutcomeSchema,
  ScheduleRunStatusSchema,
  type ScheduleRunsPage,
  type ScheduleRunStatus,
  type ScheduleSkipReason,
  ScheduleSkipReasonSchema,
  SchedulePauseReasonSchema,
  ScheduleStateSchema,
  ScheduleTargetSchema,
  type ScheduleView,
} from '@agent-os/contracts';
import {
  AgentsRepository,
  ConversationsRepository,
  Db,
  type NewScheduleRunRow,
  type OwnedScheduleRow,
  type ScheduleChange,
  type ScheduleRow,
  type ScheduleRunListRow,
  type ScheduleRunRow,
  SchedulesRepository,
} from '@agent-os/db';
import {
  CLOCK,
  type Clock,
  Inbox,
  RuntimeError,
  TaskControl,
} from '@agent-os/runtime';
import { z } from 'zod';
import { isUuid } from '../common/is-uuid';
import {
  CursorTimeSchema,
  decodeCursor,
  encodeCursor,
} from '../common/opaque-cursor';
import { chatStatus } from '../chat/chat-status';
import { rootDescription } from '../chat/root-description';
import { LibraryService } from '../library/library.service';
import { type RunConversation, runStatus } from './run-status';
import { decideRun } from './schedule-decision';
import {
  nextTermAfter,
  ruleProblem,
  type RuleInput,
  termsThrough,
} from './schedule-rule';
import { invalidSchedule, schedulesError } from './schedules.errors';

const { user_message: userMessage } = AgentMessageKindSchema.enum;

/** The delay between passes that left no work (KD-3): under a minute, so a term starts in time (NFR-03). */
export const SCHEDULE_PASS_PERIOD_MS = 5_000;
/** Due schedules one pass claims; a full batch means work remains and the next pass runs at once. */
const SCHEDULE_PASS_BATCH = 20;

/** A term to claim: its due time, whether it is a manual run, and the terms the server missed before it. */
interface Term {
  readonly dueAt: Date;
  readonly manual: boolean;
  readonly missed: readonly Date[];
}

/** What a claim wrote: nothing for a paused schedule, else the term's history row. */
type Claim =
  | { readonly kind: 'paused' }
  | { readonly kind: 'written'; readonly run: ScheduleRunRow };

/** The agent of a run: the chat's, a chip with the agent's own model, or one that fails the chip rule now. */
type RunAgent =
  | { readonly kind: 'chat' }
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'chip';
      readonly record: ChipRecord;
      readonly model: string | null;
    };

/** Fields of a history row; the rest are empty. */
type RunFields = Pick<
  ScheduleRunRow,
  'id' | 'scheduleId' | 'dueAt' | 'manual' | 'outcome'
> &
  Partial<
    Pick<
      ScheduleRunRow,
      | 'skipReason'
      | 'conversationId'
      | 'unfinishedConversationId'
      | 'messageSeq'
    >
  >;

/** A history row as the claim writes it; `createdAt` is the database's (`toInsert`). */
function runRow(fields: RunFields): ScheduleRunRow {
  return {
    skipReason: null,
    conversationId: null,
    unfinishedConversationId: null,
    messageSeq: null,
    finalStatus: null,
    createdAt: new Date(),
    ...fields,
  };
}

function toInsert(row: ScheduleRunRow): NewScheduleRunRow {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    dueAt: row.dueAt,
    manual: row.manual,
    outcome: row.outcome,
    skipReason: row.skipReason,
    conversationId: row.conversationId,
    unfinishedConversationId: row.unfinishedConversationId,
    messageSeq: row.messageSeq,
    finalStatus: row.finalStatus,
  };
}

/** Resumable and runnable now: not completed and not waiting for an answer in a deleted conversation (DC-6). */
const runnable = (schedule: ScheduleRow): boolean =>
  schedule.state !== 'completed' && schedule.pausedBecause === null;

/** The mark a run's message or new conversation carries (KD-5). */
const markOf = (schedule: ScheduleRow, manual: boolean): ScheduleMark => ({
  scheduleId: schedule.id,
  name: schedule.name,
  manual,
});

/** The title of a run's new conversation: «{name} · {day}», the day in the schedule's zone and language (KD-6). */
function titleOf(schedule: ScheduleRow, dueAt: Date): string {
  const day = new Intl.DateTimeFormat(schedule.language, {
    day: 'numeric',
    month: 'short',
    timeZone: schedule.timeZone,
  }).format(dueAt);
  return `${schedule.name} · ${day}`;
}

/** The skip a refused start of a new conversation becomes (Flow 2, DC-5); `null` for any other error. */
function refusedStart(error: unknown): ScheduleSkipReason | null {
  if (error instanceof OwnerDisabledError) return 'owner_disabled';
  if (error instanceof AgentsError && error.code === 'START_REFUSED')
    return 'agent_unavailable';
  return null;
}

const isTaskExists = (error: unknown): boolean =>
  error instanceof RuntimeError && error.code === 'TASK_EXISTS';

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

/** The name of a schedule: the employee's, or the start of the instruction on one line. */
function nameOf(body: ScheduleBody): string {
  if (body.name !== undefined && body.name !== '') return body.name;
  const line = body.instruction.replace(/\s+/g, ' ');
  return Array.from(line).slice(0, SCHEDULE_NAME_MAX_LENGTH).join('').trim();
}

const ruleInput = (row: ScheduleRow): RuleInput => ({
  rule: ScheduleRuleSchema.parse(row.rule),
  timeZone: row.timeZone,
  ruleSetAt: row.ruleSetAt,
});

/** The rule as written, for comparing a stored one with a new one: jsonb does not keep the key order. */
const ruleKey = (rule: unknown): string =>
  JSON.stringify(ScheduleRuleSchema.parse(rule));

/**
 * An employee's schedules (design-schedules.md, C3 «маршруты расписаний», Flow 3): the routes, the rule of terms
 * and the run status of the history. The owner is the session's; another employee's schedule answers as a
 * missing one, and so does an id that is not a UUID. The agent passes the chip rule of a message, the
 * conversation is the owner's live root. The next term is counted in the transaction that writes the schedule.
 */
@Injectable()
export class SchedulesService {
  private readonly logger: Logger;

  constructor(
    private readonly db: Db,
    @Inject(SchedulesRepository)
    private readonly schedules: SchedulesRepository,
    @Inject(AgentsRepository) private readonly agents: AgentsRepository,
    @Inject(ConversationsRepository)
    private readonly conversationRows: ConversationsRepository,
    private readonly library: LibraryService,
    @Inject(ViewOperations) private readonly views: ViewOperations,
    @Inject(ControlOperations) private readonly control: ControlOperations,
    @Inject(StartOperations) private readonly starts: StartOperations,
    @Inject(ACCESS_GATE) private readonly access: AccessGate,
    @Inject(TaskControl) private readonly tasks: TaskControl,
    @Inject(Inbox) private readonly inbox: Inbox,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'schedules.runs' });
  }

  /** Every schedule of the owner: active by the next term, then paused, then completed. */
  async list(ownerId: string): Promise<ScheduleListResponse> {
    const rows = await this.schedules.listOwned(ownerId);
    return {
      schedules: await Promise.all(rows.map((row) => this.toView(row))),
    };
  }

  /** Flow 3: checks the rule, the conversation and the agent, then writes the schedule with its next term. */
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

  /** Pauses an active schedule; a running run is left alone, a completed schedule does not change. */
  async pause(id: string, ownerId: string): Promise<ScheduleView> {
    const { schedule } = await this.owned(id, ownerId);
    if (schedule.state === 'active')
      await this.change(id, ownerId, { state: 'paused', nextRunAt: null });
    return this.get(id, ownerId);
  }

  /**
   * Resumes a paused schedule from its nearest future term (AC-02.2): 409 `SCHEDULE_NOT_RUNNABLE` for a
   * completed one and for one waiting for an answer in a deleted conversation (DC-6). A `once` schedule whose
   * term passed while it was paused is completed: a term on pause is not caught up.
   */
  async resume(id: string, ownerId: string): Promise<ScheduleView> {
    const { schedule } = await this.owned(id, ownerId);
    if (!runnable(schedule)) throw schedulesError('SCHEDULE_NOT_RUNNABLE');
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
      runs: await Promise.all(page.map((row) => this.toRunView(row, ownerId))),
      nextCursor:
        rows.length > SCHEDULE_RUNS_PAGE_SIZE && last
          ? encodeRunCursor(last)
          : null,
    };
  }

  /**
   * «Запустить сейчас» (FR-11, Flow 2): the claim of a term without moving the next one — a `manual` row at
   * this moment — and a new conversation started in the request. 409 `SCHEDULE_NOT_RUNNABLE` as for `resume`,
   * also once the claim finds the conversation deleted and pauses the schedule.
   */
  async runNow(id: string, ownerId: string): Promise<ScheduleRunView> {
    await this.owned(id, ownerId);
    const startedAt = Date.now();
    const dueAt = this.clock.now();
    const { schedule, claim } = await this.db.transaction(async () => {
      const held = await this.schedules.hold(id);
      if (held === undefined) throw schedulesError('SCHEDULE_NOT_FOUND');
      return {
        schedule: held,
        claim: runnable(held)
          ? await this.claimTerm(held, { dueAt, manual: true, missed: [] })
          : undefined,
      };
    });
    const fields = { scheduleId: id, ownerId, dueAt, manual: true };
    if (claim === undefined) {
      this.logger.info('schedule run now refused: not runnable', {
        ...fields,
        state: schedule.state,
        pausedBecause: schedule.pausedBecause,
        durationMs: Date.now() - startedAt,
      });
      throw schedulesError('SCHEDULE_NOT_RUNNABLE');
    }
    this.logClaim(schedule, claim, { ...fields, startedAt, missed: 0 });
    if (claim.kind === 'paused') throw schedulesError('SCHEDULE_NOT_RUNNABLE');
    const run =
      claim.run.outcome === 'starting'
        ? await this.finishStarting(claim.run, schedule)
        : claim.run;
    return this.toRunView({ run, conversationDeletedAt: null }, ownerId);
  }

  /**
   * Pauses the `this_conversation` schedules of a conversation the owner deleted (FR-09, AC-09.1) with the
   * reason `conversation_deleted`.
   */
  async pauseForDeletedConversation(
    conversationId: string,
    ownerId: string,
  ): Promise<void> {
    const paused = await this.db.transaction(() =>
      this.schedules.pauseForConversation(conversationId, ownerId),
    );
    if (paused.length > 0)
      this.logger.info('schedules paused: conversation deleted', {
        conversationId,
        ownerId,
        scheduleIds: paused.map((schedule) => schedule.id),
      });
  }

  /**
   * One pass of schedules (KD-3, NFR-03): first the `starting` rows any process left (KD-2), then the due terms,
   * a batch from the earliest. Each is handled on its own, and a failure of one is logged and leaves the rest.
   * `true` — the batch was full and some claim went through, so work may remain.
   */
  async pass(): Promise<boolean> {
    const startedAt = Date.now();
    const starting = await this.schedules.listStarting();
    for (const { run, schedule } of starting)
      await this.isolated(
        'finish',
        { scheduleId: schedule.id, ownerId: schedule.ownerId, runId: run.id },
        () => this.finishStarting(run, schedule),
      );
    const due = await this.schedules.listDue(
      this.clock.now(),
      SCHEDULE_PASS_BATCH,
    );
    let failed = 0;
    for (const schedule of due) {
      const done = await this.isolated(
        'claim',
        {
          scheduleId: schedule.id,
          ownerId: schedule.ownerId,
          dueAt: schedule.nextRunAt,
        },
        () => this.claimDue(schedule),
      );
      if (!done) failed += 1;
    }
    // A batch whose every claim failed made no progress: the next pass waits the period instead of spinning.
    const more = due.length === SCHEDULE_PASS_BATCH && failed < due.length;
    this.logger.info('schedule pass', {
      starting: starting.length,
      due: due.length,
      failed,
      more,
      durationMs: Date.now() - startedAt,
    });
    return more;
  }

  /** Runs one step of a pass; its error is logged in full and does not stop the pass. `false` — it failed. */
  private async isolated(
    step: string,
    fields: Record<string, unknown>,
    work: () => Promise<unknown>,
  ): Promise<boolean> {
    const startedAt = Date.now();
    try {
      await work();
      return true;
    } catch (error) {
      this.logger.error(`schedule ${step} failed`, {
        ...fields,
        durationMs: Date.now() - startedAt,
        error,
      });
      return false;
    }
  }

  /**
   * Flow 1, Flow 2: claims the due term of a schedule — moves it to the next term after now only while it still
   * waits for this one (KD-1); a late claim does nothing. The terms missed before the last one are `server_down`
   * skips; a `once` schedule is completed by the same move. A `starting` row is finished after the commit.
   */
  private async claimDue(due: ScheduleRow): Promise<void> {
    const expected = due.nextRunAt;
    if (expected === null) return;
    const startedAt = Date.now();
    const now = this.clock.now();
    const result = await this.db.transaction(async () => {
      // The row as it is now, held for this claim: `due` was read before the transaction, and a change committed
      // since then must decide the terms, the next term and the run.
      const held = await this.schedules.hold(due.id);
      if (
        held?.state !== 'active' ||
        held.nextRunAt?.getTime() !== expected.getTime()
      )
        return undefined;
      const input = ruleInput(held);
      const terms = termsThrough(input, expected, now);
      const dueAt = terms.at(-1);
      if (dueAt === undefined) return undefined;
      const next = nextTermAfter(input, now);
      const claimed = await this.schedules.claimDue(
        held.id,
        expected,
        next === null
          ? { nextRunAt: null, state: 'completed' }
          : { nextRunAt: next, state: 'active' },
      );
      if (claimed === undefined) return undefined;
      const claim = await this.claimTerm(claimed, {
        dueAt,
        manual: false,
        missed: terms.slice(0, -1),
      });
      return { claimed, claim, dueAt, next, missed: terms.length - 1 };
    });
    const fields = {
      scheduleId: due.id,
      ownerId: due.ownerId,
      manual: false,
      expectedDueAt: expected,
    };
    if (result === undefined) {
      this.logger.info('schedule term already claimed', {
        ...fields,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    const { claimed, claim, dueAt, next, missed } = result;
    this.logClaim(claimed, claim, {
      ...fields,
      dueAt,
      nextRunAt: next,
      startedAt,
      missed,
    });
    if (claim.kind === 'written' && claim.run.outcome === 'starting')
      await this.finishStarting(claim.run, claimed);
  }

  /**
   * The rest of a claim, in its transaction after the schedule's write (rule 5): a `this_conversation` schedule
   * whose conversation is gone — or is not a chat, whose root would refuse the message — is paused with no row
   * (AC-09.1), so it leaves the due list. Otherwise the decision (KD-4) and the rows: the
   * missed terms as `server_down`, then a skip — or the previous run's final status and the run: the marked
   * message to the schedule's conversation with its place in the queue (KD-2), or a `starting` row whose id is
   * the new conversation's. A skip writes no final status.
   */
  private async claimTerm(schedule: ScheduleRow, term: Term): Promise<Claim> {
    const { ownerId } = schedule;
    const conversationId =
      schedule.target === 'this_conversation' ? schedule.conversationId : null;
    if (
      schedule.target === 'this_conversation' &&
      (conversationId === null ||
        !(await this.liveChat(conversationId, ownerId)))
    ) {
      await this.schedules.update(schedule.id, ownerId, {
        state: 'paused',
        pausedBecause: 'conversation_deleted',
        nextRunAt: null,
      });
      return { kind: 'paused' };
    }
    const previous = await this.schedules.lastStarted(schedule.id);
    const previousStatus =
      previous === undefined ? null : await this.statusOf(previous, ownerId);
    const agent = await this.runAgent(ownerId, schedule.agentId);
    const conversation =
      conversationId === null
        ? null
        : await this.conversationNow(conversationId, ownerId, false);
    const decision = decideRun({
      previousRun: previousStatus,
      conversationBusy:
        conversation !== null &&
        !conversation.deleted &&
        (conversation.openDecision ||
          conversation.chat === 'working' ||
          conversation.chat === 'awaiting_confirmation'),
      agentAvailable: agent.kind !== 'unavailable',
      models: await this.modelVerdicts(schedule, conversationId, agent),
    });
    const base = {
      id: randomUUID(),
      scheduleId: schedule.id,
      dueAt: term.dueAt,
      manual: term.manual,
    };
    let run: ScheduleRunRow;
    if (decision.kind === 'skip') {
      run = runRow({
        ...base,
        outcome: 'skipped',
        skipReason: decision.reason,
        unfinishedConversationId:
          decision.reason === 'previous_run_unfinished' && previous
            ? await this.conversationOfRun(previous.run)
            : null,
      });
    } else {
      if (previous !== undefined && previousStatus !== null)
        await this.schedules.setFinalStatus(previous.run.id, previousStatus);
      run =
        conversationId === null
          ? runRow({ ...base, outcome: 'starting' })
          : await this.sendRun(schedule, conversationId, agent, base);
    }
    const missed = term.missed.map((dueAt) =>
      runRow({
        id: randomUUID(),
        scheduleId: schedule.id,
        dueAt,
        manual: false,
        outcome: 'skipped',
        skipReason: 'server_down',
      }),
    );
    await this.schedules.insertRuns([...missed, run].map(toInsert));
    return { kind: 'written', run };
  }

  /** A run in the schedule's conversation: its marked message and the conversation moved up (Flow 1). */
  private async sendRun(
    schedule: ScheduleRow,
    conversationId: string,
    agent: RunAgent,
    base: Pick<ScheduleRunRow, 'id' | 'scheduleId' | 'dueAt' | 'manual'>,
  ): Promise<ScheduleRunRow> {
    const { ownerId } = schedule;
    const { seq } = await this.control.send({
      agentId: conversationId,
      ownerId,
      text: schedule.instruction,
      ...(agent.kind === 'chip' ? { record: agent.record } : {}),
      schedule: markOf(schedule, base.manual),
    });
    await this.control.touchRoot(conversationId, ownerId);
    return runRow({
      ...base,
      outcome: 'started',
      conversationId,
      messageSeq: seq,
    });
  }

  /**
   * Flow 2 after the commit: a conversation with the row's id already exists → `started` without a start (a
   * previous process started it); else it starts with that id, the mark and the title. `TASK_EXISTS` — another
   * start came first — is `started` too; a refused start is a skip with its reason (DC-5). Any other error is
   * logged and leaves the row `starting` for the next pass.
   */
  private async finishStarting(
    run: ScheduleRunRow,
    schedule: ScheduleRow,
  ): Promise<ScheduleRunRow> {
    const startedAt = Date.now();
    const { ownerId } = schedule;
    const fields = {
      scheduleId: schedule.id,
      ownerId,
      runId: run.id,
      dueAt: run.dueAt,
      manual: run.manual,
    };
    if ((await this.conversationRows.find(run.id)) !== undefined)
      return this.markStarted(run, { ...fields, startedAt, how: 'found' });
    const agent = await this.runAgent(ownerId, schedule.agentId);
    if (agent.kind === 'unavailable')
      return this.markSkipped(run, 'agent_unavailable', {
        ...fields,
        startedAt,
      });
    try {
      await this.starts.start({
        agentId: run.id,
        ownerId,
        prompt: schedule.instruction,
        description: rootDescription(schedule.instruction),
        ...(agent.kind === 'chip' ? { record: agent.record } : {}),
        schedule: markOf(schedule, run.manual),
        title: titleOf(schedule, run.dueAt),
      });
    } catch (error) {
      if (isTaskExists(error))
        return this.markStarted(run, { ...fields, startedAt, how: 'exists' });
      const reason = refusedStart(error);
      if (reason !== null)
        return this.markSkipped(run, reason, { ...fields, startedAt });
      this.logger.error('schedule run start failed; the row stays starting', {
        ...fields,
        instructionLength: schedule.instruction.length,
        durationMs: Date.now() - startedAt,
        error,
      });
      return run;
    }
    return this.markStarted(run, { ...fields, startedAt, how: 'started' });
  }

  private async markStarted(
    run: ScheduleRunRow,
    { startedAt, ...fields }: Record<string, unknown> & { startedAt: number },
  ): Promise<ScheduleRunRow> {
    const changed = await this.schedules.markStarted(run.id, run.id);
    this.logger.info('schedule run started', {
      ...fields,
      conversationId: run.id,
      changed,
      durationMs: Date.now() - startedAt,
    });
    return { ...run, outcome: 'started', conversationId: run.id };
  }

  private async markSkipped(
    run: ScheduleRunRow,
    reason: ScheduleSkipReason,
    { startedAt, ...fields }: Record<string, unknown> & { startedAt: number },
  ): Promise<ScheduleRunRow> {
    const changed = await this.schedules.markSkipped(run.id, reason);
    this.logger.info('schedule run skipped: start refused', {
      ...fields,
      skipReason: reason,
      changed,
      durationMs: Date.now() - startedAt,
    });
    return { ...run, outcome: 'skipped', skipReason: reason };
  }

  /** Logs a written claim: the term, its outcome and reason, the rows and the duration; never the instruction. */
  private logClaim(
    schedule: ScheduleRow,
    claim: Claim,
    {
      startedAt,
      ...fields
    }: Record<string, unknown> & { startedAt: number; missed: number },
  ): void {
    const durationMs = Date.now() - startedAt;
    if (claim.kind === 'paused') {
      this.logger.info('schedule paused at its term: conversation deleted', {
        ...fields,
        conversationId: schedule.conversationId,
        durationMs,
      });
      return;
    }
    const { run } = claim;
    this.logger.info('schedule term claimed', {
      ...fields,
      runId: run.id,
      outcome: run.outcome,
      skipReason: run.skipReason,
      conversationId: run.conversationId ?? run.unfinishedConversationId,
      instructionLength: schedule.instruction.length,
      durationMs,
    });
  }

  /** The agent of a run by the chip rule now (AC-07.1). */
  private async runAgent(
    ownerId: string,
    agentId: string | null,
  ): Promise<RunAgent> {
    if (agentId === null) return { kind: 'chat' };
    const resolved = await this.library.resolve(ownerId, agentId);
    if (resolved === null || !inRootLaunchSet(resolved))
      return { kind: 'unavailable' };
    return {
      kind: 'chip',
      record: { id: resolved.id, kind: resolved.kind, name: resolved.name },
      model: resolved.content.model,
    };
  }

  /**
   * The gate's verdicts on the models of the run's first call (KD-4): the conversation's — its root's for
   * `this_conversation`, a new chat's otherwise (`null` while none is set) — and the chip agent's own one.
   */
  private async modelVerdicts(
    schedule: ScheduleRow,
    conversationId: string | null,
    agent: RunAgent,
  ): Promise<(ModelVerdict | null)[]> {
    const { ownerId } = schedule;
    const conversationModel =
      conversationId === null
        ? await this.starts.newChatModel(ownerId)
        : await this.rootModel(conversationId);
    const models = [
      conversationModel,
      ...(agent.kind === 'chip' && agent.model !== null ? [agent.model] : []),
    ];
    return Promise.all(
      models.map((model) =>
        model === null
          ? Promise.resolve(null)
          : this.access.model(ownerId, model),
      ),
    );
  }

  private async rootModel(conversationId: string): Promise<string> {
    const row = await this.conversationRows.find(conversationId);
    if (row === undefined)
      throw new Error(`Conversation ${conversationId} has no session row`);
    return row.model;
  }

  /**
   * The conversation of a run a skip points at (UXRD SH-06): a started run's, or a `starting` row's once the
   * conversation with its id exists — the key needs the row.
   */
  private async conversationOfRun(run: ScheduleRunRow): Promise<string | null> {
    if (run.conversationId !== null) return run.conversationId;
    return (await this.conversationRows.find(run.id)) === undefined
      ? null
      : run.id;
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
   * and so is a root that is not a chat (a trainer or a test run): its root refuses the run's message.
   */
  private async liveConversation(
    conversationId: string,
    ownerId: string,
  ): Promise<void> {
    if (!(await this.liveChat(conversationId, ownerId)))
      throw schedulesError('THREAD_NOT_FOUND');
  }

  /** The id is the owner's live root of a chat (`forkable` marks a chat root). */
  private async liveChat(
    conversationId: string,
    ownerId: string,
  ): Promise<boolean> {
    if (!isUuid(conversationId)) return false;
    const root = await this.views.root(conversationId, ownerId);
    return root?.forkable === true;
  }

  /** The chip rule of a message (AC-01.3): an agent the owner's chat may not start is `RECORD_NOT_FOUND`. */
  private async checkAgent(
    ownerId: string,
    agentId: string | null,
  ): Promise<void> {
    const agent = await this.runAgent(ownerId, agentId);
    if (agent.kind === 'unavailable') throw schedulesError('RECORD_NOT_FOUND');
  }

  /** The schedule's agent: its chip and whether the chip rule passes now (UXRD SH-05). */
  private async agentOf(
    ownerId: string,
    agentId: string | null,
  ): Promise<ScheduleAgent | null> {
    if (agentId === null) return null;
    const agent = await this.runAgent(ownerId, agentId);
    if (agent.kind === 'chip') return { ...agent.record, available: true };
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
      lastRun:
        lastRun === undefined ? null : await this.toRunView(lastRun, ownerId),
    };
  }

  /** One history row with its status (KD-4): a `starting` row shows as started and working. */
  private async toRunView(
    row: ScheduleRunListRow,
    ownerId: string,
  ): Promise<ScheduleRunView> {
    const { run } = row;
    const skipped = run.outcome === 'skipped';
    return {
      id: run.id,
      dueAt: run.dueAt.toISOString(),
      manual: run.manual,
      outcome: skipped ? 'skipped' : 'started',
      status: await this.statusOf(row, ownerId),
      skipReason: ScheduleSkipReasonSchema.nullable().parse(run.skipReason),
      conversationId: skipped
        ? run.unfinishedConversationId
        : run.conversationId,
    };
  }

  /** The status of a history row (KD-4, `run-status.ts`); its conversation is read only while it can change. */
  private async statusOf(
    { run, conversationDeletedAt }: ScheduleRunListRow,
    ownerId: string,
  ): Promise<ScheduleRunStatus | null> {
    const outcome = ScheduleRunOutcomeSchema.parse(run.outcome);
    const finalStatus = ScheduleRunStatusSchema.nullable().parse(
      run.finalStatus,
    );
    const conversation =
      outcome === 'started' && finalStatus === null && run.conversationId
        ? await this.conversationNow(
            run.conversationId,
            ownerId,
            conversationDeletedAt !== null,
          )
        : null;
    return runStatus({
      run: { outcome, finalStatus, messageSeq: run.messageSeq },
      conversation,
    });
  }

  /** What the status of a started run reads of its conversation now. */
  private async conversationNow(
    conversationId: string,
    ownerId: string,
    deleted: boolean,
  ): Promise<RunConversation> {
    const lastUserMessageSeq = await this.inbox.lastSeq(
      conversationId,
      userMessage,
    );
    if (deleted) return { deleted: true, lastUserMessageSeq };
    const [root, task, confirmations] = await Promise.all([
      this.views.get(conversationId, ownerId),
      this.tasks.get(conversationId, ownerId),
      this.views.confirmations(conversationId, ownerId),
    ]);
    return {
      deleted: false,
      lastUserMessageSeq,
      chat: chatStatus({ root, task, training: false }).status,
      openDecision: confirmations.some(
        (confirmation) => confirmation.status === 'open',
      ),
    };
  }
}
