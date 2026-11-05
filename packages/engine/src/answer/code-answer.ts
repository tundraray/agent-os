import { z } from 'zod';

/** Why the engine ended an investigation by force (design-engine.md, InvestigationView `stopReason`). */
export const STOP_REASONS = [
  'budget_exhausted',
  'step_limit',
  'controller_invalid',
  'model_unavailable',
  'deadline',
  'context_overflow',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

const AnswerClaimSchema = z.object({
  claimId: z.uuid(),
  text: z.string(),
  evidenceIds: z.array(z.uuid()),
  verified: z.boolean(),
});

/**
 * The answer of an investigation as stored in `research_engine_runs.answer` (design-engine.md, InvestigationView
 * `answer`). `summary` is null in an answer built by code: no model wrote it.
 */
export const InvestigationAnswerSchema = z.object({
  answerId: z.uuid(),
  outcome: z.enum(['answered', 'partial', 'inconclusive']),
  stopReason: z.enum(STOP_REASONS).nullable(),
  summary: z.string().nullable(),
  established: z.array(AnswerClaimSchema),
  assumed: z.array(AnswerClaimSchema),
  unknown: z.array(AnswerClaimSchema),
  removed: z.array(z.object({ claimId: z.uuid(), text: z.string(), reason: z.string() })),
});
export type InvestigationAnswer = z.infer<typeof InvestigationAnswerSchema>;

/** The latest revision of a claim, as the code answer reads it. */
export interface LatestClaim {
  readonly claimId: string;
  readonly text: string;
  readonly evidenceIds: readonly string[];
  readonly status: string;
}

export type CodeAnswerEnd =
  /** A forced stop (Flow 2). */
  | { readonly stopReason: StopReason }
  /** The controller accepted `concludeInconclusive`: not a stop, the investigation itself is inconclusive. */
  | { readonly concluded: true };

/**
 * The answer code builds without a model call (KD-6, FR-09): the `supported` claims as established with their
 * evidence. A forced stop is `partial` when at least one claim is supported and `inconclusive` otherwise; a concluded
 * investigation is `inconclusive` with no stop reason.
 */
export function buildCodeAnswer(answerId: string, claims: readonly LatestClaim[], end: CodeAnswerEnd): InvestigationAnswer {
  const established = claims
    .filter((claim) => claim.status === 'supported')
    .map((claim) => ({ claimId: claim.claimId, text: claim.text, evidenceIds: [...claim.evidenceIds], verified: true }));
  const stopReason = 'stopReason' in end ? end.stopReason : null;
  return {
    answerId,
    outcome: stopReason !== null && established.length > 0 ? 'partial' : 'inconclusive',
    stopReason,
    summary: null,
    established,
    assumed: [],
    unknown: [],
    removed: [],
  };
}
