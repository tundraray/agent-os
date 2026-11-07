import { z } from 'zod';
import { type Pointer, PointerSchema } from '../verify/pointer.js';

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

/**
 * A claim of a worker: its text, the atoms it asserts and the pointer to the records it rests on (KD-1, contract
 * «Вывод `worker`»). The claim's pages are the pages of its pointer; there is no separate list of evidence ids.
 */
const WorkerClaimSchema = z.object({
  text: z.string().min(1),
  atoms: z.array(AtomSchema),
  pointer: PointerSchema.describe(
    'The records the claim rests on, 1 to 20 in all, grouped by page: the page id and the numbers of its records from 0',
  ),
});
export type WorkerClaim = z.infer<typeof WorkerClaimSchema>;

/** What the `worker` role returns for its sub-question. */
export const WorkerOutputSchema = z.object({
  claims: z.array(WorkerClaimSchema),
});

/** The pages a pointer names, in pointer order and without repeats: the pages of the claim. */
export function pointerPages(pointer: Pointer): string[] {
  return [...new Set(pointer.map((entry) => entry.pageId))];
}
