import type { ForcedEndCode } from '../../agents/result-forms.js';
import type { StopReason } from '../../answer/code-answer.js';

/**
 * How the root ended when its answer is built by code: the packet of the answer agent did not fit (`answer_overflow`),
 * the code of a forced end, or the closure `inconclusive`. The answer of the answer agent is never built by code and has no
 * stop reason, so it is not an ending here.
 */
export type RootEnding = 'answer_overflow' | 'inconclusive' | ForcedEndCode;

/**
 * The stop reason by the rule of precedence (design-research-flow.md, «Как причина остановки получается из конца корня»;
 * DC-1, AC-12.3). `budgetExhausted` decides only where the budget may be the first cause: the branches it cut off spent the
 * turns and the time of the root.
 */
export function stopReasonOf(ending: RootEnding, budgetExhausted: boolean): StopReason | null {
  switch (ending) {
    case 'answer_overflow':
    case 'context_overflow':
      return 'context_overflow';
    case 'run_tokens_exhausted':
    case 'investigation_tokens_exhausted':
      return 'budget_exhausted';
    case 'model_unavailable':
      return 'model_unavailable';
    case 'not_after':
      return budgetExhausted ? 'budget_exhausted' : 'deadline';
    case 'turn_limit':
      return budgetExhausted ? 'budget_exhausted' : 'step_limit';
    case 'inconclusive':
      return budgetExhausted ? 'budget_exhausted' : null;
  }
}
