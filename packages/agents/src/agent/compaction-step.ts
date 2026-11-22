import { HistoryEventSchema } from '@agent-os/contracts';
import type { SessionPatch } from '@agent-os/db';
import type { StepContext, StepResult } from '@agent-os/runtime';

import { knowledgeBlock } from '../knowledge/knowledge-block';
import { modelErrorMessage } from '../model/model-client';
import type { NewHistoryEntry } from '../store/history';
import type { Session } from '../store/sessions';
import { taskBlock, tasksOf } from '../tools/system/task-list-block';
import type { AgentDeps } from './agent-deps';
import type { SessionHistory } from './agent-state';
import type { BaseAgent } from './base-agent';
import { entriesOf } from './deliver';
import {
  appendWithEvent,
  callUnlessAborted,
  failResult,
  logStep,
  previewEntries,
  providerMessagesOf,
  refusedResult,
  type StepPrelude,
  withStepBlocks,
} from './step-common';

/** The step kind in the step log. */
const STEP_KIND = 'compaction';

/** The request that follows the history in the compaction call (FR-27). */
const COMPACTION_REQUEST =
  'The conversation above is getting too long. Write a summary of it that replaces it for you from now on. ' +
  'Keep the task, what the employee and other agents asked, every decision made, the facts found with ' +
  'their sources, the agents you started and their results, and what is left to do. ' +
  'Answer with the summary text only; do not call tools.';

/**
 * Whether the next step compacts the history (KD-7, «Как шаг выбирает работу» d2): the input tokens
 * of the last model call reached `AGENT_COMPACT_AT_TOKENS`.
 */
export function compactionDue(
  session: Pick<Session, 'lastInputTokens'>,
  compactAtTokens: number,
): boolean {
  return (
    session.lastInputTokens !== null &&
    session.lastInputTokens >= compactAtTokens
  );
}

/**
 * The compaction step of an agent, called by `BaseAgent.compactionStep`; `prelude` — what the agent writes first
 * (continuation). Design-agents.md: KD-1, KD-7, FR-27, DC-1, Invariant 5: the model of
 * the session summarizes the history it sees; the step writes a `compaction` entry with the summary
 * and the `seq` it covers, the `compacted` event, then the delivered messages (KD-1), clears
 * `last_input_tokens` and returns `continue`. The call is not a turn (DC-1). Earlier entries stay:
 * the model sees the summary and what follows it, the employee reads the whole history. An empty summary
 * compacts nothing (agent-harness KD-7): the prelude and the delivered messages are written, `last_input_tokens`
 * is cleared, and the step returns `continue` without a `compaction` entry or `compacted` event.
 */
export async function runCompactionStep(
  deps: AgentDeps,
  agent: Pick<
    BaseAgent,
    'input' | 'definition' | 'offeredDeclaration' | 'turnsAfterDelivery'
  >,
  ctx: StepContext,
  session: Session,
  /** The history the model sees, as the agent holds it. */
  view: SessionHistory,
  prelude?: StepPrelude,
): Promise<StepResult> {
  const { registry, modelClient, audit, history, messageRows, sessionRows } =
    deps;
  const startedAt = Date.now();
  const { snapshot } = agent.input;
  const { definition } = agent;
  const delivered = await entriesOf(deps, ctx.messages);
  // The summary covers the prelude: it is written before the summary; the delivered messages follow it.
  const shown = previewEntries(view.lastSeq, prelude?.entries ?? []);
  // The same system text as the model step's (KD-6): otherwise this call would miss its prompt cache, and
  // the summary would be written without the task list (design-task-list.md KD-2).
  const knowledge = await knowledgeBlock(deps, {
    snapshot,
    taskId: ctx.taskId,
    logger: ctx.logger,
  });
  const declaration = await agent.offeredDeclaration(ctx);
  const tasks = taskBlock(
    await tasksOf(deps, ctx.taskId, declaration.taskList),
  );
  // History holds tool calls, and the provider takes them only with the tools defined.
  const sessionTools = await registry.toolsFor(ctx.ownerId, declaration);

  const result = await callUnlessAborted(ctx, () =>
    modelClient.call({
      ownerId: ctx.ownerId,
      rootId: ctx.rootId,
      taskId: ctx.taskId,
      agentName: definition.name,
      model: session.model,
      instructions: withStepBlocks(definition.prompt, { knowledge, tasks }),
      messages: [
        ...providerMessagesOf(view, shown),
        { role: 'user', content: COMPACTION_REQUEST },
      ],
      tools: sessionTools,
      // The summary is not an answer the employee reads: its parts do not go to the hook.
      streamsText: false,
      signal: ctx.signal,
      logger: ctx.logger,
    }),
  );
  if (result === undefined) return { outcome: 'continue' };

  // The compaction call is not a turn (DC-1).
  const turns = agent.turnsAfterDelivery(
    prelude?.patch.turns ?? session.turns,
    ctx.messages,
  );
  const writePrelude = async (): Promise<readonly NewHistoryEntry[]> =>
    prelude === undefined ? [] : prelude.write();

  // The entries a step that compacts nothing still owes: the prelude, then the delivered messages.
  const writeOwedEntries = async (): Promise<NewHistoryEntry[]> => [
    ...(await writePrelude()),
    ...delivered,
  ];
  if (result.kind === 'not_started') {
    return refusedResult({
      deps,
      ctx,
      stepKind: STEP_KIND,
      startedAt,
      model: session.model,
      refusal: result.verdict,
      audit,
      writeEntries: writeOwedEntries,
      patch: { ...prelude?.patch },
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
      writeEntries: writeOwedEntries,
      patch: { ...prelude?.patch },
    });
  }

  const patch: SessionPatch = {
    ...prelude?.patch,
    turns,
    lastInputTokens: null,
  };
  const summary = result.text.trim();
  if (summary === '') {
    // agent-harness KD-7: an empty summary would hide the whole history, so nothing is compacted; the
    // step writes what it owes and clears `lastInputTokens`, so the next step is the model, not a compaction.
    ctx.logger.warn('compaction returned an empty summary', {
      agentId: ctx.taskId,
      stepNo: ctx.stepNo,
      model: session.model,
    });
    logStep(ctx, STEP_KIND, startedAt, 'continue', {
      emptySummary: true,
      turns,
    });
    return {
      outcome: 'continue',
      commit: async (effects) => {
        await appendWithEvent(
          deps,
          effects,
          ctx.taskId,
          await writeOwedEntries(),
        );
        await sessionRows.update(ctx.taskId, patch);
      },
    };
  }
  if (result.toolCalls.length > 0) {
    ctx.logger.warn('compaction answer had tool calls; they are ignored', {
      agentId: ctx.taskId,
      toolCalls: result.toolCalls.length,
    });
  }

  logStep(ctx, STEP_KIND, startedAt, 'continue', {
    compactedInputTokens: session.lastInputTokens,
    turns,
  });
  return {
    outcome: 'continue',
    commit: async (effects) => {
      // The prelude goes first in its own appends, so the summary knows the last `seq` it covers.
      // `agents.history_appended` goes once, with the last `seq`, from the last append.
      await history.append(ctx.taskId, await writePrelude());
      const throughSeq = await messageRows.lastSeq(ctx.taskId);
      await appendWithEvent(deps, effects, ctx.taskId, [
        { kind: 'compaction', content: { summary, throughSeq } },
        {
          kind: 'event',
          content: { event: HistoryEventSchema.enum.compacted, reason: null },
        },
        ...delivered,
      ]);
      await sessionRows.update(ctx.taskId, patch);
    },
  };
}
