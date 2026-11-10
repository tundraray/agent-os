import { type AgentTree, claimWritingAgents } from '@agent-os/engine';
import { z } from 'zod';

/**
 * The first-error stage of an unsolved cause scenario (design-self-check.md, «Как находится этап первой ошибки»,
 * DC-16; design-research-flow.md, «Этап первой ошибки v3», DC-12). Only trace identifiers, claim statuses, the answer's
 * composition, the verdict code and who wrote a claim decide it; no model text is read here.
 */

/** The stage label of each role, as the report shows it. */
export const FIRST_ERROR_STAGES = {
  controller: 'сбор — controller',
  worker: 'анализ — worker',
  subworker: 'анализ — subworker',
  verifier: 'проверка — verifier',
  synthesis: 'ответ — synthesis',
} as const;
export type FirstErrorRole = keyof typeof FIRST_ERROR_STAGES;
export type FirstErrorStage = (typeof FIRST_ERROR_STAGES)[FirstErrorRole];
/** The four roles a run's summary counts: a subworker's error is a worker's. */
export type FirstErrorSummaryRole = Exclude<FirstErrorRole, 'subworker'>;
type ClaimAuthor = 'worker' | 'subworker';

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
  /** The analyst whose run wrote the claim; left out for a claim no `claims_write` wrote, where analysis is the worker's. */
  readonly author?: ClaimAuthor | undefined;
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
): Record<FirstErrorSummaryRole, number> {
  const counts: Record<FirstErrorSummaryRole, number> = {
    controller: 0,
    worker: 0,
    verifier: 0,
    synthesis: 0,
  };
  for (const role of roles) {
    counts[role === 'subworker' ? 'worker' : role] += 1;
  }
  return counts;
}

const ClaimsWriteOutcomeSchema = z.object({
  result: z.object({ claimIds: z.array(z.string()) }),
});

const AnalystDefinitionsSchema = z.object({
  agents: z.record(z.string(), z.object({ tools: z.array(z.string()) })),
});

/**
 * Who wrote each claim, by the `claims_write` calls of the analysts' runs: an analyst is a run whose frozen definition
 * has `claims_write`, and one called by another analyst is the subworker; no agent name decides. A claim the root
 * writes when it closes has no such call: analysis is then the worker's place.
 */
export function claimAuthors(
  tree: AgentTree,
  processConfig: unknown,
): Map<string, ClaimAuthor> {
  const analysts = claimWritingAgents(
    AnalystDefinitionsSchema.parse(processConfig).agents,
  );
  const agentOfRun = new Map(
    tree.runs.map((run) => [run.runTaskId, run.agentName]),
  );
  const authors = new Map<string, ClaimAuthor>();
  for (const run of tree.runs) {
    if (!analysts.has(run.agentName)) continue;
    const caller =
      run.parent === null ? undefined : agentOfRun.get(run.parent.taskId);
    const author =
      caller !== undefined && analysts.has(caller) ? 'subworker' : 'worker';
    for (const call of run.toolCalls) {
      if (call.toolName !== 'claims_write' || call.state !== 'done') continue;
      const outcome = ClaimsWriteOutcomeSchema.parse(call.outcome);
      for (const claimId of outcome.result.claimIds) {
        authors.set(claimId, author);
      }
    }
  }
  return authors;
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
  const role =
    ROLE_BY_STATUS[furthest.status] ??
    (established.has(furthest.claimId)
      ? ROLE_BY_VERDICT[run.verdict]
      : 'synthesis');
  return role === 'worker' ? (furthest.author ?? 'worker') : role;
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
