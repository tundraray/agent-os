import type { Coverage, Task } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { Clock, EvidenceReader, HandlerResult, InvestigationService, TaskContext, TaskHandler } from '@agent-os/runtime';
import { answerSaver, checkpointedAnswer } from '../attempt/checkpoint.js';
import { abandon as abandonAttempt, failed, readTaskFrame, succeeded, type TaskFrame } from '../attempt/task-attempt.js';
import { ANALYZE_WORKFLOW, AnalyzeInputSchema } from '../capabilities/analyze.js';
import { WorkerOutputSchema, type WorkerClaim } from '../claims/claim.schema.js';
import { claimsRepository as claims } from '../claims/claims.repository.js';
import { renderPromptTemplate } from '../config/prompt-template.js';
import type { ContextBuilder } from '../context/context-builder.js';
import type { EvidencePage } from '../context/role-packets.js';
import { promptValues } from '../controller/plan-role.js';
import { abandonEarlierAttempts } from '../model/ledger.js';
import type { ModelGateway } from '../model/model-gateway.js';
import { promptVersion } from '../model/prompt-version.js';
import { PageSchema } from '../verify/pointer.js';

export interface AnalyzeDeps {
  readonly database: Database;
  /** The gather task's coverage, read as the controller reads its tasks. */
  readonly investigations: Pick<InvestigationService, 'listForThread'>;
  /** Content of the gather task's evidence, for the investigation's owner. */
  readonly evidence: Pick<EvidenceReader, 'get'>;
  readonly gateway: ModelGateway;
  readonly contextBuilder: ContextBuilder;
  readonly clock: Clock;
}

/** The checkpoint name of the worker's one model call. */
const ANALYZE_CALL = 'analyze';
const INVALID_MODEL_OUTPUT = 'invalid_model_output';

const abandon = (cause: 'cancelled' | 'fenced'): never => abandonAttempt(ANALYZE_WORKFLOW, cause);

/** What a model call of the worker gave: claims to write, or the result the task ends with. */
type WorkerAnswer = { readonly next: 'claims'; readonly claims: readonly WorkerClaim[] } | { readonly next: 'result'; readonly result: HandlerResult };

/**
 * `research.analyze` v1 (design-engine.md, Flow 1): one worker call over its own sub-question and the evidence of its
 * own gather task, its records numbered within each page (KD-1), nothing else (AC-05.2). The answer is saved to the
 * checkpoint before the guarded write of its claim revisions — `unverified`, with their atoms, their pointers and the
 * gather task's coverage (AC-05.3)
 * — and a replayed attempt writes from the checkpoint without a call (invariant 3). Material over the role window ends
 * `needs_narrowing` without a call (DC-7); `notAfter` before or during the call fails the task `deadline` (DC-3); a
 * refused reservation or an unavailable model fails it with its code (AC-07.2, DC-12); an output still invalid after
 * the gateway's retry ends the task without claims and with the warning `invalid_model_output`.
 */
