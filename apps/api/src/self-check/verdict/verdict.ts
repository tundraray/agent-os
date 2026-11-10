import type { ScenarioKey } from '@agent-os/mcp-fixture';
import type { FormCheckResult } from '../judge/form-check.js';
import type { JudgedAnswer, KeyedJudgeForm } from '../judge/judge-forms.js';

/** The verdict reason codes of a run (design-self-check.md, «Что видно в отчёте»). */
export type VerdictReason =
  | 'no_answer'
  | 'timeout'
  | 'judge_invalid'
  | 'wrong_cause'
  | 'cause_invented'
  | 'cause_not_established'
  | 'cause_not_grounded'
  | 'cause_not_linked'
  | 'passed';

export type Verdict =
  | { readonly verdict: 'passed'; readonly reason: 'passed' }
  | {
      readonly verdict: 'failed';
      readonly reason: Exclude<
        VerdictReason,
        'passed' | 'no_answer' | 'timeout' | 'judge_invalid'
      >;
    }
  | {
      readonly verdict: 'unclear';
      readonly reason: 'no_answer' | 'timeout' | 'judge_invalid';
    };

export type VerdictInput =
  /** The run ended without an answer: it gets its verdict before the judge (DC-9). */
  | { readonly answer: null }
  | {
      readonly answer: JudgedAnswer;
      /** The judge form after `checkKeyedForm` over the same answer and scenario kind. */
      readonly form: FormCheckResult<KeyedJudgeForm>;
      readonly key: Pick<ScenarioKey, 'kind' | 'causeTraceIds'>;
      /** The `traceId` fields of the records of each evidence page, by evidence id. */
      readonly pageTraceIds: ReadonlyMap<string, readonly string[]>;
    };

const failed = (reason: Extract<Verdict, { verdict: 'failed' }>['reason']) =>
  ({ verdict: 'failed', reason }) as const;
const PASSED = { verdict: 'passed', reason: 'passed' } as const;

/**
 * The verdict ladder of a scenario run (design-self-check.md, «Как выносится вердикт сценария», DC-11). It reads only
 * the checked form's fields, the scenario kind and identifiers: the change claims are grounded when one of them cites a
 * page whose records carry a trace from the key's proof.
 */
export function scenarioVerdict(input: VerdictInput): Verdict {
  if (input.answer === null) {
    return { verdict: 'unclear', reason: 'no_answer' };
  }
  const { answer, form: checked, key, pageTraceIds } = input;
  if (!checked.valid) {
    return { verdict: 'unclear', reason: 'judge_invalid' };
  }
  const form = checked.form;
  if (form.otherCauseEstablished === 'yes') {
    return failed(key.kind === 'no_cause' ? 'cause_invented' : 'wrong_cause');
  }
  if (key.kind === 'no_cause') {
    return PASSED;
  }
  if (form.causeChange !== 'established') {
    return failed('cause_not_established');
  }
  if (!citesKeyTrace(form.causeChangeClaimIds, answer, key, pageTraceIds)) {
    return failed('cause_not_grounded');
  }
  if (form.causeLink !== 'established' && form.causeLink !== 'assumed') {
    return failed('cause_not_linked');
  }
  return PASSED;
}

/** Whether at least one of the established claims cites a page with a record from the key's proof. */
function citesKeyTrace(
  claimIds: readonly string[],
  answer: JudgedAnswer,
  key: Pick<ScenarioKey, 'causeTraceIds'>,
  pageTraceIds: ReadonlyMap<string, readonly string[]>,
): boolean {
  const named = new Set(claimIds);
  return citesTrace(
    (answer.established ?? []).filter((claim) => named.has(claim.claimId)),
    key.causeTraceIds,
    pageTraceIds,
  );
}

/** Whether at least one of the claims cites a page holding a record of the traces. */
export function citesTrace(
  claims: readonly { readonly evidenceIds: readonly string[] }[],
  traceIds: readonly string[],
  pageTraceIds: ReadonlyMap<string, readonly string[]>,
): boolean {
  const wanted = new Set(traceIds);
  return claims.some((claim) =>
    claim.evidenceIds.some((evidenceId) =>
      tracesOf(evidenceId, pageTraceIds).some((traceId) => wanted.has(traceId)),
    ),
  );
}

/** A cited page the caller did not read is a defect of the caller, not a page without key traces. */
function tracesOf(
  evidenceId: string,
  pageTraceIds: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const traces = pageTraceIds.get(evidenceId);
  if (traces === undefined) {
    throw new Error(`no trace ids were read for evidence page ${evidenceId}`);
  }
  return traces;
}
