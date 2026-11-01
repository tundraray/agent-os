import { z } from 'zod';

/** The parts of a claim code checks against source records (design-engine.md, Terms: atom). */
const ATOM_KINDS = ['traceId', 'service', 'event', 'interval', 'number'] as const;

/**
 * One atom as the model states it. The value is text in every kind — an interval as `start/end`, a number as written —
 * so the output schema stays a flat object for the native `json_schema` output; the verifier reads it by its kind.
 */
const AtomSchema = z.object({
  kind: z.enum(ATOM_KINDS),
  value: z.string().min(1),
});

/** A claim of a worker: its text, the atoms it asserts and the evidence it rests on. */
const WorkerClaimSchema = z.object({
  text: z.string().min(1),
  atoms: z.array(AtomSchema),
  evidenceIds: z.array(z.string()),
});
export type WorkerClaim = z.infer<typeof WorkerClaimSchema>;

/** What the `worker` role returns for its sub-question. */
export const WorkerOutputSchema = z.object({
  claims: z.array(WorkerClaimSchema),
});
