import { z } from 'zod';

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

/**
 * One part of an AI SDK v7 UIMessage. Validated structurally only (`type` is required);
 * the full part shape is owned by the `ai` package (use its validateUIMessages for deep checks).
 */
export const HistoryMessagePartSchema = z.looseObject({
  type: z.string().min(1),
});

/** An AI SDK v7 UIMessage restored from thread history (same shape as the live v7 stream). */
export const HistoryMessageSchema = z.looseObject({
  id: z.string().min(1),
  role: z.enum(['system', 'user', 'assistant']),
  metadata: z.unknown().optional(),
  parts: z.array(HistoryMessagePartSchema),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

/** Response of GET /api/threads/:threadId/messages: every message, oldest first, one linear branch. */
export const ThreadMessagesResponseSchema = z.object({
  messages: z.array(HistoryMessageSchema),
});
export type ThreadMessagesResponse = z.infer<
  typeof ThreadMessagesResponseSchema
>;

/**
 * Structural reference to an element of `body.messages` of POST /api/chat/:agentId:
 * only `id` and `role` are read (AC-14.6 "discard the tail"); the full UIMessage
 * shape is validated by Mastra.
 */
export const ChatMessageRefSchema = z.looseObject({
  id: z.string().min(1),
  role: z.string(),
});
export type ChatMessageRef = z.infer<typeof ChatMessageRefSchema>;

/** Machine-readable error codes of the threads API. */
export const ThreadsErrorCodeSchema = z.enum([
  'THREAD_NOT_FOUND',
  'VALIDATION_FAILED',
  'INVALID_CURSOR',
]);
export type ThreadsErrorCode = z.infer<typeof ThreadsErrorCodeSchema>;

/** Error body produced by NestJS HttpException (errorCode is set by the threads API). */
export const ApiErrorSchema = z.object({
  statusCode: z.number().int(),
  message: z.union([z.string(), z.array(z.string())]),
  error: z.string().optional(),
  errorCode: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
