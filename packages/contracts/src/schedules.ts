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
 * What a schedule's run does without a person (chat-scheduling KD-3): `read` — changing calls are refused
 * `unattended`; `full` — the changing kinds of cards are sent without one, within the owner's rights.
 */
export const ScheduleAccessSchema = z.enum(['read', 'full']);
export type ScheduleAccess = z.infer<typeof ScheduleAccessSchema>;

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
  /**
   * The conversation a `this_conversation` run answers in: required then, a live conversation of the employee; with
   * `new_conversation` the schedule keeps none, whatever comes here (chat-scheduling KD-6).
   */
  conversationId: z.string().min(1).nullable(),
  /** The interface language: the day in a new conversation's title (KD-6). */
  language: LanguageSchema,
  /** What a run may do without a person (chat-scheduling KD-3); `full` needs `consent: true`. */
  access: ScheduleAccessSchema,
  /** The employee ticked the consent to `full` in the form (chat-scheduling KD-2). */
  consent: z.boolean().optional(),
});
export type ScheduleBody = z.infer<typeof ScheduleBodySchema>;

/** The chat agent's tool that reads the employee's schedules and the local time (chat-scheduling KD-5). */
export const LIST_SCHEDULES_TOOL = 'list_schedules';
/** The chat agent's tool that creates, changes, pauses, resumes or deletes a schedule at once (chat-scheduling KD-1). */
export const MANAGE_SCHEDULE_TOOL = 'manage_schedule';

/**
 * The result of `manage_schedule` starts with `Schedule <id>: <name>`; a change that set a `full` schedule back to
 * `read` has this fixed second line (chat-scheduling KD-2). The model and the web card read both.
 */
export const SCHEDULE_ACCESS_DROPPED_LINE = 'Access: full -> read';

/** What `manage_schedule` does; the web card reads it from the call's `args.action`. */
export const ScheduleToolActionSchema = z.enum([
  'create',
  'change',
  'pause',
  'resume',
  'delete',
]);
export type ScheduleToolAction = z.infer<typeof ScheduleToolActionSchema>;

/** The fields of `manage_schedule` beyond `action` and `scheduleId`: only `create` and `change` take them. */
const SCHEDULE_TOOL_FIELDS = [
  'name',
  'instruction',
  'agentId',
  'rule',
  'target',
  'timeZone',
] as const;

/**
 * Arguments of `manage_schedule` (chat-scheduling design-server.md, «`ScheduleToolArgs`»). `scheduleId` is required
 * by every action but `create`, which takes none; `create` requires `instruction`, `rule` and `target`; `pause`,
 * `resume` and `delete` take nothing else. A `change` keeps the saved value of every field it leaves out.
 */
export const ScheduleToolArgsSchema = z
  .object({
    action: ScheduleToolActionSchema,
    scheduleId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The id of the schedule, as list_schedules names it; not for create',
      ),
    name: z
      .string()
      .trim()
      .max(SCHEDULE_NAME_MAX_LENGTH)
      .optional()
      .describe(
        'A short name; empty or absent on create — the start of the instruction',
      ),
    instruction: ChatTextSchema.optional().describe(
      'What the agent is asked to do at each run, as the employee would write it; required on create',
    ),
    agentId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'The id of a library agent, as list_records names it; null or absent on create — the chat agent',
      ),
    rule: ScheduleRuleSchema.optional().describe(
      'When it runs, in local time of the schedule time zone; required on create',
    ),
    target: ScheduleTargetSchema.optional().describe(
      'new_conversation: each run in a new conversation; this_conversation: in this conversation. Required on create',
    ),
    timeZone: TimeZoneSchema.optional().describe(
      'An IANA time zone, only when the employee named one; otherwise the zone list_schedules shows',
    ),
  })
  .superRefine((args, ctx) => {
    if (args.action === 'create') {
      if (args.scheduleId !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['scheduleId'],
          message: 'create makes a new schedule and takes no scheduleId',
        });
      for (const field of ['instruction', 'rule', 'target'] as const)
        if (args[field] === undefined)
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: `${field} is required to create a schedule`,
          });
      return;
    }
    if (args.scheduleId === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['scheduleId'],
        message: `scheduleId is required to ${args.action} a schedule`,
      });
    if (args.action === 'change') return;
    for (const field of SCHEDULE_TOOL_FIELDS)
      if (args[field] !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${args.action} takes only scheduleId`,
        });
  });
export type ScheduleToolArgs = z.infer<typeof ScheduleToolArgsSchema>;

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
  /** The conversation a `this_conversation` run answers in, deleted or not; `null` with `new_conversation` (KD-6). */
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
  access: ScheduleAccessSchema,
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
