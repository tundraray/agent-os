/**
 * The first-error stage of an unsolved cause scenario (design-self-check.md, «Как находится этап первой ошибки»,
 * DC-16). Only trace identifiers, claim statuses, the answer's composition and the verdict code decide it; no model
 * text is read here.
 */

/** The stage label of each role, as the report shows it. */
export const FIRST_ERROR_STAGES = {
  controller: 'сбор — controller',
  worker: 'анализ — worker',
  verifier: 'проверка — verifier',
  synthesis: 'ответ — synthesis',
} as const;
export type FirstErrorRole = keyof typeof FIRST_ERROR_STAGES;
export type FirstErrorStage = (typeof FIRST_ERROR_STAGES)[FirstErrorRole];

/** The verdict codes of an unsolved cause scenario; «неясно» codes have no first-error stage. */
export type CauseFailureCode =
  | 'wrong_cause'
  | 'cause_not_established'
  | 'cause_not_grounded'
  | 'cause_not_linked';

/** An evidence page the run collected, with the `traceId` fields of its records. */
export interface EvidencePageTraces {
  readonly evidenceId: string;
  readonly traceIds: readonly string[];
}

/** A claim's latest revision: its status and the evidence pages it rests on. */
export interface FirstErrorClaim {
  readonly claimId: string;
  readonly status: string;
  readonly evidenceIds: readonly string[];
}

export interface FirstErrorRun {
  /** The trace identifiers of the key's evidence. */
  readonly keyTraceIds: readonly string[];
  readonly pages: readonly EvidencePageTraces[];
  readonly claims: readonly FirstErrorClaim[];
  /** The claims the answer places in «Установлено». */
  readonly establishedClaimIds: readonly string[];
  readonly verdict: CauseFailureCode;
}

export interface FirstError {
  readonly role: FirstErrorRole;
  readonly stage: FirstErrorStage;
}

/**
 * How far a claim advanced, highest first: supported before causal before the rest. Among the rest a claim that
 * went through the check (refuted, insufficient) advanced further than one that did not reach it (unverified).
 */
const ADVANCE_BY_STATUS: Readonly<Record<string, number>> = {
  supported: 3,
  causal: 2,
  refuted: 1,
  insufficient: 1,
  unverified: 0,
};

/** The stage of a furthest claim that is not supported; a supported claim goes on to the answer. */
const ROLE_BY_STATUS: Readonly<Partial<Record<string, FirstErrorRole>>> = {
  causal: 'worker',
  refuted: 'verifier',
  insufficient: 'verifier',
  unverified: 'controller',
};

/** The last branch: a supported claim stands in «Установлено» and the run still failed. */
const ROLE_BY_VERDICT: Readonly<Record<CauseFailureCode, FirstErrorRole>> = {
  wrong_cause: 'verifier',
  cause_not_grounded: 'worker',
  cause_not_established: 'worker',
  cause_not_linked: 'synthesis',
};

/** The role and stage where the key's evidence was first lost in an unsolved cause scenario (DC-16). */
export function findFirstError(run: FirstErrorRun): FirstError {
  const role = firstErrorRole(run);
  return { role, stage: FIRST_ERROR_STAGES[role] };
}

/** The first-error count of each role over a launch's unsolved cause runs; every role is present. */
export function countFirstErrorsByRole(
  roles: readonly FirstErrorRole[],
): Record<FirstErrorRole, number> {
  const counts: Record<FirstErrorRole, number> = {
    controller: 0,
    worker: 0,
    verifier: 0,
    synthesis: 0,
  };
  for (const role of roles) {
    counts[role] += 1;
  }
  return counts;
}

function firstErrorRole(run: FirstErrorRun): FirstErrorRole {
  const keyTraces = new Set(run.keyTraceIds);
  const keyPages = new Set(
    run.pages
      .filter((page) => page.traceIds.some((traceId) => keyTraces.has(traceId)))
      .map((page) => page.evidenceId),
  );
  if (keyPages.size === 0) {
    return 'controller';
  }
  const citing = run.claims.filter((claim) =>
    claim.evidenceIds.some((evidenceId) => keyPages.has(evidenceId)),
  );
  if (citing.length === 0) {
    return 'worker';
  }
  const established = new Set(run.establishedClaimIds);
  const ranked = citing.map((claim) => ({
    claim,
    advance: advanceOf(claim, established),
  }));
  const { claim: furthest } = ranked.reduce((best, next) =>
    next.advance > best.advance ? next : best,
  );
  const statusRole = ROLE_BY_STATUS[furthest.status];
  if (statusRole !== undefined) {
    return statusRole;
  }
  if (!established.has(furthest.claimId)) {
    return 'synthesis';
  }
  return ROLE_BY_VERDICT[run.verdict];
}

/** A supported claim in «Установлено» advanced further than a supported claim the answer left out of it. */
function advanceOf(
  claim: FirstErrorClaim,
  established: ReadonlySet<string>,
): number {
  const advance = ADVANCE_BY_STATUS[claim.status];
  if (advance === undefined) {
    throw new Error(
      `claim ${claim.claimId} has status ${claim.status}, which the first-error scheme does not know`,
    );
  }
  return advance * 2 + (established.has(claim.claimId) ? 1 : 0);
}