export function createAnalyzeHandler(deps: AnalyzeDeps): TaskHandler {
  const { database: db } = deps;
  const decoder = new TextDecoder();

  /** Coverage of the gather task, as the runtime recorded it; code carries it to the claims unchanged. */
  async function gatherCoverage(frame: TaskFrame, gatherTaskId: string): Promise<Coverage | null> {
    const thread = await deps.investigations.listForThread(frame.resourceId, frame.threadId);
    const tasks: readonly Task[] = thread.find((candidate) => candidate.investigationId === frame.investigationId)?.tasks ?? [];
    return tasks.find((task) => task.taskId === gatherTaskId)?.coverage ?? null;
  }

  /** The gather task's pages with their records in `items` order — the order the worker numbers them in (KD-1). */
  async function readPages(frame: TaskFrame, evidenceIds: readonly string[]): Promise<EvidencePage[]> {
    return Promise.all(
      evidenceIds.map(async (evidenceId) => {
        const stored = await deps.evidence.get(evidenceId, frame.resourceId);
        const page = PageSchema.parse(JSON.parse(decoder.decode(stored.bytes)));
        return { evidenceId, records: page.items };
      }),
    );
  }

  /** The worker's call, or its outcome when no claims follow from it. */
  async function callWorker(
    ctx: TaskContext,
    frame: TaskFrame,
    request: { readonly subquestion: string; readonly evidenceIds: readonly string[]; readonly coverage: Coverage | null },
  ): Promise<WorkerAnswer> {
    const roleConfig = frame.config.roles.worker;
    const instructions = renderPromptTemplate(roleConfig.prompt, promptValues(frame));
    const packet = await deps.contextBuilder.buildWorkerPacket(
      { roleConfig, instructions, outputSchema: WorkerOutputSchema, signal: ctx.signal },
      { subquestion: request.subquestion, pages: await readPages(frame, request.evidenceIds) },
    );
    if (packet.outcome === 'needs_narrowing') {
      // DC-7: nothing is cut and the model is not called; the controller reads the sign in its next observations.
      const narrowing = { materialTokens: packet.materialTokens, limitTokens: packet.limitTokens };
      return { next: 'result', result: succeeded({ needsNarrowing: narrowing, claimIds: [] }, { coverage: request.coverage }) };
    }
    if (packet.outcome === 'count_failed') {
      return { next: 'result', result: failed(ctx, 'model_unavailable', 'the worker packet could not be counted') };
    }
    const answered = await deps.gateway.call({
      ctx,
      role: 'worker',
      roleConfig,
      instructions,
      promptVersion: promptVersion(roleConfig.prompt),
      messages: packet.messages,
      outputSchema: WorkerOutputSchema,
      notAfter: frame.notAfter,
      checkpointAnswer: answerSaver(ctx, ANALYZE_CALL),
    });
    switch (answered.outcome) {
      case 'answered':
        return { next: 'claims', claims: answered.output.claims };
      case INVALID_MODEL_OUTPUT:
        return { next: 'result', result: succeeded({ claimIds: [] }, { coverage: request.coverage, warnings: [INVALID_MODEL_OUTPUT] }) };
      case 'no_answer':
        if (answered.reason === 'cancelled') return abandon('cancelled');
        return { next: 'result', result: failed(ctx, 'deadline', 'the worker call reached notAfter') };
      case 'fenced':
        return abandon('fenced');
      case 'failed':
        return { next: 'result', result: failed(ctx, answered.code, `the worker call failed: ${answered.code}`) };
    }
  }

  async function run(ctx: TaskContext): Promise<HandlerResult> {
    const input = AnalyzeInputSchema.parse(ctx.input);
    if ((await abandonEarlierAttempts(ctx)) === 'fenced') return abandon('fenced');
    const notAfter = new Date(input.notAfter);
    // DC-3: a task claimed at or after `notAfter` calls no model.
    if (deps.clock.now() >= notAfter) {
      return failed(ctx, 'deadline', 'the analysis task was claimed after notAfter');
    }
    const frame = await readTaskFrame(db, ctx, notAfter);
    const evidenceIds = ctx.upstream.find((task) => task.taskId === input.gatherTaskId)?.outputRefs ?? [];
    const coverage = await gatherCoverage(frame, input.gatherTaskId);

    const saved = checkpointedAnswer(ctx, ANALYZE_CALL);
    const answer: WorkerAnswer =
      saved === undefined
        ? await callWorker(ctx, frame, { subquestion: input.subquestion, evidenceIds, coverage })
        : { next: 'claims', claims: WorkerOutputSchema.parse(saved.output).claims };
    if (answer.next === 'result') return answer.result;

    // The pointer is stored as the worker wrote it: `research.verify` checks it against the investigation's pages (DC-6).
    const written = await ctx.withAttemptGuard((tx) =>
      claims.writeTaskClaims(tx, { investigationId: ctx.investigationId, taskId: ctx.taskId, coverage, claims: answer.claims }),
    );
    if (written.outcome === 'fenced') return abandon('fenced');
    return succeeded({ claimIds: written.value }, { coverage });
  }

  return {
    workflowType: ANALYZE_WORKFLOW,
    workflowVersion: 1,
    inputSchema: AnalyzeInputSchema,
    run,
  };
}
