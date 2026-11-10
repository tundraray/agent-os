import { z } from 'zod';
import type { ClosureDecision, ClosureInput, CollectStep, ResultForm } from '../../agents/result-forms.js';
import { composeAnswer, type KnownClaim, type ReferenceCheck, screenDraft } from '../../answer/reference-gateway.js';
import { buildResearchAnswer } from '../../answer/research-answer.builder.js';
import type { WorkerClaim } from '../../claims/claim.schema.js';
import { claimsRepository } from '../../claims/claims.repository.js';
import { checkedClaimOf, checkerCallEnd, claimWritingAgents } from '../checker-calls.js';
import { SynthesisOutputSchema } from './answer-draft.js';
import {
  CODE_ANSWER_FORCED_END,
  type CodeAnswer,
  CodeAnswerClaimSchema,
  CodeAnswerCollectedSchema,
  collectCodeAnswer,
  decideCodeAnswer,
  derivedIdsOf,
  pageDetailsOf,
  writeCodeAnswer,
} from './code-answer-end.js';

/**
 * How the root closes an investigation (design-research-flow.md, «Как корень закрывает расследование», Contract
 * `research_close`, DC-9): `collect` reads the plan, the claims, the calls of the checker and the runs of the answer agent;
 * `evaluate` holds the four gates in their order — two for `inconclusive` — and then builds the answer through the reference
 * gateway, or by code; `write` puts down the answer, or the new claims of a draft on the refusal `needs_verification`.
 * Every decision reads fields and ids; no step reads a text.
 */

/**
 * How the root closes: `answer`, the id of a finished run of the answer agent, or `inconclusive`.
 * One object with two optional fields, not a union: a provider takes a tool schema of type object only.
 */
const ResearchCloseResultSchema = z
  .strictObject({
    answer: z.uuid().optional().describe('The run id of a finished run of the answer agent'),
    inconclusive: z.literal(true).optional().describe('True to close the investigation as not established'),
  })
  .refine((result) => (result.answer === undefined) !== (result.inconclusive === undefined), {
    message: 'exactly one of answer and inconclusive is given',
  });

const ANSWER_DRAFT = 'answer_draft';
const NEEDS_VERIFICATION = 'needs_verification';

const CollectedSchema = z.object({
  runTaskId: z.string(),
  plan: z.unknown(),
  runs: z.array(
    z.object({
      run: z.string(),
      agent: z.string(),
      parent: z.string().nullable(),
      parentCallIndex: z.number().nullable(),
      result: z.unknown(),
      failure: z.unknown(),
    }),
  ),
  toolCalls: z.array(
    z.object({
      run: z.string(),
      callIndex: z.number(),
      toolName: z.string(),
      arguments: z.unknown(),
      state: z.string(),
      outcome: z.unknown(),
      reason: z.string().nullable(),
    }),
  ),
  codeAnswer: CodeAnswerCollectedSchema.extend({
    engineRun: CodeAnswerCollectedSchema.shape.engineRun.extend({
      processConfig: z.object({ agents: z.record(z.string(), z.object({ result: z.string(), tools: z.array(z.string()) })) }),
    }),
    claims: z.array(CodeAnswerClaimSchema.extend({ pointer: z.unknown(), taskId: z.string() })),
  }),
});
type Collected = z.infer<typeof CollectedSchema>;
type AnswerRun = Collected['runs'][number];

/** The outcome of a refused `finish`: the reason of the form is in it, not in the row's `reason`, always `invalid_result`. */
const RefusedFinishOutcomeSchema = z.object({ detail: z.object({ reason: z.string() }) });
const OverflowResultSchema = z.object({ overflow: z.literal(true) });

const collectClose: CollectStep = async (context, reader) => ({
  runTaskId: context.runTaskId,
  plan: await reader.plan(),
  runs: await reader.runs(),
  toolCalls: await reader.toolCalls(),
  codeAnswer: await collectCodeAnswer(context, reader),
});

/**
 * The refusal `needs_verification`: the model reads only `detail`, the ids `evaluate` gives the new claims because
 * `write` returns nothing (DC-9); the claims `write` puts down travel beside it.
 */
type NewClaimsRefusal = Extract<ClosureDecision, { kind: 'refuse' }> & {
  readonly detail: { readonly claimIds: readonly string[] };
  readonly newClaims: readonly WorkerClaim[];
};
type AnsweredClose = Extract<ClosureDecision, { kind: 'accept' }> & CodeAnswer;

const refuse = (reason: string, claimIds?: readonly string[]): ClosureDecision =>
  claimIds === undefined ? { kind: 'refuse', reason } : { kind: 'refuse', reason, detail: { claimIds } };

const answered = (answer: CodeAnswer): AnsweredClose => ({ kind: 'accept', ...answer });

const isAnswered = (decision: ClosureDecision): decision is AnsweredClose => decision.kind === 'accept' && 'message' in decision;
const isNewClaimsRefusal = (decision: ClosureDecision): decision is NewClaimsRefusal =>
  decision.kind === 'refuse' && decision.reason === NEEDS_VERIFICATION && 'newClaims' in decision;

/** The claims a call of the checker was attempted on: it ended with an assessment, or with a refusal that counts. */
function claimsOfAttemptedChecks(input: Collected): ReadonlySet<string> {
  const { agents } = input.codeAnswer.engineRun.processConfig;
  const claimIds = new Set<string>();
  for (const call of input.toolCalls) {
    const claimId = checkedClaimOf(call, agents);
    if (claimId !== null && checkerCallEnd(call) !== 'not_attempted') claimIds.add(claimId);
  }
  return claimIds;
}

