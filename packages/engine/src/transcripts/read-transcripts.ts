import { type Database, researchInvestigations, researchLlmCalls, researchLlmTranscripts } from '@agent-os/db';
import { and, asc, eq, gte, isNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type AgentRunRow, agentRunsRepository } from '../agents/agent-runs.repository.js';
import { SHIPPED_RESULT_FORMS } from '../agents/result-forms.js';
import { readRunFrame, type RunFrame, sessionViewOf, toRunSession } from '../agents/run-session.js';
import { OPENING_SEQ, type WindowStage } from '../agents/session-window.js';
import { sessionRepository } from '../agents/session.repository.js';
import { toolCallsRepository } from '../agents/tool-calls.repository.js';
import { agentToolsOf, BASE_TOOLS, createToolRegistry } from '../agents/tool-registry.js';
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
  /** A process role, `agent` or `judge`, as stored. */
  readonly role: string;
  /**
   * The agent of a turn (role `agent`): from the run row of a turn in an investigation, from the transcript itself for a
   * turn of `Engine.assessAgent`; null for every other call.
   */
  readonly agentName: string | null;
  readonly model: string;
  readonly promptVersion: string;
  /**
   * The instructions and the messages as sent to the provider, with their provider options. A turn of an agent run
   * stores a reference to its session view instead; the read rebuilds the view from the session (design-agent-core.md,
   * KD-2).
   */
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
  const selected = await selectTranscripts(
    db,
    and(
      eq(researchLlmTranscripts.investigationId, investigationId),
      taskId === undefined ? undefined : eq(researchLlmTranscripts.taskId, taskId),
      notExpired,
    ),
  );
  const transcripts = await withAgentTurns(db, investigationId, selected);
  return transcripts === null ? NOT_FOUND : { outcome: 'found', transcripts };
}

/** The reference of an agent turn's transcript to its session view (`AgentTranscriptInput`). */
const ViewReferenceSchema = z.object({
  instructions: z.string(),
  view: z.object({ throughSeq: z.number().int(), stage: z.number().int().min(0).max(4) }),
});

/** A window the view of stages 0–3 always fits: the rebuilt view stays at its recorded stage. */
const UNBOUNDED_WINDOW = Number.MAX_SAFE_INTEGER;
const TOOL_REGISTRY = createToolRegistry(BASE_TOOLS);

/**
 * The turns of agent runs with their agent and their input rebuilt from the session (KD-2): the session up to the last
 * message the view covered, at the stage it recorded — stage 4 by the definition's window, with the engine's shipped
 * result forms. A turn whose run (and with it its session) is gone reads as a deleted investigation: null.
 */
async function withAgentTurns(
  db: Database,
  investigationId: string,
  transcripts: readonly Transcript[],
): Promise<Transcript[] | null> {
  const runs = new Map<string, AgentRunRow | undefined>();
  let frame: RunFrame | undefined;
  const read: Transcript[] = [];
  for (const transcript of transcripts) {
    const reference = ViewReferenceSchema.safeParse(transcript.input);
    if (transcript.role !== 'agent' || transcript.taskId === null || !reference.success) {
      read.push(transcript);
      continue;
    }
    if (!runs.has(transcript.taskId)) runs.set(transcript.taskId, await agentRunsRepository.read(db, transcript.taskId));
    const run = runs.get(transcript.taskId);
    if (run === undefined) return null;
    frame ??= await readRunFrame(db, investigationId);
    const messages = await rebuiltMessages(db, { frame, run, ...reference.data.view });
    read.push({ ...transcript, agentName: run.agentName, input: { instructions: reference.data.instructions, messages } });
  }
  return read;
}

async function rebuiltMessages(
  db: Database,
  turn: { readonly frame: RunFrame; readonly run: AgentRunRow; readonly throughSeq: number; readonly stage: number },
) {
  const { frame, run } = turn;
  const definition = frame.config.agents[run.agentName];
  if (definition === undefined) throw new Error(`agent ${run.agentName} is not a definition of the frozen configuration`);
  const [rows, calls] = await Promise.all([
    // The opening is part of every view, also of a first turn recorded before the opening's number was kept (-1).
    sessionRepository.read(db, run.taskId).then((all) => all.filter((row) => row.seq <= Math.max(turn.throughSeq, OPENING_SEQ))),
    toolCallsRepository.ofRun(db, run.taskId),
  ]);
  const form = SHIPPED_RESULT_FORMS.find((shipped) => shipped.name === definition.result);
  const tools = agentToolsOf(definition.tools, { registry: TOOL_REGISTRY, resultSchema: form?.resultSchema ?? z.unknown() });
  const stage = turn.stage as WindowStage;
  return sessionViewOf({
    frame,
    agentName: run.agentName,
    definition,
    tools,
    session: toRunSession(rows, calls),
    heldStage: stage,
    ...(stage < 4 ? { windowTokens: UNBOUNDED_WINDOW } : {}),
  }).messages;
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
    agentName: row.agentName,
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
