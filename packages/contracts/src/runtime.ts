import { z } from 'zod';

/**
 * Value sets of the task runtime (design-runtime.md, Contract Definitions). They are exported as
 * values: the CHECK domains of the `runtime_*` tables in schema `app` are built from them.
 */

/** `kind` of the one message the runtime puts in a parent's inbox on every end of a child task. */
export const CHILD_FINISHED_KIND = 'child_finished';

/** Status of a task. `completed`, `failed` and `stopped` end it; a message with `revive` queues it again. */
export const TaskStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'stopped',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** The statuses that end a task. */
export const TaskEndStatusSchema = TaskStatusSchema.extract([
  'completed',
  'failed',
  'stopped',
]);

/**
 * Why a `waiting` task waits; null in every other status. `children`: the step's commit created
 * awaited children or asked a question, and the wake-up rule decides which `child_finished` wakes
 * the task (data-model/design-runtime.md, KD-2); `human`: a question task waits for its answer
 * (KD-3).
 */
export const WaitReasonSchema = z.enum(['messages', 'children', 'human']);
export type WaitReason = z.infer<typeof WaitReasonSchema>;

/**
 * Payload of `child_finished` (data-model/design-runtime.md, «Сообщение `child_finished`»): the
 * child, its end status, `result` only of a `completed` child, `failure` only of a `failed` one and
 * the time from the child's creation to its end. Only the runtime writes it, never with `revive`.
 */
export const ChildFinishedPayloadSchema = z.object({
  taskId: z.uuid(),
  status: TaskEndStatusSchema,
  result: z.unknown().optional(),
  failure: z.object({ reason: z.string(), message: z.string() }).optional(),
  durationMs: z.number().int().nonnegative(),
});
export type ChildFinishedPayload = z.infer<typeof ChildFinishedPayloadSchema>;

/** Failure reasons the runtime itself sets; a handler's `fail` carries its own reason. */
export const RuntimeFailureReasonSchema = z.enum([
  'handler_error',
  'invalid_step_result',
  'step_timeout',
  'recovery_exhausted',
]);
export type RuntimeFailureReason = z.infer<typeof RuntimeFailureReasonSchema>;

/**
 * Status of a task of a session's task list (deep-agents design-task-list.md, Data Model); not the runtime's
 * `TaskStatusSchema`. A deleted task leaves the list, so `deleted` is no stored status.
 */
export const SessionTaskStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
]);
export type SessionTaskStatus = z.infer<typeof SessionTaskStatusSchema>;
