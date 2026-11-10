import { createHash, randomUUID } from 'node:crypto';
import { ResearchAnswerConfidenceSchema } from '@agent-os/contracts';
import type { RuntimeTx } from '@agent-os/runtime';
import { z } from 'zod';
import type { CollectStep, ForcedEndCode, ForcedEndDecision, ForcedEndFunction, FormRunContext } from '../../agents/result-forms.js';
import { answerRepository as answers } from '../../answer/answer.repository.js';
import { buildCodeAnswer, type InvestigationAnswer } from '../../answer/code-answer.js';
import { type AnswerMessage, type AnswerPage, buildResearchAnswer } from '../../answer/research-answer.builder.js';
import { type RootEnding, stopReasonOf } from './stop-reason.js';

/**
 * The answer code builds when the root cannot answer through the answer agent (design-research-flow.md, KD-3,
 * «Как причина остановки получается из конца корня»), shared by `research_close` and `answer_draft` at the root. Everything
 * is read in `collect`, so the step that decides stays pure.
 */

/** The answer and its message: one written row, with the answer as the root's result. */
export interface CodeAnswer {
  readonly result: InvestigationAnswer;
  readonly message: AnswerMessage;
}

/** A claim as the answer built by code reads it. */
export const CodeAnswerClaimSchema = z.object({
  claimId: z.string(),
  text: z.string(),
  evidenceIds: z.array(z.string()),
  status: z.string(),
  confidence: ResearchAnswerConfidenceSchema.nullable(),
});

const RecordPageSchema = z.object({
  page: z.string(),
  provenance: z.object({ sourceId: z.string(), toolName: z.string(), snapshot: z.string() }),
  coverage: z.object({ truncated: z.boolean() }),
});

/** What {@link collectCodeAnswer} returns; `research_close` extends it with the fields its gates read. */
export const CodeAnswerCollectedSchema = z.object({
  answerId: z.uuid(),
  /** The question: the assignment of the root. */
  goal: z.string(),
  engineRun: z.object({ launchKey: z.string(), sourceMode: z.enum(['sources', 'model_knowledge']) }),
  budgetExhausted: z.boolean(),
  claims: z.array(CodeAnswerClaimSchema),
  pages: z.array(RecordPageSchema),
});

/** The details of each page of the investigation, by page id, as the answer message reads them. */
export function pageDetailsOf(pages: readonly z.infer<typeof RecordPageSchema>[]): Map<string, AnswerPage> {
  return new Map(
    pages.map(({ page, provenance, coverage }) => [
      page,
      { sourceId: provenance.sourceId, toolName: provenance.toolName, snapshot: provenance.snapshot, truncated: coverage.truncated },
    ]),
  );
}

/**
 * Ids derived from a seed and their place, so that deciding stays pure and a retry numbers the same claims the same:
 * sha256 of `<seed>:<place>` in the form of a UUID.
 */
export function derivedIdsOf(seed: string): () => string {
  let place = 0;
  return () => {
    const hex = createHash('sha256').update(`${seed}:${place++}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
}

/** What the answer is built from. The id is taken here so that deciding stays pure. */
export const collectCodeAnswer: CollectStep = async (context, reader) => ({
  answerId: randomUUID(),
  goal: context.assignment,
  engineRun: await reader.engineRun(),
  budgetExhausted: await reader.budgetExhausted(),
  claims: await reader.claims(),
  pages: await reader.recordPages(),
});

/** `partial` with a `supported` claim and `inconclusive` otherwise, no summary; a closure with no reason is not a stop. */
export function decideCodeAnswer(collected: unknown, ending: RootEnding): CodeAnswer {
  const { answerId, goal, engineRun, budgetExhausted, claims, pages } = CodeAnswerCollectedSchema.parse(collected);
  const stopReason = stopReasonOf(ending, budgetExhausted);
  const result = buildCodeAnswer(answerId, claims, stopReason === null ? { concluded: true } : { stopReason });
  const message = buildResearchAnswer({
    answer: result,
    goal,
    launchKey: engineRun.launchKey,
    sourceMode: engineRun.sourceMode,
    pages: pageDetailsOf(pages),
  });
  return { result, message };
}

/** The answer and its message in the guarded transaction of the function, the same write as the root's result. */
export async function writeCodeAnswer(tx: RuntimeTx, context: FormRunContext, answer: CodeAnswer): Promise<void> {
  await answers.writeAnswer(tx, context.investigationId, answer.result, answer.message);
}

type AnsweredDecision = Extract<ForcedEndDecision, { kind: 'result' }> & CodeAnswer;

const isAnswered = (decision: ForcedEndDecision): decision is AnsweredDecision => decision.kind === 'result' && 'message' in decision;

const forcedEndOf = (code: ForcedEndCode): ForcedEndFunction => ({
  collect: collectCodeAnswer,
  decide: (collected) => {
    const answered: AnsweredDecision = { kind: 'result', ...decideCodeAnswer(collected, code) };
    return answered;
  },
  write: async (tx, context, decision) => {
    if (isAnswered(decision)) await writeCodeAnswer(tx, context, decision);
  },
});

/** The forced ends of the root: every code ends with an answer built by code, and the investigation is `completed`. */
export const CODE_ANSWER_FORCED_END: Readonly<Record<ForcedEndCode, ForcedEndFunction>> = {
  run_tokens_exhausted: forcedEndOf('run_tokens_exhausted'),
  investigation_tokens_exhausted: forcedEndOf('investigation_tokens_exhausted'),
  not_after: forcedEndOf('not_after'),
  turn_limit: forcedEndOf('turn_limit'),
  model_unavailable: forcedEndOf('model_unavailable'),
  context_overflow: forcedEndOf('context_overflow'),
};
