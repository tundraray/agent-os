import { randomUUID } from 'node:crypto';
import { type Database, researchLlmTranscripts } from '@agent-os/db';
import type { RuntimeTx, TaskContext } from '@agent-os/runtime';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { CallUsage } from '../model/cost.js';
import type { ModelRole } from '../model/ledger.js';
import type { AgentTurnMessage, ProviderMessage } from '../model/role-agent.js';

/** The input of a call as it goes to the provider: the instructions and the messages with their provider options. */
export interface TranscriptInput {
  readonly instructions: string;
  readonly messages: readonly ProviderMessage[];
}

/**
 * The input of an agent turn (design-agent-core.md, KD-2): the instructions and a reference to the session view — the
 * last session message it covers, the results and turns it replaced with stubs and the window stage — instead of a copy
 * of the session.
 */
export interface AgentTranscriptInput {
  readonly instructions: string;
  readonly view: {
    readonly throughSeq: number;
    readonly stubbedCalls: readonly string[];
    readonly collapsedTurns: readonly number[];
    readonly stage: number;
  };
}

/**
 * The whole input of an agent turn outside an investigation (`Engine.assessAgent`, DC-25): it has no session to refer
 * to, so the view's messages are stored as they were sent.
 */
export interface AgentTurnTranscriptInput {
  readonly instructions: string;
  readonly messages: readonly AgentTurnMessage[];
}

/** What the reservation of a call writes next to its ledger row (design-self-check.md, KD-1, KD-2). */
export interface TranscriptOpening {
  /** First 12 hex digits of the SHA-256 of the role's prompt template (`promptVersion`). */
  readonly promptVersion: string;
  readonly input: TranscriptInput | AgentTranscriptInput | AgentTurnTranscriptInput;
}

/** The answer as the model client returned it, before the role schema checked it. */
export interface TranscriptResponse {
  readonly object: unknown;
  readonly finishReason: string | null;
  /** The raw text of the answer; present only when the client returned a non-empty one. */
  readonly text?: string;
}

/**
 * How the close of a call ends its transcript: `answered` or `invalid_output` (a refusal included) with the response,
 * `provider_error` without one. `abandoned` is never written: reading derives it from the abandoned ledger row.
 */
export type TranscriptClosing =
  | { readonly outcome: 'answered' | 'invalid_output'; readonly response: TranscriptResponse }
  | { readonly outcome: 'provider_error'; readonly response: null };

/** Usage the ledger row of the call got on close; the transcript stores the same numbers. */
export interface TranscriptUsage {
  readonly inputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  /** As the ledger stores it, a numeric string. */
  readonly costUsd: string;
}

/**
 * Writes the open transcript of a reserved call. Runs inside the reservation's guarded transaction, after its ledger
 * row is inserted: a fenced or refused reservation writes neither.
 */
export async function insertOpenTranscript(
  tx: RuntimeTx,
  ctx: Pick<TaskContext, 'investigationId' | 'taskId' | 'attempt'>,
  call: { readonly callId: string; readonly role: ModelRole; readonly model: string; readonly opening: TranscriptOpening },
): Promise<void> {
  await tx.insert(researchLlmTranscripts).values({
    callId: call.callId,
    llmCallId: call.callId,
    investigationId: ctx.investigationId,
    taskId: ctx.taskId,
    attempt: ctx.attempt,
    role: call.role,
    model: call.model,
    promptVersion: call.opening.promptVersion,
    input: call.opening.input,
  });
}

/**
 * Closes the open transcript of a call with its answer and the ledger row's usage. Runs inside the close's guarded
 * transaction, only when that transaction closed the ledger row.
 */
export async function closeTranscript(
  tx: RuntimeTx | Database,
  callId: string,
  closing: { readonly transcript: TranscriptClosing; readonly usage: TranscriptUsage },
): Promise<void> {
  const { transcript, usage } = closing;
  const closed = await tx
    .update(researchLlmTranscripts)
    .set({
      response: transcript.response,
      outcome: transcript.outcome,
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      closedAt: sql`now()`,
    })
    .where(and(eq(researchLlmTranscripts.callId, callId), isNull(researchLlmTranscripts.outcome)))
    .returning({ callId: researchLlmTranscripts.callId });
  if (closed.length === 0) {
    throw new Error(`transcript of call ${callId} is not open`);
  }
}

/** Role a transcript records: a process role, or `judge` for the self-check judge (design-self-check.md, Transcript). */
export type TranscriptRole = ModelRole | 'judge';

/**
 * What a call outside an investigation task is bound to: an investigation of the same database, a self-check run, or
 * both — at least one (the `research_llm_transcripts` binding check).
 */
export type TranscriptBinding =
  | { readonly investigationId: string; readonly selfCheckRunId?: string }
  | { readonly investigationId?: string; readonly selfCheckRunId: string };

/** The open transcript of one attempt of a call outside an investigation task (`Engine.assess`). */
export interface OutsideTaskOpening {
  readonly role: TranscriptRole;
  readonly model: string;
  readonly binding: TranscriptBinding;
  /** The agent of an `Engine.assessAgent` turn, which has no run row (design-agent-core.md, Data Model). */
  readonly agentName?: string;
  readonly opening: TranscriptOpening;
}

/** How such an attempt closes: the transcript outcome and the usage the provider reported, priced by the catalog. */
export interface OutsideTaskClosing {
  readonly transcript: TranscriptClosing;
  /** Null when the provider reported no usage. */
  readonly usage: CallUsage | null;
  readonly costUsd: number;
}

/**
 * Transcript writes of calls outside an investigation task: no ledger row, no task, no attempt guard — the transcript
 * holds the call's spend itself (design-self-check.md, KD-1).
 */
export interface OutsideTaskTranscripts {
  /** Writes the open transcript and returns its `callId`. */
  open(call: OutsideTaskOpening): Promise<string>;
  close(callId: string, closing: OutsideTaskClosing): Promise<void>;
}

/** Scale of `research_llm_transcripts.cost_usd`, as the ledger stores its cost. */
const COST_SCALE = 8;

/** The Postgres writes of {@link OutsideTaskTranscripts}, each one statement on the database. */
export function postgresOutsideTaskTranscripts(database: Database): OutsideTaskTranscripts {
  return {
    async open(call) {
      const callId = randomUUID();
      await database.insert(researchLlmTranscripts).values({
        callId,
        investigationId: call.binding.investigationId ?? null,
        selfCheckRunId: call.binding.selfCheckRunId ?? null,
        role: call.role,
        agentName: call.agentName ?? null,
        model: call.model,
        promptVersion: call.opening.promptVersion,
        input: call.opening.input,
      });
      return callId;
    },
    async close(callId, closing) {
      await closeTranscript(database, callId, {
        transcript: closing.transcript,
        usage: {
          inputTokens: closing.usage?.inputTokens ?? null,
          cacheReadTokens: closing.usage?.cacheReadTokens ?? null,
          cacheWriteTokens: closing.usage?.cacheWriteTokens ?? null,
          outputTokens: closing.usage?.outputTokens ?? null,
          costUsd: closing.costUsd.toFixed(COST_SCALE),
        },
      });
    },
  };
}
