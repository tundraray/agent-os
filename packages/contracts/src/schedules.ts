import { z } from 'zod';

import { ToolPairSchema } from './agents';
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
  /**
   * The changing MCP tools a run calls without a card (improvements design-server.md); may be empty. Each pair
   * must be one of GET /api/schedules/tools; a repeated pair is kept once.
   */
  allowedTools: z.array(ToolPairSchema),
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

/** One trigger of a schedule: a send of its instruction, at its term or by «Run now». */
export const ScheduleRunViewSchema = z.object({
  id: z.string().min(1),
  /** The term the schedule triggered for; a manual trigger's — the moment it was asked for. */
  dueAt: z.iso.datetime(),
  manual: z.boolean(),
  /** The conversation the instruction went to; `null` when the send was refused or that conversation is deleted. */
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
  /** The pairs saved on the schedule, even one the owner lost the right to (such a call is refused by rights). */
  allowedTools: z.array(ToolPairSchema),
});
export type ScheduleView = z.infer<typeof ScheduleViewSchema>;

/** One changing MCP tool the owner has the right to: a candidate for a schedule's `allowedTools`. */
export const ScheduleToolSchema = ToolPairSchema.extend({
  /** The title from the tool's description, when it has one. */
  toolTitle: z.string().min(1).optional(),
  description: z.string(),
});
export type ScheduleTool = z.infer<typeof ScheduleToolSchema>;

/** Response of GET /api/schedules/tools: by server, then by tool name. */
export const ScheduleToolsResponseSchema = z.object({
  tools: z.array(ScheduleToolSchema),
});
export type ScheduleToolsResponse = z.infer<typeof ScheduleToolsResponseSchema>;

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