/**
 * Gate 2: the `unverified` claims of an analyst (a run whose frozen definition has `claims_write`) or of the root's
 * gate 4 with no attempted call of the checker. Only runs that have ended are in `runs`, so a claim whose author is not
 * among them, the root itself, is held to account too.
 */
function uncheckedClaims(input: Collected): readonly string[] {
  const analysts = claimWritingAgents(input.codeAnswer.engineRun.processConfig.agents);
  const agentOfRun = new Map(input.runs.map((run) => [run.run, run.agent]));
  const attempted = claimsOfAttemptedChecks(input);
  return input.codeAnswer.claims
    .filter((claim) => {
      if (claim.status !== 'unverified' || attempted.has(claim.claimId)) return false;
      const author = agentOfRun.get(claim.taskId);
      return author === undefined || analysts.has(author);
    })
    .map((claim) => claim.claimId);
}

/** The number of the root's last `finish` refused `needs_verification`; null when there was none. */
function lastNeedsVerification(input: Collected): number | null {
  let last: number | null = null;
  for (const call of input.toolCalls) {
    if (call.run !== input.runTaskId || call.toolName !== 'finish' || call.state !== 'rejected') continue;
    const outcome = RefusedFinishOutcomeSchema.safeParse(call.outcome);
    if (outcome.data?.detail.reason === NEEDS_VERIFICATION) last = Math.max(last ?? call.callIndex, call.callIndex);
  }
  return last;
}

/**
 * Gate 3 before the draft is read: a successful child of the root, of the answer agent's form, and — the root does not call
 * `finish` while it waits for the runs of its turn — one whose call comes after the last refusal, so no clock is compared.
 */
function usableAnswerRun(input: Collected, runId: string, refusedAt: number | null): AnswerRun | null {
  const run = input.runs.find((candidate) => candidate.run === runId && candidate.parent === input.runTaskId);
  if (run === undefined || run.failure !== null || run.result === null) return null;
  if (input.codeAnswer.engineRun.processConfig.agents[run.agent]?.result !== ANSWER_DRAFT) return null;
  if (refusedAt !== null && (run.parentCallIndex === null || run.parentCallIndex <= refusedAt)) return null;
  return run;
}

/** Gates 3 and 4 and the reference gateway over the answer agent's draft. */
function closeByDraft(input: Collected, runId: string): ClosureDecision {
  const { codeAnswer } = input;
  const refusedAt = lastNeedsVerification(input);
  const run = usableAnswerRun(input, runId, refusedAt);
  if (run === null) return refuse('draft_invalid');
  if (OverflowResultSchema.safeParse(run.result).success) return answered(decideCodeAnswer(codeAnswer, 'answer_overflow'));
  const draft = SynthesisOutputSchema.safeParse(run.result);
  if (!draft.success) return refuse('draft_invalid');

  const { answerId, goal, engineRun, claims, pages } = codeAnswer;
  const known = new Map<string, KnownClaim>(claims.map((claim) => [claim.claimId, claim]));
  const references = new Map<string, ReferenceCheck>(pages.map(({ page }) => [page, 'own']));
  const screened = screenDraft({ sourceMode: engineRun.sourceMode, claims: draft.data.claims, known, references });

  if (screened.fresh.length > 0 && refusedAt === null) {
    const nextClaimId = derivedIdsOf(input.runTaskId);
    const refusal: NewClaimsRefusal = {
      kind: 'refuse',
      reason: NEEDS_VERIFICATION,
      detail: { claimIds: screened.fresh.map(() => nextClaimId()) },
      newClaims: screened.fresh.map(({ text, atoms, pointer }) => ({ text, atoms, pointer })),
    };
    return refusal;
  }

  const nextClaimId = derivedIdsOf(answerId);
  const composed = composeAnswer({
    sourceMode: engineRun.sourceMode,
    answerId,
    draft: draft.data,
    screened,
    // Gate 4 is behind: a claim still new goes to «Предположения» unverified, and no row is written for it.
    freshClaimIds: screened.fresh.map(() => nextClaimId()),
    verifyRoundsLeft: 0,
    removedClaimId: nextClaimId,
  });
  if (composed.outcome !== 'answer') throw new Error('a draft past gate 4 goes to no verification');
  const message = buildResearchAnswer({
    answer: composed.answer,
    goal,
    launchKey: engineRun.launchKey,
    sourceMode: engineRun.sourceMode,
    pages: pageDetailsOf(pages),
  });
  return answered({ result: composed.answer, message });
}

function evaluateClose({ result, collected }: ClosureInput): ClosureDecision {
  const input = CollectedSchema.parse(collected);
  const close = ResearchCloseResultSchema.parse(result);
  if (input.plan === null) return refuse('plan_missing');
  const unchecked = uncheckedClaims(input);
  if (unchecked.length > 0) return refuse('unverified_claims', unchecked);
  return close.answer === undefined ? answered(decideCodeAnswer(input.codeAnswer, 'inconclusive')) : closeByDraft(input, close.answer);
}

export const RESEARCH_CLOSE_FORM: ResultForm = {
  name: 'research_close',
  version: 1,
  resultSchema: ResearchCloseResultSchema,
  onlyOn: 'rootAgent',
  closure: {
    collect: collectClose,
    evaluate: evaluateClose,
    write: async (tx, context, decision) => {
      if (isAnswered(decision)) await writeCodeAnswer(tx, context, decision);
      if (isNewClaimsRefusal(decision)) {
        await claimsRepository.writeTaskClaims(tx, {
          investigationId: context.investigationId,
          taskId: context.runTaskId,
          coverage: null,
          claims: decision.newClaims,
          claimIds: decision.detail.claimIds,
        });
      }
    },
  },
  forcedEnd: CODE_ANSWER_FORCED_END,
};
