import { FailureClassSchema } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type {
  HandlerResult,
  InvestigationService,
  RuntimeTx,
  TaskContext,
  TaskHandler,
  TaskScheduler,
  UpstreamTask,
} from '@agent-os/runtime';
import { z } from 'zod';
import type { AgentDefinition } from '../config/agent-config.schema.js';
import { ENGINE_FAILURE_CLASSES } from '../engine-errors.js';
import { abandonEarlierAttempts } from '../model/ledger.js';
import type { AgentTurnAnswer, ModelGateway } from '../model/model-gateway.js';
import { promptVersion } from '../model/prompt-version.js';
import type { AgentToolDefinition } from '../model/role-agent.js';
import type { EngineLogger } from '../ports.js';
import { type AgentRunRow, agentRunsRepository as agentRuns } from './agent-runs.repository.js';
import {
  AGENT_ROOT_WORKFLOW,
  AGENT_RUN_WORKFLOW,
  AGENT_WORKFLOW_VERSION,
  type AgentTaskInput,
  AgentTaskInputSchema,
  runNotAfter,
} from './agent-task-spec.js';
import { childCallEnding } from './child-failure.js';
import type { AgentRegistries } from './definition-check.js';
import { closureStep, type FormRun, runForcedEnd, runPrologue } from './process-code.js';
import type { ResultForm } from './result-forms.js';
import {
  answerMessage,
  noticeMessage,
  readHeldStage,
  readRunFrame,
  type RunFrame,
  type RunSession,
  sessionViewOf,
  toRunSession,
} from './run-session.js';
import type { SessionView, WindowStage } from './session-window.js';
import { sessionRepository as sessions } from './session.repository.js';
import type { ToolAccessPolicy } from './tool-access-policy.js';
import { type ToolCallRow, toolCallsRepository as toolCalls } from './tool-calls.repository.js';
import { baseImmediateTools, createToolExecutor, POSTGRES_AGENT_TREE, type ToolExecutor } from './tool-executor.js';
import { agentToolsOf } from './tool-registry.js';
import type { AgentRunContext } from './tools/tool-context.js';
import {
  decideAfterTurn,
  decideAnswer,
  decideNextTurn,
  decideView,
  routeFailure,
  toolsOfTurn,
  type TurnFailureCode,
} from './turn-rules.js';

/**
 * `AgentRunHandler` (design-agent-core.md, KD-1, KD-6, C4 «один ход», Flow 1, Flow 2): the handler of the tasks
 * `agent.run` and `agent.root`, version 1. One attempt reads the run and its session, decides where to go on after a
 * restart, makes turns — each one gateway request with the run's view and the definition's tools, none of them run by
 * the model — executes the calls, waits for child tasks and returns the result, a failure, `wait` or `yield`. The run's
 * state lives in the engine's tables only (ADR-0001): no Mastra `Memory`, no `DurableAgent`.
 */

/** The agent options of `createEngine` with the design's and the runtime's defaults (Runtime Settings). */
export interface AgentRunTimings {
  /** `AGENT_TURN_MS`. */
  readonly turnMs: number;
  /** `AGENT_DEADLINE_MARGIN_MS`. */
  readonly deadlineMarginMs: number;
  /** `AGENT_ATTEMPT_SLICE_MS`. */
  readonly attemptSliceMs: number;
  /** `AGENT_BUSY_WAIT_MS`. */
  readonly busyWaitMs: number;
  /** `RUNTIME_LEASE_MS`. */
  readonly leaseMs: number;
}

export interface AgentRunHandlerDeps {
  readonly database: Database;
  readonly scheduler: Pick<TaskScheduler, 'propose'>;
  readonly investigations: Pick<InvestigationService, 'listForThread'>;
  readonly gateway: Pick<ModelGateway, 'turn'>;
  readonly registries: AgentRegistries;
  readonly accessPolicy: ToolAccessPolicy;
  readonly timings: AgentRunTimings;
  readonly clock: { now(): Date };
  readonly logger: EngineLogger;
}

