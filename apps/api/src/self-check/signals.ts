import type { RunRecord } from '@agent-os/engine';
import type { FormCheckResult } from './judge/form-check.js';
import type { UnkeyedJudgeForm } from './judge/judge-forms.js';
import type { SelfCheckSettings } from './settings.js';

/**
 * The four failure signals of an investigation without a key (design-self-check.md, «Как считаются сигналы сбоя»,
 * DC-15). Each is a rule over the judge form's closed value, claim statuses, claim identifiers and decision statuses;
 * no model text is read here.
 */

/** What the signals read of a run record. */
export type SignalRun = Pick<RunRecord, 'answer' | 'claims' | 'decisions'>;

type StopReason = NonNullable<RunRecord['answer']>['stopReason'];

export interface SignalInput {
  readonly run: SignalRun;
  /** The checked form of the judge without a key; null only when the investigation has no answer and no judge ran. */
  readonly judge: FormCheckResult<UnkeyedJudgeForm> | null;
  readonly thresholds: SelfCheckSettings['signals'];
}

export interface FailureSignals {
  /** Null when the investigation has no answer: the judge is not called and the signal is not set. */
  readonly lowJudgeScore: {
    readonly fired: boolean;
    /** Null when the form broke the rules or the judge was unavailable. */
    readonly answersQuestion: UnkeyedJudgeForm['answersQuestion'] | null;
    readonly judgeInvalid: boolean;
  } | null;
  readonly discardedClaims: {
    readonly fired: boolean;
    readonly discarded: number;
    readonly total: number;
    /** Null when the investigation has no claims. */
    readonly share: number | null;
  };
  readonly controllerRejections: {
    readonly fired: boolean;
    readonly rejected: number;
  };
  readonly stopReason: {
    readonly fired: boolean;
    readonly stopReason: StopReason;
  };
}

/** Statuses of a latest revision that the check discarded; `causal` passed the check, `unverified` never reached it. */
export const DISCARDED_STATUSES: ReadonlySet<string> = new Set([
  'refuted',
  'insufficient',
]);

/** The four failure signals of one investigation; a signal fires at or above its threshold. */
export function failureSignals({
  run,
  judge,
  thresholds,
}: SignalInput): FailureSignals {
  const stopReason = run.answer?.stopReason ?? null;
  const rejected = run.decisions.filter(
    (decision) => decision.status === 'rejected',
  ).length;
  return {
    lowJudgeScore: lowJudgeScore(run.answer !== null, judge),
    discardedClaims: discardedClaims(run, thresholds.discardedShare),
    controllerRejections: {
      fired: rejected >= thresholds.controllerRejections,
      rejected,
    },
    stopReason: { fired: stopReason !== null, stopReason },
  };
}

/** The signal is `no` or a form not by the rules (`judge_invalid`); it is not set without an answer. */
function lowJudgeScore(
  answered: boolean,
  judge: SignalInput['judge'],
): FailureSignals['lowJudgeScore'] {
  if (!answered) return null;
  if (judge === null) {
    throw new Error(
      'the low judge score needs the judge result of an answered investigation',
    );
  }
  if (!judge.valid)
    return { fired: true, answersQuestion: null, judgeInvalid: true };
  const { answersQuestion } = judge.form;
  return {
    fired: answersQuestion === 'no',
    answersQuestion,
    judgeInvalid: false,
  };
}

/**
 * Discarded: a claim whose latest revision is `refuted` or `insufficient` in any answer section, or a claim the answer
 * gateway removed. A removed new draft claim has no revision, so it joins the denominator as well; each claim
 * identifier counts once.
 */
function discardedClaims(
  run: SignalRun,
  threshold: number,
): FailureSignals['discardedClaims'] {
  const removedIds = new Set(
    (run.answer?.removed ?? []).map((claim) => claim.claimId),
  );
  const allIds = new Set([
    ...run.claims.map((claim) => claim.claimId),
    ...removedIds,
  ]);
  const discardedIds = new Set([
    ...run.claims
      .filter((claim) => DISCARDED_STATUSES.has(claim.status))
      .map((claim) => claim.claimId),
    ...removedIds,
  ]);
  const total = allIds.size;
  const discarded = discardedIds.size;
  const share = total === 0 ? null : discarded / total;
  return {
    fired: share !== null && share >= threshold,
    discarded,
    total,
    share,
  };
}
