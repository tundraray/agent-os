import { HistoryEventSchema } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { RuntimeTx, StepContext, StepResult } from '@agent-os/runtime';

import type { AccessAudit } from '../access-gate.js';
import { knowledgeBlock, withKnowledge } from '../knowledge/knowledge-block.js';
import type { KnowledgeVectorStore } from '../knowledge/vector-store.js';
import { type ModelClient, modelErrorMessage } from '../model/model-client.js';
import { snapshotDefinition } from '../start/snapshot-definition.js';
import type { HistoryEntry } from '../history/history.js';
import { history, type NewHistoryEntry } from '../store/history.repository.js';
import {
  type Session,
  type SessionPatch,
  sessionInputOf,
  sessions,
} from '../store/sessions.repository.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { entriesOf, rootTurnReset } from './deliver.js';
import {
  appendWithEvent,
  callUnlessAborted,
  failResult,
  logStep,
  previewEntries,
  providerMessagesOf,
  readSessionHistory,
  refusedResult,
  type StepPrelude,
} from './model-step.js';

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
export function compactionDue(session: Pick<Session, 'lastInputTokens'>, compactAtTokens: number): boolean {
  return session.lastInputTokens !== null && session.lastInputTokens >= compactAtTokens;
}

export interface CompactionStepDeps {
  /** Reads the history outside the commit: only steps of this agent write it, one at a time. */
  readonly database: Database;
  readonly registry: ToolRegistry;
  readonly modelClient: ModelClient;
  /** Gets the `access_denied` record of a refused model call (KD-6). */
  readonly audit: AccessAudit;
  /** Closeness of the graph's records to the session's question, for the knowledge block (KD-6). */
  readonly vectorStore: KnowledgeVectorStore;
}

/** The compaction step (KD-7); `prelude` — what the handler writes first (continuation). */
export type CompactionStep = (
  ctx: StepContext,
  session: Session,
  /** The session's entries from its last compaction on, as the handler read them. */
  own: readonly HistoryEntry[],
  prelude?: StepPrelude,
) => Promise<StepResult>;

/**
 * Builds the compaction step (design-agents.md: KD-1, KD-7, FR-27, DC-1, Invariant 5): the model of
 * the session summarizes the history it sees; the step writes a `compaction` entry with the summary
 * and the `seq` it covers, the `compacted` event, then the delivered messages (KD-1), clears
 * `last_input_tokens` and returns `continue`. The call is not a turn (DC-1). Earlier entries stay:
 * the model sees the summary and what follows it, the employee reads the whole history.
 */
export function createCompactionStep(deps: CompactionStepDeps): CompactionStep {
  const { database, registry, modelClient, audit, vectorStore } = deps;

  return async function compactionStep(ctx, session, own, prelude) {
    const startedAt = Date.now();
    const { snapshot } = sessionInputOf(ctx.input);
    const definition = snapshotDefinition(snapshot);
    const delivered = await entriesOf(database, ctx.messages);
    const view = await readSessionHistory(database, session, own);
    // The summary covers the prelude: it is written before the summary; the delivered messages follow it.
    const shown = previewEntries(view.lastSeq, prelude?.entries ?? []);
    // The same system text as the model step's (KD-6): otherwise this call would miss its prompt cache.
    const knowledge = await knowledgeBlock(
      { database, store: vectorStore },
      { snapshot, taskId: ctx.taskId, logger: ctx.logger },
    );
    // History holds tool calls, and the provider takes them only with the tools defined.
    const sessionTools = await registry.sessionTools({
      snapshot,
      ownerId: session.ownerId,
      agentId: ctx.taskId,
      root: ctx.parentId === null,
    });

    const result = await callUnlessAborted(ctx, () =>
      modelClient.call({
        ownerId: ctx.ownerId,
        rootId: ctx.rootId,
        taskId: ctx.taskId,
        agentName: definition.name,
        model: session.model,
        instructions: withKnowledge(definition.prompt, knowledge),
        messages: [...providerMessagesOf(view, shown), { role: 'user', content: COMPACTION_REQUEST }],
        tools: sessionTools,
        // The summary is not an answer the employee reads: its parts do not go to the hook.
        streamsText: false,
        signal: ctx.signal,
        logger: ctx.logger,
      }),
    );
    if (result === undefined) return { outcome: 'continue' };

    // The compaction call is not a turn (DC-1).
    const turns = rootTurnReset({
      turns: prelude?.patch.turns ?? session.turns,
      isRoot: ctx.parentId === null,
      messages: ctx.messages,
    });
    const writePrelude = async (tx: RuntimeTx): Promise<readonly NewHistoryEntry[]> =>
      prelude === undefined ? [] : prelude.write(tx);

    const writeFailureEntries = async (tx: RuntimeTx): Promise<NewHistoryEntry[]> => [
      ...(await writePrelude(tx)),
      ...delivered,
    ];
    if (result.kind === 'not_started') {
      return refusedResult({
        ctx,
        stepKind: STEP_KIND,
        startedAt,
        model: session.model,
        refusal: result.verdict,
        audit,
        writeEntries: writeFailureEntries,
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
        ctx,
        reason: result.reason,
        message: modelErrorMessage(session.model, result),
        writeEntries: writeFailureEntries,
        patch: { ...prelude?.patch },
      });
    }

    const summary = result.text.trim();
    if (summary === '') {
      // An empty summary would hide the whole history from the model: fail the step, keep the history.
      throw new Error(`The compaction call of agent ${ctx.taskId} returned no summary`);
    }
    if (result.toolCalls.length > 0) {
      ctx.logger.warn('compaction answer had tool calls; they are ignored', {
        agentId: ctx.taskId,
        toolCalls: result.toolCalls.length,
      });
    }

    const patch: SessionPatch = { ...prelude?.patch, turns, lastInputTokens: null };
    logStep(ctx, STEP_KIND, startedAt, 'continue', {
      compactedInputTokens: session.lastInputTokens,
      turns,
    });
    return {
      outcome: 'continue',
      commit: async (tx, effects) => {
        // The prelude goes first in its own appends, so the summary knows the last `seq` it covers.
        // `agents.history_appended` goes once, with the last `seq`, from the last append.
        await history.append(tx, ctx.taskId, await writePrelude(tx));
        const throughSeq = await history.lastSeq(tx, ctx.taskId);
        await appendWithEvent(tx, effects, ctx.taskId, [
          { kind: 'compaction', content: { summary, throughSeq } },
          { kind: 'event', content: { event: HistoryEventSchema.enum.compacted, reason: null } },
          ...delivered,
        ]);
        await sessions.update(tx, ctx.taskId, patch);
      },
    };
  };
}