/** The attempt ends without an outcome: a cancel or a lost attempt; the runtime decides it by the abort or the fence. */
class AttemptAbandonedError extends Error {
  override readonly name = 'AttemptAbandonedError';
}

function abandon(cause: 'cancelled' | 'fenced'): never {
  throw new AttemptAbandonedError(`agent run attempt ended without an outcome: ${cause}`);
}

/** The fields of a result that an agent run never fills: it writes no evidence and proposes through the scheduler. */
const emptyResult = () => ({
  answerOrDelta: null,
  evidenceRefs: [],
  coverage: null,
  missingEvidence: [],
  warnings: [],
  proposedTasks: [],
});

/** What a run that ends with a result returns: the result, which the parent also reads from the run row. */
const completed = (result: unknown): HandlerResult => ({
  ...emptyResult(),
  kind: 'completed',
  answerOrDelta: z.json().parse({ result }),
});

const yielded = (): HandlerResult => ({ ...emptyResult(), kind: 'yield' });

function failedResult(ctx: TaskContext, failure: StoredFailure): HandlerResult {
  return {
    ...emptyResult(),
    kind: 'failed',
    failure: { ...failure, cause: null, attempt: ctx.attempt, toolCalls: 0, retries: 0 },
  };
}

/** The failure a run records in its row when it ends without a result. */
const StoredFailureSchema = z.object({ class: FailureClassSchema, code: z.string().min(1), message: z.string() });
type StoredFailure = z.infer<typeof StoredFailureSchema>;

/** The codes a run fails with: those of its turns, which go through the forced end first, and those of its prologue. */
type RunFailureCode = TurnFailureCode | 'prologue_oversize' | 'prologue_refused';

const failureOf = (code: RunFailureCode, message: string): StoredFailure => ({
  class: ENGINE_FAILURE_CLASSES[code],
  code,
  message,
});

/** Final statuses of a child task: the parent writes its outcome into the session. */
const FINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** Everything one attempt of a run works with, read at its start. */
interface Attempt {
  readonly ctx: TaskContext;
  readonly input: AgentTaskInput;
  readonly frame: RunFrame;
  readonly definition: AgentDefinition;
  readonly form: ResultForm;
  readonly tools: readonly AgentToolDefinition[];
  readonly run: AgentRunContext;
  readonly row: AgentRunRow;
  readonly startedAt: Date;
}

