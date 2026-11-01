import { type Capability, DECISION_KINDS, type DecisionKind, decisionsOpenedBy } from '../config/capabilities.js';
import type { ProcessConfig } from '../config/process-config.schema.js';
import { type Decision, DecisionSchema, isDecisionKind, TASK_CREATING_KINDS } from './decision.schema.js';

/** The runtime refuses a task deadline below this; a decision creating tasks needs more time left (DC-3). */
const MIN_TASK_DEADLINE_MS = 1_000;

/** Why a controller output is not a step (written to `research_decisions.rejection_reason`). */
export type RejectionReason =
  | 'kind_unknown'
  | 'capability_disabled'
  | 'invalid_structure'
  | 'invalid_model_output'
  | 'fan_out_exceeded'
  | 'plan_revisions_exhausted'
  | 'no_novelty'
  | 'verify_rounds_exhausted'
  | 'deadline_too_close'
  | 'nothing_to_wait_for';

/** What the limits look like at this step; the handler reads it from the engine rows and the runtime. */
export interface GateState {
  readonly capabilities: readonly Capability[];
  readonly limits: Pick<ProcessConfig['limits'], 'maxPlanRevisions' | 'noveltyWindow' | 'maxFanOut' | 'maxVerifyRounds'>;
  /** Accepted `replan` decisions so far: the plan has this many revisions beyond the first. */
  readonly replans: number;
  /** Accepted `requestVerification` decisions so far. */
  readonly verifyRounds: number;
  /** Trailing accepted steps that brought no new evidence and no new claim revision. */
  readonly stepsWithoutNovelty: number;
  readonly msUntilNotAfter: number;
  /** Tasks of the investigation other than the controller that are not in a final status. */
  readonly openTasks: number;
}

export type GateVerdict =
  | { readonly verdict: 'accepted'; readonly decision: Decision }
  | { readonly verdict: 'rejected'; readonly reason: RejectionReason; readonly kind: DecisionKind | null };

/** Kinds still open after the plan revisions are used up (AC-02.2). */
const AFTER_LAST_REPLAN: ReadonlySet<DecisionKind> = new Set(['requestVerification', 'proposeAnswer', 'concludeInconclusive']);
/** Kinds still open after `noveltyWindow` steps without novelty (AC-03.1). */
const WITHOUT_NOVELTY: ReadonlySet<DecisionKind> = new Set(['proposeAnswer', 'concludeInconclusive']);

/** Why a kind the configuration opens is closed at this step, or null when it is admissible. */
function limitOf(kind: DecisionKind, state: GateState): RejectionReason | null {
  if (state.replans >= state.limits.maxPlanRevisions && !AFTER_LAST_REPLAN.has(kind)) {
    return 'plan_revisions_exhausted';
  }
  if (state.stepsWithoutNovelty >= state.limits.noveltyWindow && !WITHOUT_NOVELTY.has(kind)) {
    return 'no_novelty';
  }
  if (kind === 'requestVerification' && state.verifyRounds >= state.limits.maxVerifyRounds) {
    return 'verify_rounds_exhausted';
  }
  if (TASK_CREATING_KINDS.has(kind) && state.msUntilNotAfter <= MIN_TASK_DEADLINE_MS) {
    return 'deadline_too_close';
  }
  if (kind === 'wait' && state.openTasks === 0) {
    return 'nothing_to_wait_for';
  }
  return null;
}

/** The decisions code admits at this step, in the order of the closed set (DecisionInput `admissible`). */
export function admissibleDecisions(state: GateState): DecisionKind[] {
  const opened = decisionsOpenedBy(state.capabilities);
  return DECISION_KINDS.filter((kind) => opened.has(kind) && limitOf(kind, state) === null);
}

/**
 * Invariant 6: a controller output becomes a decision only when its kind is in the closed set, the configuration enables
 * its capability (DC-1), its structure passes the schema, it stays within `maxFanOut` (DC-6) and the limits of this step
 * admit it. The checks run in that order, and the first failure is the reason.
 */
export function judgeDecision(output: unknown, state: GateState): GateVerdict {
  const rawKind = typeof output === 'object' && output !== null && 'kind' in output ? output.kind : undefined;
  if (typeof rawKind !== 'string' || !isDecisionKind(rawKind)) {
    return { verdict: 'rejected', reason: 'kind_unknown', kind: null };
  }
  const kind = rawKind;
  const rejected = (reason: RejectionReason): GateVerdict => ({ verdict: 'rejected', reason, kind });
  if (!decisionsOpenedBy(state.capabilities).has(kind)) {
    return rejected('capability_disabled');
  }
  const parsed = DecisionSchema.safeParse(output);
  if (!parsed.success) {
    return rejected('invalid_structure');
  }
  const decision = parsed.data;
  if (decision.kind === 'requestAnalysis' && decision.subquestions.length > state.limits.maxFanOut) {
    return rejected('fan_out_exceeded');
  }
  const limit = limitOf(kind, state);
  return limit === null ? { verdict: 'accepted', decision } : rejected(limit);
}
