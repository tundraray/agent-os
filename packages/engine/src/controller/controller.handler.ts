import { randomUUID } from 'node:crypto';
import type { Task } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { Clock, HandlerResult, InvestigationService, TaskContext, TaskHandler, TaskScheduler } from '@agent-os/runtime';
import type { SourceRegistry } from '@agent-os/sources';
import { z } from 'zod';
import { answerRepository as answers } from '../answer/answer.repository.js';
import { buildCodeAnswer, type CodeAnswerEnd, InvestigationAnswerSchema, type StopReason } from '../answer/code-answer.js';
import { checkpointedAnswer } from '../attempt/checkpoint.js';
import { abandon as abandonAttempt } from '../attempt/task-attempt.js';
import { createCapabilityRegistry } from '../capabilities/capability-registry.js';
import { recordProposedTasks, unavailableRequestsOf } from '../capabilities/proposed-tasks.repository.js';
import { SYNTHESIZE_WORKFLOW } from '../capabilities/synthesize.js';
import { ProcessConfigSchema } from '../config/process-config.schema.js';
import { renderPromptTemplate } from '../config/prompt-template.js';
import type { SourceMode } from '../config/source-check.js';
import type { ContextBuilder } from '../context/context-builder.js';
import { abandonEarlierAttempts, abandonReservations } from '../model/ledger.js';
import type { ModelGateway } from '../model/model-gateway.js';
import type { RoleMessage } from '../model/token-counter.js';
import type { EngineLogger } from '../ports.js';
import { signalsRepository as signals } from '../signals/signals.repository.js';
import { admissibleDecisions, type GateState, type GateVerdict, judgeControllerOutput } from './decision-gate.js';
import { controllerMaterial, openTasks, otherTasks, stepsWithoutNovelty } from './decision-input.js';
import { ControllerOutputSchema, DecisionSchema } from './decision.schema.js';
import { controllerRepository as repository, type DecisionRow, proposeAnswerByCode } from './decisions.repository.js';
import { type InvestigationFrame, type PlanRevisionResult, promptValues, writePlanRevision } from './plan-role.js';
import { callOrReplay } from './role-call.js';
import { noSourceEnd, seedPlan, stopBeforeStep } from './stop-rules.js';

const CONTROLLER_WORKFLOW = 'research.controller';

export interface ControllerDeps {
  readonly database: Database;
  readonly investigations: Pick<InvestigationService, 'listForThread'>;
  /** Proposes the tasks of accepted decisions (ADR-0001: the engine writes runtime state only through its services). */
  readonly scheduler: Pick<TaskScheduler, 'propose'>;
  readonly sourceRegistry: Pick<SourceRegistry, 'resolveTool' | 'currentSnapshot'>;
  readonly gateway: ModelGateway;
  readonly contextBuilder: ContextBuilder;
  readonly clock: Clock;
  /** Warnings of the controller's capabilities, e.g. a source snapshot that could not be read (KD-10). */
  readonly logger: EngineLogger;
}

/** A decision whose capability arrives in a later release of the engine reached execution. */
class DecisionNotExecutableError extends Error {
  override readonly name = 'DecisionNotExecutableError';
}

