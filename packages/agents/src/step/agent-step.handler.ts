import {
  AGENT_TASK_TYPE,
  AgentMessageKindSchema,
  HistoryEventSchema,
  ToolCallStateSchema,
} from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { RuntimeTx, StepContext, StepResult, TaskHandler } from '@agent-os/runtime';

import type { AgentsEmbeddings } from '../embeddings/embeddings';
import { embedQuestion } from '../knowledge/question-vector';
import { type CallState, foldCalls, isDelegated } from '../history/call-state';
import type { HistoryEntry } from '../history/history';
import { callRecords, interruptedResults } from '../store/call-records.repository';
import { history, type NewHistoryEntry } from '../store/history.repository';
import {
  AgentTaskInputSchema,
  type Session,
  type SessionPatch,
  sessionInputOf,
  sessions,
} from '../store/sessions.repository';
import { compactionDue, type CompactionStep } from './compaction-step';
import { type Continuation, continuationOf, stopEvent } from './continuation';
import { appendWithEvent, logStep, type ModelStep, type StepPrelude } from './model-step';
import type { ToolStep } from './tool-step';

const { interrupt } = AgentMessageKindSchema.enum;
const { done } = ToolCallStateSchema.enum;

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

export interface AgentStepHandlerDeps {
  /** Reads the session and its history outside the commit: only steps of this agent write them. */
  readonly database: Database;
  readonly toolStep: ToolStep;
  readonly modelStep: ModelStep;
  readonly compactionStep: CompactionStep;
  /** `AGENT_COMPACT_AT_TOKENS`. */
  readonly compactAtTokens: number;
  /** The question vector of a session that learns (self-learning KD-6); the only caller in a run. */
  readonly embeddings: Pick<AgentsEmbeddings, 'embed'>;
}

/** What the step found in its messages and its session before choosing the kind of work. */
interface StepPlan {
  readonly continuation: Continuation | undefined;
  /** The step took an `interrupt` message (KD-3). */
  readonly interrupted: boolean;
  /** A message of another kind than `interrupt` is delivered: the `interrupted` mark goes (KD-3). */
  readonly otherMessages: boolean;
  /** Open calls of the agent before the step. */
  readonly open: readonly CallState[];
}

/** A stop or an interrupt closes the open calls in the prelude: they are never run. */
function closesOpen(plan: StepPlan): boolean {
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
 * What the handler writes ahead of the chosen step (Flow 6, Flow 7, KD-3): the continuation entries of a
 * finished agent, then on an `interrupt` the open calls closed and the `interrupted` event; the
 * `interrupted` mark cleared by a message of another kind. The model sees the open calls as the commit
 * will close them. `undefined` when there is nothing to write.
 */
function preludeOf(ctx: StepContext, session: Session, plan: StepPlan): StepPrelude | undefined {
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
    write: async (tx) => {
      // The results are appended here, ahead of the events the caller appends.
      if (closes) await callRecords.closeOpen(tx, ctx.taskId);
      return events;
    },
  };
}

/**
 * The tool step does not know the prelude: its commit is wrapped so the prelude goes first, in the same
 * transaction. A step abandoned without a commit stays so.
 */
function withPrelude(ctx: StepContext, result: StepResult, prelude: StepPrelude | undefined): StepResult {
  const inner = result.commit;
  if (prelude === undefined || inner === undefined) return result;
  return {
    ...result,
    commit: async (tx, effects) => {
      await appendWithEvent(tx, effects, ctx.taskId, await prelude.write(tx));
      await sessions.update(tx, ctx.taskId, prelude.patch);
      await inner(tx, effects);
    },
  };
}

/**
 * An `interrupt` and no other message (KD-3): the open calls closed, the `interrupted`
 * event, the session marked «прерван» with its turn counter reset; the agent waits for a message.
 */
function interruptWait(ctx: StepContext, prelude: StepPrelude, startedAt: number): StepResult {
  logStep(ctx, 'interrupt', startedAt, 'wait');
  return {
    outcome: 'wait',
    commit: async (tx, effects) => {
      // The step's only messages are `interrupt`s: they add no entry of their own.
      await appendWithEvent(tx, effects, ctx.taskId, await prelude.write(tx));
      await sessions.update(tx, ctx.taskId, {
        ...prelude.patch,
        interrupted: true,
        turns: 0,
      });
    },
  };
}

