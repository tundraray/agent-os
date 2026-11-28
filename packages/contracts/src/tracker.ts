import { z } from 'zod';

import { LanguageSchema } from './identity';
import {
  ConversationStateSchema,
  THREAD_TITLE_MAX_LENGTH,
  ThreadIdSchema,
} from './threads';

/**
 * The task tracker API (task-tracker design-server.md, Contract Definitions «Маршруты»): an employee's own tasks,
 * their feed of comments and status changes, and the conversations their delegations opened. Every time field is
 * an ISO string.
 */

/** Max length of a task's description. */
export const TRACKER_DESCRIPTION_MAX_LENGTH = 6000;
/** Max length of a comment, of a delegation's note and of a `tracker_report` comment. */
export const TRACKER_COMMENT_MAX_LENGTH = 4000;

/** The status of a task. */
export const TrackerTaskStatusSchema = z.enum([
  'todo',
  'in_progress',
  'in_review',
  'needs_decision',
  'done',
  'cancelled',
]);
export type TrackerTaskStatus = z.infer<typeof TrackerTaskStatusSchema>;

/** Who wrote a feed entry: the employee, or the chat of a task's conversation. */
export const TrackerAuthorSchema = z.enum(['employee', 'agent']);
export type TrackerAuthor = z.infer<typeof TrackerAuthorSchema>;

/** The kind of a stored feed entry; `created` and `delegated` are built from the task and its links. */
export const TrackerEventKindSchema = z.enum(['comment', 'status']);
export type TrackerEventKind = z.infer<typeof TrackerEventKindSchema>;

/** A task's title: it becomes the title of the conversations its delegations open. */
const TitleSchema = z.string().trim().min(1).max(THREAD_TITLE_MAX_LENGTH);
const DescriptionSchema = z.string().max(TRACKER_DESCRIPTION_MAX_LENGTH);
/** The text of a comment and of a delegation's note. */
const CommentTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(TRACKER_COMMENT_MAX_LENGTH);

/** Query of GET /api/tracker/tasks: without `status` — every task but `done` and `cancelled`. */
export const TrackerTaskListQuerySchema = z.object({
  status: TrackerTaskStatusSchema.optional(),
});
export type TrackerTaskListQuery = z.infer<typeof TrackerTaskListQuerySchema>;

/** Body of POST /api/tracker/tasks: the task is created `todo`. */
export const TrackerTaskCreateBodySchema = z.object({
  title: TitleSchema,
  description: DescriptionSchema.default(''),
});
export type TrackerTaskCreateBody = z.infer<typeof TrackerTaskCreateBodySchema>;

/** Body of PATCH /api/tracker/tasks/:id: at least one field. */
export const TrackerTaskPatchBodySchema = z
  .object({
    title: TitleSchema.optional(),
    description: DescriptionSchema.optional(),
    status: TrackerTaskStatusSchema.optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined ||
      body.description !== undefined ||
      body.status !== undefined,
    { message: 'at least one of title, description, status is required' },
  );
export type TrackerTaskPatchBody = z.infer<typeof TrackerTaskPatchBodySchema>;

/** Body of POST /api/tracker/tasks/:id/comments; `forward` — send it to the task's live conversation too. */
export const TrackerCommentBodySchema = z.object({
  text: CommentTextSchema,
  forward: z.boolean(),
});
export type TrackerCommentBody = z.infer<typeof TrackerCommentBodySchema>;

/**
 * Body of POST /api/tracker/tasks/:id/delegations. `agentId` — an agent or a deep agent of the «+» menu, `null` —
 * the chat agent; not checked as a UUID here: the chip rule answers any id it cannot start as a missing record.
 */
export const TrackerDelegationBodySchema = z.object({
  agentId: z.string().min(1).nullable(),
  note: CommentTextSchema.optional(),
  /** The language of the start message. */
  language: LanguageSchema,
});
export type TrackerDelegationBody = z.infer<typeof TrackerDelegationBodySchema>;

/** A row of the list. `state` — the state of the task's live conversations that needs the employee first. */
export const TrackerTaskSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: TrackerTaskStatusSchema,
  updatedAt: z.iso.datetime(),
  state: ConversationStateSchema.nullable(),
});
export type TrackerTaskSummary = z.infer<typeof TrackerTaskSummarySchema>;

/** Response of GET /api/tracker/tasks: recently changed first. */
export const TrackerTaskListResponseSchema = z.object({
  tasks: z.array(TrackerTaskSummarySchema),
});
export type TrackerTaskListResponse = z.infer<
  typeof TrackerTaskListResponseSchema
