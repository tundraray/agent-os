import { type Database, researchInvestigations, researchLlmCalls, researchLlmTranscripts } from '@agent-os/db';
import { and, asc, eq, gte, isNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TranscriptUsage } from './transcript-writes.js';

/**
 * How long a transcript is kept and read: a whole number of days (`TRANSCRIPT_RETENTION_DAYS` of the deployment), or
 * `no_term` for a database whose transcripts are kept without a term (scenario runs of the self-check, AC-01.5).
 */
export type TranscriptRetention = { readonly days: number } | 'no_term';

/**
 * How a transcript reads (design-self-check.md, Contract `Transcript`): the stored outcome of a closed call; `abandoned`
 * when the call's ledger row was closed `abandoned` before an answer; `open` while the call goes on.
 */
export type TranscriptOutcome = 'answered' | 'invalid_output' | 'provider_error' | 'abandoned' | 'open';

/** One model call attempt as a developer and the `engine` part read it (design-self-check.md, Contract `Transcript`). */
export interface Transcript {
  /** Equals the `research_llm_calls` row of a call inside an investigation. */
  readonly callId: string;
  /** Null for a call bound only to a self-check run. */
  readonly investigationId: string | null;
  /** Null for a call outside an investigation task (`Engine.assess`). */
  readonly taskId: string | null;
  readonly attempt: number | null;
  /** The self-check run that made a call outside a task; null for the calls of the roles. */
  readonly selfCheckRunId: string | null;
  /** A process role or `judge`, as stored. */
  readonly role: string;
  readonly model: string;
  readonly promptVersion: string;
  /** The instructions and the messages as sent to the provider, with their provider options. */
  readonly input: unknown;
  /** The response object and the finish reason; null until the call is closed, and for a provider error. */
  readonly response: unknown;
  readonly outcome: TranscriptOutcome;
  /** The tokens (cache reads and writes apart) and the cost; null until the call is closed. */
  readonly usage: TranscriptUsage | null;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
}

/**
 * What to read: the transcripts of an investigation for its owner (of one of its tasks when `taskId` is given), or the
 * transcripts of a self-check run's calls outside any investigation.
 */
export type TranscriptSelector =
  | { readonly investigationId: string; readonly ownerId: string; readonly taskId?: string }
  | { readonly selfCheckRunId: string };

export type ReadTranscriptsInput = TranscriptSelector & { readonly retention: TranscriptRetention };

export type ReadTranscriptsResult =
  | { readonly outcome: 'found'; readonly transcripts: readonly Transcript[] }
  | { readonly outcome: 'rejected'; readonly code: 'investigation_not_found' };

const NOT_FOUND: ReadTranscriptsResult = { outcome: 'rejected', code: 'investigation_not_found' };

const StoredOutcomeSchema = z.enum(['answered', 'invalid_output', 'provider_error']).nullable();
const isUuid = (value: string): boolean => z.uuid().safeParse(value).success;

/**
 * Reads transcripts over the database alone, without building an engine, in call order (creation time, ties by
 * `callId`). An investigation is read only by its owner: another owner, an absent or a deleted investigation answers
 * `investigation_not_found`. A self-check run reads only the transcripts bound to no investigation, so it never
 * reaches past the owner filter. A transcript older than the retention term is not returned even before the purge.
 */
export async function readTranscripts(db: Database, input: ReadTranscriptsInput): Promise<ReadTranscriptsResult> {
  const notExpired = retainedFilter(input.retention);
  if ('selfCheckRunId' in input) {
    return {
      outcome: 'found',
      transcripts: await selectTranscripts(
        db,
        and(eq(researchLlmTranscripts.selfCheckRunId, input.selfCheckRunId), isNull(researchLlmTranscripts.investigationId), notExpired),
      ),
    };
  }
  const { investigationId, ownerId, taskId } = input;
  if (!isUuid(investigationId)) {
    return NOT_FOUND;
  }
  const [owned] = await db
    .select({ investigationId: researchInvestigations.investigationId })
    .from(researchInvestigations)
    .where(and(eq(researchInvestigations.investigationId, investigationId), eq(researchInvestigations.resourceId, ownerId)));
  if (owned === undefined) {
    return NOT_FOUND;
  }
  if (taskId !== undefined && !isUuid(taskId)) {
    // No task of the investigation has such an id.
    return { outcome: 'found', transcripts: [] };
  }
  return {
    outcome: 'found',
    transcripts: await selectTranscripts(
      db,
      and(
        eq(researchLlmTranscripts.investigationId, investigationId),
        taskId === undefined ? undefined : eq(researchLlmTranscripts.taskId, taskId),
        notExpired,
      ),
    ),
  };
}

/** A transcript within the term, on the database clock; no condition without a term. */
function retainedFilter(retention: TranscriptRetention): SQL | undefined {
  return retention === 'no_term' ? undefined : gte(researchLlmTranscripts.createdAt, retentionCutoff(retention));
}

/**
 * The instant before which a transcript is past the term, on the database clock, which the read and the purge share.
 * Throws on a term that is not a whole number of days of at least 1: the settings parse it, so such a value is a defect
 * of the caller.
 */
export function retentionCutoff(retention: { readonly days: number }): SQL {
  if (!Number.isInteger(retention.days) || retention.days < 1) {
    throw new Error(`transcript retention must be a whole number of days of at least 1, got ${retention.days}`);
  }
  return sql`now() - make_interval(days => ${retention.days})`;
}

async function selectTranscripts(db: Database, where: SQL | undefined): Promise<Transcript[]> {
  const rows = await db
    .select({ transcript: researchLlmTranscripts, ledgerStatus: researchLlmCalls.status })
    .from(researchLlmTranscripts)
    .leftJoin(researchLlmCalls, eq(researchLlmCalls.callId, researchLlmTranscripts.llmCallId))
    .where(where)
    .orderBy(asc(researchLlmTranscripts.createdAt), asc(researchLlmTranscripts.callId));
  return rows.map(({ transcript, ledgerStatus }) => toTranscript(transcript, ledgerStatus));
}

function toTranscript(row: typeof researchLlmTranscripts.$inferSelect, ledgerStatus: string | null): Transcript {
  const stored = StoredOutcomeSchema.parse(row.outcome);
  // `abandoned` is never stored on the transcript: the ledger row of the call says it.
  const outcome: TranscriptOutcome = stored ?? (ledgerStatus === 'abandoned' ? 'abandoned' : 'open');
  return {
    callId: row.callId,
    investigationId: row.investigationId,
    taskId: row.taskId,
    attempt: row.attempt,
    selfCheckRunId: row.selfCheckRunId,
    role: row.role,
    model: row.model,
    promptVersion: row.promptVersion,
    input: row.input,
    response: row.response,
    outcome,
    usage:
      row.costUsd === null
        ? null
        : {
            inputTokens: row.inputTokens,
            cacheReadTokens: row.cacheReadTokens,
            cacheWriteTokens: row.cacheWriteTokens,
            outputTokens: row.outputTokens,
            costUsd: row.costUsd,
          },
    createdAt: row.createdAt,
    closedAt: row.closedAt,
  };
}
