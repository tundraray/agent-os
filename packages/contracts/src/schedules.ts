import { z } from 'zod';

import { ChatTextSchema } from './chat';
import { LanguageSchema } from './identity';
import { ChipRecordSchema } from './library';

/**
 * The schedules API (schedules-search-memory design-schedules.md, Contract Definitions «Маршруты»): an
 * employee's schedules, their next term and the history of their runs. Every time field is an ISO string.
 */

/** Max length of a schedule's name: leaves room for the day in a new conversation's title. */
export const SCHEDULE_NAME_MAX_LENGTH = 100;
/** Page size of GET /api/schedules/:id/runs. */
export const SCHEDULE_RUNS_PAGE_SIZE = 20;
/** Max period of an `every_hours` rule: a year; a larger one would overflow the date of the next term. */
export const SCHEDULE_EVERY_HOURS_MAX = 8760;

/** Where a run answers: a new conversation each time, or the conversation the schedule was created in. */
export const ScheduleTargetSchema = z.enum([
  'new_conversation',
  'this_conversation',
]);
export type ScheduleTarget = z.infer<typeof ScheduleTargetSchema>;

/** `active` — the pass sees its next term; `paused` — no terms; `completed` — a `once` schedule past its term. */
export const ScheduleStateSchema = z.enum(['active', 'paused', 'completed']);
export type ScheduleState = z.infer<typeof ScheduleStateSchema>;

/** Why a schedule is paused other than by the employee. */
export const SchedulePauseReasonSchema = z.enum(['conversation_deleted']);
export type SchedulePauseReason = z.infer<typeof SchedulePauseReasonSchema>;

/**
 * Outcome of a history row: `starting` — taken for a new conversation not started yet (its id is the
 * conversation's), `started`, `skipped`. A row changes only from `starting`.
 */
export const ScheduleRunOutcomeSchema = z.enum([
  'starting',
  'started',
  'skipped',
]);
export type ScheduleRunOutcome = z.infer<typeof ScheduleRunOutcomeSchema>;

/** Why a term gave no run, in the order the term checks them (KD-4); `server_down` — a term of the catch-up. */
export const ScheduleSkipReasonSchema = z.enum([
  'previous_run_unfinished',
  'conversation_busy',
  'owner_disabled',
  'agent_unavailable',
  'quota_exhausted',
  'server_down',
]);
export type ScheduleSkipReason = z.infer<typeof ScheduleSkipReasonSchema>;

/** Status of a started run (Data Model «Статус запуска»). */
export const ScheduleRunStatusSchema = z.enum([
  'working',
  'awaiting_confirmation',
  'completed',
  'failed',
  'stopped',
]);
export type ScheduleRunStatus = z.infer<typeof ScheduleRunStatusSchema>;

/** Local time of day `HH:MM` in the schedule's time zone. */
const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** ISO day of the week: 1 — Monday, 7 — Sunday. */
const IsoDaySchema = z.number().int().min(1).max(7);

/** The rule of a schedule; date and time are local in the schedule's time zone. */
export const ScheduleRuleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('once'),
    date: z.iso.date(),
    time: LocalTimeSchema,
  }),
  z.object({ kind: z.literal('daily'), time: LocalTimeSchema }),
  z.object({
    kind: z.literal('weekdays'),
    days: z.array(IsoDaySchema).min(1).max(7),
    time: LocalTimeSchema,
  }),
  /** Terms every `hours` hours from the moment the rule was created or last changed. */
  z.object({
    kind: z.literal('every_hours'),
    hours: z.number().int().min(1).max(SCHEDULE_EVERY_HOURS_MAX),
  }),
]);
export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>;

/** An IANA time zone name; the service checks that it exists. */
const TimeZoneSchema = z.string().min(1).max(64);

/**
 * Body of POST /api/schedules and PUT /api/schedules/:id. An empty or absent `name` becomes the start of the
 * instruction. `agentId` and `conversationId` are not checked as UUIDs here: the service answers an id that is
 * not one as a missing one.
 */
export const ScheduleBodySchema = z.object({
  name: z.string().trim().max(SCHEDULE_NAME_MAX_LENGTH).optional(),
  instruction: ChatTextSchema,
  /** The library agent of the chip; `null` — the chat agent. */
  agentId: z.string().min(1).nullable(),
  rule: ScheduleRuleSchema,
  timeZone: TimeZoneSchema,
  target: ScheduleTargetSchema,
  /** The conversation the schedule is created in; `null` in a new chat without messages. */
  conversationId: z.string().min(1).nullable(),
  /** The interface language: the day in a new conversation's title (KD-6). */
  language: LanguageSchema,
});
export type ScheduleBody = z.infer<typeof ScheduleBodySchema>;