>;

/** One conversation of a task, deleted ones too. */
export const TrackerTaskConversationSchema = z.object({
  id: ThreadIdSchema,
  /** The conversation's title now. */
  title: z.string(),
  /** The agent of the delegation: `null` — the chat agent; `id` is `null` once its row is gone. */
  agent: z
    .object({ id: z.string().min(1).nullable(), name: z.string().min(1) })
    .nullable(),
  delegatedAt: z.iso.datetime(),
  /** Deleted by the employee: then `state` is `null`. */
  deleted: z.boolean(),
  state: ConversationStateSchema.nullable(),
});
export type TrackerTaskConversation = z.infer<
  typeof TrackerTaskConversationSchema
>;

/** One entry of a task's feed. */
export const TrackerFeedItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('created'), at: z.iso.datetime() }),
  z.object({
    kind: z.literal('delegated'),
    at: z.iso.datetime(),
    conversationId: ThreadIdSchema,
  }),
  /**
   * An agent's comment names the conversation it came from; an employee's — the conversation it was sent to, or
   * `null`.
   */
  z.object({
    kind: z.literal('comment'),
    at: z.iso.datetime(),
    id: z.string().min(1),
    author: TrackerAuthorSchema,
    text: z.string().min(1),
    conversationId: ThreadIdSchema.nullable(),
  }),
  z.object({
    kind: z.literal('status'),
    at: z.iso.datetime(),
    status: TrackerTaskStatusSchema,
    author: TrackerAuthorSchema,
    conversationId: ThreadIdSchema.nullable(),
  }),
]);
export type TrackerFeedItem = z.infer<typeof TrackerFeedItemSchema>;

/** A task's screen. */
export const TrackerTaskViewSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  status: TrackerTaskStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** The latest delegation first. */
  conversations: z.array(TrackerTaskConversationSchema),
  /** Oldest first. */
  feed: z.array(TrackerFeedItemSchema),
  /** Where a forwarded comment goes: the live conversation delegated last; `null` — none is live. */
  forwardTo: z
    .object({ conversationId: ThreadIdSchema, title: z.string() })
    .nullable(),
});
export type TrackerTaskView = z.infer<typeof TrackerTaskViewSchema>;

/** Response of POST /api/tracker/tasks/:id/delegations. */
export const TrackerDelegationResponseSchema = z.object({
  conversationId: ThreadIdSchema,
  task: TrackerTaskViewSchema,
});
export type TrackerDelegationResponse = z.infer<
  typeof TrackerDelegationResponseSchema
>;

/** The task of a conversation in its view (`ConversationView.trackerTask`): its id and current title. */
export const ConversationTrackerTaskSchema = z
  .object({ id: z.string().min(1), title: z.string().min(1) })
  .nullable();
export type ConversationTrackerTask = z.infer<
  typeof ConversationTrackerTaskSchema
>;

/** The tool of a task conversation's chat that reports on its task (task-tracker KD-4). */
export const TRACKER_REPORT_TOOL = 'tracker_report';

/** The statuses `tracker_report` may set (Invariant 1). */
export const TrackerReportStatusSchema = TrackerTaskStatusSchema.extract([
  'in_review',
  'needs_decision',
]);
export type TrackerReportStatus = z.infer<typeof TrackerReportStatusSchema>;

/**
 * Arguments of `tracker_report` (Contract Definitions «Инструмент `tracker_report`»): a comment, a status or both.
 * No task id: the task is the one the caller's conversation is linked to (AC-07.2).
 */
export const TrackerReportArgsSchema = z
  .object({
    comment: CommentTextSchema.optional().describe(
      'What was done or found, for the employee to read on the task',
    ),
    status: TrackerReportStatusSchema.optional().describe(
      'in_review when the work is done; needs_decision when the employee must decide something',
    ),
  })
  .refine((args) => args.comment !== undefined || args.status !== undefined, {
    message: 'pass a comment, a status or both',
  });
export type TrackerReportArgs = z.infer<typeof TrackerReportArgsSchema>;

/** Machine-readable error codes of the tracker API. */
export const TrackerErrorCodeSchema = z.enum([
  'TRACKER_TASK_NOT_FOUND',
  'TRACKER_NO_CONVERSATION',
  'VALIDATION_FAILED',
]);
export type TrackerErrorCode = z.infer<typeof TrackerErrorCodeSchema>;
