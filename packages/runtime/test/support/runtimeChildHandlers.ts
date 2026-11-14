import type { Database } from '@agent-os/db';
import type { StepContext, StepResult, TaskHandler } from '@agent-os/runtime';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { HANDLER_ROWS_TABLE, scriptedHandler, writeHandlerRow } from './testHandlers.js';

/**
 * Handlers of the E2E-1 tree and of the on-demand measurements, shared by the compiled child (which
 * runs them) and the test process (which registers them, workers off, only to create tasks of their
 * types). Every row they write goes to {@link HANDLER_ROWS_TABLE}, told apart by `note`:
 *
 * - `step:<outcome>` — the step's own row, written in its commit: it exists exactly when the commit
 *   did. `<outcome>` is `done`, `unknown` (the redone step found its intent and skipped the action),
 *   `asked` (a decision request), or the JSON a decision step saw.
 * - `intent` — written through `guard` before the external action.
 * - `external` — written by the external-action double, in its own autocommit statement: the action
 *   happened, whatever became of the step.
 * - `children:<n>` — the parent's step row: `n` child notices in that step.
 */

/** Variable of the child's environment naming the task types it registers (JSON of {@link ChildTypes}). */
export const CHILD_TYPES_ENV = 'E2E_CHILD_TYPES';

/** Task types a process registers, by role; an absent role is not registered. */
export interface ChildTypes {
  /** P: waits for `input.children` child notices, then completes. */
  parent?: string;
  /** C1: `input.steps` steps, each a guarded intent, the external action and a committed row. */
  writer?: string;
  /** C2: two steps, a committed row each. */
  reader?: string;
  /** A decision step, then a step that records the decision and the messages it got. */
  decider?: string;
  /** A step that holds until its signal aborts (measurements). */
  hold?: string;
}

export const STEP_DONE = 'step:done';
export const STEP_UNKNOWN = 'step:unknown';
export const STEP_ASKED = 'step:asked';
export const INTENT_NOTE = 'intent';
export const EXTERNAL_NOTE = 'external';
const CHILDREN_NOTE_PREFIX = 'children:';

/** The decision request of the decider's first step. */
export const DECISION_KIND = 'approval';
export const DECISION_PAYLOAD = { question: 'proceed?' };

/** The external action of the guard row: one autocommit row per call, apart from the step. */
async function callExternalAction(db: Database, ctx: StepContext): Promise<void> {
  await db.execute(sql`
    INSERT INTO ${sql.raw(HANDLER_ROWS_TABLE)} (task_id, step_no, attempt, resumed_after_loss, note)
    SELECT task_id, ${ctx.stepNo}, attempt, ${ctx.resumedAfterLoss}, ${EXTERNAL_NOTE}
      FROM app.runtime_tasks WHERE task_id = ${ctx.taskId}`);
}

const ParentInputSchema = z.object({ children: z.number().int().min(1) });

/** P: each step records how many child notices it got; completes once all children reported. */
function parentHandler(type: string, db: Database): TaskHandler {
  return {
    type,
    inputSchema: ParentInputSchema,
    async step(ctx): Promise<StepResult> {
      const { children } = ParentInputSchema.parse(ctx.input);
      const notices = ctx.messages.filter((message) => message.kind === 'child_finished').length;
      // Notices of earlier steps: only committed steps left a row.
      const { rows } = await db.execute<{ note: string }>(sql`
        SELECT note FROM ${sql.raw(HANDLER_ROWS_TABLE)}
         WHERE task_id = ${ctx.taskId} AND note LIKE ${`${CHILDREN_NOTE_PREFIX}%`}`);
      const earlier = rows.reduce(
        (sum, row) => sum + Number(row.note.slice(CHILDREN_NOTE_PREFIX.length)),
        0,
      );
      const commit = writeHandlerRow(ctx, `${CHILDREN_NOTE_PREFIX}${notices}`);
      return earlier + notices >= children
        ? { outcome: 'complete', result: { children }, commit }
        : { outcome: 'wait', commit };
    },
  };
}

const WriterInputSchema = z.object({ steps: z.number().int().min(1) });

/**
 * C1 (UC-7): every step writes its intent through `guard`, calls the external action, and commits
 * its row. A step that finds its own intent — the previous attempt got that far and was lost — does
 * not call the action again and commits the outcome `unknown`.
 */
function writerHandler(type: string, db: Database): TaskHandler {
  return {
    type,
    inputSchema: WriterInputSchema,
    async step(ctx): Promise<StepResult> {
      const { steps } = WriterInputSchema.parse(ctx.input);
      const guarded = await ctx.guard(async (tx) => {
        const { rows } = await tx.execute(sql`
          SELECT 1 FROM ${sql.raw(HANDLER_ROWS_TABLE)}
           WHERE task_id = ${ctx.taskId} AND step_no = ${ctx.stepNo} AND note = ${INTENT_NOTE}`);
        if (rows.length > 0) return 'found' as const;
        await writeHandlerRow(ctx, INTENT_NOTE)(tx);
        return 'written' as const;
      });
      if (guarded.outcome === 'fenced') {
        throw new Error(`Step ${ctx.stepNo} of ${ctx.taskId} was fenced at its intent`);
      }
      if (guarded.value === 'written') await callExternalAction(db, ctx);
      const commit = writeHandlerRow(ctx, guarded.value === 'found' ? STEP_UNKNOWN : STEP_DONE);
      return ctx.stepNo >= steps - 1
        ? { outcome: 'complete', result: { steps }, commit }
        : { outcome: 'continue', commit };
    },
  };
}

/** C2: two steps; its first step receives the message the test sent before the run. */
function readerHandler(type: string): TaskHandler {
  return scriptedHandler({
    type,
    steps: [{ outcome: 'continue' }, { outcome: 'complete', result: { steps: 2 } }],
    note: STEP_DONE,
  });
}

/** What the decider's second step saw: the resolution and the payloads of its messages. */
export interface DeciderView {
  decision: unknown;
  messages: unknown[];
}

/** UC-6: asks for a decision, then records the decision and the messages it got, and completes. */
function deciderHandler(type: string): TaskHandler {
  return {
    type,
    inputSchema: z.object({}),
    async step(ctx): Promise<StepResult> {
      if (ctx.stepNo === 0) {
        return {
          outcome: 'await_decision',
          kind: DECISION_KIND,
          payload: DECISION_PAYLOAD,
          commit: writeHandlerRow(ctx, STEP_ASKED),
        };
      }
      const view: DeciderView = {
        decision: ctx.decision?.resolution ?? null,
        messages: ctx.messages.map((message) => message.payload),
      };
      return {
        outcome: 'complete',
        result: view,
        commit: writeHandlerRow(ctx, JSON.stringify(view)),
      };
    },
  };
}

/** Holds its step until the signal aborts; the late result is fenced. */
function holdHandler(type: string): TaskHandler {
  return {
    type,
    inputSchema: z.object({}),
    async step(ctx): Promise<StepResult> {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          resolve();
          return;
        }
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { outcome: 'wait' };
    },
  };
}

/** The handlers of the roles in `types`; `db` is the process's own pool. */
export function handlersFor(types: ChildTypes, db: Database): TaskHandler[] {
  const handlers: TaskHandler[] = [];
  if (types.parent) handlers.push(parentHandler(types.parent, db));
  if (types.writer) handlers.push(writerHandler(types.writer, db));
  if (types.reader) handlers.push(readerHandler(types.reader));
  if (types.decider) handlers.push(deciderHandler(types.decider));
  if (types.hold) handlers.push(holdHandler(types.hold));
  return handlers;
}
