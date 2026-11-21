import { z } from 'zod';

import { ToolRefusalReasonSchema } from './agents';

/** Page size of GET /api/threads (user decision 2026-10-28). */
export const THREAD_PAGE_SIZE = 20;
/** Max length of a manually set thread title (FR-15). */
export const THREAD_TITLE_MAX_LENGTH = 200;
/** Max length of a generated thread title (AC-17.1). */
export const GENERATED_THREAD_TITLE_MAX_LENGTH = 80;

/** Thread id as it appears in /api/threads/:threadId and /chat/:threadId. */
export const ThreadIdSchema = z.string().min(1).max(255);
export type ThreadId = z.infer<typeof ThreadIdSchema>;

/** A thread as shown in the sidebar and header. `title: null` = not titled yet ("Новая беседа"). */
export const ThreadSummarySchema = z.object({
  id: ThreadIdSchema,
  title: z.string().min(1).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

/** Query of GET /api/threads. `cursor` is opaque: pass `nextCursor` of the previous page as is. */
export const ThreadListQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
});
export type ThreadListQuery = z.infer<typeof ThreadListQuerySchema>;

/** Response of GET /api/threads: newest `updatedAt` first, at most THREAD_PAGE_SIZE items. */
export const ThreadListResponseSchema = z.object({
  threads: z.array(ThreadSummarySchema).max(THREAD_PAGE_SIZE),
  nextCursor: z.string().min(1).nullable(),
});
export type ThreadListResponse = z.infer<typeof ThreadListResponseSchema>;

/** Body of PATCH /api/threads/:threadId. Surrounding whitespace is trimmed before the length check. */
export const RenameThreadRequestSchema = z.object({
  title: z.string().trim().min(1).max(THREAD_TITLE_MAX_LENGTH),
});
export type RenameThreadRequest = z.infer<typeof RenameThreadRequestSchema>;

/** Machine-readable error codes of the threads API. */
export const ThreadsErrorCodeSchema = z.enum([
  'THREAD_NOT_FOUND',
  'VALIDATION_FAILED',
  'INVALID_CURSOR',
  'AGENT_NOT_FOUND',
  'RUN_NOT_FOUND',
  'DECISION_NOT_FOUND',
  'INVALID_ARGUMENTS',
  'NOT_FINISHED',
  'PARENT_FINISHED',
  'START_REFUSED',
  'DRAFT_NOT_FOUND',
  'DRAFT_RESOLVED',
]);
export type ThreadsErrorCode = z.infer<typeof ThreadsErrorCodeSchema>;

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
