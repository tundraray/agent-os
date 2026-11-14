import { randomUUID } from 'node:crypto';
import type { Database } from '@agent-os/db';
import type {
  RuntimeTx,
  StepContext,
  StepDecision,
  StepResult,
  TaskHandler,
} from '@agent-os/runtime';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

/**
 * Test handlers of the runtime: plain objects, so the in-process tests and the child process of
 * E2E-1 run the same code. A scripted step writes one row to the handler's own table through its
 * `commit`, so a row exists exactly when the step's commit transaction did.
 */

/**
 * The handler's own table. It lives in schema `public`, outside `app` and the migrations: the
 * package writes only its `runtime_*` tables, the test handler only this one (code system, Module
 * Boundaries). No foreign key: rows are read by `task_id`.
 */
export const HANDLER_ROWS_TABLE = 'public.e2e_handler_rows';

/** Creates {@link HANDLER_ROWS_TABLE} once; the harness calls it before building the runtime. */
export async function ensureHandlerRowsTable(db: Database): Promise<void> {
  await db.execute(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS ${HANDLER_ROWS_TABLE} (
         task_id uuid NOT NULL,
         step_no integer NOT NULL,
         attempt integer NOT NULL,
         resumed_after_loss boolean NOT NULL,
         note text)`,
    ),
  );
}

/** A task type unique to one test: workers of other tests never claim its tasks. */
export function uniqueType(label: string): string {
  return `test-${label}-${randomUUID()}`;
}

/**
 * A point a step holds at until the test opens it. `reached` resolves when a step arrives; a step
 * held at the gate gives up (throws) when its signal is aborted, so a closing harness never waits
 * on a gate the test left shut.
 */
export interface Gate {
  /** Resolves once a step has reached the gate. */
  readonly reached: Promise<void>;
  /** Lets every step at the gate, and every later one, through. */
  open(): void;
  /** Called by the step: marks the gate reached and waits until it is open or `signal` aborts. */
  pass(signal: AbortSignal): Promise<void>;
}

export function createGate(): Gate {
  let markReached: () => void = () => undefined;
  let markOpen: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    markOpen = resolve;
  });
  return {
    reached,
    open: () => markOpen(),
    pass(signal) {
      markReached();
      return new Promise<void>((resolve, reject) => {
        const onAbort = () =>
          reject(new Error(`step left the gate: ${String(signal.reason)}`));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        void opened.then(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    },
  };
}

/** Gates made on first use, one per key: one per task of a handler type many tasks share. */
export interface GateBook {
  of(key: string): Gate;
}

export function createGateBook(): GateBook {
  const gates = new Map<string, Gate>();
  return {
    of(key) {
      let gate = gates.get(key);
      if (!gate) {
        gate = createGate();
        gates.set(key, gate);
      }
      return gate;
    },
  };
}

/**
 * A signal that never aborts: a step that passes its gate with it holds through an interrupt or a
 * stop and answers afterwards with a late result, as a handler deaf to its signal would.
 */
export const DEAF_SIGNAL: AbortSignal = new AbortController().signal;

/**
 * What one scripted step does; `throw` raises `error` from `step` instead of returning. With a
 * `gate` the step holds at it before answering; with `deaf` it holds there through its signal.
 */
export type ScriptedStep = (
  | { outcome: 'continue' }
  | { outcome: 'wait' }
  | { outcome: 'complete'; result: unknown }
  | { outcome: 'await_decision'; kind: string; payload: unknown }
  | { outcome: 'throw'; error: Error }
) & { gate?: Gate; deaf?: boolean };

/** A message as a step saw it in its context. */
export interface SeenMessage {
  seq: number;
  kind: string;
  sender: string;
  payload: unknown;
  revive: boolean;
}

/** What a step's context held when the handler was called. */
export interface StepView {
  taskId: string;
  stepNo: number;
  messages: SeenMessage[];
  decision: StepDecision | null;
}

export interface ScriptedHandlerOptions {
  type: string;
  /** Step `n` runs `steps[n]`; steps past the end repeat the last one. */
  steps: readonly ScriptedStep[];
  /** Written to every row, e.g. the instance that ran the step. */
  note?: string;
  /** Receives the view of every step's context, in call order, before the step's gate. */
  seen?: StepView[];
}

function viewOf(ctx: StepContext): StepView {
  return {
    taskId: ctx.taskId,
    stepNo: ctx.stepNo,
    messages: ctx.messages.map((message) => ({
      seq: message.seq,
      kind: message.kind,
      sender: message.sender,
      payload: message.payload,
      revive: message.revive,
    })),
    decision: ctx.decision,
  };
}

/**
 * Writes the step's handler row inside the commit. `attempt` is read from the task row, which the
 * commit holds FOR UPDATE after checking that the claimed attempt is still current: it is the
 * attempt that committed the step.
 */
export function writeHandlerRow(ctx: StepContext, note: string | null) {
  return async (tx: RuntimeTx) => {
    await tx.execute(sql`
      INSERT INTO ${sql.raw(HANDLER_ROWS_TABLE)} (task_id, step_no, attempt, resumed_after_loss, note)
      SELECT task_id, ${ctx.stepNo}, attempt, ${ctx.resumedAfterLoss}, ${note}
        FROM app.runtime_tasks WHERE task_id = ${ctx.taskId}`);
  };
}

/** A handler that runs a fixed script of steps; its input is any JSON object. */
export function scriptedHandler(options: ScriptedHandlerOptions): TaskHandler {
  const { type, steps, note, seen } = options;
  if (steps.length === 0) throw new Error(`Handler ${type} has no steps`);
  return {
    type,
    inputSchema: z.record(z.string(), z.unknown()),
    async step(ctx: StepContext): Promise<StepResult> {
      const scripted = steps[Math.min(ctx.stepNo, steps.length - 1)];
      seen?.push(viewOf(ctx));
      if (scripted.gate) await scripted.gate.pass(scripted.deaf ? DEAF_SIGNAL : ctx.signal);
      if (scripted.outcome === 'throw') throw scripted.error;
      return { ...outcomeOf(scripted), commit: writeHandlerRow(ctx, note ?? null) };
    },
  };
}

function outcomeOf(scripted: Exclude<ScriptedStep, { outcome: 'throw' }>): StepResult {
  switch (scripted.outcome) {
    case 'continue':
    case 'wait':
      return { outcome: scripted.outcome };
    case 'complete':
      return { outcome: 'complete', result: scripted.result };
    case 'await_decision':
      return { outcome: 'await_decision', kind: scripted.kind, payload: scripted.payload };
  }
}
