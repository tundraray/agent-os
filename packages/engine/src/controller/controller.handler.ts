import { randomUUID } from 'node:crypto';
import type { Task } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { Clock, HandlerResult, InvestigationService, TaskContext, TaskHandler } from '@agent-os/runtime';
import { z } from 'zod';
import { buildCodeAnswer, type CodeAnswerEnd, InvestigationAnswerSchema, type StopReason } from '../answer/code-answer.js';
import { checkpointedAnswer } from '../attempt/checkpoint.js';
import { ProcessConfigSchema } from '../config/process-config.schema.js';
import { renderPromptTemplate } from '../config/prompt-template.js';
import type { SourceMode } from '../config/source-check.js';
import type { ContextBuilder } from '../context/context-builder.js';
import type { ModelGateway } from '../model/model-gateway.js';
import type { RoleMessage } from '../model/token-counter.js';
import { admissibleDecisions, type GateState, type GateVerdict, judgeDecision } from './decision-gate.js';
import { controllerMaterial, openTasks, otherTasks, stepsWithoutNovelty } from './decision-input.js';
import { ControllerOutputSchema } from './decision.schema.js';
import { controllerRepository as repository, type DecisionRow } from './decisions.repository.js';
import { type InvestigationFrame, promptValues, writePlanRevision } from './plan-role.js';
import { callOrReplay } from './role-call.js';
import { stopBeforeStep } from './stop-rules.js';

const CONTROLLER_WORKFLOW = 'research.controller';

export interface ControllerDeps {
  readonly database: Database;
  readonly investigations: Pick<InvestigationService, 'listForThread'>;
  readonly gateway: ModelGateway;
  readonly contextBuilder: ContextBuilder;
  readonly clock: Clock;
}

/** The attempt ends without an outcome: a cancel or a lost attempt; the runtime decides it by the abort or the fence. */
class AttemptAbandonedError extends Error {
  override readonly name = 'AttemptAbandonedError';
}

/** A decision whose capability arrives in a later release of the engine reached execution. */
class DecisionNotExecutableError extends Error {
  override readonly name = 'DecisionNotExecutableError';
}

const abandon = (cause: 'cancelled' | 'fenced'): never => {
  throw new AttemptAbandonedError(`controller attempt ended without an outcome: ${cause}`);
};

/** One investigation as one attempt of its controller task sees it. */
interface Investigation extends InvestigationFrame {
  readonly resourceId: string;
  readonly threadId: string;
}

type StepEnd =
  | { readonly next: 'continue' }
  | { readonly next: 'result'; readonly result: HandlerResult };

/** The fields of a controller result that are always empty: it writes no evidence and proposes through the scheduler. */
const emptyResult = () => ({ evidenceRefs: [], coverage: null, missingEvidence: [], warnings: [], proposedTasks: [] });

/**
 * `research.controller` v1 (KD-2): one long-lived task per investigation. An attempt writes the first plan revision,
 * then takes steps — one accepted decision each (Terms) — until a decision has to wait or the investigation ends. Every
 * value it acts on comes from the investigation's engine row: the frozen configuration and the mode recorded at the start
 * (DC-15, DC-16), never the engine's loaded set.
 */
