import { researchAgentRuns } from '@agent-os/db';
import type { RuntimeTx, TaskContext } from '@agent-os/runtime';
import { and, eq, isNull } from 'drizzle-orm';
import { agentRunsRepository as agentRuns } from './agent-runs.repository.js';
import { createFormDataReader } from './collect-reader.js';
import { refsBelong } from './investigation-refs.js';
import type { SnapshotEntry } from './fingerprint.js';
import type { ClosureInput, ForcedEndCode, FormRunContext, ResultForm } from './result-forms.js';
import { sessionRepository as sessions } from './session.repository.js';
import type { CallStep } from './tool-calls.repository.js';

/**
 * The process code of a result form as the engine runs it (design-agent-core.md, KD-8, «Формы результата и код
 * процесса», Flow 5; ADR-0010). Each function — the prologue, the closure, a forced end — runs its optional `collect`, its
 * pure step and its `write` in one guarded transaction in the mode `requireActive`, and records its outcome in the same
 * write, so a retry after a restart writes nothing twice (invariant 14). No step calls the model, an external system,
 * `TaskScheduler.propose` or the attempt functions; an exception of a step fails the run `internal`, as any exception of
 * the handler.
 */

/** The prologue's input is bounded as a runtime checkpoint is: 64 KiB of UTF-8 JSON (DC-19). */
const PROLOGUE_INPUT_MAX_BYTES = 64 * 1_024;

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** Whether the prologue's input — from `collect` or the assignment — is within 64 KiB as JSON (DC-19). */
export function prologueInputFits(input: unknown): boolean {
  return utf8Bytes(JSON.stringify(input) ?? 'null') <= PROLOGUE_INPUT_MAX_BYTES;
}

/** Whether the first message of `start` is within the form's `firstMessageMaxBytes`, in UTF-8 bytes (DC-19). */
export function firstMessageFits(firstMessage: string, firstMessageMaxBytes: number): boolean {
  return utf8Bytes(firstMessage) <= firstMessageMaxBytes;
}

/** A guarded write of the run in the mode `requireActive`; a stop or a lost attempt ends the attempt without a write. */
export type GuardedWrite = <T>(work: (tx: RuntimeTx) => Promise<T>) => Promise<T>;

/** What the process code of one run works with. */
export interface FormRun {
  readonly ctx: Pick<TaskContext, 'taskId' | 'investigationId'>;
  readonly form: ResultForm;
  readonly context: FormRunContext;
  /** The run's assignment from its task input: the prologue's input when the form has no `collect`. */
  readonly assignment: string;
  readonly snapshotEntries: readonly SnapshotEntry[];
  readonly guarded: GuardedWrite;
}

const bindingsOf = (form: ResultForm) => form.bindings ?? {};

function readerOf(run: FormRun, tx: RuntimeTx) {
  return createFormDataReader(tx, { investigationId: run.ctx.investigationId, snapshotEntries: run.snapshotEntries });
}

/** Records the prologue's input in the run row, once. */
async function writePrologueInput(tx: RuntimeTx, runTaskId: string, input: unknown): Promise<void> {
  await tx
    .update(researchAgentRuns)
    .set({ prologueInput: input })
    .where(and(eq(researchAgentRuns.taskId, runTaskId), isNull(researchAgentRuns.prologueInput)));
}

export type PrologueOutcome =
  | { readonly kind: 'started' }
  | { readonly kind: 'completed'; readonly result: unknown }
  | { readonly kind: 'fail'; readonly code: 'prologue_oversize' | 'prologue_refused'; readonly message: string };

/**
 * The prologue (DC-19, DC-26): once, while the session is empty. Its input — what `collect` returned, or the assignment
 * — is checked against 64 KiB before `build`. `start` writes the first message and the input in one guarded write; a
 * first message over `firstMessageMaxBytes` is `prologue_oversize` with nothing written. `end` goes through the closure's
 * `evaluate`: accepted — its rows, the prologue's input and the run's result in one write; refused — `prologue_refused`,
 * and `write` is not called. A retry after the first message was written does not call the prologue again.
 */
export async function runPrologue(run: FormRun): Promise<PrologueOutcome> {
  const prologue = run.form.prologue;
  if (prologue === undefined) throw new Error(`form ${run.form.name} has no prologue`);
  const owner = { runTaskId: run.ctx.taskId, investigationId: run.ctx.investigationId };
  return run.guarded(async (tx): Promise<PrologueOutcome> => {
    if ((await sessions.read(tx, run.ctx.taskId)).length > 0) return { kind: 'started' };
    const input = prologue.collect === undefined ? run.assignment : await prologue.collect(run.context, readerOf(run, tx));
    if (!prologueInputFits(input)) {
      return { kind: 'fail', code: 'prologue_oversize', message: 'the prologue input is over 64 KiB' };
    }
    const decision = prologue.build(input, bindingsOf(run.form));
    if (decision.kind === 'start') {
      if (!firstMessageFits(decision.firstMessage, prologue.firstMessageMaxBytes)) {
        return { kind: 'fail', code: 'prologue_oversize', message: 'the first message is over firstMessageMaxBytes' };
      }
      await sessions.append(tx, owner, [{ kind: 'prologue', content: { text: decision.firstMessage } }]);
      await writePrologueInput(tx, run.ctx.taskId, input);
      return { kind: 'started' };
    }
    const closed = await evaluateResult(run, tx, { result: decision.result, prologueInput: input });
    if (closed.kind === 'refuse') {
      return { kind: 'fail', code: 'prologue_refused', message: 'the closure refused the result of the prologue' };
    }
    await writePrologueInput(tx, run.ctx.taskId, input);
    await agentRuns.writeEnding(tx, run.ctx.taskId, { result: closed.result });
    return { kind: 'completed', result: closed.result };
  });
}

