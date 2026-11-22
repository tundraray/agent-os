import { AgentMessageKindSchema } from '@agent-os/contracts';
import type {
  AgentKnowledgeRunsRepository,
  Db,
  EmbeddingOutcome,
  KnowledgeQuestionRow,
} from '@agent-os/db';
import type { StepContext, StepMessage } from '@agent-os/runtime';
import { z } from 'zod';

import type { AgentsEmbeddings, EmbedResult } from '../embeddings/embeddings';
import type { RunSnapshot } from '../start/snapshot';
import type { Session } from '../store/sessions';
import { sessionLearningOf } from './knowledge-block';

/** The `source` of a question taken from the session's `task`; otherwise it is the employee message's id. */
const TASK_QUESTION_SOURCE = 'task';

const { user_message: userMessage } = AgentMessageKindSchema.enum;

/** The part of a `user_message` payload the question needs. */
const UserMessageTextSchema = z.object({ text: z.string() });

/** A question of the session to embed: where it comes from and its text (never logged). */
export interface SessionQuestion {
  readonly source: string;
  readonly text: string;
}

export interface QuestionVectorDeps {
  /** The savepoint of the question outcome: a deleted deep agent fails only it. */
  readonly db: Db;
  readonly knowledgeRunRows: AgentKnowledgeRunsRepository;
  readonly embeddings: Pick<AgentsEmbeddings, 'embed'>;
}

/** What the embeddings call gave: its result, or the error it threw while the step was not cancelled. */
type EmbedAttempt = EmbedResult | { readonly kind: 'error'; readonly message: string };

/**
 * The question to embed now (KD-6, Invariant 12), for a session that learns: a step of an agent that embeds
 * the employee's messages (a deep agent) that delivers a `user_message` other than the stored source — the
 * last such message; no question row yet
 * (the session may exist before its first step) — the session's `task`; otherwise nothing. A step that
 * is both the first and delivers a message embeds only the message: it is the newer question.
 */
function questionToEmbed(
  session: Session,
  embedsEmployeeMessages: boolean,
  messages: readonly StepMessage[],
  stored: KnowledgeQuestionRow | undefined,
): SessionQuestion | null {
  const employees = embedsEmployeeMessages ? messages.filter((message) => message.kind === userMessage) : [];
  const latest = employees[employees.length - 1];
  if (latest !== undefined && latest.messageId !== stored?.source) {
    return { source: latest.messageId, text: UserMessageTextSchema.parse(latest.payload).text };
  }
  if (stored === undefined) return { source: TASK_QUESTION_SOURCE, text: session.prompt };
  return null;
}

/**
 * The outcome for the deep agent's vector row (Contract «Строка векторов»): success — no reason;
 * a refusal — its reason; `owner_disabled` (one employee's refusal) and a thrown error — none, log only.
 */
function outcomeOf(attempt: EmbedAttempt): EmbeddingOutcome | null {
  if (attempt.kind === 'vectors') return { reason: null, model: attempt.model };
  if (attempt.kind === 'error' || attempt.reason === 'owner_disabled') return null;
  return { reason: attempt.reason, model: attempt.model };
}

/**
 * The session's question vector (KD-6, Flow 2): computed before the step chooses its work, outside a
 * transaction, once per question — the row is written even when embeddings refuse or throw, with an
 * empty vector, so the next step and a re-run of a lost step find it and make no call. The spend is the
 * session owner's, under the session's task. A session that does not learn reads and calls nothing.
 * The call is bounded by the embeddings service itself (its request timeout and two retries) and by
 * the step's signal. `false` — the step was cancelled or its write fenced: it ends without writes.
 */
export async function embedQuestion(
  deps: QuestionVectorDeps,
  ctx: StepContext,
  session: Session,
  /** The snapshot of the run: whether its session learns. */
  snapshot: RunSnapshot,
  /** The agent embeds the employee's messages as new questions (a deep agent). */
  embedsEmployeeMessages: boolean,
): Promise<boolean> {
  const learning = sessionLearningOf(snapshot);
  if (learning === null) return true;
  const { recordId } = learning;

  const stored = await deps.knowledgeRunRows.readQuestion(ctx.taskId);
  const question = questionToEmbed(session, embedsEmployeeMessages, ctx.messages, stored);
  if (question === null) return true;

  const startedAt = Date.now();
  const fields = {
    taskId: ctx.taskId,
    recordId,
    ownerId: session.ownerId,
    source: question.source === TASK_QUESTION_SOURCE ? TASK_QUESTION_SOURCE : userMessage,
    messageId: question.source === TASK_QUESTION_SOURCE ? null : question.source,
  };
  let attempt: EmbedAttempt;
  try {
    attempt = await deps.embeddings.embed({
      texts: [question.text],
      inputType: 'query',
      ownerId: session.ownerId,
      taskId: ctx.taskId,
      signal: ctx.signal,
      logger: ctx.logger,
    });
  } catch (error) {
    if (ctx.signal.aborted) return false;
    attempt = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }

  const vector = attempt.kind === 'vectors' ? attempt.vectors[0] : undefined;
  const model = attempt.kind === 'error' ? null : attempt.model;
  const outcome = outcomeOf(attempt);
  const written = await ctx.guard(async () => {
    await deps.knowledgeRunRows.writeQuestion({
      taskId: ctx.taskId,
      source: question.source,
      model,
      vector: vector === undefined ? null : [...vector],
    });
    if (outcome === null) return;
    // A deep agent deleted during the run takes its vector row with it: the outcome is lost, not the step.
    await deps.db
      .savepoint(() => deps.knowledgeRunRows.writeQuestionOutcome(recordId, outcome))
      .catch((error: unknown) => {
        ctx.logger.warn('question outcome not written', {
          ...fields,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
  if (written.outcome === 'fenced') return false;

  const durationMs = Date.now() - startedAt;
  if (attempt.kind === 'vectors') {
    ctx.logger.info('question vector written', { ...fields, model, outcome: 'vectors', durationMs });
  } else if (attempt.kind === 'unavailable') {
    ctx.logger.warn('question vector written empty', {
      ...fields,
      model,
      outcome: attempt.reason,
      message: attempt.message,
      durationMs,
    });
  } else {
    ctx.logger.error('question vector written empty', {
      ...fields,
      model,
      outcome: 'error',
      error: attempt.message,
      durationMs,
    });
  }
  return true;
}
