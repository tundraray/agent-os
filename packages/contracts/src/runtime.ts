import { z } from 'zod';

/**
 * Value sets of the task runtime (design-runtime.md, Contract Definitions). They are exported as
 * values: the CHECK domains of the `runtime_*` tables in schema `app` are built from them.
 */

/** Max UTF-8 size of a runtime event payload (8 KiB). */
export const EVENT_PAYLOAD_MAX_BYTES = 8 * 1024;

/** `kind` of the message the runtime puts in a parent's inbox when a child task ends. */
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

/** Why a `waiting` task waits; null in every other status. */
export const WaitReasonSchema = z.enum(['messages', 'decision', 'interrupted']);
export type WaitReason = z.infer<typeof WaitReasonSchema>;

/** Status of an inbox message: `delivered` once a committed step received it. */
export const MessageStatusSchema = z.enum(['pending', 'delivered']);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

/** Status of a decision request; a task has at most one `open` request. */
export const DecisionStatusSchema = z.enum(['open', 'resolved', 'cancelled']);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

/** Status of an event delivery to a consumer (outbox). */
export const DeliveryStatusSchema = z.enum([
  'pending',
  'done',
  'needs_attention',
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

/** Event types written by the runtime; upper-layer events carry their own package prefix. */
export const RuntimeEventTypeSchema = z.enum([
  'task.created',
  'task.queued',
  'task.step_started',
  'task.step_committed',
  'task.waiting',
  'task.interrupted',
  'task.completed',
  'task.failed',
  'task.stopped',
  'task.recovered',
  'inbox.enqueued',
  'inbox.delivered',
  'decision.requested',
  'decision.resolved',
]);
export type RuntimeEventType = z.infer<typeof RuntimeEventTypeSchema>;

/** Failure reasons the runtime itself sets; a handler's `fail` carries its own reason. */
export const RuntimeFailureReasonSchema = z.enum([
  'handler_error',
  'invalid_step_result',
  'step_timeout',
  'recovery_exhausted',
]);
export type RuntimeFailureReason = z.infer<typeof RuntimeFailureReasonSchema>;