export function createControllerHandler(deps: ControllerDeps): TaskHandler {
  const { database: db } = deps;

  async function finish(ctx: TaskContext, investigationId: string, end: CodeAnswerEnd): Promise<HandlerResult> {
    const claims = await repository.latestClaims(db, investigationId);
    const answer = buildCodeAnswer(randomUUID(), claims, end);
    const written = await ctx.withAttemptGuard((tx) => repository.writeAnswer(tx, investigationId, answer));
    if (written.outcome === 'fenced') return abandon('fenced');
    return completed(InvestigationAnswerSchema.parse(written.value));
  }

  async function tasksOf(investigation: Investigation): Promise<Task[]> {
    const thread = await deps.investigations.listForThread(investigation.resourceId, investigation.threadId);
    return thread.find((candidate) => candidate.investigationId === investigation.investigationId)?.tasks ?? [];
  }

  /** The effect of the latest accepted decision, when this attempt has not applied it yet (a replay or a wake). */
  async function applyLatest(ctx: TaskContext, investigation: Investigation, latest: DecisionRow): Promise<StepEnd> {
    switch (latest.kind) {
      case 'concludeInconclusive':
        return { next: 'result', result: await finish(ctx, investigation.investigationId, { concluded: true }) };
      case 'replan': {
        const current = await repository.latestPlanRevision(db, investigation.investigationId);
        if (current !== undefined && current.revision > (latest.planRevision ?? 0)) return { next: 'continue' };
        const reason = z.object({ reason: z.string() }).parse(latest.decision).reason;
        const revised = await writePlanRevision(deps, ctx, { frame: investigation, previous: current, reason });
        if (revised.outcome === 'abandon') return abandon(revised.cause);
        if (revised.outcome === 'stop') return stop(ctx, investigation, revised.reason);
        return { next: 'continue' };
      }
      case 'wait': {
        const open = openTasks(otherTasks(await tasksOf(investigation), ctx.taskId)).map((task) => task.taskId);
        if (open.length === 0) return { next: 'continue' };
        const registered = await ctx.registerWait(open);
        if (registered.outcome !== 'ok') {
          throw new Error(`wait of investigation ${investigation.investigationId} refused: ${registered.reason}`);
        }
        return { next: 'result', result: { kind: 'wait', answerOrDelta: null, waitFor: open, ...emptyResult() } };
      }
      default:
        throw new DecisionNotExecutableError(`decision ${latest.kind ?? 'unknown'} is not executable by this engine`);
    }
  }

  async function stop(ctx: TaskContext, investigation: Investigation, reason: StopReason): Promise<StepEnd> {
    return { next: 'result', result: await finish(ctx, investigation.investigationId, { stopReason: reason }) };
  }

  /**
   * One step: up to `maxDecisionRetries` + 1 controller calls (DC-2), each output judged by `DecisionGate` and recorded,
   * accepted or rejected with its reason, before anything follows from it. All of them rejected stops the
   * investigation with `controller_invalid` (AC-01.3).
   */
  async function takeStep(ctx: TaskContext, investigation: Investigation, decisions: readonly DecisionRow[]): Promise<StepEnd> {
    const { config, investigationId } = investigation;
    const accepted = decisions.filter((row) => row.status === 'accepted');
    const step = accepted.length + 1;
    const now = deps.clock.now();
    const stopReason = stopBeforeStep({ step, maxSteps: config.limits.maxSteps, now, notAfter: investigation.notAfter });
    if (stopReason !== null) return stop(ctx, investigation, stopReason);

    const [plan, claims, tasks, readRun] = await Promise.all([
      repository.latestPlanRevision(db, investigationId),
      repository.latestClaims(db, investigationId),
      tasksOf(investigation).then((all) => otherTasks(all, ctx.taskId)),
      repository.readRun(db, investigationId),
    ]);
    if (plan === undefined || readRun === undefined) {
      throw new Error(`investigation ${investigationId} lost its plan or engine row`);
    }
    const state: GateState = {
      capabilities: config.capabilities,
      limits: config.limits,
      replans: accepted.filter((row) => row.kind === 'replan').length,
      verifyRounds: accepted.filter((row) => row.kind === 'requestVerification').length,
      stepsWithoutNovelty: stepsWithoutNovelty(accepted, claims, tasks),
      msUntilNotAfter: investigation.notAfter.getTime() - now.getTime(),
      openTasks: openTasks(tasks).length,
    };
    const { run } = readRun;
    const material = controllerMaterial({
      plan,
      admissible: admissibleDecisions(state),
      stepsWithoutNovelty: state.stepsWithoutNovelty,
      tasks,
      claims,
      previous: accepted.at(-1),
      budget: {
        tokensLeft: run.tokenBudget - run.tokensSpent - run.tokensReserved,
        stepsLeft: config.limits.maxSteps - step + 1,
        planRevisionsLeft: config.limits.maxPlanRevisions - state.replans,
        verifyRoundsLeft: config.limits.maxVerifyRounds - state.verifyRounds,
        msUntilDeadlineMargin: state.msUntilNotAfter,
      },
    });
    const roleConfig = config.roles.controller;
    const instructions = renderPromptTemplate(roleConfig.prompt, promptValues(investigation));

    const recorded = decisions.filter((row) => row.step === step).length;
    for (let callIndex = recorded; callIndex <= config.limits.maxDecisionRetries; callIndex += 1) {
      const call = `decision:${step}:${callIndex}`;
      let messages: readonly RoleMessage[] = [];
      // A replayed answer needs no packet: the model is not called again (invariant 3).
      if (checkpointedAnswer(ctx, call) === undefined) {
        const packet = await deps.contextBuilder.buildControllerPacket(
          { roleConfig, instructions, outputSchema: ControllerOutputSchema, signal: ctx.signal },
          material,
        );
        // DC-8: the mandatory part does not fit, so the model is not called with a cut input.
        if (packet.outcome === 'context_overflow') return stop(ctx, investigation, 'context_overflow');
        if (packet.outcome === 'count_failed') return stop(ctx, investigation, 'model_unavailable');
        messages = packet.messages;
      }

      const answered = await callOrReplay(deps.gateway, {
        ctx,
        role: 'controller',
        roleConfig,
        call,
        instructions,
        messages,
        outputSchema: ControllerOutputSchema,
        notAfter: investigation.notAfter,
      });
      if (answered.outcome === 'abandon') return abandon(answered.cause);
      if (answered.outcome === 'stop') return stop(ctx, investigation, answered.reason);
      const verdict: GateVerdict =
        answered.outcome === 'answered'
          ? judgeDecision(answered.output, state)
          : { verdict: 'rejected', reason: 'invalid_model_output', kind: null };
      const written = await ctx.withAttemptGuard((tx) =>
        repository.insertDecision(tx, {
          decisionId: randomUUID(),
          investigationId,
          step,
          callIndex,
          status: verdict.verdict,
          rejectionReason: verdict.verdict === 'rejected' ? verdict.reason : null,
          decidedBy: 'model',
          kind: verdict.verdict === 'accepted' ? verdict.decision.kind : verdict.kind,
          decision: verdict.verdict === 'accepted' ? verdict.decision : answered.outcome === 'answered' ? answered.output : null,
          planRevision: plan.revision,
          notAfter: investigation.notAfter,
        }),
      );
      if (written.outcome === 'fenced') return abandon('fenced');
      if (verdict.verdict === 'accepted') return { next: 'continue' };
    }
    return stop(ctx, investigation, 'controller_invalid');
  }

  async function run(ctx: TaskContext): Promise<HandlerResult> {
    const read = await repository.readRun(db, ctx.investigationId);
    if (read === undefined) {
      throw new Error(`investigation ${ctx.investigationId} has no engine row`);
    }
    const { run: row } = read;
    if (row.answer !== null) {
      return completed(InvestigationAnswerSchema.parse(row.answer));
    }
    const sourceMode = row.sourceMode as SourceMode;
    if (sourceMode === 'model_knowledge') {
      throw new DecisionNotExecutableError('the model_knowledge path of the controller is not executable by this engine');
    }
    const config = ProcessConfigSchema.parse(row.processConfig);
    const investigation: Investigation = {
      investigationId: ctx.investigationId,
      resourceId: row.resourceId,
      threadId: read.threadId,
      query: read.query,
      config,
      sourceMode,
      // Invariant 5: no role call starts after `notAfter`, `deadlineMarginMs` before the controller's deadline.
      notAfter: new Date(ctx.deadlineAt.getTime() - config.limits.deadlineMarginMs),
    };

    if ((await repository.latestPlanRevision(db, ctx.investigationId)) === undefined) {
      const first = await writePlanRevision(deps, ctx, { frame: investigation, previous: undefined, reason: null });
      if (first.outcome === 'abandon') return abandon(first.cause);
      if (first.outcome === 'stop') return finish(ctx, ctx.investigationId, { stopReason: first.reason });
    }

    for (;;) {
      const decisions = await repository.decisionsOf(db, ctx.investigationId);
      const latest = decisions.filter((decision) => decision.status === 'accepted').at(-1);
      const applied = latest === undefined ? { next: 'continue' as const } : await applyLatest(ctx, investigation, latest);
      if (applied.next === 'result') return applied.result;
      const stepped = await takeStep(ctx, investigation, decisions);
      if (stepped.next === 'result') return stepped.result;
    }
  }

  return {
    workflowType: CONTROLLER_WORKFLOW,
    workflowVersion: 1,
    inputSchema: z.object({ investigationId: z.uuid() }),
    run,
  };
}

/** Contract «Завершение расследования»: the controller task succeeds with the `answerId` and `outcome`. */
function completed(answer: z.infer<typeof InvestigationAnswerSchema>): HandlerResult {
  return { kind: 'completed', answerOrDelta: { answerId: answer.answerId, outcome: answer.outcome }, ...emptyResult() };
}
