import type { Task } from '@agent-os/contracts';
import type { CodeAnswerEnd, StopReason } from '../answer/code-answer.js';
import type { Capability } from '../config/capabilities.js';
import type { ProcessConfig } from '../config/process-config.schema.js';
import type { ModelCallResult } from '../model/model-gateway.js';
import type { PlanContent } from './plan-role.js';

/**
 * What a model call of the controller task (its `plan` role or the controller itself) means for the investigation:
 * an answer to go on with, a forced stop with its reason (Flow 2), an invalid output (the caller decides), or the end of
 * the attempt without an outcome — a cancel or a lost attempt, which the runtime decides by the abort or the fence.
 */
export type ControllerCallOutcome<T> =
  | { readonly outcome: 'answered'; readonly output: T }
  | { readonly outcome: 'invalid' }
  | { readonly outcome: 'stop'; readonly reason: StopReason }
  | { readonly outcome: 'abandon'; readonly cause: 'cancelled' | 'fenced' };

export function controllerCallOutcome<T>(result: ModelCallResult<T>): ControllerCallOutcome<T> {
  switch (result.outcome) {
    case 'answered':
      return result;
    case 'invalid_model_output':
      return { outcome: 'invalid' };
    case 'fenced':
      return { outcome: 'abandon', cause: 'fenced' };
    case 'no_answer':
      // DC-3: `notAfter` before or during the call stops with `deadline`; a cancel gets no answer (AC-21.1).
      return result.reason === 'deadline' ? { outcome: 'stop', reason: 'deadline' } : { outcome: 'abandon', cause: 'cancelled' };
    case 'failed':
      // AC-07.3 and DC-12: an exhausted budget or an unavailable model stops the investigation with an answer by code.
      return { outcome: 'stop', reason: result.code === 'model_unavailable' ? 'model_unavailable' : 'budget_exhausted' };
  }
}

/** Stop checks before a step's first controller call: the step limit (AC-03.2), then `notAfter` (DC-3). */
export function stopBeforeStep(input: { readonly step: number; readonly maxSteps: number; readonly now: Date; readonly notAfter: Date }): StopReason | null {
  if (input.step > input.maxSteps) {
    return 'step_limit';
  }
  return input.now >= input.notAfter ? 'deadline' : null;
}

/**
 * KD-8: without the `plan` capability the first plan revision is the configuration's `goal`, written by code without a
 * role call; null when the `plan` role writes it.
 */
export function seedPlan(config: Pick<ProcessConfig, 'goal' | 'capabilities'>): PlanContent | null {
  return config.capabilities.includes('plan') ? null : { goal: config.goal, readinessCriteria: [], branches: [] };
}

/** The synthesis task of the no-source path as the controller observes it. */
export type ObservedSynthesis = Pick<Task, 'status' | 'failureReason' | 'outcome'>;

const FINAL_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled']);

/** AC-25.5: the failure classes of a synthesis that end the no-source path with a stop reason. */
const STOP_BY_FAILURE_CLASS: Readonly<Record<string, StopReason>> = {
  budget_exhausted: 'budget_exhausted',
  deadline: 'deadline',
  transport_protocol: 'model_unavailable',
};

/**
 * Flow 5: the end code gives an investigation without sources when no answer is recorded, or null while its synthesis
 * is still to be proposed or running. Without `synthesize` the investigation concludes inconclusive with no stop reason
 * (KD-8). A synthesis that failed on the budget, on `notAfter` or on an unavailable model stops it with that reason
 * (AC-25.5); one whose packet did not fit stops it with `context_overflow`, as the controller's own input does (DC-8);
 * one that succeeded without an answer (an invalid output after the retry) concludes it. Any other failure is a defect
 * of the run, not an outcome of the investigation.
 */
export function noSourceEnd(input: {
  readonly capabilities: readonly Capability[];
  readonly synthesis: ObservedSynthesis | undefined;
}): CodeAnswerEnd | null {
  const { synthesis } = input;
  if (!input.capabilities.includes('synthesize')) return { concluded: true };
  if (synthesis === undefined || !FINAL_STATUSES.has(synthesis.status)) return null;
  if (synthesis.status === 'succeeded') {
    const delta = synthesis.outcome?.answerOrDelta;
    const narrowing = typeof delta === 'object' && delta !== null && 'needsNarrowing' in delta;
    return narrowing ? { stopReason: 'context_overflow' } : { concluded: true };
  }
  const failureClass = synthesis.failureReason?.class ?? 'unknown';
  const stopReason = STOP_BY_FAILURE_CLASS[failureClass];
  if (stopReason === undefined) {
    throw new Error(`the synthesis ended ${synthesis.status} with ${failureClass}: no answer can follow from it`);
  }
  return { stopReason };
}
