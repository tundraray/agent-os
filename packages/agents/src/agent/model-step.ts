import {
  CHILD_FINISHED_KIND,
  RUN_CODE_TOOL,
  type SessionTaskStatus,
  SessionTaskStatusSchema,
} from '@agent-os/contracts';
import type { SessionPatch } from '@agent-os/db';
import { isFinished, type StepContext, type StepEffects, type StepResult } from '@agent-os/runtime';

import { knowledgeBlock } from '../knowledge/knowledge-block';
import { modelErrorMessage } from '../model/model-client';
import type { AgentToolCall, AgentToolDefinition } from '../model/mastra-turn';
import type { NewHistoryEntry } from '../store/history';
import type { Session } from '../store/sessions';
import { taskBlock, tasksOf } from '../tools/system/task-list-block';
import { callTargetOf } from '../tools/tool-registry';
import type { AgentDeps } from './agent-deps';
import type { SessionHistory } from './agent-state';
import type { BaseAgent } from './base-agent';
import { entriesOf } from './deliver';
import {
  appendWithEvent,
  callUnlessAborted,
  FAILURE_REASONS,
  failResult,
  logStep,
  previewEntries,
  providerMessagesOf,
  refusedResult,
  type StepPrelude,
  withStepBlocks,
} from './step-common';
import { type EndOfTurn, type EndOfTurnInput, noticeContent } from './turn-rules';

/** Tasks that keep an agent from finishing its turn (design-task-list.md KD-4). */
const OPEN_TASK_STATUSES: readonly SessionTaskStatus[] = [
  SessionTaskStatusSchema.enum.pending,
  SessionTaskStatusSchema.enum.in_progress,
];

/** The step kind in the step log. */
const STEP_KIND = 'model';

/**
 * The journal fields of an answered model call (FR-07, AC-07.1, DC-10): the tools the model was shown,
 * the tools it chose in order, how many calls are direct and how many are `run_code`, and the cut-off
 * flag. Names only — never argument values (NFR-01). Calls made from inside a script are not counted here.
 */
