import type { Coverage, Task } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { Clock, EvidenceReader, HandlerResult, InvestigationService, TaskContext, TaskHandler } from '@agent-os/runtime';
import { answerSaver, checkpointedAnswer } from '../attempt/checkpoint.js';
import { ANALYZE_WORKFLOW, AnalyzeInputSchema } from '../capabilities/analyze.js';
import { WorkerOutputSchema, type WorkerClaim } from '../claims/claim.schema.js';
import { claimsRepository as claims } from '../claims/claims.repository.js';
import { ProcessConfigSchema } from '../config/process-config.schema.js';
import { renderPromptTemplate } from '../config/prompt-template.js';
import type { SourceMode } from '../config/source-check.js';
import type { ContextBuilder } from '../context/context-builder.js';
import type { EvidenceItem } from '../context/role-packets.js';
import { controllerRepository } from '../controller/decisions.repository.js';
import { type InvestigationFrame, promptValues } from '../controller/plan-role.js';
import { ENGINE_FAILURE_CLASSES, type EngineFailureCode } from '../engine-errors.js';
import { abandonEarlierAttempts } from '../model/ledger.js';
import type { ModelGateway } from '../model/model-gateway.js';

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

/** The attempt ends without an outcome: a cancel or a lost attempt; the runtime decides it by the abort or the fence. */
class AttemptAbandonedError extends Error {
  override readonly name = 'AttemptAbandonedError';
}

const abandon = (cause: 'cancelled' | 'fenced'): never => {
  throw new AttemptAbandonedError(`analysis attempt ended without an outcome: ${cause}`);
};

/** What a model call of the worker gave: claims to write, or the result the task ends with. */
type WorkerAnswer = { readonly next: 'claims'; readonly claims: readonly WorkerClaim[] } | { readonly next: 'result'; readonly result: HandlerResult };

/** The investigation as one analysis attempt sees it: its frozen configuration, mode and query, and the owner. */
interface AnalysisFrame extends InvestigationFrame {
  readonly resourceId: string;
  readonly threadId: string;
}

function succeeded(answerOrDelta: HandlerResult['answerOrDelta'], coverage: Coverage | null, warnings: string[] = []): HandlerResult {
  return { kind: 'completed', answerOrDelta, evidenceRefs: [], coverage, missingEvidence: [], warnings, proposedTasks: [] };
}

function failed(ctx: TaskContext, code: EngineFailureCode, message: string): HandlerResult {
  return {
    kind: 'failed',
    answerOrDelta: null,
    evidenceRefs: [],
    coverage: null,
    missingEvidence: [],
    warnings: [],
    proposedTasks: [],
    failure: { class: ENGINE_FAILURE_CLASSES[code], code, message, cause: null, attempt: ctx.attempt, toolCalls: 0, retries: 0 },
  };
}

/**
 * `research.analyze` v1 (design-engine.md, Flow 1): one worker call over its own sub-question and the evidence of its
 * own gather task, nothing else (AC-05.2). The answer is saved to the checkpoint before the guarded write of its claim
 * revisions — `unverified`, with their atoms, the cited evidence of this task and the gather task's coverage (AC-05.3)
 * — and a replayed attempt writes from the checkpoint without a call (invariant 3). Material over the role window ends
 * `needs_narrowing` without a call (DC-7); `notAfter` before or during the call fails the task `deadline` (DC-3); a
 * refused reservation or an unavailable model fails it with its code (AC-07.2, DC-12); an output still invalid after
 * the gateway's retry ends the task without claims and with the warning `invalid_model_output`.
 */
