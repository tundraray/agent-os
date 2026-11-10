import { researchAgentMemory, researchAgentRuns, researchClaims, researchEvidence } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

/**
 * A reference to data of an investigation (design-agent-core.md, DC-4): a note by its number, a claim, a record (an
 * evidence page) or an agent run by its task. A note's id is its number as a digit string, as the `text` form carries it.
 */
export interface InvestigationRef {
  readonly type: 'note' | 'claim' | 'record' | 'run';
  readonly id: string;
}

const isUuid = (id: string): boolean => z.uuid().safeParse(id).success;
/** A note number: a positive integer within `Number.MAX_SAFE_INTEGER`, written without leading zeros. */
const NOTE_NUMBER = /^[1-9]\d{0,14}$/;

/** Distinct ids of one reference type. */
const idsOf = (refs: readonly InvestigationRef[], type: InvestigationRef['type']): string[] => [
  ...new Set(refs.filter((ref) => ref.type === type).map((ref) => ref.id)),
];

/** How many of `ids` the investigation has in one table: each reference type is one lookup. */
async function countOwn(
  tx: RuntimeTx,
  investigationId: string,
  type: InvestigationRef['type'],
  ids: readonly string[],
): Promise<number> {
  switch (type) {
    case 'record':
      return (
        await tx
          .select({ id: researchEvidence.evidenceId })
          .from(researchEvidence)
          .where(and(eq(researchEvidence.investigationId, investigationId), inArray(researchEvidence.evidenceId, [...ids])))
      ).length;
    case 'claim':
      return (
        await tx
          .selectDistinct({ id: researchClaims.claimId })
          .from(researchClaims)
          .where(and(eq(researchClaims.investigationId, investigationId), inArray(researchClaims.claimId, [...ids])))
      ).length;
    case 'run':
      return (
        await tx
          .select({ id: researchAgentRuns.taskId })
          .from(researchAgentRuns)
          .where(and(eq(researchAgentRuns.investigationId, investigationId), inArray(researchAgentRuns.taskId, [...ids])))
      ).length;
    case 'note':
      return (
        await tx
          .select({ seq: researchAgentMemory.seq })
          .from(researchAgentMemory)
          .where(
            and(eq(researchAgentMemory.investigationId, investigationId), inArray(researchAgentMemory.seq, ids.map(Number))),
          )
      ).length;
  }
}

const TYPES: readonly InvestigationRef['type'][] = ['note', 'claim', 'record', 'run'];

/**
 * Whether every reference leads to data of this investigation (DC-4), read inside the caller's guarded transaction. An
 * id of another investigation, an id that leads nowhere and an id of the wrong shape are the same refusal.
 */
export async function refsBelong(
  tx: RuntimeTx,
  investigationId: string,
  refs: readonly InvestigationRef[],
): Promise<boolean> {
  for (const type of TYPES) {
    const ids = idsOf(refs, type);
    if (ids.length === 0) continue;
    if (!ids.every((id) => (type === 'note' ? NOTE_NUMBER.test(id) : isUuid(id)))) return false;
    if ((await countOwn(tx, investigationId, type, ids)) !== ids.length) return false;
  }
  return true;
}
