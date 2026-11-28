import { z } from 'zod';

import { ToolRefusalReasonSchema } from './agents';
import { NotificationLevelSchema } from './identity';

/** Page size of GET /api/threads (user decision 2026-10-28). */
export const THREAD_PAGE_SIZE = 20;
/** Max length of a manually set thread title (FR-15). */
export const THREAD_TITLE_MAX_LENGTH = 200;
/** Max length of a generated thread title (AC-17.1). */
export const GENERATED_THREAD_TITLE_MAX_LENGTH = 80;

/** Thread id as it appears in /api/threads/:threadId and /chat/:threadId. */
export const ThreadIdSchema = z.string().min(1).max(255);
export type ThreadId = z.infer<typeof ThreadIdSchema>;

/**
 * A thread as shown in the sidebar and header. `title: null` = not titled yet ("Новая беседа").
 * `forkable` — its root is a chat; `forkedFrom` — the source of a fork (`title: null` once deleted or untitled)
 * and the last inherited entry; `forkCount` — its live forks (create-and-test design-fork.md);
 * `notificationLevel` — the conversation's own level, `null` — the employee's default (live-feed KD-7).
 */
export const ThreadSummarySchema = z.object({
  id: ThreadIdSchema,
  title: z.string().min(1).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  forkable: z.boolean(),
  forkedFrom: z
    .object({
      threadId: ThreadIdSchema,
      title: z.string().min(1).nullable(),
      throughSeq: z.number().int(),
    })
    .nullable(),
  forkCount: z.number().int().min(0),
  notificationLevel: NotificationLevelSchema.nullable(),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

/** Response of GET /api/threads/:threadId/forks: the live forks of the thread, newest first. */
export const ThreadForksResponseSchema = z.object({
  threads: z.array(ThreadSummarySchema),
});
export type ThreadForksResponse = z.infer<typeof ThreadForksResponseSchema>;

/** Query of GET /api/threads. `cursor` is opaque: pass `nextCursor` of the previous page as is. */
export const ThreadListQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
});
export type ThreadListQuery = z.infer<typeof ThreadListQuerySchema>;

/**
 * What a conversation of the list is doing (improvements design-server.md, «ConversationState»): a question
 * open in its tree, the root or an agent under it working, or the last answer / failure after the seen mark.
 */
export const ConversationStateSchema = z.enum([
  'waiting_for_you',
  'working',
  'new_answer',
  'failed',
]);
export type ConversationState = z.infer<typeof ConversationStateSchema>;

/** Response of GET /api/threads: newest `updatedAt` first, at most THREAD_PAGE_SIZE items; `state: null` — read and idle. */
export const ThreadListResponseSchema = z.object({
  threads: z
    .array(
      ThreadSummarySchema.extend({
        state: ConversationStateSchema.nullable(),
      }),
    )
    .max(THREAD_PAGE_SIZE),
  nextCursor: z.string().min(1).nullable(),
});
export type ThreadListResponse = z.infer<typeof ThreadListResponseSchema>;

/** Page size of GET /api/search (conversation-search design, «Маршрут»). */
export const SEARCH_PAGE_SIZE = 20;

/** Query of GET /api/search: `q` is 2–200 characters after trimming; `cursor` is the previous page's `nextCursor`. */
export const ConversationSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  cursor: ThreadListQuerySchema.shape.cursor,
});
export type ConversationSearchQuery = z.infer<
  typeof ConversationSearchQuerySchema
>;

/** A text with the ranges of the found words: `start`/`end` in JS string units, ascending, not overlapping. */
export const MarkedTextSchema = z.object({
  text: z.string(),
  marks: z.array(
    z.object({ start: z.number().int().min(0), end: z.number().int().min(0) }),
  ),
});
export type MarkedText = z.infer<typeof MarkedTextSchema>;

/** Where a match was found: the conversation title, a message or a tool result. */
export const MatchPlaceSchema = z.enum(['title', 'message', 'tool_result']);
export type MatchPlace = z.infer<typeof MatchPlaceSchema>;

/**
 * One found place. `threadId`/`title` — the employee's conversation (the tree root); `agent` — the
 * sub-agent it was found at, `null` in the employee's conversation or in the title; `tool` and `callId`
 * only for `tool_result`; `seq` — the history entry of a `message` or the `tool_result` entry of a result (live-feed
 * KD-5), `null` for `title`; `titleMarks` only for `title`, `snippet` for the rest.
 */
