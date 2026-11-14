import {
  AGENT_TASK_TYPE,
  AgentMessageKindSchema,
  HistoryEventSchema,
  ToolCallStateSchema,
} from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { RuntimeTx, StepContext, StepResult, TaskHandler } from '@agent-os/runtime';
import { z } from 'zod';

import type { NewHistoryEntry } from '../store/history.repository.js';
import { type Session, type SessionInput, type SessionPatch, sessions } from '../store/sessions.repository.js';
import { type ToolCallRow, toolCalls } from '../store/tool-calls.repository.js';
import { SessionLimitsSchema } from '../tools/tool.js';
import { compactionDue, type CompactionStep } from './compaction-step.js';
import { type Continuation, continuationEntries, continuationOf } from './continuation.js';
import { closeOpen, entriesOf, interruptedOutcome, interruptText, toolResultEntry } from './deliver.js';
import { appendWithEvent, logStep, type ModelStep, type StepPrelude } from './model-step.js';
import type { ToolStep } from './tool-step.js';
import { nextTurns } from './turn-rules.js';

/** The input of an `agent` task (plan Notes 3): the model is chosen already; the first step makes the session from it. */
const AgentTaskInputSchema = z.object({
  definition: z.string().min(1),
  description: z.string(),
  prompt: z.string(),
  model: z.string().min(1),
  limits: SessionLimitsSchema.optional(),
  forkedFrom: z
    .object({ agentId: z.string().min(1), throughSeq: z.number().int().nonnegative() })
    .optional(),
}) satisfies z.ZodType<SessionInput>;

const { interrupt } = AgentMessageKindSchema.enum;

/** The session fields a continuation sets (`continuationEntries`): the turn counter from zero, `closed` cleared. */
const CONTINUATION_PATCH: SessionPatch = { turns: 0, closed: false };

const INTERRUPTED_EVENT: NewHistoryEntry = {
  kind: 'event',
  content: { event: HistoryEventSchema.enum.interrupted, reason: null },
};

export interface AgentStepHandlerDeps {
  /** Reads the session and its open calls outside the commit: only steps of this agent write them. */
  readonly database: Database;
  readonly toolStep: ToolStep;
  readonly modelStep: ModelStep;
  readonly compactionStep: CompactionStep;
  /** `AGENT_COMPACT_AT_TOKENS`. */
  readonly compactAtTokens: number;
}

/** What the step found in its messages and its session before choosing the kind of work. */
interface StepPlan {
  readonly continuation: Continuation | undefined;
  /** The step took an `interrupt` message (KD-3). */
  readonly interrupted: boolean;
  /** One of the `interrupt` messages carries the employee's text. */
  readonly interruptWithText: boolean;
  /** A message of another kind than `interrupt` is delivered: the `interrupted` mark goes (KD-3). */
  readonly otherMessages: boolean;
  /** Open calls of the agent before the step. */
  readonly open: readonly ToolCallRow[];
}

/** An open call as the commit will close it (`closeOpen`), so the model sees its result in this call. */
function closedPreview(call: ToolCallRow): NewHistoryEntry {
  return toolResultEntry({
    ...call,
    state: ToolCallStateSchema.enum.done,
    outcome: interruptedOutcome(call) ?? null,
    finishedAt: new Date(),
  });
}

/**
 * What the handler writes ahead of the chosen step (Flow 6, Flow 7, KD-3): the continuation entries of a
 * finished agent, then on an `interrupt` the open calls closed and the `interrupted` event; the
 * `interrupted` mark cleared by a message of another kind. `undefined` when there is nothing to write.
 */
