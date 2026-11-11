import type { ForcedEndCode } from '../../agents/result-forms.js';
import type { StopReason } from '../../answer/code-answer.js';

/**
 * How the root ended when its answer is built by code: the packet of the answer agent did not fit (`answer_overflow`),
 * the code of a forced end, or the closure `inconclusive`. The answer of the answer agent is never built by code and has no
 * stop reason, so it is not an ending here.
 */
export type RootEnding = 'answer_overflow' | 'inconclusive' | ForcedEndCode;

/** What the investigation's tree says besides how the root ended. */
export interface TreeSigns {
  /** The tree's `budgetExhausted` (DC-16). */
  readonly budgetExhausted: boolean;
  /** No accepted plan revision, and the plan attempts are exhausted (design-catalog-planning.md, KD-4). */
  readonly planSourcesRejected: boolean;
}

/**
 * The stop reason by the rule of precedence (design-research-flow.md, «Как причина остановки получается из конца корня»;
 * DC-1, AC-12.3; design-catalog-planning.md, «Закрытие корня и причина остановки»). The first rule: with no accepted plan
 * and the attempts exhausted, the closure «не выяснено» and every forced end of the root stop with `plan_sources_rejected`.
 * `budgetExhausted` decides only where the budget may be the first cause: the branches it cut off spent the turns and the
 * time of the root.
 */
export function stopReasonOf(ending: RootEnding, { budgetExhausted, planSourcesRejected }: TreeSigns): StopReason | null {
  if (planSourcesRejected) return 'plan_sources_rejected';
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
