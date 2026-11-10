import { type ResearchAnswerConfidence, ResearchAnswerConfidenceSchema } from '@agent-os/contracts';
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

/** Most items the summary of an answer holds (design-engine.md, Runtime settings). */
export const SUMMARY_ITEMS_MAX = 3;

const AnswerClaimSchema = z.object({
  claimId: z.uuid(),
  text: z.string(),
  /** Of an established claim: the basis of its check, never the pages a draft named (DC-4). */
  evidenceIds: z.array(z.uuid()),
  verified: z.boolean(),
});

/**
 * The answer of an investigation as stored in `research_engine_runs.answer` (design-engine.md, InvestigationView
 * `answer`, Data Model «Ответ движка»). An answer written before agent-quality reads with the same schema: no summary
 * items, no group, no causal flag. `summary` is the summary string of those answers only; it is null in every answer
 * written since — the summary is `summaryItems`, built by code from accepted claims (KD-4).
 */
export const InvestigationAnswerSchema = z.object({
  answerId: z.uuid(),
  outcome: z.enum(['answered', 'partial', 'inconclusive']),
  stopReason: z.enum(STOP_REASONS).nullable(),
  summary: z.string().nullable(),
  /** Empty: no summary. Each item is the stored text and group of a claim established in this answer (DC-12). */
  summaryItems: z
    .array(z.object({ claimId: z.uuid(), text: z.string(), confidence: ResearchAnswerConfidenceSchema }))
    .max(SUMMARY_ITEMS_MAX)
    .default([]),
  /** `confidence` is the group of the claim's `supported` revision. */
  established: z.array(AnswerClaimSchema.extend({ confidence: ResearchAnswerConfidenceSchema.nullable().default(null) })),
  /** `causal` marks a claim whose check found it causal; it is verified, so `verified` is true with it. */
  assumed: z.array(AnswerClaimSchema.extend({ causal: z.boolean().default(false) })),
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
  /** The group of a `supported` revision; null for every other status. */
  readonly confidence: ResearchAnswerConfidence | null;
}

export type CodeAnswerEnd =
  /** A forced stop (Flow 2). */
  | { readonly stopReason: StopReason }
  /** The controller accepted `concludeInconclusive`: not a stop, the investigation itself is inconclusive. */
  | { readonly concluded: true };

/**
 * The answer code builds without a model call (KD-6, FR-09): the `supported` claims as established with their stored
 * basis and group — a `causal` claim is never established (invariant 2). No model chose summary items, so there are
 * none (AC-16.4). A forced stop is `partial` when at least one claim is supported and `inconclusive` otherwise; a concluded
 * investigation is `inconclusive` with no stop reason.
 */
export function buildCodeAnswer(answerId: string, claims: readonly LatestClaim[], end: CodeAnswerEnd): InvestigationAnswer {
  const established = claims
    .filter((claim) => claim.status === 'supported')
    .map((claim) => ({
      claimId: claim.claimId,
      text: claim.text,
      evidenceIds: [...claim.evidenceIds],
      verified: true,
      confidence: claim.confidence,
    }));
  const stopReason = 'stopReason' in end ? end.stopReason : null;
  return {
    answerId,
    outcome: stopReason !== null && established.length > 0 ? 'partial' : 'inconclusive',
    stopReason,
    summary: null,
    summaryItems: [],
    established,
    assumed: [],
    unknown: [],
    removed: [],
  };
}
