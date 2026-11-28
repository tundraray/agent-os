import {
  CHILD_FINISHED_KIND,
  isCodeRunCall,
  type SessionTaskStatus,
  SessionTaskStatusSchema,
} from '@agent-os/contracts';
import type { SessionPatch } from '@agent-os/db';
import {
  isFinished,
  type StepContext,
  type StepResult,
} from '@agent-os/runtime';

import { agentTasksOf } from '../task-tree';
import { modelErrorMessage } from '../model/model-client';
import type { AgentToolCall, AgentToolDefinition } from '../model/mastra-turn';
import type { NewHistoryEntry } from '../store/history';
import type { Session } from '../store/sessions';
import { memoryBlock } from '../tools/system/memory-block';
import { taskBlock, tasksOf } from '../tools/system/task-list-block';
import { callTargetOf } from '../tools/tool-registry';
import type { AgentDeps } from './agent-deps';
import type { SessionHistory } from './agent-state';
import type { BaseAgent } from './base-agent';
import { entriesOf } from './deliver';
import {
  callUnlessAborted,
  FAILURE_REASONS,
  failResult,
  logStep,
  overflowResult,
  previewEntries,
  providerMessagesOf,
  refusedResult,
  signalAttention,
  type StepPrelude,
  withStepBlocks,
} from './step-common';
import {
  type EndOfTurn,
  type EndOfTurnInput,
  noticeContent,
} from './turn-rules';
import { agentOwner } from './agent-owner';

/** Tasks that keep an agent from finishing its turn (design-task-list.md KD-4). */
const OPEN_TASK_STATUSES: readonly SessionTaskStatus[] = [
  SessionTaskStatusSchema.enum.pending,
  SessionTaskStatusSchema.enum.in_progress,
];

/** The step kind in the step log. */
const STEP_KIND = 'model';

/** After the call the step owes no entry: its debt was written before the call (KD-1). */
const writtenBeforeCall = async (): Promise<readonly NewHistoryEntry[]> => [];

/**
 * The journal fields of an answered model call (FR-07, AC-07.1, DC-10): the tools the model was shown,
 * the tools it chose in order, how many calls are direct and how many are `run_code`, and the cut-off
 * flag. Names only — never argument values (NFR-01). Calls made from inside a script are not counted here.
 */
function answerFields(
  tools: readonly AgentToolDefinition[],
  answer: {
    readonly toolCalls: readonly AgentToolCall[];
    readonly cutOff: boolean;
  },
): Record<string, unknown> {
  const toolsChosen = answer.toolCalls.map((call) => call.toolName);
  const runCodeCalls = toolsChosen.filter((name) =>
    isCodeRunCall(name, null),
  ).length;
  return {
    toolsShown: tools.length,
    toolNamesShown: tools.map((tool) => tool.name),
    toolsChosen,
    directCalls: toolsChosen.length - runCodeCalls,
    runCodeCalls,
    cutOff: answer.cutOff,
  };
}

/** Children of the agent that keep its turn from ending. */
export interface ChildrenInFlight {
  /** Children not finished yet. */
  readonly unfinished: number;
  /** `child_finished` notices pending beyond this step's messages (Notes 6). */
  readonly pending: number;
}

/**
 * What the agent knows of the model's answer without tool calls when it ends its turn; `continues` — this step
 * continues the finished agent (its prelude writes `continued`), read only by `DeepAgent`.
 */
export type TurnAnswer = Pick<
  EndOfTurnInput,
  'answerFields' | 'openTasks' | 'text' | 'cutOff'
> & { readonly continues: boolean };

/** How a turn ends, with the children the agent counted for it (the step log names them). */
export interface TurnEnd {
  readonly ending: EndOfTurn;
  readonly inFlight: ChildrenInFlight;
}

/** Children not finished yet, and `child_finished` notices pending beyond this step's messages (Notes 6). */
export async function childrenInFlight(
  deps: Pick<AgentDeps, 'tasks' | 'inbox'>,
  ctx: StepContext,
): Promise<ChildrenInFlight> {
  const tree = await deps.tasks.listTree(ctx.rootId, agentOwner(ctx));
  const unfinished = agentTasksOf(tree).filter(
    (task) => task.parentId === ctx.taskId && !isFinished(task.status),
  ).length;
  const delivered = new Set(ctx.messages.map((message) => message.messageId));
  const pendingMessages = await deps.inbox.listPending(
    ctx.taskId,
    agentOwner(ctx),
  );
  const pending = pendingMessages.filter(
    (message) =>
      message.kind === CHILD_FINISHED_KIND && !delivered.has(message.messageId),
  ).length;
  return { unfinished, pending };
}

