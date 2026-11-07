import type { AbortReasonKind } from '@agent-os/contracts';

/**
 * Time limits of a task (design-lifecycle.md KD-3, «Как работают сроки задачи»), as pure rules
 * over the settings and the task's own budget; the collector and the dispatcher apply them.
 */

/**
 * How long a ready task may wait in the queue for its first claim: the smaller of
 * `RUNTIME_QUEUE_WAIT_MS` and the task's total deadline (`deadline_ms`).
 */
export function queueLimitMs(queueWaitMs: number, deadlineMs: number): number {
  return Math.min(queueWaitMs, deadlineMs);
}

/** When an attempt is aborted and why. */
export interface AttemptLimit {
  ms: number;
  reason: Extract<AbortReasonKind, 'attempt_timeout' | 'deadline'>;
}

/**
 * How long an attempt may run: the smaller of `RUNTIME_ATTEMPT_MS` and the time left to the task's
 * `deadline_at`. Only a setting that ends strictly first aborts with `attempt_timeout`, which the
 * collector retries; otherwise the attempt ends at the total deadline, which is never retried.
 */
export function attemptLimit(
  attemptMs: number,
  msToDeadline: number,
): AttemptLimit {
  const left = Math.max(msToDeadline, 0);
  return attemptMs < left
    ? { ms: attemptMs, reason: 'attempt_timeout' }
    : { ms: left, reason: 'deadline' };
}