function preludeOf(ctx: StepContext, session: Session, plan: StepPlan): StepPrelude | undefined {
  const { continuation, interrupted } = plan;
  const stopClosesOpen = continuation !== undefined && continuation.stop !== null;

  const entries: NewHistoryEntry[] = [];
  if (continuation !== undefined) {
    if (continuation.stop !== null) {
      entries.push(...plan.open.map(closedPreview), {
        kind: 'event',
        content: {
          event: continuation.stop.withParent
            ? HistoryEventSchema.enum.stopped_with_parent
            : HistoryEventSchema.enum.stopped,
          reason: null,
        },
      });
    }
    entries.push({ kind: 'event', content: { event: HistoryEventSchema.enum.continued, reason: null } });
  }
  if (interrupted) {
    if (!stopClosesOpen) entries.push(...plan.open.map(closedPreview));
    entries.push(INTERRUPTED_EVENT);
  }

  const clearsMark = session.interrupted && (plan.otherMessages || plan.interruptWithText);
  const patch: SessionPatch = {
    ...(continuation === undefined ? {} : CONTINUATION_PATCH),
    ...(clearsMark ? { interrupted: false } : {}),
  };
  if (entries.length === 0 && Object.keys(patch).length === 0) return undefined;

  return {
    entries,
    patch,
    write: async (tx) => {
      const written: NewHistoryEntry[] = [];
      const continued = await continuationEntries(tx, { session, messages: ctx.messages });
      if (continued !== undefined) written.push(...continued.entries);
      if (interrupted) {
        written.push(...(await closeOpen(tx, ctx.taskId)), INTERRUPTED_EVENT);
      }
      return written;
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
 * An `interrupt` without text and no other message (KD-3): the open calls closed, the `interrupted`
 * event, the session marked «прерван» with its turn counter reset; the agent waits for a message.
 */
function interruptWait(ctx: StepContext, prelude: StepPrelude, startedAt: number): StepResult {
  logStep(ctx, 'interrupt', startedAt, 'wait');
  return {
    outcome: 'wait',
    commit: async (tx, effects) => {
      const entries = [...(await prelude.write(tx)), ...(await entriesOf(tx, ctx.messages))];
      await appendWithEvent(tx, effects, ctx.taskId, entries);
      await sessions.update(tx, ctx.taskId, {
        ...prelude.patch,
        interrupted: true,
        turns: nextTurns(0, { kind: 'interrupted_without_text' }),
      });
    },
  };
}

/**
 * Builds the handler of `agent` tasks (design-agents.md: C3 `AgentStepHandler`, «Как шаг выбирает
 * работу», KD-3, Flow 6). Between steps it keeps nothing in memory: each step reads the session.
 *
 * 1. The session is made from the task input if the starter did not make it (through `guard`).
 * 2. A finished agent continues (`continuationOf`): its stop entries and `continued` go first.
 * 3. An `interrupt` closes the open calls and writes `interrupted`; with text the model is called at
 *    once, without text (and no other message) the agent is marked and waits.
 * 4. Otherwise: open calls → the tool step; input of the previous call at the threshold → compaction;
 *    else the model step (its turn limit check is d3).
 */
export function createAgentStepHandler(deps: AgentStepHandlerDeps): TaskHandler {
  const { database } = deps;

  /** The session of the agent, made from the task input when missing; `undefined` when the attempt is fenced. */
  async function sessionOf(ctx: StepContext): Promise<Session | undefined> {
    const existing = await sessions.get(database, ctx.taskId);
    if (existing !== undefined) return existing;
    const input = AgentTaskInputSchema.parse(ctx.input);
    const made = await ctx.guard((tx: RuntimeTx) =>
      sessions.ensureSession(tx, ctx.taskId, input, ctx.ownerId),
    );
    if (made.outcome === 'fenced') return undefined;
    const session = await sessions.get(database, ctx.taskId);
    if (session === undefined) throw new Error(`Session of agent ${ctx.taskId} was not created`);
    return session;
  }

  async function step(ctx: StepContext): Promise<StepResult> {
    const startedAt = Date.now();
    const session = await sessionOf(ctx);
    if (session === undefined) {
      ctx.logger.info('agent step abandoned without writes', {
        agentId: ctx.taskId,
        stepNo: ctx.stepNo,
        reason: 'session write fenced',
      });
      return { outcome: 'continue' };
    }

    const interrupts = ctx.messages.filter((message) => message.kind === interrupt);
    const plan: StepPlan = {
      continuation: continuationOf({ session, messages: ctx.messages }),
      interrupted: interrupts.length > 0,
      interruptWithText: interrupts.some((message) => interruptText(message) !== undefined),
      otherMessages: ctx.messages.some((message) => message.kind !== interrupt),
      open: await toolCalls.open(database, ctx.taskId),
    };
    const prelude = preludeOf(ctx, session, plan);

    if (plan.interrupted) {
      if (plan.interruptWithText) return deps.modelStep(ctx, session, prelude);
      // `prelude` is set: an interrupt always writes its event.
      if (!plan.otherMessages && prelude !== undefined) return interruptWait(ctx, prelude, startedAt);
    }

    // A stop or an interrupt closes the open calls in the prelude: they are never run.
    const closedByPrelude =
      plan.interrupted || (plan.continuation !== undefined && plan.continuation.stop !== null);
    const openCalls = closedByPrelude ? [] : plan.open;
    if (openCalls.length > 0) {
      return withPrelude(ctx, await deps.toolStep(ctx, session, openCalls), prelude);
    }
    if (compactionDue(session, deps.compactAtTokens)) {
      return deps.compactionStep(ctx, session, prelude);
    }
    return deps.modelStep(ctx, session, prelude);
  }

  return { type: AGENT_TASK_TYPE, inputSchema: AgentTaskInputSchema, step };
}