function answerFields(
  tools: readonly AgentToolDefinition[],
  answer: { readonly toolCalls: readonly AgentToolCall[]; readonly cutOff: boolean },
): Record<string, unknown> {
  const toolsChosen = answer.toolCalls.map((call) => call.toolName);
  const runCodeCalls = toolsChosen.filter((name) => name === RUN_CODE_TOOL).length;
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

/** What the agent knows of the model's answer without tool calls when it ends its turn. */
export type TurnAnswer = Pick<EndOfTurnInput, 'answerFields' | 'openTasks' | 'text' | 'cutOff'>;

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
  const tree = await deps.tasks.listTree(ctx.rootId, ctx.ownerId);
  const unfinished = tree.filter((task) => task.parentId === ctx.taskId && !isFinished(task.status)).length;
  const delivered = new Set(ctx.messages.map((message) => message.messageId));
  const pendingMessages = await deps.inbox.listPending(ctx.taskId, ctx.ownerId);
  const pending = pendingMessages.filter(
    (message) => message.kind === CHILD_FINISHED_KIND && !delivered.has(message.messageId),
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
 * - Otherwise the delivered messages go to history before the call, and the model of the session
 *   (Invariant 6) gets the history and the session's tools. A provider that keeps failing → `fail`
 *   `model_error`; a call `AccessGate` refused → `fail` with the verdict's reason, the model not called.
 *   Each failure closes the session and resets the turn counter (DC-1).
 * - An answer with calls is written with them: they are open (`requested`) until their results;
 *   `continue`, the tool step runs them. An answer without calls ends the turn (`endOfTurn`): `wait`, a notice and `continue`, or
 *   `complete` with `{ report }`, the session closed and its counter reset. How the turn ends is the agent's
 *   (`endOfTurn`), as are the tools it declares (`offeredDeclaration`) and the turn counter after the delivered
 *   messages (`turnsAfterDelivery`).
 * - Every commit writes the turn counter, `last_input_tokens` of the call (KD-7) and
 *   `agents.history_appended`.
 */
export async function runModelStep(
  deps: AgentDeps,
  agent: Pick<BaseAgent, 'input' | 'definition' | 'offeredDeclaration' | 'turnsAfterDelivery' | 'endOfTurn'>,
  ctx: StepContext,
  session: Session,
  /** The history the model sees, as the agent holds it. */
  view: SessionHistory,
  prelude?: StepPrelude,
): Promise<StepResult> {
  const { registry, modelClient, audit } = deps;
  const startedAt = Date.now();
  // The run's definition comes from its snapshot only, never from the library now (ADR-0017).
  const { snapshot, answerFields: askedFields } = agent.input;
  const { definition } = agent;
  const turns = agent.turnsAfterDelivery(prelude?.patch.turns ?? session.turns, ctx.messages);
  const delivered = await entriesOf(deps, ctx.messages);
  const writeStepEntries = async (): Promise<NewHistoryEntry[]> => [
    ...(prelude === undefined ? [] : await prelude.write()),
    ...delivered,
  ];
  const basePatch: SessionPatch = { ...prelude?.patch };

  // The snapshot's `maxTurns` is spent: the step fails instead of calling the model.
  if (turns >= definition.maxTurns) {
    logStep(ctx, STEP_KIND, startedAt, 'fail', { reason: FAILURE_REASONS.turn_limit, turns });
    return failResult({
      deps,
      ctx,
      reason: FAILURE_REASONS.turn_limit,
      message: `Agent ${definition.name} used all ${definition.maxTurns} turns of its assignment`,
      writeEntries: writeStepEntries,
      patch: basePatch,
    });
  }

  const shown = previewEntries(view.lastSeq, [...(prelude?.entries ?? []), ...delivered]);
  // The graph is live data read beside the snapshot on every step (KD-6); a failed read fails the step.
  const knowledge = await knowledgeBlock(deps, { snapshot, taskId: ctx.taskId, logger: ctx.logger });
  // The task list too (design-task-list.md KD-2): only a tool step changes it, so `endOfTurn` below reads the
  // same tasks.
  const declaration = await agent.offeredDeclaration(ctx);
  const tasks = await tasksOf(deps, ctx.taskId, declaration.taskList);
  // The owner the runtime names and what the agent declares: the library answers with the session's tools.
  const sessionTools = await registry.toolsFor(ctx.ownerId, declaration);
  const result = await callUnlessAborted(ctx, () =>
    modelClient.call({
      ownerId: ctx.ownerId,
      rootId: ctx.rootId,
      taskId: ctx.taskId,
      agentName: definition.name,
      model: session.model,
      instructions: withStepBlocks(definition.prompt, { knowledge, tasks: taskBlock(tasks) }),
      messages: providerMessagesOf(view, shown),
      tools: sessionTools,
      streamsText: true,
      signal: ctx.signal,
      logger: ctx.logger,
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
      writeEntries: writeStepEntries,
      patch: basePatch,
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
      writeEntries: writeStepEntries,
      patch: basePatch,
    });
  }

  const counted = turns + 1;
  const answered = answerFields(sessionTools, result);
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
    modelCallId: result.modelCallId,
  };
  const callPatch: SessionPatch = {
    ...basePatch,
    turns: counted,
    lastInputTokens: result.usage.inputTokens,
  };
  const writeAnswer = async (
    effects: StepEffects,
    after: readonly NewHistoryEntry[],
    patch: SessionPatch,
  ): Promise<void> => {
    await appendWithEvent(deps, effects, ctx.taskId, [
      ...(await writeStepEntries()),
      answerEntry,
      ...after,
    ]);
    await deps.sessionRows.update(ctx.taskId, patch);
  };

  if (result.toolCalls.length > 0) {
    logStep(ctx, STEP_KIND, startedAt, 'continue', {
      toolCalls: result.toolCalls.length,
      turns: counted,
      ...answered,
    });
    return {
      outcome: 'continue',
      commit: (effects) => writeAnswer(effects, [], callPatch),
    };
  }

  const { ending, inFlight } = await agent.endOfTurn(ctx, {
    answerFields: (askedFields ?? []).map((field) => field.name),
    openTasks: tasks.filter((task) => OPEN_TASK_STATUSES.includes(task.status)),
    text: result.text,
    cutOff: result.cutOff,
  });

  switch (ending.kind) {
    case 'wait':
      logStep(ctx, STEP_KIND, startedAt, 'wait', {
        turns: counted,
        unfinishedChildren: inFlight.unfinished,
        pendingChildNotices: inFlight.pending,
        ...answered,
      });
      return { outcome: 'wait', commit: (effects) => writeAnswer(effects, [], callPatch) };
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
      logStep(ctx, STEP_KIND, startedAt, 'continue', { notice: true, turns: counted, ...answered });
      return {
        outcome: 'continue',
        commit: (effects) =>
          writeAnswer(effects, [{ kind: 'notice', content: noticeContent(ending) }], callPatch),
      };
    case 'complete':
      logStep(ctx, STEP_KIND, startedAt, 'complete', { turns: counted, ...answered });
      return {
        outcome: 'complete',
        result: { report: ending.report },
        commit: (effects) =>
          writeAnswer(effects, [], { ...callPatch, turns: 0, closed: true }),
      };
  }
}
