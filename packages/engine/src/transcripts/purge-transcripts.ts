import {
  type Database,
  researchAgentMessages,
  researchAgentRuns,
  researchInvestigations,
  researchLlmTranscripts,
} from '@agent-os/db';
import { and, inArray, lt, ne, sql } from 'drizzle-orm';
import { retentionCutoff, type TranscriptRetention } from './read-transcripts.js';

/** An investigation in one of these is closed: its runs make no new turn, so their sessions may go. */
const CLOSED_STATUSES = ['completed', 'failed', 'cancelled'];

/**
 * Deletes the transcripts older than the retention term that are bound to an investigation of an owner other than
 * `keptOwnerId`, and returns their number (design-self-check.md, Contract `purgeExpiredTranscripts`, AC-01.5). The
 * transcripts of `keptOwnerId`'s investigations and of calls outside any investigation stay whatever their age. Only
 * transcripts go: the `research_llm_calls` journal with its spend stays. With `no_term` nothing is deleted.
 *
 * Before them it deletes the session messages of agent runs of closed investigations of the same owners
 * (design-agent-core.md, KD-2, «Чистка сессий»): a run's session goes once the newest transcript of its turns is past
 * the term — so a transcript that is still read always has its session — and a run without a transcript once the term
 * has passed since its investigation closed.
 */
export async function purgeExpiredTranscripts(
  db: Database,
  retention: TranscriptRetention,
  keptOwnerId: string,
): Promise<number> {
  if (retention === 'no_term') {
    return 0;
  }
  const cutoff = retentionCutoff(retention);
  const expiredRuns = db
    .select({ taskId: researchAgentRuns.taskId })
    .from(researchAgentRuns)
    .innerJoin(researchInvestigations, sql`${researchInvestigations.investigationId} = ${researchAgentRuns.investigationId}`)
    .where(
      and(
        ne(researchInvestigations.resourceId, keptOwnerId),
        inArray(researchInvestigations.status, CLOSED_STATUSES),
        sql`coalesce(
          (select max(${researchLlmTranscripts.createdAt}) from ${researchLlmTranscripts}
            where ${researchLlmTranscripts.taskId} = ${researchAgentRuns.taskId}),
          ${researchInvestigations.updatedAt}
        ) < ${cutoff}`,
      ),
    );
  await db.delete(researchAgentMessages).where(inArray(researchAgentMessages.runTaskId, expiredRuns));

  const otherOwners = db
    .select({ investigationId: researchInvestigations.investigationId })
    .from(researchInvestigations)
    .where(ne(researchInvestigations.resourceId, keptOwnerId));
  const purged = await db
    .delete(researchLlmTranscripts)
    .where(
      and(
        lt(researchLlmTranscripts.createdAt, cutoff),
        inArray(researchLlmTranscripts.investigationId, otherOwners),
      ),
    )
    .returning({ callId: researchLlmTranscripts.callId });
  return purged.length;
}
