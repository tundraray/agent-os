import { HistoryEventSchema } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { RuntimeTx, StepContext, StepResult } from '@agent-os/runtime';

import type { DefinitionCatalog } from '../definitions/catalog.js';
import type { ModelClient } from '../model/model-client.js';
import { buildProviderMessages } from '../model/provider-messages.js';
import { history, type NewHistoryEntry } from '../store/history.repository.js';
import { type Session, type SessionPatch, sessions } from '../store/sessions.repository.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { entriesOf, rootTurnReset } from './deliver.js';
import {
  appendWithEvent,
  callUnlessAborted,
  definitionOf,
  FAILURE_REASONS,
  failResult,
  logStep,
  modelErrorMessage,
  previewEntries,
  readSessionHistory,
  type StepPrelude,
} from './model-step.js';
import { nextTurns } from './turn-rules.js';

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
  readonly catalog: DefinitionCatalog;
  readonly registry: ToolRegistry;
  readonly modelClient: ModelClient;
}

/** The compaction step (KD-7); `prelude` — what the handler writes first (continuation). */
export type CompactionStep = (
  ctx: StepContext,
  session: Session,
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
  const { database, catalog, registry, modelClient } = deps;

  return async function compactionStep(ctx, session, prelude) {
    const startedAt = Date.now();
    const definition = definitionOf(catalog, ctx, session);
    const delivered = await entriesOf(database, ctx.messages);
    const view = await readSessionHistory(database, session);
    // The summary covers the prelude: it is written before the summary; the delivered messages follow it.
    const shown = previewEntries(view.lastSeq, prelude?.entries ?? []);
    // History holds tool calls, and the provider takes them only with the tools defined.
    const sessionTools = registry.sessionTools({
      definition,
      limits: session.limits,
      ownerId: session.ownerId,
    });

    const result = await callUnlessAborted(ctx, () =>
      modelClient.call({
        ownerId: ctx.ownerId,
        rootId: ctx.rootId,
        taskId: ctx.taskId,
        agentName: definition.name,
        model: session.model,
        instructions: definition.prompt,
        messages: [
          ...buildProviderMessages({
            ...(view.forkPrefix === undefined ? {} : { forkPrefix: view.forkPrefix }),
            entries: [...view.entries, ...shown],
            calls: view.calls,
          }),
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

    const turns = nextTurns(
      rootTurnReset({
        turns: prelude?.patch.turns ?? session.turns,
        isRoot: ctx.parentId === null,
        messages: ctx.messages,
      }),
      { kind: 'compaction_call' },
    );
    const writePrelude = async (tx: RuntimeTx): Promise<readonly NewHistoryEntry[]> =>
      prelude === undefined ? [] : prelude.write(tx);

    if (result.kind === 'model_error') {
      logStep(ctx, STEP_KIND, startedAt, 'fail', {
        reason: FAILURE_REASONS.modelError,
        statusCode: result.error.statusCode,
      });
      return failResult({
        ctx,
        reason: FAILURE_REASONS.modelError,
        message: modelErrorMessage(session.model, result),
        writeEntries: async (tx) => [...(await writePrelude(tx)), ...delivered],
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
        const preludeEntries = await writePrelude(tx);
        // The prelude goes first in its own append, so the summary knows the last `seq` it covers.
        // `agents.history_appended` goes once, with the last `seq`, from the second append.
        const before = await history.append(tx, ctx.taskId, preludeEntries);
        const throughSeq = before.at(-1)?.seq ?? view.lastSeq;
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
