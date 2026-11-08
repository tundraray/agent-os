import { type Database, researchInvestigations, researchLlmTranscripts } from '@agent-os/db';
import { and, inArray, lt, ne } from 'drizzle-orm';
import { retentionCutoff, type TranscriptRetention } from './read-transcripts.js';

/**
 * Deletes the transcripts older than the retention term that are bound to an investigation of an owner other than
 * `keptOwnerId`, and returns their number (design-self-check.md, Contract `purgeExpiredTranscripts`, AC-01.5). The
 * transcripts of `keptOwnerId`'s investigations and of calls outside any investigation stay whatever their age. Only
 * transcripts go: the `research_llm_calls` journal with its spend stays. With `no_term` nothing is deleted.
 */
export async function purgeExpiredTranscripts(
  db: Database,
  retention: TranscriptRetention,
  keptOwnerId: string,
): Promise<number> {
  if (retention === 'no_term') {
    return 0;
  }
  const otherOwners = db
    .select({ investigationId: researchInvestigations.investigationId })
    .from(researchInvestigations)
    .where(ne(researchInvestigations.resourceId, keptOwnerId));
  const purged = await db
    .delete(researchLlmTranscripts)
    .where(
      and(
        lt(researchLlmTranscripts.createdAt, retentionCutoff(retention)),
        inArray(researchLlmTranscripts.investigationId, otherOwners),
      ),
    )
    .returning({ callId: researchLlmTranscripts.callId });
  return purged.length;
}
