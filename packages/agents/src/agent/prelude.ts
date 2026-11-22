import { HistoryEventSchema } from '@agent-os/contracts';
import type { SessionPatch } from '@agent-os/db';
import type { StepContext, StepResult } from '@agent-os/runtime';

import type { CallState } from '../history/call-state';
import { stopEvent } from '../resume';
import { interruptedResults } from '../store/call-records';
import type { NewHistoryEntry } from '../store/history';
import type { Session } from '../store/sessions';
import type { AgentDeps } from './agent-deps';
import type { Continuation } from './continuation';
import { appendWithEvent, logStep, type StepPrelude } from './step-common';

/** The session fields a continuation sets (Flow 6): the turn counter from zero, `closed` cleared. */
const CONTINUATION_PATCH: SessionPatch = { turns: 0, closed: false };

const CONTINUED_EVENT: NewHistoryEntry = {
  kind: 'event',
  content: { event: HistoryEventSchema.enum.continued, reason: null },
};

const INTERRUPTED_EVENT: NewHistoryEntry = {
  kind: 'event',
  content: { event: HistoryEventSchema.enum.interrupted, reason: null },
};

/** What the step found in its messages and its session before choosing the kind of work. */
export interface StepPlan {
  readonly continuation: Continuation | undefined;
  /** The step took an `interrupt` message (KD-3). */
  readonly interrupted: boolean;
  /** A message of another kind than `interrupt` is delivered: the `interrupted` mark goes (KD-3). */
  readonly otherMessages: boolean;
  /** Open calls of the agent before the step. */
  readonly open: readonly CallState[];
}

/** A stop or an interrupt closes the open calls in the prelude: they are never run. */
export function closesOpen(plan: StepPlan): boolean {
  return plan.interrupted || (plan.continuation?.stop ?? null) !== null;
}

/**
 * The events of the prelude, which follow the results of the calls it closes (Flow 6, Flow 7, KD-3):
 * for a stopped agent its stop event — the one `history` showed derived until now — then `continued`;
 * on an `interrupt` the `interrupted` event.
 */
function preludeEvents(plan: StepPlan): NewHistoryEntry[] {
  const stop = plan.continuation?.stop ?? null;
  const entries: NewHistoryEntry[] = [];
  if (stop !== null) entries.push(stopEvent(stop.withParent));
  if (plan.continuation !== undefined) entries.push(CONTINUED_EVENT);
  if (plan.interrupted) entries.push(INTERRUPTED_EVENT);
  return entries;
}

/**
 * What the agent writes ahead of the chosen step (Flow 6, Flow 7, KD-3): the continuation entries of a
 * finished agent, then on an `interrupt` the open calls closed and the `interrupted` event; the
 * `interrupted` mark cleared by a message of another kind. The model sees the open calls as the commit
 * will close them. `undefined` when there is nothing to write.
 */
export function preludeOf(
  deps: Pick<AgentDeps, 'callRecords'>,
  ctx: StepContext,
  session: Session,
  plan: StepPlan,
): StepPrelude | undefined {
  const closes = closesOpen(plan);
  const events = preludeEvents(plan);
  const entries = [...(closes ? interruptedResults(plan.open, new Date()) : []), ...events];

  const clearsMark = session.interrupted && plan.otherMessages;
  const patch: SessionPatch = {
    ...(plan.continuation === undefined ? {} : CONTINUATION_PATCH),
    ...(clearsMark ? { interrupted: false } : {}),
  };
  if (entries.length === 0 && Object.keys(patch).length === 0) return undefined;

  return {
    entries,
    patch,
    write: async () => {
      // The results are appended here, ahead of the events the caller appends.
      if (closes) await deps.callRecords.closeOpen(ctx.taskId);
      return events;
    },
  };
}

/**
 * The tool step does not know the prelude: its commit is wrapped so the prelude goes first, in the same
 * transaction. A step abandoned without a commit stays so.
 */
export function withPrelude(
  deps: Pick<AgentDeps, 'history' | 'sessionRows'>,
  ctx: StepContext,
  result: StepResult,
  prelude: StepPrelude | undefined,
): StepResult {
  const inner = result.commit;
  if (prelude === undefined || inner === undefined) return result;
  return {
    ...result,
    commit: async (effects) => {
      await appendWithEvent(deps, effects, ctx.taskId, await prelude.write());
      await deps.sessionRows.update(ctx.taskId, prelude.patch);
      await inner(effects);
    },
  };
}

/**
 * An `interrupt` and no other message (KD-3): the open calls closed, the `interrupted`
 * event, the session marked «прерван» with its turn counter reset; the agent waits for a message.
 */
export function interruptWait(
  deps: Pick<AgentDeps, 'history' | 'sessionRows'>,
  ctx: StepContext,
  prelude: StepPrelude,
  startedAt: number,
): StepResult {
  logStep(ctx, 'interrupt', startedAt, 'wait');
  return {
    outcome: 'wait',
    commit: async (effects) => {
      // The step's only messages are `interrupt`s: they add no entry of their own.
      await appendWithEvent(deps, effects, ctx.taskId, await prelude.write());
      await deps.sessionRows.update(ctx.taskId, {
        ...prelude.patch,
        interrupted: true,
        turns: 0,
      });
    },
  };
}

/** A step whose guarded write was fenced or whose signal was aborted: nothing is written. */
export function abandoned(ctx: StepContext, reason: string): StepResult {
  ctx.logger.info('agent step abandoned without writes', {
    agentId: ctx.taskId,
    stepNo: ctx.stepNo,
    reason,
  });
  return { outcome: 'continue' };
}