export function createAnalyzeHandler(deps: AnalyzeDeps): TaskHandler {
  const { database: db } = deps;
  const decoder = new TextDecoder();

  async function frameOf(ctx: TaskContext, notAfter: Date): Promise<AnalysisFrame> {
    const read = await controllerRepository.readRun(db, ctx.investigationId);
    if (read === undefined) {
      throw new Error(`investigation ${ctx.investigationId} has no engine row`);
    }
    return {
      investigationId: ctx.investigationId,
      resourceId: read.run.resourceId,
      threadId: read.threadId,
      query: read.query,
      config: ProcessConfigSchema.parse(read.run.processConfig),
      sourceMode: read.run.sourceMode as SourceMode,
      notAfter,
    };
  }

  /** Coverage of the gather task, as the runtime recorded it; code carries it to the claims unchanged. */
  async function gatherCoverage(frame: AnalysisFrame, gatherTaskId: string): Promise<Coverage | null> {
    const thread = await deps.investigations.listForThread(frame.resourceId, frame.threadId);
    const tasks: readonly Task[] = thread.find((candidate) => candidate.investigationId === frame.investigationId)?.tasks ?? [];
    return tasks.find((task) => task.taskId === gatherTaskId)?.coverage ?? null;
  }

  async function readEvidence(frame: AnalysisFrame, evidenceIds: readonly string[]): Promise<EvidenceItem[]> {
    return Promise.all(
      evidenceIds.map(async (evidenceId) => {
        const stored = await deps.evidence.get(evidenceId, frame.resourceId);
        return { evidenceId, text: decoder.decode(stored.bytes) };
      }),
    );
  }

  /** The worker's call, or its outcome when no claims follow from it. */
  async function callWorker(
    ctx: TaskContext,
    frame: AnalysisFrame,
    request: { readonly subquestion: string; readonly evidenceIds: readonly string[]; readonly coverage: Coverage | null },
  ): Promise<WorkerAnswer> {
    const roleConfig = frame.config.roles.worker;
    const instructions = renderPromptTemplate(roleConfig.prompt, promptValues(frame));
    const packet = await deps.contextBuilder.buildWorkerPacket(
      { roleConfig, instructions, outputSchema: WorkerOutputSchema, signal: ctx.signal },
      { subquestion: request.subquestion, evidence: await readEvidence(frame, request.evidenceIds) },
    );
    if (packet.outcome === 'needs_narrowing') {
      // DC-7: nothing is cut and the model is not called; the controller reads the sign in its next observations.
      const narrowing = { materialTokens: packet.materialTokens, limitTokens: packet.limitTokens };
      return { next: 'result', result: succeeded({ needsNarrowing: narrowing, claimIds: [] }, request.coverage) };
    }
    if (packet.outcome === 'count_failed') {
      return { next: 'result', result: failed(ctx, 'model_unavailable', 'the worker packet could not be counted') };
    }
    const answered = await deps.gateway.call({
      ctx,
      role: 'worker',
      roleConfig,
      instructions,
      messages: packet.messages,
      outputSchema: WorkerOutputSchema,
      notAfter: frame.notAfter,
      checkpointAnswer: answerSaver(ctx, ANALYZE_CALL),
    });
    switch (answered.outcome) {
      case 'answered':
        return { next: 'claims', claims: answered.output.claims };
      case INVALID_MODEL_OUTPUT:
        return { next: 'result', result: succeeded({ claimIds: [] }, request.coverage, [INVALID_MODEL_OUTPUT]) };
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
    const frame = await frameOf(ctx, notAfter);
    const evidenceIds = ctx.upstream.find((task) => task.taskId === input.gatherTaskId)?.outputRefs ?? [];
    const coverage = await gatherCoverage(frame, input.gatherTaskId);

    const saved = checkpointedAnswer(ctx, ANALYZE_CALL);
    const answer: WorkerAnswer =
      saved === undefined
        ? await callWorker(ctx, frame, { subquestion: input.subquestion, evidenceIds, coverage })
        : { next: 'claims', claims: WorkerOutputSchema.parse(saved.output).claims };
    if (answer.next === 'result') return answer.result;

    // A claim cites only the evidence this worker read; any other id is dropped and the reference gateway judges the rest.
    const own = new Set(evidenceIds);
    const cited = answer.claims.map((claim) => ({ ...claim, evidenceIds: claim.evidenceIds.filter((id) => own.has(id)) }));
    const written = await ctx.withAttemptGuard((tx) =>
      claims.writeTaskClaims(tx, { investigationId: ctx.investigationId, taskId: ctx.taskId, coverage, claims: cited }),
    );
    if (written.outcome === 'fenced') return abandon('fenced');
    return succeeded({ claimIds: written.value }, coverage);
  }

  return {
    workflowType: ANALYZE_WORKFLOW,
    workflowVersion: 1,
    inputSchema: AnalyzeInputSchema,
    run,
  };
}
