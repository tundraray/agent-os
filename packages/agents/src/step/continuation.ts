import { HistoryEventSchema, TaskStatusSchema } from '@agent-os/contracts';
import type { StepMessage, Task } from '@agent-os/runtime';

import type { NewHistoryEntry } from '../store/history.repository';
import type { Session } from '../store/sessions.repository';
import { type ResumeMark, resumeMarkOf } from './deliver';

const { stopped } = TaskStatusSchema.enum;

/** The payload of a `user_message` or, with `fromAgentId` added by the caller, an `agent_message`. */
export interface MessagePayload {
  readonly text: string;
  readonly resume?: ResumeMark;
}

/**
 * The payload of a message to `target` (plan Notes 3, 5). The runtime stops an agent without a write
 * of `agents`, so the sender reads the target's status (`tasks.get`) and marks a message to a stopped
 * agent with `resume`; its first step then writes the stop entries. `withParent` — the parent was
 * stopped by the same command: `tasks.stop` ends the whole subtree in one transaction, and
 * `finished_at` is the transaction's `now()`, so the parent's `finishedAt` equals the target's.
 * The caller passes `targetParent` when the target is stopped and has a parent.
 */
export function messagePayload(
  text: string,
  target: Task,
  targetParent?: Task | null,
): MessagePayload {
  if (target.status !== stopped) return { text };
  return { text, resume: { stopped: true, withParent: stoppedTogether(target, targetParent) } };
}

/** Whether the command that stopped `target` stopped its `parent` too. */
export function stoppedTogether(target: Task, parent: Task | null | undefined): boolean {
  if (parent?.status !== stopped) return false;
  return (
    parent.finishedAt !== null &&
    target.finishedAt !== null &&
    parent.finishedAt.getTime() === target.finishedAt.getTime()
  );
}

/** A finished agent continues with this step (Flow 6); `stop` is set when the runtime had stopped it (Flow 7). */
export interface Continuation {
  readonly stop: { readonly withParent: boolean } | null;
}

export interface ContinuationInput {
  readonly session: Session;
  readonly messages: readonly StepMessage[];
}

/**
 * Whether this step continues a finished agent: its session is `closed` (it completed or failed by
 * itself) or a message carries the `resume.stopped` mark (plan Notes 5). Pure, so the step knows
 * before its commit that the open calls of a stopped agent are closed, not run.
 */
export function continuationOf(input: ContinuationInput): Continuation | undefined {
  const mark = input.messages
    .map(resumeMarkOf)
    .find((resume): resume is ResumeMark => resume !== undefined);
  if (mark !== undefined) return { stop: { withParent: mark.withParent } };
  if (input.session.closed) return { stop: null };
  return undefined;
}

/**
 * The stop event of an agent the runtime stopped (Flow 7), which follows the results of its open calls:
 * `stopped`, or `stopped_with_parent` when the same command stopped its parent.
 */
export function stopEvent(withParent: boolean): Extract<NewHistoryEntry, { kind: 'event' }> {
  const event = withParent
    ? HistoryEventSchema.enum.stopped_with_parent
    : HistoryEventSchema.enum.stopped;
  return { kind: 'event', content: { event, reason: null } };
}