export const ConversationMatchSchema = z.object({
  threadId: ThreadIdSchema,
  title: z.string().min(1).nullable(),
  at: z.iso.datetime(),
  place: MatchPlaceSchema,
  agent: z.object({ agentId: z.string().min(1), name: z.string() }).nullable(),
  tool: z.string().min(1).nullable(),
  seq: z.number().int().nullable(),
  callId: z.string().min(1).nullable(),
  titleMarks: MarkedTextSchema.shape.marks,
  snippet: MarkedTextSchema.nullable(),
});
export type ConversationMatch = z.infer<typeof ConversationMatchSchema>;

/** Response of GET /api/search: newest first, at most SEARCH_PAGE_SIZE matches. */
export const ConversationSearchResponseSchema = z.object({
  matches: z.array(ConversationMatchSchema).max(SEARCH_PAGE_SIZE),
  nextCursor: z.string().min(1).nullable(),
});
export type ConversationSearchResponse = z.infer<
  typeof ConversationSearchResponseSchema
>;

/** Body of PATCH /api/threads/:threadId. Surrounding whitespace is trimmed before the length check. */
export const RenameThreadRequestSchema = z.object({
  title: z.string().trim().min(1).max(THREAD_TITLE_MAX_LENGTH),
});
export type RenameThreadRequest = z.infer<typeof RenameThreadRequestSchema>;

/**
 * Body of PUT /api/threads/:threadId/seen: the last history entry of the root the web has shown. The mark
 * never goes down, and a number past the last entry becomes the last entry.
 */
export const MarkSeenRequestSchema = z.object({
  throughSeq: z.number().int().min(0),
});
export type MarkSeenRequest = z.infer<typeof MarkSeenRequestSchema>;

/** Body of PUT /api/threads/:threadId/notification-level: the conversation's level, `null` — as the default. */
export const ThreadNotificationLevelRequestSchema = z.object({
  level: NotificationLevelSchema.nullable(),
});
export type ThreadNotificationLevelRequest = z.infer<
  typeof ThreadNotificationLevelRequestSchema
>;

/** Machine-readable error codes of the threads API. */
export const ThreadsErrorCodeSchema = z.enum([
  'THREAD_NOT_FOUND',
  'VALIDATION_FAILED',
  'INVALID_CURSOR',
  'AGENT_NOT_FOUND',
  'RUN_NOT_FOUND',
  'DECISION_NOT_FOUND',
  'DOCUMENT_NOT_FOUND',
  'INVALID_ARGUMENTS',
  'NOT_FINISHED',
  'PARENT_FINISHED',
  'START_REFUSED',
  'FORK_REFUSED',
]);
export type ThreadsErrorCode = z.infer<typeof ThreadsErrorCodeSchema>;

/** Why a conversation cannot be forked now (create-and-test design-fork.md, KD-4), in the order checked. */
export const ForkRefusalReasonSchema = z.enum([
  'not_a_chat',
  'awaiting_confirmation',
  'answering',
  'tasks_running',
]);
export type ForkRefusalReason = z.infer<typeof ForkRefusalReasonSchema>;

/**
 * Error body produced by NestJS HttpException. `errorCode` is set by the API;
 * `reason` is the machine-readable cause where an operation names one.
 */
export const ApiErrorSchema = z.object({
  statusCode: z.number().int(),
  message: z.union([z.string(), z.array(z.string())]),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  reason: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * 409 START_REFUSED of the first message and of a restart: the start procedure refused the record.
 * `model` is the refused model on a model or provider refusal, otherwise `null` (also on
 * `model_not_configured`: no default chat model is chosen).
 */
export const StartRefusedErrorSchema = ApiErrorSchema.extend({
  errorCode: z.literal('START_REFUSED'),
  reason: ToolRefusalReasonSchema.extract([
    'record_unavailable',
    'model_not_connected',
    'model_not_allowed',
    'model_not_configured',
    'provider_missing',
    'provider_disabled',
    'provider_key_missing',
  ]),
  model: z.string().min(1).nullable(),
});
export type StartRefusedError = z.infer<typeof StartRefusedErrorSchema>;
