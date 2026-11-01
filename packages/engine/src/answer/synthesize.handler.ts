import { randomUUID } from 'node:crypto';
import type { Task } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { Clock, EvidenceReader, HandlerResult, InvestigationService, TaskContext, TaskHandler } from '@agent-os/runtime';
import { z } from 'zod';
import { answerSaver, checkpointedAnswer } from '../attempt/checkpoint.js';
import { abandon as abandonAttempt, failed, readTaskFrame, succeeded, type TaskFrame } from '../attempt/task-attempt.js';
import { SYNTHESIZE_WORKFLOW, SynthesizeInputSchema } from '../capabilities/synthesize.js';
import { WorkerOutputSchema } from '../claims/claim.schema.js';
import { claimsRepository as claims } from '../claims/claims.repository.js';
import { renderPromptTemplate } from '../config/prompt-template.js';
import type { ContextBuilder } from '../context/context-builder.js';
import { controllerRepository, type LatestClaimRow } from '../controller/decisions.repository.js';
import { promptValues } from '../controller/plan-role.js';
import { abandonEarlierAttempts } from '../model/ledger.js';
import type { ModelGateway } from '../model/model-gateway.js';
import { answerRepository as answers } from './answer.repository.js';
import { InvestigationAnswerSchema } from './code-answer.js';
import { composeAnswer, type DraftClaim, type ReferenceCheck, screenDraft, type SynthesisDraft } from './reference-gateway.js';

export interface SynthesizeDeps {
  readonly database: Database;
  /** The tasks of the investigation: cited evidence must come from one of them (AC-09.1). */
  readonly investigations: Pick<InvestigationService, 'listForThread'>;
  /** Provenance of the cited evidence, for the investigation's owner. */
  readonly evidence: Pick<EvidenceReader, 'get'>;
  readonly gateway: ModelGateway;
  readonly contextBuilder: ContextBuilder;
  readonly clock: Clock;
}

/** The checkpoint name of the synthesis's one model call. */
const SYNTHESIZE_CALL = 'synthesize';
const INVALID_MODEL_OUTPUT = 'invalid_model_output';
const EvidenceIdSchema = z.uuid();

/**
 * What the `synthesis` role returns: the draft answer. A claim names the input claim it states by `claimId`, or is new
 * (`claimId` null) with its atoms, so it can be verified like a worker claim (AC-09.3).
 */
const SynthesisOutputSchema = z.object({
  outcome: z.enum(['answered', 'partial', 'inconclusive']),
  summary: z.string(),
  claims: z.array(
    WorkerOutputSchema.shape.claims.element.extend({
      claimId: z.string().nullable().describe('The claimId of an input claim; null for a claim the answer adds'),
    }),
  ),
});

/** A path of the engine that arrives in a later task of the plan reached execution. */
class SynthesisNotExecutableError extends Error {
  override readonly name = 'SynthesisNotExecutableError';
}

const abandon = (cause: 'cancelled' | 'fenced'): never => abandonAttempt(SYNTHESIZE_WORKFLOW, cause);

type Drafted = { readonly next: 'draft'; readonly draft: SynthesisDraft } | { readonly next: 'result'; readonly result: HandlerResult };

/**
 * `research.synthesize` v1 (design-engine.md, Flow 3). The `synthesis` role gets the claims of the investigation with
 * their status, the answer sections of the configuration and the investigation's `sourceMode` in its prompt; its draft
 * is saved to the checkpoint. Code then checks every cited evidence through `EvidenceReader.get` for the owner and
 * against the investigation's tasks, and the reference gateway decides the answer (KD-6): new claims are written as
 * `unverified` revisions and either sent to verification first (`needs_verification`, AC-09.3) or delivered as assumed;
 * the answer is written once with the claims the gateway removed and why (AC-09.1).
 */