export function createAgentRunHandlers(deps: AgentRunHandlerDeps): TaskHandler[] {
  const { database, timings } = deps;
  const executor: ToolExecutor = createToolExecutor({
    registry: deps.registries.tools,
    tools: baseImmediateTools(deps.registries.tools),
    accessPolicy: deps.accessPolicy,
    calls: toolCalls,
    tree: POSTGRES_AGENT_TREE,
    scheduler: deps.scheduler,
    investigations: deps.investigations,
    clock: deps.clock,
    timings: { deadlineMarginMs: timings.deadlineMarginMs, leaseMs: timings.leaseMs },
  });

  /** A guarded write in the mode `requireActive`; a stop or a lost attempt ends the attempt without an outcome. */
  async function guarded<T>(ctx: TaskContext, work: (tx: RuntimeTx) => Promise<T>): Promise<T> {
    const result = await ctx.withAttemptGuard(work, { requireActive: true });
    if (result.outcome === 'committed') return result.value;
    return abandon(result.outcome === 'stopping' ? 'cancelled' : 'fenced');
  }

  /** The run row: written once by the first attempt from its task input (Data Model), read by every later one. */
  async function ensureRunRow(ctx: TaskContext, input: AgentTaskInput, definition: AgentDefinition, form: ResultForm) {
    const existing = await agentRuns.read(database, ctx.taskId);
    if (existing !== undefined) return existing;
    const parent = input.parent === null ? undefined : await agentRuns.read(database, input.parent.taskId);
    const notAfter = runNotAfter({
      taskDeadlineAt: ctx.deadlineAt,
      deadlineMarginMs: timings.deadlineMarginMs,
      inputNotAfter: new Date(input.notAfter),
      parent: parent === undefined ? null : { notAfter: parent.notAfter, leaseMs: timings.leaseMs },
    });
    await guarded(ctx, (tx) =>
      agentRuns.insert(tx, {
        taskId: ctx.taskId,
        investigationId: ctx.investigationId,
        agentName: input.agentName,
        parent: input.parent,
        depth: input.depth,
        assignment: form.prologue === undefined ? input.assignment : null,
        shareTokens: ctx.budget.maxTokens,
        notAfter,
        sources: input.sources,
      }),
    );
    const written = await agentRuns.read(database, ctx.taskId);
    if (written === undefined) throw new Error(`run row of task ${ctx.taskId} is missing after its write`);
    return written;
  }

  async function begin(ctx: TaskContext): Promise<Attempt> {
    const input = AgentTaskInputSchema.parse(ctx.input);
    const frame = await readRunFrame(database, ctx.investigationId);
    const definition = Object.hasOwn(frame.config.agents, input.agentName) ? frame.config.agents[input.agentName] : undefined;
    if (definition === undefined) throw new Error(`agent ${input.agentName} is not a definition of the investigation`);
    const form = deps.registries.forms.get(definition.result);
    if (form === undefined) throw new Error(`result form ${definition.result} is not in the registry`);
    const row = await ensureRunRow(ctx, input, definition, form);
    const run: AgentRunContext = {
      runTaskId: ctx.taskId,
      investigationId: ctx.investigationId,
      resourceId: frame.resourceId,
      threadId: frame.threadId,
      agentName: input.agentName,
      definition,
      config: frame.config,
      resultSchema: form.resultSchema,
      depth: row.depth,
      shareTokens: row.shareTokens,
      sources: row.sources,
      notAfter: row.notAfter,
    };
    const tools = agentToolsOf(definition.tools, { registry: deps.registries.tools, resultSchema: form.resultSchema });
    return { ctx, input, frame, definition, form, tools, run, row, startedAt: deps.clock.now() };
  }

  /** The session with its calls, as the window rule reads it. */
  async function readSession(ctx: TaskContext): Promise<{ readonly session: RunSession; readonly calls: ToolCallRow[] }> {
    const [rows, calls] = await Promise.all([sessions.read(database, ctx.taskId), toolCalls.ofRun(database, ctx.taskId)]);
    return { session: toRunSession(rows, calls), calls };
  }

  /** What the form's process code works with for this run (KD-8). */
  function formRunOf(attempt: Attempt): FormRun {
    const { ctx, form, frame, definition, input } = attempt;
    return {
      ctx,
      form,
      context: {
        investigationId: ctx.investigationId,
        resourceId: frame.resourceId,
        runTaskId: ctx.taskId,
        agentName: input.agentName,
        definition,
        assignment: form.prologue === undefined ? input.assignment : null,
        sourceMode: frame.sourceMode,
      },
      assignment: input.assignment,
      snapshotEntries: frame.snapshot[input.agentName] ?? [],
      guarded: (work) => guarded(ctx, work),
    };
  }

  /**
   * An empty session gets its opening: the assignment, or — for a form with a prologue — the prologue's first message, or
   * the prologue's accepted `end` without a model turn (DC-19, DC-26). Null when the run goes on to its turns.
   */
  async function openSession(attempt: Attempt): Promise<HandlerResult | null> {
    if (attempt.form.prologue !== undefined) {
      const opened = await runPrologue(formRunOf(attempt));
      if (opened.kind === 'started') return null;
      if (opened.kind === 'completed') return completed(opened.result);
      return recordFailure(attempt, failureOf(opened.code, opened.message));
    }
    const owner = { runTaskId: attempt.ctx.taskId, investigationId: attempt.ctx.investigationId };
    await guarded(attempt.ctx, async (tx) => {
      if ((await sessions.read(tx, attempt.ctx.taskId)).length > 0) return;
      await sessions.append(tx, owner, [{ kind: 'assignment', content: { text: attempt.input.assignment } }]);
    });
    return null;
  }

  /**
   * Ends the run where a turn would fail it (DC-21, DC-30): the form's forced end for the code runs first, and its
   * `result` completes the run; without one, or on `none`, the run fails with the code.
   */
  async function fail(attempt: Attempt, code: TurnFailureCode, message: string): Promise<HandlerResult> {
    const route = routeFailure(code, attempt.form);
    if (route.kind === 'forced_end') {
      const turn = (await readSession(attempt.ctx)).session.turnsTaken;
      const ended = await runForcedEnd(formRunOf(attempt), route.code, turn);
      if (ended.kind === 'result') return completed(ended.result);
    }
    return recordFailure(attempt, failureOf(code, message));
  }

  /** The failure is recorded once in the run row; the parent reads its class and code from the task. */
  async function recordFailure(attempt: Attempt, failure: StoredFailure): Promise<HandlerResult> {
    const { code } = failure;
    await guarded(attempt.ctx, (tx) => agentRuns.writeEnding(tx, attempt.ctx.taskId, { failure }));
    deps.logger.warn('agent run failed', {
      investigationId: attempt.ctx.investigationId,
      taskId: attempt.ctx.taskId,
      outcome: code,
    });
    return failedResult(attempt.ctx, failure);
  }

  /**
   * A lone `finish` whose result passed its form's schema goes through the form's closure (DC-20): accepted — the
   * closure's rows, the call's outcome and the run's result in one guarded write; refused — the closure's rows and the
   * call refused `invalid_result`, and the run goes on (null).
   */
  async function complete(
    attempt: Attempt,
    finish: { readonly callId: string; readonly result: unknown },
  ): Promise<HandlerResult | null> {
    const written = await toolCalls.transition(
      attempt.ctx,
      { callId: finish.callId, from: ['requested'] },
      closureStep(formRunOf(attempt), finish),
    );
    if (written.outcome === 'fenced') return abandon('fenced');
    if (written.outcome === 'stopping') return abandon('cancelled');
    if (written.call.state === 'rejected') return null;
    const row = await agentRuns.read(database, attempt.ctx.taskId);
    return completed(row?.result ?? finish.result);
  }

  /** The `call_agent` result limit of the registry: a child's result in the parent's session is cut to it. */
  const childResultMaxBytes = deps.registries.tools.get('call_agent')?.resultMaxBytes ?? 0;

  /**
   * A child's result, or `child_failed` with its reason from the closed list (DC-6), ends its call (`waiting` → `done`)
   * with the spend of the child's subtree.
   */
  async function endChildCall(attempt: Attempt, call: ToolCallRow, child: UpstreamTask): Promise<void> {
    const ended = await toolCalls.transition(attempt.ctx, { callId: call.id, from: ['waiting'] }, (tx) =>
      childCallEnding(tx, call, child, childResultMaxBytes),
    );
    if (ended.outcome === 'fenced') abandon('fenced');
    if (ended.outcome === 'stopping') abandon('cancelled');
  }

  /**
   * Step 1 after a wake (DC-5): the waiting calls whose child task is final get its result or reason, in the order of
   * the calls, so the results of one turn's children stand in the parent's session in call order.
   */
  async function collectChildren(attempt: Attempt, calls: readonly ToolCallRow[]): Promise<void> {
    const upstream = new Map(attempt.ctx.upstream.map((task) => [task.taskId, task]));
    for (const call of calls) {
      if (call.state !== 'waiting' || call.childTaskId === null) continue;
      const child = upstream.get(call.childTaskId);
      if (child !== undefined && FINAL.has(child.status)) await endChildCall(attempt, call, child);
    }
  }

  /** Writes the answer of a turn with its calls (`requested`) and, without a call, the notice `no_tool_call` (DC-2). */
  function answerWriter(attempt: Attempt, turn: number) {
    return async (tx: RuntimeTx, answer: AgentTurnAnswer): Promise<void> => {
      const owner = { runTaskId: attempt.ctx.taskId, investigationId: attempt.ctx.investigationId };
      const firstCallIndex = (await toolCalls.ofRun(tx, attempt.ctx.taskId)).length;
      const message = answerMessage(turn, answer, firstCallIndex);
      await sessions.append(tx, owner, [{ ...message, llmCallId: answer.callId }]);
      await toolCalls.insertRequested(
        tx,
        { investigationId: attempt.ctx.investigationId, runTaskId: attempt.ctx.taskId, turn },
        message.content.toolCalls.map((call) => ({ callIndex: call.callIndex, toolName: call.toolName, arguments: call.args })),
      );
      if (answer.toolCalls.length === 0) {
        await sessions.append(tx, owner, [noticeMessage(turn, 'no_tool_call')]);
      }
    };
  }

  function viewOf(attempt: Attempt, session: RunSession, heldStage: WindowStage): SessionView {
    const { frame, definition, tools } = attempt;
    return sessionViewOf({ frame, agentName: attempt.input.agentName, definition, tools, session, heldStage });
  }

  type TurnStep =
    | { readonly kind: 'recorded' }
    | { readonly kind: 'yield' }
    | { readonly kind: 'fail'; readonly code: TurnFailureCode; readonly message: string };

  /**
   * One turn (steps 2–4): the view from the held stage, one gateway request with the window's input limit; a counted
   * input over the window sends the same turn again at the next stage (DC-30), and the stage it reached is held.
   */
  async function makeTurn(
    attempt: Attempt,
    turn: { readonly turn: number; readonly last: boolean },
    held: { stage: WindowStage },
  ): Promise<TurnStep> {
    const { ctx, definition } = attempt;
    const chosen = toolsOfTurn(attempt.tools, turn.last);
    for (;;) {
      const { session } = await readSession(ctx);
      const view = viewOf(attempt, session, held.stage);
      if (decideView(view).kind === 'fail') {
        return { kind: 'fail', code: 'context_overflow', message: 'the view does not fit the window at stage 4' } as const;
      }
      const result = await deps.gateway.turn({
        ctx,
        agentName: attempt.input.agentName,
        definition: {
          model: definition.model,
          effort: definition.effort,
          maxOutputTokens: definition.limits.maxOutputTokens,
          marginTokens: definition.limits.marginTokens,
        },
        promptVersion: promptVersion(definition.prompt),
        instructions: view.instructions,
        messages: view.messages,
        tools: chosen.tools,
        toolChoice: chosen.toolChoice,
        inputLimitTokens: definition.limits.windowTokens - definition.limits.marginTokens,
        transcriptInput: {
          instructions: view.instructions,
          view: {
            throughSeq: view.throughSeq,
            stubbedCalls: view.stubbedCalls,
            collapsedTurns: view.collapsedTurns,
            stage: view.stage,
          },
        },
        notAfter: attempt.run.notAfter,
        busyWaitMs: timings.busyWaitMs,
        writeAnswer: answerWriter(attempt, turn.turn),
      });
      const step = decideAnswer(result, view.stage);
      switch (step.kind) {
        case 'record':
          held.stage = view.stage;
          return { kind: 'recorded' } as const;
        case 'next_stage':
          held.stage = step.stage;
          continue;
        case 'yield':
          return { kind: 'yield' } as const;
        case 'abandon':
          return abandon(step.cause);
        case 'fail':
          return { kind: 'fail', code: step.code, message: `the turn ended ${step.code}` } as const;
      }
    }
  }

  /** The notice of the last turn, written once before it (Contract «Сообщения кода в сессии»). */
  async function noteLastTurn(attempt: Attempt, session: RunSession): Promise<void> {
    const after = session.turnsTaken;
    if (session.notices.has(`${after}:last_turn`)) return;
    const owner = { runTaskId: attempt.ctx.taskId, investigationId: attempt.ctx.investigationId };
    await guarded(attempt.ctx, (tx) => sessions.append(tx, owner, [noticeMessage(after, 'last_turn')]));
  }

  async function registerWait(ctx: TaskContext, waitFor: readonly string[]): Promise<HandlerResult> {
    const registered = await ctx.registerWait(waitFor);
    if (registered.outcome === 'rejected') {
      if (registered.reason === 'investigation_inactive') return abandon('cancelled');
      throw new Error(`wait of run ${ctx.taskId} refused: ${registered.reason}`);
    }
    return { ...emptyResult(), kind: 'wait', waitFor: [...waitFor] };
  }

  async function run(ctx: TaskContext): Promise<HandlerResult> {
    if ((await abandonEarlierAttempts(ctx)) === 'fenced') return abandon('fenced');
    const attempt = await begin(ctx);
    // DC-23: a run whose result or failure is recorded ends with it, without a new turn.
    if (attempt.row.result !== null) return completed(attempt.row.result);
    if (attempt.row.failure !== null) return failedResult(ctx, StoredFailureSchema.parse(attempt.row.failure));
    if ((await sessions.read(database, ctx.taskId)).length === 0) {
      const opened = await openSession(attempt);
      if (opened !== null) return opened;
    }

    const held = { stage: await readHeldStage(database, ctx.taskId) };
    for (;;) {
      const read = await readSession(ctx);
      const turn = read.session.turnsTaken;
      const ofTurn = read.calls.filter((call) => call.turn === turn);
      if (turn > 0) {
        await collectChildren(attempt, ofTurn);
        const current = (await toolCalls.ofRun(database, ctx.taskId)).filter((call) => call.turn === turn);
        const execution = await executor.executeTurn(ctx, attempt.run, current);
        if (execution.outcome !== 'executed') return abandon(execution.outcome === 'stopping' ? 'cancelled' : 'fenced');
        const after = decideAfterTurn({ ...execution, turn, maxTurns: attempt.definition.limits.maxTurns });
        if (after.kind === 'complete') {
          const ended = await complete(attempt, after.finish);
          if (ended !== null) return ended;
          continue;
        }
        if (after.kind === 'wait') return registerWait(ctx, after.waitFor);
        if (after.kind === 'fail') return fail(attempt, after.code, 'the last turn did not end the run');
      }

      const next = decideNextTurn({
        turnsTaken: turn,
        maxTurns: attempt.definition.limits.maxTurns,
        now: deps.clock.now(),
        notAfter: attempt.run.notAfter,
        turnMs: timings.turnMs,
        attemptStartedAt: attempt.startedAt,
        attemptSliceMs: timings.attemptSliceMs,
      });
      if (next.kind === 'yield') return yielded();
      if (next.kind === 'fail') return fail(attempt, next.code, `no turn started: ${next.code}`);
      if (next.last) await noteLastTurn(attempt, read.session);

      const step: TurnStep = await makeTurn(attempt, next, held);
      if (step.kind === 'yield') return yielded();
      if (step.kind === 'fail') return fail(attempt, step.code, step.message);
    }
  }

  const handlerOf = (workflowType: string): TaskHandler => ({
    workflowType,
    workflowVersion: AGENT_WORKFLOW_VERSION,
    inputSchema: AgentTaskInputSchema,
    run,
  });
  return [handlerOf(AGENT_ROOT_WORKFLOW), handlerOf(AGENT_RUN_WORKFLOW)];
}