type Evaluated = { readonly kind: 'accept'; readonly result: unknown } | { readonly kind: 'refuse'; readonly reason: string };

/**
 * The closure's `collect` and `evaluate` over a result, and its `write` for a `finish` (not for the prologue's `end`,
 * whose refusal writes nothing). A form without a closure accepts a result that passes its schema.
 */
async function evaluateResult(
  run: FormRun,
  tx: RuntimeTx,
  input: Pick<ClosureInput, 'result' | 'prologueInput'>,
  options: { readonly writeRefusal: boolean } = { writeRefusal: false },
): Promise<Evaluated> {
  const closure = run.form.closure;
  if (closure === undefined) {
    const parsed = run.form.resultSchema.safeParse(input.result);
    return parsed.success ? { kind: 'accept', result: parsed.data } : { kind: 'refuse', reason: 'invalid_result' };
  }
  const collected = closure.collect === undefined ? null : await closure.collect(run.context, readerOf(run, tx));
  const decision = closure.evaluate({ ...input, collected }, bindingsOf(run.form));
  if (decision.kind === 'accept' || options.writeRefusal) await closure.write(tx, run.context, decision);
  return decision;
}

const invalidResult = (reason: string): CallStep => ({
  to: 'rejected',
  outcome: 'rejected',
  reason: 'invalid_result',
  detail: { reason },
});

/**
 * The closure on a lone `finish` whose result passed the form's schema (DC-20): the step of the `finish` call, decided
 * in its guarded transaction. The result's references go first: one of another investigation or to nothing refuses it
 * `invalid_result` with the reason `foreign_ref`, and nothing of the closure runs (DC-4). `accept` — the closure's rows,
 * the call's outcome and the run's result; `refuse` — the closure's rows and the call refused `invalid_result` with the
 * reason, a notice the model reads next turn.
 */
export function closureStep(run: FormRun, finish: { readonly result: unknown }) {
  return async (tx: RuntimeTx): Promise<CallStep> => {
    const refs = run.form.refsOf?.(finish.result) ?? [];
    if (!(await refsBelong(tx, run.ctx.investigationId, refs))) return invalidResult('foreign_ref');
    const row = await agentRuns.read(tx, run.ctx.taskId);
    if (row === undefined) throw new Error(`run row of task ${run.ctx.taskId} is missing`);
    const prologueInput = row.prologueInput ?? row.assignment;
    const decision = await evaluateResult(run, tx, { result: finish.result, prologueInput }, { writeRefusal: true });
    if (decision.kind === 'refuse') return invalidResult(decision.reason);
    await agentRuns.writeEnding(tx, run.ctx.taskId, { result: decision.result });
    return { to: 'done', outcome: 'success', result: decision.result };
  };
}

export type ForcedEndOutcome = { readonly kind: 'result'; readonly result: unknown } | { readonly kind: 'none' };

/**
 * A forced end (DC-21): between turns, where the handler would fail the run with `code`. `result` — the function's rows
 * and the run's result in one guarded write, with a notice of the code it replaced (the tree read takes
 * `budgetExhausted` from it); `none` — nothing is written, and the run fails with the code.
 */
export async function runForcedEnd(run: FormRun, code: ForcedEndCode, turn: number): Promise<ForcedEndOutcome> {
  const forcedEnd = run.form.forcedEnd?.[code];
  if (forcedEnd === undefined) return { kind: 'none' };
  const owner = { runTaskId: run.ctx.taskId, investigationId: run.ctx.investigationId };
  return run.guarded(async (tx): Promise<ForcedEndOutcome> => {
    const collected = forcedEnd.collect === undefined ? null : await forcedEnd.collect(run.context, readerOf(run, tx));
    const decision = forcedEnd.decide(collected, bindingsOf(run.form));
    if (decision.kind === 'none') return decision;
    await forcedEnd.write(tx, run.context, decision);
    await agentRuns.writeEnding(tx, run.ctx.taskId, { result: decision.result });
    await sessions.append(tx, owner, [
      {
        kind: 'code_notice',
        content: { turn, code: 'forced_end', text: `[forced_end] the run ended by its form instead of ${code}`, failureCode: code },
      },
    ]);
    return decision;
  });
}
