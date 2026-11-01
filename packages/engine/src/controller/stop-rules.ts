import type { StopReason } from '../answer/code-answer.js';
import type { ModelCallResult } from '../model/model-gateway.js';

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