/** Body of POST /api/schedules/next-run: the preview of the next term. */
export const ScheduleNextRunRequestSchema = z.object({
  rule: ScheduleRuleSchema,
  timeZone: TimeZoneSchema,
});
export type ScheduleNextRunRequest = z.infer<
  typeof ScheduleNextRunRequestSchema
>;

/** Response of POST /api/schedules/next-run: the nearest term from now. */
export const ScheduleNextRunResponseSchema = z.object({
  nextRunAt: z.iso.datetime(),
});
export type ScheduleNextRunResponse = z.infer<
  typeof ScheduleNextRunResponseSchema
>;

/** One row of a schedule's history. A `starting` row shows as `started` with the status `working`. */
export const ScheduleRunViewSchema = z.object({
  id: z.string().min(1),
  /** The term the run was due at; a manual run's — the moment it was asked for. */
  dueAt: z.iso.datetime(),
  manual: z.boolean(),
  outcome: ScheduleRunOutcomeSchema.exclude(['starting']),
  /** Set on a started run, `null` on a skip. */
  status: ScheduleRunStatusSchema.nullable(),
  /** Set on a skip, `null` on a started run. */
  skipReason: ScheduleSkipReasonSchema.nullable(),
  /**
   * The conversation of a started run; on a `previous_run_unfinished` skip — the conversation of that
   * unfinished run; otherwise `null`.
   */
  conversationId: z.string().min(1).nullable(),
});
export type ScheduleRunView = z.infer<typeof ScheduleRunViewSchema>;

/** The agent of a schedule: its chip and whether it passes the chip rule now. */
export const ScheduleAgentSchema = ChipRecordSchema.extend({
  available: z.boolean(),
});
export type ScheduleAgent = z.infer<typeof ScheduleAgentSchema>;

/** A schedule for the list and its page. */
export const ScheduleViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  instruction: z.string().min(1),
  rule: ScheduleRuleSchema,
  timeZone: z.string().min(1),
  target: ScheduleTargetSchema,
  createdAt: z.iso.datetime(),
  /** `null` — the chat agent. */
  agent: ScheduleAgentSchema.nullable(),
  /** The conversation the schedule was created in, deleted or not; `null` — created in a new chat. */
  conversation: z
    .object({
      id: z.string().min(1),
      title: z.string(),
      deleted: z.boolean(),
    })
    .nullable(),
  state: ScheduleStateSchema,
  pausedBecause: SchedulePauseReasonSchema.nullable(),
  /** `null` while paused and once completed. */
  nextRunAt: z.iso.datetime().nullable(),
  lastRun: ScheduleRunViewSchema.nullable(),
});
export type ScheduleView = z.infer<typeof ScheduleViewSchema>;

/** Response of GET /api/schedules: active by the next term, then paused, then completed. */
export const ScheduleListResponseSchema = z.object({
  schedules: z.array(ScheduleViewSchema),
});
export type ScheduleListResponse = z.infer<typeof ScheduleListResponseSchema>;

/** Query of GET /api/schedules/:id/runs; `cursor` is opaque: pass `nextCursor` of the previous page. */
export const ScheduleRunsQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
});
export type ScheduleRunsQuery = z.infer<typeof ScheduleRunsQuerySchema>;

/** Response of GET /api/schedules/:id/runs: latest terms first. */
export const ScheduleRunsPageSchema = z.object({
  runs: z.array(ScheduleRunViewSchema).max(SCHEDULE_RUNS_PAGE_SIZE),
  nextCursor: z.string().min(1).nullable(),
});
export type ScheduleRunsPage = z.infer<typeof ScheduleRunsPageSchema>;

/** Machine-readable error codes of the schedules API. */
export const SchedulesErrorCodeSchema = z.enum([
  'SCHEDULE_NOT_FOUND',
  'SCHEDULE_NOT_RUNNABLE',
  'VALIDATION_FAILED',
  'RECORD_NOT_FOUND',
  'THREAD_NOT_FOUND',
  'INVALID_CURSOR',
]);
export type SchedulesErrorCode = z.infer<typeof SchedulesErrorCodeSchema>;