/**
 * The model step of an agent, called by `BaseAgent.modelStep` (design-agents.md: KD-1, KD-2, KD-6, «Как шаг
 * выбирает работу» d3–d4, «Конец хода», Flow 1, Flow 2, DC-1, DC-3, DC-4, Invariants 4, 6): the delivered
 * messages, one model call, the answer with its open calls. `prelude` — what the agent writes first
 * (continuation, interrupt).
 *
 * - The turn limit spent → `fail` `turn_limit`, the delivered messages written before the `failed` event.
 * - Otherwise the prelude, the delivered messages and their session fields are written by
 *   `ctx.guardWithDelivery` before the call (runtime-fixes KD-1); fenced → `continue` without a call or a write.
 *   Then the model of the session
 *   (Invariant 6) gets the history and the session's tools. A provider that keeps failing → `fail`
 *   `model_error`; a call `AccessGate` refused → `fail` with the verdict's reason, the model not called.
 *   Each failure closes the session and resets the turn counter (DC-1).
 * - An answer with calls is written with them: they are open (`requested`) until their results;
 *   `continue`, the tool step runs them. An answer without calls ends the turn (`endOfTurn`): `wait`, a notice and `continue`, or
 *   `complete` with `{ report, document }`, the session closed and its counter reset. How the turn ends is the agent's
 *   (`endOfTurn`), as are the tools it declares (`offeredDeclaration`) and the turn counter after the delivered
 *   messages (`turnsAfterDelivery`).
 * - The first provider overflow (`context_overflow` with the session's mark clear) → `continue`: the commit sets
 *   the mark and raises `last_input_tokens` to the threshold, so the next step compacts with previews; with the
 *   mark set it fails like any `model_error` (runtime-fixes KD-5).
 * - Every commit writes the turn counter and `last_input_tokens` of the call (KD-7), and clears the overflow mark.
 */