const abandon = (cause: 'cancelled' | 'fenced'): never => abandonAttempt(CONTROLLER_WORKFLOW, cause);

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
  const capabilities = createCapabilityRegistry({
    scheduler: deps.scheduler,
    sources: deps.sourceRegistry,
    clock: deps.clock,
    logger: deps.logger,
  });

  async function finish(ctx: TaskContext, investigationId: string, end: CodeAnswerEnd): Promise<HandlerResult> {
    const claims = await repository.latestClaims(db, investigationId);
    const answer = buildCodeAnswer(randomUUID(), claims, end);
    const written = await ctx.withAttemptGuard((tx) => answers.writeAnswer(tx, investigationId, answer));
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
      case 'wait':
        return waitFor(ctx, investigation, openTasks(otherTasks(await tasksOf(investigation), ctx.taskId)));
      case 'requestEvidence':
      case 'requestAnalysis':
      case 'requestVerification':
      // Flow 3: the synthesis writes the answer and wakes the controller, which then finds it; an outcome without an
      // answer — `needs_verification` or a failure — reaches the next step through its observations.
      case 'proposeAnswer':
        return applyTasks(ctx, investigation, latest);
      default:
        throw new DecisionNotExecutableError(`decision ${latest.kind ?? 'unknown'} is not executable by this engine`);
    }
  }

  /** Ends the attempt waiting for `open` (registered through the runtime), or goes on when nothing is open. */
  async function waitFor(ctx: TaskContext, investigation: Investigation, open: readonly Task[]): Promise<StepEnd> {
    if (open.length === 0) return { next: 'continue' };
    const taskIds = open.map((task) => task.taskId);
    const registered = await ctx.registerWait(taskIds);
    if (registered.outcome !== 'ok') {
      throw new Error(`wait of investigation ${investigation.investigationId} refused: ${registered.reason}`);
    }
    return { next: 'result', result: { kind: 'wait', answerOrDelta: null, waitFor: taskIds, ...emptyResult() } };
  }

  /**
   * A decision that creates tasks: its capability proposes them once and the decision row records them; an attempt that
   * finds them recorded (a wake or a replay) does not propose again. With `await` (true by default) the attempt waits
   * for those of them still open before the next step. A request whose source gave no snapshot creates no task and is
   * recorded on the decision as unavailable; nothing waits for it (KD-10).
   */
  async function applyTasks(ctx: TaskContext, investigation: Investigation, latest: DecisionRow): Promise<StepEnd> {
    const decision = DecisionSchema.parse(latest.decision);
    let taskIds: readonly string[] = latest.proposedTaskIds;
    if (taskIds.length === 0 && unavailableRequestsOf(latest.decision).length === 0) {
      const frame = {
        ctx,
        investigationId: investigation.investigationId,
        config: investigation.config,
        notAfter: latest.notAfter ?? investigation.notAfter,
        decisionId: latest.decisionId,
      };
      const proposing = capabilities.proposeTasks(frame, decision);
      if (proposing === undefined) {
        throw new DecisionNotExecutableError(`decision ${decision.kind} is not executable by this engine`);
      }
      const proposed = await proposing;
      if (proposed.outcome === 'abandon') return abandon(proposed.cause);
      if (proposed.outcome === 'stop') return stop(ctx, investigation, proposed.reason);
      const recorded = await ctx.withAttemptGuard((tx) => recordProposedTasks(tx, latest.decisionId, proposed));
      if (recorded.outcome === 'fenced') return abandon('fenced');
      taskIds = proposed.taskIds;
    }
    if (!('await' in decision) || !decision.await) return { next: 'continue' };
    const proposedSet = new Set(taskIds);
    return waitFor(ctx, investigation, openTasks(await tasksOf(investigation)).filter((task) => proposedSet.has(task.taskId)));
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

    const [plan, claims, tasks, readRun, unread] = await Promise.all([
      repository.latestPlanRevision(db, investigationId),
      repository.latestClaims(db, investigationId),
      tasksOf(investigation).then((all) => otherTasks(all, ctx.taskId)),
      repository.readRun(db, investigationId),
      signals.unread(db, investigationId),
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
      tools: capabilities.fetchToolCatalog(config),
      signals: unread,
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

    const openTaskIds = new Set(openTasks(tasks).map((task) => task.taskId));
    const finishedTaskIds = tasks.filter((task) => !openTaskIds.has(task.taskId)).map((task) => task.taskId);
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
          ? judgeControllerOutput(answered.output, state, capabilities.fetchTools(config))
          : { verdict: 'rejected', reason: 'invalid_model_output', kind: null };
      const decisionId = randomUUID();
      const written = await ctx.withAttemptGuard(async (tx) => {
        await repository.insertDecision(tx, {
          decisionId,
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
        });
        // DC-9: a task the controller sees in a final status closes no reservation of its own any more.
        await abandonReservations(tx, investigationId, { taskIds: finishedTaskIds });
        // AC-04.1: the accepted decision is the one that read the signals of its input.
        if (verdict.verdict === 'accepted') {
          await signals.markRead(tx, decisionId, unread.map((signal) => signal.signalId));
        }
      });
      if (written.outcome === 'fenced') return abandon('fenced');
      if (verdict.verdict === 'accepted') return { next: 'continue' };
    }
    return stop(ctx, investigation, 'controller_invalid');
  }

  /** The first plan revision: the `plan` role writes it, or code seeds it with the goal without a call (KD-8). */
  async function writeFirstPlanRevision(ctx: TaskContext, investigation: Investigation): Promise<PlanRevisionResult> {
    const seed = seedPlan(investigation.config);
    if (seed === null) {
      return writePlanRevision(deps, ctx, { frame: investigation, previous: undefined, reason: null });
    }
    const written = await ctx.withAttemptGuard((tx) =>
      repository.insertPlanRevision(tx, { investigationId: investigation.investigationId, revision: 1, plan: seed, reason: null }),
    );
    return written.outcome === 'fenced' ? { outcome: 'abandon', cause: 'fenced' } : { outcome: 'revised', revision: 1 };
  }

  /**
   * Flow 5 (KD-8, invariant 10): without sources the controller model is never called and no `DecisionInput` is built.
   * After the plan, code accepts the one decision `proposeAnswer`, proposes `research.synthesize` and waits for it like
   * for any decision; the synthesis writes the answer. A synthesis that ends without one — or a configuration without
   * `synthesize` — ends the investigation with an answer by code (AC-25.5).
   */
  async function answerWithoutSources(ctx: TaskContext, investigation: Investigation): Promise<HandlerResult> {
    const { config, investigationId } = investigation;
    const accepted = async () =>
      (await repository.decisionsOf(db, investigationId)).filter((row) => row.status === 'accepted').at(-1);
    let decision = await accepted();
    if (decision === undefined) {
      const end = noSourceEnd({ capabilities: config.capabilities, synthesis: undefined });
      if (end !== null) return finish(ctx, investigationId, end);
      const plan = await repository.latestPlanRevision(db, investigationId);
      if (plan === undefined) throw new Error(`investigation ${investigationId} lost its plan`);
      const byCode = proposeAnswerByCode({
        decisionId: randomUUID(),
        investigationId,
        planRevision: plan.revision,
        notAfter: investigation.notAfter,
      });
      const written = await ctx.withAttemptGuard((tx) => repository.insertDecision(tx, byCode));
      if (written.outcome === 'fenced') return abandon('fenced');
      // A replayed attempt keeps the decision written first.
      decision = await accepted();
      if (decision === undefined) throw new Error(`investigation ${investigationId} lost its decision`);
    }
    const applied = await applyTasks(ctx, investigation, decision);
    if (applied.next === 'result') return applied.result;

    // The synthesis has ended: with the answer it wrote, or without one, and then code answers.
    const read = await repository.readRun(db, investigationId);
    if (read !== undefined && read.run.answer !== null) return completed(InvestigationAnswerSchema.parse(read.run.answer));
    const synthesis = otherTasks(await tasksOf(investigation), ctx.taskId).find((task) => task.workflowType === SYNTHESIZE_WORKFLOW);
    const end = noSourceEnd({ capabilities: config.capabilities, synthesis });
    if (end === null) throw new Error(`the synthesis of investigation ${investigationId} has not ended`);
    return finish(ctx, investigationId, end);
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
    if ((await abandonEarlierAttempts(ctx)) === 'fenced') return abandon('fenced');
    // DC-16: the mode recorded at the start, never the engine's current `connectedSources`.
    const sourceMode = row.sourceMode as SourceMode;
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
      const first = await writeFirstPlanRevision(ctx, investigation);
      if (first.outcome === 'abandon') return abandon(first.cause);
      if (first.outcome === 'stop') return finish(ctx, ctx.investigationId, { stopReason: first.reason });
    }
    if (sourceMode === 'model_knowledge') return answerWithoutSources(ctx, investigation);

    for (;;) {
      const decisions = await repository.decisionsOf(db, ctx.investigationId);
      const latest = decisions.filter((decision) => decision.status === 'accepted').at(-1);
      if (latest !== undefined) {
        const applied = await applyLatest(ctx, investigation, latest);
        if (applied.next === 'result') return applied.result;
      }
      // Applying the latest decision may have recorded its tasks: the step reads the rows as they are now.
      const current = latest === undefined ? decisions : await repository.decisionsOf(db, ctx.investigationId);
      const stepped = await takeStep(ctx, investigation, current);
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