/** A step whose guarded write was fenced or whose signal was aborted: nothing is written. */
function abandoned(ctx: StepContext, reason: string): StepResult {
  ctx.logger.info('agent step abandoned without writes', {
    agentId: ctx.taskId,
    stepNo: ctx.stepNo,
    reason,
  });
  return { outcome: 'continue' };
}

/**
 * Builds the handler of `agent` tasks (design-agents.md: C3 `AgentStepHandler`, «Как шаг выбирает
 * работу», KD-3, Flow 6). Between steps it keeps nothing in memory: each step reads the session.
 *
 * 1. The session is made from the task input — the snapshot written at the start (ADR-0017) — if the
 *    starter did not make it (through `guard`). A session that learns gets its question vector on a
 *    new question (self-learning KD-6, `embedQuestion`).
 * 2. A finished agent continues (`continuationOf`): its stop entries and `continued` go first.
 * 3. An `interrupt` closes the open calls and writes `interrupted`; with no other message the agent is
 *    marked and waits, with one the step goes on to its work.
 * 4. Otherwise: open calls → the tool step; input of the previous call at the threshold → compaction;
 *    else the model step (its turn limit check is d3).
 */
export function createAgentStepHandler(deps: AgentStepHandlerDeps): TaskHandler {
  const { database } = deps;

  /** The session of the agent, made from the snapshot in the task input when missing; `undefined` when the attempt is fenced. */
  async function sessionOf(ctx: StepContext): Promise<Session | undefined> {
    const existing = await sessions.get(database, ctx.taskId);
    if (existing !== undefined) return existing;
    const input = sessionInputOf(ctx.input);
    const made = await ctx.guard((tx: RuntimeTx) =>
      sessions.ensureSession(tx, ctx, input),
    );
    if (made.outcome === 'fenced') return undefined;
    const session = await sessions.get(database, ctx.taskId);
    if (session === undefined) throw new Error(`Session of agent ${ctx.taskId} was not created`);
    return session;
  }

  async function step(ctx: StepContext): Promise<StepResult> {
    const startedAt = Date.now();
    const session = await sessionOf(ctx);
    if (session === undefined) return abandoned(ctx, 'session write fenced');
    if (!(await embedQuestion(deps, ctx, session))) {
      return abandoned(ctx, 'question write fenced or cancelled');
    }

    // One read of the history for the whole step: from the last compaction on, where every open call
    // and everything the model sees is. Nothing is cached between steps — any worker runs the next one.
    const own: HistoryEntry[] = await history.visible(database, ctx.taskId);
    const calls = foldCalls(own);
    const plan: StepPlan = {
      continuation: continuationOf({ session, messages: ctx.messages }),
      interrupted: ctx.messages.some((message) => message.kind === interrupt),
      otherMessages: ctx.messages.some((message) => message.kind !== interrupt),
      open: calls.filter((call) => call.state !== done),
    };
    const prelude = preludeOf(ctx, session, plan);

    // `prelude` is set: an interrupt always writes its event.
    if (plan.interrupted && !plan.otherMessages && prelude !== undefined) {
      return interruptWait(ctx, prelude, startedAt);
    }

    // A stop or an interrupt closes the open calls, but a sent `task` call only its tracker's outcomes close
    // (deep-agents/design-task.md KD-3): the tool step closes it with the `tasks_finished` this step delivers.
    const toRun = closesOpen(plan) ? plan.open.filter(isDelegated) : plan.open;
    if (toRun.length > 0) {
      return withPrelude(ctx, await deps.toolStep(ctx, session, toRun, calls), prelude);
    }
    // A compaction is written only here, with no call left open: `history.visible` relies on it.
    if (compactionDue(session, deps.compactAtTokens)) {
      return deps.compactionStep(ctx, session, own, prelude);
    }
    return deps.modelStep(ctx, session, own, prelude);
  }

  return { type: AGENT_TASK_TYPE, inputSchema: AgentTaskInputSchema, step };
}
