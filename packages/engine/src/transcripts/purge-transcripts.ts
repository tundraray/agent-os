import { type Database, researchLlmTranscripts } from '@agent-os/db';
import { lt } from 'drizzle-orm';
import { retentionCutoff, type TranscriptRetention } from './read-transcripts.js';

/**
 * Deletes the transcripts older than the retention term and returns their number (design-self-check.md, Contract
 * `purgeExpiredTranscripts`). Only transcripts go: the `research_llm_calls` journal with its spend stays. With
 * `no_term` nothing is deleted.
 */
export async function purgeExpiredTranscripts(db: Database, retention: TranscriptRetention): Promise<number> {
  if (retention === 'no_term') {
    return 0;
  }
  const purged = await db
    .delete(researchLlmTranscripts)
    .where(lt(researchLlmTranscripts.createdAt, retentionCutoff(retention)))
    .returning({ callId: researchLlmTranscripts.callId });
  return purged.length;
}
