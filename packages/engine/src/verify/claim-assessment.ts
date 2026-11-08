import { z } from 'zod';

/**
 * What the `verifier` role returns for one claim (design-engine.md, Contract Definitions, «Вывод verifier —
 * ClaimAssessment»): whether the given records support the claim's meaning, its type, and for each given record its
 * number in the input and its relation to the claim. Every object is closed. The record number stays a plain number
 * in the schema (an integer adds bounds the native `json_schema` output does not need); `decideClaim` refuses a number
 * that was not in the input.
 */
export const ClaimAssessmentSchema = z.strictObject({
  support: z.enum(['yes', 'no', 'insufficient']),
  claimType: z.enum(['observation', 'quantitative', 'causal']),
  records: z.array(
    z.strictObject({
      record: z.number(),
      relation: z.enum(['supports', 'contradicts', 'unrelated']),
    }),
  ),
});
export type ClaimAssessment = z.infer<typeof ClaimAssessmentSchema>;
export type ClaimType = ClaimAssessment['claimType'];

/**
 * The profile of an established claim (KD-3): four features with two values each, the key of the group table. A causal
 * claim is never established, so its type is not a profile value.
 */
export const ClaimProfileSchema = z.strictObject({
  claimType: z.enum(['observation', 'quantitative']),
  /** The result of `checkAtoms`: every atom found, one missing or contradicted, or no atoms; it never sets the status. */
  valueCheck: z.enum(['matched', 'unmatched', 'not_applicable']),
  /** Records marked `supports`; records with one `traceId` count once, a record without `traceId` on its own. */
  independentRecords: z.enum(['one', 'two_or_more']),
  /** Whether the assessment marked any record `contradicts`. */
  contradictions: z.boolean(),
});
export type ClaimProfile = z.infer<typeof ClaimProfileSchema>;