export async function runModelStep(
  deps: AgentDeps,
  agent: Pick<
    BaseAgent,
    | 'input'
    | 'definition'
    | 'caller'
    | 'offeredDeclaration'
    | 'turnsAfterDelivery'
    | 'endOfTurn'
  >,
  ctx: StepContext,
  session: Session,
  /** The history the model sees, as the agent holds it. */
  view: SessionHistory,
  prelude?: StepPrelude,
): Promise<StepResult> {
  const { registry, modelClient, audit } = deps;
  const startedAt = Date.now();
  // The run's definition comes from its version only, never from the library now (ADR-0017; KD-6).
  const { answerFields: askedFields } = agent.input;
  const { definition } = agent;
  const turns = agent.turnsAfterDelivery(
    prelude?.patch.turns ?? session.turns,
    ctx.messages,
  );
  const delivered = await entriesOf(deps, ctx);
  const writeStepEntries = async (): Promise<NewHistoryEntry[]> => [
    ...(prelude === undefined ? [] : await prelude.write()),
    ...delivered,
  ];
  const basePatch: SessionPatch = { ...prelude?.patch };

  // The version's `maxTurns` is spent: the step fails instead of calling the model.
  if (turns >= definition.maxTurns) {
    logStep(ctx, STEP_KIND, startedAt, 'fail', {
      reason: FAILURE_REASONS.turn_limit,
      turns,
    });
    return failResult({
      deps,
      ctx,
      reason: FAILURE_REASONS.turn_limit,
      message: `Agent ${definition.name} used all ${definition.maxTurns} turns of its assignment`,
      writeEntries: writeStepEntries,
      patch: basePatch,
    });
  }

  const shown = previewEntries(view.lastSeq, [
    ...(prelude?.entries ?? []),
    ...delivered,
  ]);
  // KD-1 (runtime-fixes design-steps.md): the step's debt and its session fields lie in history before the
  // call, with the messages marked delivered; an interrupt or a stop during the call then finds the question
  // written, and a step repeated after a restart gets no message again. The commit writes only the answer.
  const debt = await ctx.guardWithDelivery(async () => {
    await deps.history.append(ctx.taskId, await writeStepEntries());
    await deps.sessionRows.update(ctx.taskId, { ...basePatch, turns });
  });
  if (debt.outcome === 'fenced') {
    logStep(ctx, STEP_KIND, startedAt, 'continue', {
      fenced: true,
      deliveredMessages: ctx.messages.length,
    });
    return { outcome: 'continue' };
  }
  // Memory is live data read beside the version on every step (design-memory.md KD-3); a failed read fails the step.
  const memory = await memoryBlock(deps, agent.caller, ctx.logger);
  // The task list too (design-task-list.md KD-2): only a tool step changes it, so `endOfTurn` below reads the
  // same tasks.
  const declaration = await agent.offeredDeclaration(ctx);
  const tasks = await tasksOf(deps, ctx.taskId, declaration.taskList);
  // The owner the runtime names and what the agent declares: the library answers with the session's tools.
  const sessionTools = await registry.toolsFor(agentOwner(ctx), declaration);
  const result = await callUnlessAborted(ctx, () =>
    modelClient.call({
      ownerId: agentOwner(ctx),
      rootId: ctx.rootId,
      taskId: ctx.taskId,
      agentName: definition.name,
      model: session.model,
      instructions: withStepBlocks(definition.prompt, {
        memory,
        tasks: taskBlock(tasks),
      }),
      messages: providerMessagesOf(view, shown),
      tools: sessionTools,
      streamsText: true,
      signal: ctx.signal,
      logger: ctx.logger,
      training: agent.caller.training,
    }),
  );
  if (result === undefined) return { outcome: 'continue' };

  if (result.kind === 'not_started') {
    return refusedResult({
      deps,
      ctx,
      stepKind: STEP_KIND,
      startedAt,
      model: session.model,
      refusal: result.verdict,
      audit,
      writeEntries: writtenBeforeCall,
      patch: {},
    });
  }
  if (
    result.kind === 'model_error' &&
    result.reason === FAILURE_REASONS.context_overflow &&
    !session.overflowed
  ) {
    return overflowResult({
      deps,
      ctx,
      stepKind: STEP_KIND,
      startedAt,
      session,
      writeEntries: writtenBeforeCall,
      patch: {},
    });
  }
  if (result.kind === 'model_error') {
    logStep(ctx, STEP_KIND, startedAt, 'fail', {
      reason: result.reason,
      provider: result.provider,
      statusCode: result.statusCode,
    });
    return failResult({
      deps,
      ctx,
      reason: result.reason,
      message: modelErrorMessage(session.model, result),
      writeEntries: writtenBeforeCall,
      patch: {},
    });
  }

  const counted = turns + 1;
  // A model answer ends an overflow (KD-5): the mark is cleared, and the log shows the recovery.
  const answered = {
    ...answerFields(sessionTools, result),
    overflowCleared: session.overflowed,
  };
  const answerEntry: NewHistoryEntry = {
    kind: 'model_answer',
    content: {
      text: result.text,
      toolCalls: result.toolCalls.map((call) => ({
        callId: call.toolCallId,
        // A name the session does not offer stays as the model wrote it: the tool step refuses it.
        ...callTargetOf(sessionTools, call.toolName),
        args: call.args,
      })),
    },
  };
  const callPatch: SessionPatch = {
    turns: counted,
    lastInputTokens: result.usage.inputTokens,
    overflowed: false,
  };
  const writeAnswer = async (
    after: readonly NewHistoryEntry[],
    patch: SessionPatch,
  ): Promise<void> => {
    await deps.history.append(ctx.taskId, [answerEntry, ...after]);
    await deps.sessionRows.update(ctx.taskId, patch);
  };
  // An answer that ends the root's turn calls the employee (live-feed KD-4); a subagent's answer does not.
  const writeTurnEnd = async (patch: SessionPatch): Promise<void> => {
    await writeAnswer([], patch);
    if (ctx.parentId === null) await signalAttention(deps, ctx, 'answer');
  };

  if (result.toolCalls.length > 0) {
    logStep(ctx, STEP_KIND, startedAt, 'continue', {
      toolCalls: result.toolCalls.length,
      turns: counted,
      ...answered,
    });
    return {
      outcome: 'continue',
      commit: () => writeAnswer([], callPatch),
    };
  }

  const { ending, inFlight } = await agent.endOfTurn(ctx, {
    answerFields: (askedFields ?? []).map((field) => field.name),
    openTasks: tasks.filter((task) => OPEN_TASK_STATUSES.includes(task.status)),
    text: result.text,
    cutOff: result.cutOff,
    continues: prelude?.patch.closed === false,
  });

  switch (ending.kind) {
    case 'wait':
      logStep(ctx, STEP_KIND, startedAt, 'wait', {
        turns: counted,
        unfinishedChildren: inFlight.unfinished,
        pendingChildNotices: inFlight.pending,
        ...answered,
      });
      return {
        outcome: 'wait',
        commit: () => writeTurnEnd(callPatch),
      };
    case 'notice':
      if (ending.openTasks !== undefined) {
        // Every reminder is logged, numbers only, so how often an agent answers with tasks open shows (Risks).
        ctx.logger.info('agent reminded of open tasks', {
          agentId: ctx.taskId,
          rootId: ctx.rootId,
          ownerId: ctx.ownerId,
          stepNo: ctx.stepNo,
          openTasks: ending.openTasks,
        });
      }
      if (ending.missingReport !== undefined) {
        // Likewise each answer refused for lacking the final subagent's completed answer.
        ctx.logger.info('deep agent reminded of the final subagent report', {
          agentId: ctx.taskId,
          rootId: ctx.rootId,
          ownerId: ctx.ownerId,
          stepNo: ctx.stepNo,
          finalSubagent: ending.missingReport,
        });
      }
      logStep(ctx, STEP_KIND, startedAt, 'continue', {
        notice: true,
        turns: counted,
        ...answered,
      });
      return {
        outcome: 'continue',
        commit: () =>
          writeAnswer(
            [{ kind: 'notice', content: noticeContent(ending) }],
            callPatch,
          ),
      };
    case 'complete':
      logStep(ctx, STEP_KIND, startedAt, 'complete', {
        turns: counted,
        ...answered,
      });
      return {
        outcome: 'complete',
        result: { report: ending.report, document: ending.document },
        commit: () => writeTurnEnd({ ...callPatch, turns: 0, closed: true }),
      };
  }
}
