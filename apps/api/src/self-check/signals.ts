import {
  type AgentTree,
  checkedClaimOf,
  checkerCallEnd,
  type RunRecord,
} from '@agent-os/engine';
import { z } from 'zod';
import type { FormCheckResult } from './judge/form-check.js';
import type { UnkeyedJudgeForm } from './judge/judge-forms.js';
import type { SelfCheckSettings } from './settings.js';

/**
 * The four failure signals of an investigation without a key (design-self-check.md, «Как считаются сигналы сбоя»,
 * DC-15; design-research-flow.md, «Сигналы сбоя v3», KD-6). Each is a rule over the judge form's closed value, claim
 * statuses, claim identifiers and the codes of refused calls; no model text is read here.
 */

/** What the signals read of a run record. */
export type SignalRun = Pick<RunRecord, 'answer' | 'claims' | 'agentTree'>;

type StopReason = NonNullable<RunRecord['answer']>['stopReason'];

export interface SignalInput {
  readonly run: SignalRun;
  /** The checked form of the judge without a key; null only when the investigation has no answer and no judge ran. */
  readonly judge: FormCheckResult<UnkeyedJudgeForm> | null;
  readonly thresholds: SelfCheckSettings['signals'];
}

interface RejectionCount {
  readonly fired: boolean;
  readonly rejected: number;
}

interface CommonSignals {
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
  readonly stopReason: {
    readonly fired: boolean;
    readonly stopReason: StopReason;
  };
}

/** The signals of a run: the common three and the refused calls of its tree. */
export type FailureSignals = CommonSignals & {
  readonly rejectedCalls: RejectionCount;
};

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
  const common: CommonSignals = {
    lowJudgeScore: lowJudgeScore(run.answer !== null, judge),
    discardedClaims: discardedClaims(run, thresholds.discardedShare),
    stopReason: { fired: stopReason !== null, stopReason },
  };
  const rejected = rejectedCalls(run.agentTree).filter(countsAsFault).length;
  return {
    ...common,
    rejectedCalls: { fired: rejected >= thresholds.rejectedCalls, rejected },
  };
}

/** A call of the tree the code refused. */
export interface RejectedCall {
  readonly agent: string;
  readonly tool: string;
  readonly reason: string | null;
}

/** A refused `finish`: the closure's reason is in the outcome; the row's own `reason` is always `invalid_result`. */
const RefusedFinishOutcomeSchema = z.object({
  detail: z.object({ reason: z.string() }),
});

/**
 * Every refused call of the tree, with the closure's reason for a `finish`. A failed child is not here: its call ended
 * `done` with `child_failed`, and the failure is seen in the tree.
 */
export function rejectedCalls(tree: AgentTree): RejectedCall[] {
  return tree.runs.flatMap((run) =>
    run.toolCalls.flatMap((call) => {
      if (call.state !== 'rejected') return [];
      const closure =
        call.toolName === 'finish'
          ? RefusedFinishOutcomeSchema.safeParse(call.outcome).data?.detail
              .reason
          : undefined;
      return [
        {
          agent: run.agentName,
          tool: call.toolName,
          reason: closure ?? call.reason,
        },
      ];
    }),
  );
}

/** `needs_verification` is a step of the closing protocol, not an agent's error; every other refusal is one. */
const countsAsFault = ({ tool, reason }: RejectedCall): boolean =>
  !(tool === 'finish' && reason === 'needs_verification');

const AgentFormsSchema = z.object({
  agents: z.record(z.string(), z.object({ result: z.string() })),
});

export interface UnverifiedByRefusalInput {
  readonly claims: RunRecord['claims'];
  readonly agentTree: AgentTree;
  readonly processConfig: unknown;
}

/**
 * Claims that stayed `unverified` after a call of the checker ended without checking them: refused for the budget, the
 * number of children or tasks, or a run that failed (design-research-flow.md, «Утверждения без проверки из-за отказов»),
 * by the rule gate 2 of `research_close` reads (`checkerCallEnd`). Not a signal: it explains why a conclusion stands in
 * «Предположения».
 */
export function unverifiedByRefusal({
  claims,
  agentTree,
  processConfig,
}: UnverifiedByRefusalInput): RunRecord['claims'][number][] {
  const { agents } = AgentFormsSchema.parse(processConfig);
  const refused = new Set(
    agentTree.runs.flatMap((run) =>
      run.toolCalls.flatMap((call) => {
        const claimId = checkedClaimOf(call, agents);
        return claimId !== null && checkerCallEnd(call) === 'unchecked'
          ? [claimId]
          : [];
      }),
    ),
  );
  return claims.filter(
    (claim) => claim.status === 'unverified' && refused.has(claim.claimId),
  );
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