export function createSynthesizeHandler(deps: SynthesizeDeps): TaskHandler {
  const { database: db } = deps;

  async function tasksOf(frame: TaskFrame): Promise<readonly Task[]> {
    const thread = await deps.investigations.listForThread(frame.resourceId, frame.threadId);
    return thread.find((candidate) => candidate.investigationId === frame.investigationId)?.tasks ?? [];
  }

  /** Each cited id: evidence of a task of this investigation, of another investigation of the owner, or none (AC-09.1). */
  async function checkReferences(frame: TaskFrame, cited: readonly string[]): Promise<Map<string, ReferenceCheck>> {
    const own = new Set((await tasksOf(frame)).map((task) => task.taskId));
    const checks = new Map<string, ReferenceCheck>();
    for (const evidenceId of new Set(cited)) {
      if (!EvidenceIdSchema.safeParse(evidenceId).success) {
        checks.set(evidenceId, 'not_found');
        continue;
      }
      try {
        const stored = await deps.evidence.get(evidenceId, frame.resourceId);
        checks.set(evidenceId, own.has(stored.record.taskId) ? 'own' : 'foreign');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'evidence_not_found')) throw error;
        checks.set(evidenceId, 'not_found');
      }
    }
    return checks;
  }

  async function callSynthesis(ctx: TaskContext, frame: TaskFrame, known: readonly LatestClaimRow[]): Promise<Drafted> {
    const roleConfig = frame.config.roles.synthesis;
    const instructions = renderPromptTemplate(roleConfig.prompt, promptValues(frame));
    const assignment = JSON.stringify({
      claims: known.map(({ claimId, status, text, evidenceIds }) => ({ claimId, status, text, evidenceIds })),
    });
    const packet = await deps.contextBuilder.buildSlotPacket(
      { roleConfig, instructions, outputSchema: SynthesisOutputSchema, signal: ctx.signal },
      { assignment, evidence: [] },
    );
    if (packet.outcome === 'needs_narrowing') {
      const narrowing = { materialTokens: packet.materialTokens, limitTokens: packet.limitTokens };
      return { next: 'result', result: succeeded({ needsNarrowing: narrowing, answerId: null }) };
    }
    if (packet.outcome === 'count_failed') {
      return { next: 'result', result: failed(ctx, 'model_unavailable', 'the synthesis packet could not be counted') };
    }
    const answered = await deps.gateway.call({
      ctx,
      role: 'synthesis',
      roleConfig,
      instructions,
      messages: packet.messages,
      outputSchema: SynthesisOutputSchema,
      notAfter: frame.notAfter,
      checkpointAnswer: answerSaver(ctx, SYNTHESIZE_CALL),
    });
    switch (answered.outcome) {
      case 'answered':
        return { next: 'draft', draft: answered.output };
      case INVALID_MODEL_OUTPUT:
        return { next: 'result', result: succeeded({ answerId: null }, { warnings: [INVALID_MODEL_OUTPUT] }) };
      case 'no_answer':
        if (answered.reason === 'cancelled') return abandon('cancelled');
        return { next: 'result', result: failed(ctx, 'deadline', 'the synthesis call reached notAfter') };
      case 'fenced':
        return abandon('fenced');
      case 'failed':
        return { next: 'result', result: failed(ctx, answered.code, `the synthesis call failed: ${answered.code}`) };
    }
  }

  async function run(ctx: TaskContext): Promise<HandlerResult> {
    const input = SynthesizeInputSchema.parse(ctx.input);
    if ((await abandonEarlierAttempts(ctx)) === 'fenced') return abandon('fenced');
    const notAfter = new Date(input.notAfter);
    // DC-3: a task claimed at or after `notAfter` calls no model.
    if (deps.clock.now() >= notAfter) {
      return failed(ctx, 'deadline', 'the synthesis task was claimed after notAfter');
    }
    const frame = await readTaskFrame(db, ctx, notAfter);
    if (frame.sourceMode === 'model_knowledge') {
      throw new SynthesisNotExecutableError('the model_knowledge path of the synthesis is not executable by this engine');
    }
    const known = await controllerRepository.latestClaims(db, ctx.investigationId);

    const saved = checkpointedAnswer(ctx, SYNTHESIZE_CALL);
    const drafted: Drafted =
      saved === undefined ? await callSynthesis(ctx, frame, known) : { next: 'draft', draft: SynthesisOutputSchema.parse(saved.output) };
    if (drafted.next === 'result') return drafted.result;
    const { draft } = drafted;

    const draftClaims: readonly DraftClaim[] = draft.claims;
    const screened = screenDraft({
      claims: draftClaims,
      known: new Map(known.map((claim) => [claim.claimId, claim])),
      references: await checkReferences(frame, draftClaims.flatMap((claim) => claim.evidenceIds)),
    });
    const { limits, capabilities } = frame.config;
    const verifyRoundsLeft = capabilities.includes('verify')
      ? Math.max(0, limits.maxVerifyRounds - (await answers.verifyRoundsUsed(db, ctx.investigationId)))
      : 0;
    const answerId = randomUUID();
    const written = await ctx.withAttemptGuard(async (tx) => {
      // A replayed attempt gets the ids written first (unique by task and number).
      const freshClaimIds = await claims.writeTaskClaims(tx, {
        investigationId: ctx.investigationId,
        taskId: ctx.taskId,
        coverage: null,
        claims: screened.fresh,
      });
      const result = composeAnswer({ answerId, draft, screened, freshClaimIds, verifyRoundsLeft, removedClaimId: randomUUID });
      if (result.outcome === 'needs_verification') return result;
      return { outcome: 'answer' as const, answer: InvestigationAnswerSchema.parse(await answers.writeAnswer(tx, ctx.investigationId, result.answer)) };
    });
    if (written.outcome === 'fenced') return abandon('fenced');
    const result = written.value;
    if (result.outcome === 'needs_verification') {
      return succeeded({ needsVerification: { claimIds: [...result.claimIds] } });
    }
    return succeeded({ answerId: result.answer.answerId, outcome: result.answer.outcome });
  }

  return {
    workflowType: SYNTHESIZE_WORKFLOW,
    workflowVersion: 1,
    inputSchema: SynthesizeInputSchema,
    run,
  };
}
