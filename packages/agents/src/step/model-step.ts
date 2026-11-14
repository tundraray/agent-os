import {
  AGENTS_HISTORY_APPENDED,
  CHILD_FINISHED_KIND,
  HistoryEventSchema,
  TaskStatusSchema,
} from '@agent-os/contracts';
import { agentToolCalls, type Database } from '@agent-os/db';
import type {
  Runtime,
  RuntimeTx,
  StepContext,
  StepEffects,
  StepResult,
} from '@agent-os/runtime';
import { eq } from 'drizzle-orm';

import type { DefinitionCatalog } from '../definitions/catalog.js';
import type { AgentDefinition } from '../definitions/definition.js';
import type { HistoryContent, HistoryEntry, ToolCallRecord } from '../history/history.js';
import { mcpToolName } from '../mcp/mcp-clients.js';
import type { ModelAnswer, ModelClient, ModelError } from '../model/model-client.js';
import { buildProviderMessages, type ForkPrefix } from '../model/provider-messages.js';
import { history, type NewHistoryEntry } from '../store/history.repository.js';
import {
  type Session,
  type SessionPatch,
  sessions,
  type StoreReader,
} from '../store/sessions.repository.js';
import { type NewToolCall, toolCalls } from '../store/tool-calls.repository.js';
import { callTarget, type SessionTool, type ToolRegistry } from '../tools/tool-registry.js';
import { entriesOf, rootTurnReset } from './deliver.js';
import { endOfTurn, type FinalAgentReport, nextTurns, turnLimitReached } from './turn-rules.js';

/** The step kind in the step log. */
const STEP_KIND = 'model';

/** The largest `seq` a history can have: `agent_messages.seq` is a Postgres `integer`. */
const MAX_SEQ = 2_147_483_647;

/** Failure reasons of the package (design-agents.md, AgentView `failureReason`). */
export const FAILURE_REASONS = { turnLimit: 'turn_limit', modelError: 'model_error' } as const;

const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  TaskStatusSchema.enum.completed,
  TaskStatusSchema.enum.failed,
  TaskStatusSchema.enum.stopped,
]);

/**
 * What the handler (T4.4) writes before the step's own entries — a continuation (Flow 6, Flow 7) or
 * the closings of an interrupt (KD-3). The model sees `entries` in this step's call; `write` makes the
 * real writes in the commit transaction and returns the entries to append, ahead of the delivered
 * messages. `patch` — session fields the handler changes (the turn counter from zero, the
 * `interrupted` mark cleared); the step's own fields are applied over it.
 */
export interface StepPrelude {
  readonly entries: readonly NewHistoryEntry[];
  readonly write: (tx: RuntimeTx) => Promise<readonly NewHistoryEntry[]>;
  readonly patch: SessionPatch;
}

/** The history the model sees, read outside the commit: the fork prefix, the own entries and calls. */
export interface SessionHistory {
  readonly forkPrefix?: ForkPrefix;
  /** Every own entry in `seq` order. */
  readonly entries: readonly HistoryEntry[];
  readonly calls: readonly ToolCallRecord[];
  /** `seq` of the last own entry; 0 for an empty history. */
  readonly lastSeq: number;
}

/**
 * The calls of an agent as the provider messages need them. The model called an MCP tool by its
 * model name, so a call kept as its server and raw name gets `mcp__<server>__<tool>` back.
 */
async function callRecords(reader: StoreReader, taskId: string): Promise<ToolCallRecord[]> {
  // Read here, not in the repository: only the history view needs every call of a session.
  const rows = await reader
    .select({
      callId: agentToolCalls.callId,
      answerSeq: agentToolCalls.answerSeq,
      position: agentToolCalls.position,
      tool: agentToolCalls.tool,
      server: agentToolCalls.server,
      args: agentToolCalls.args,
    })
    .from(agentToolCalls)
    .where(eq(agentToolCalls.taskId, taskId));
  return rows.map((row) => ({
    callId: row.callId,
    answerSeq: row.answerSeq,
    position: row.position,
    tool: row.server === null ? row.tool : mcpToolName(row.server, row.tool),
    args: row.args,
  }));
}

/** Reads the session's history with the parent's part of a fork (KD-7). */
export async function readSessionHistory(
  reader: StoreReader,
  session: Session,
): Promise<SessionHistory> {
  const entries = await history.listThrough(reader, session.taskId, MAX_SEQ);
  const calls = await callRecords(reader, session.taskId);
  const lastSeq = entries.at(-1)?.seq ?? 0;
  if (session.forkedFromTaskId === null || session.forkedThroughSeq === null) {
    return { entries, calls, lastSeq };
  }
  const throughSeq = session.forkedThroughSeq;
  const forkPrefix: ForkPrefix = {
    throughSeq,
    entries: await history.listThrough(reader, session.forkedFromTaskId, throughSeq),
    calls: await callRecords(reader, session.forkedFromTaskId),
  };
  return { forkPrefix, entries, calls, lastSeq };
}

/**
 * Entries not written yet, numbered after `lastSeq` as the commit will number them, so the model
 * sees them in this call.
 */
export function previewEntries(
  lastSeq: number,
  entries: readonly NewHistoryEntry[],
): HistoryEntry[] {
  const createdAt = new Date();
  // Each entry keeps its own kind and content; TypeScript cannot correlate them across the spread.
  return entries.map(
    (entry, index) =>
      ({ seq: lastSeq + index + 1, kind: entry.kind, createdAt, content: entry.content }) as HistoryEntry,
  );
}

/** Appends the entries and writes `agents.history_appended` with the last `seq` (§ «Сообщения и события»). */
export async function appendWithEvent(
  tx: RuntimeTx,
  effects: StepEffects,
  taskId: string,
  entries: readonly NewHistoryEntry[],
): Promise<HistoryEntry[]> {
  const appended = await history.append(tx, taskId, entries);
  const last = appended.at(-1);
  if (last !== undefined) {
    await effects.emit(AGENTS_HISTORY_APPENDED, { agentId: taskId, seq: last.seq });
  }
  return appended;
}

/** The `failed` event the history shows before the step fails. */
function failedEvent(reason: string): NewHistoryEntry {
  return { kind: 'event', content: { event: HistoryEventSchema.enum.failed, reason } };
}

/** The definition of the session's agent; a session whose definition left the catalog is a defect. */
export function definitionOf(catalog: DefinitionCatalog, ctx: StepContext, session: Session): AgentDefinition {
  const definition = catalog.get(session.definition);
  if (definition === undefined) {
    throw new Error(
      `Agent ${ctx.taskId} has definition ${session.definition}, which is not in the catalog`,
    );
  }
  return definition;
}

/** The message of a `model_error` failure: the provider status, never the request. */
export function modelErrorMessage(model: string, result: ModelError): string {
  const status = result.error.statusCode === null ? 'no status' : `status ${result.error.statusCode}`;
  return `Model ${model} kept failing (${status})`;
}

/**
 * A failure of the agent itself (DC-1): the step's entries, then the `failed` event with the reason;
 * the session is closed and its turn counter reset. The model sees the delivered messages after a
 * continuation (KD-1).
 */
export function failResult(input: {
  readonly ctx: StepContext;
  readonly reason: string;
  readonly message: string;
  /** Writes the entries before the event and returns them. */
  readonly writeEntries: (tx: RuntimeTx) => Promise<readonly NewHistoryEntry[]>;
  readonly patch: SessionPatch;
}): StepResult {
  const { ctx, reason, message } = input;
  return {
    outcome: 'fail',
    reason,
    message,
    commit: async (tx, effects) => {
      const entries = await input.writeEntries(tx);
      await appendWithEvent(tx, effects, ctx.taskId, [...entries, failedEvent(reason)]);
      await sessions.update(tx, ctx.taskId, {
        ...input.patch,
        turns: nextTurns(0, { kind: 'failed' }),
        closed: true,
      });
    },
  };
}

/** Logs the end of a step (rule 3 of the plan). */
export function logStep(
  ctx: StepContext,
  stepKind: string,
  startedAt: number,
  outcome: StepResult['outcome'],
  extra: Record<string, unknown> = {},
): void {
  ctx.logger.info('agent step finished', {
    stepKind,
    agentId: ctx.taskId,
    rootId: ctx.rootId,
    ownerId: ctx.ownerId,
    stepNo: ctx.stepNo,
    outcome,
    ...extra,
    durationMs: Date.now() - startedAt,
  });
}

/**
 * Calls the model; a cancel of the step (the signal aborted) gives `undefined` — the runtime rejects
 * the result of a step that is no longer current, so the step ends without writes.
 */
export async function callUnlessAborted<T>(ctx: StepContext, call: () => Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch (error) {
    if (!ctx.signal.aborted) throw error;
    ctx.logger.info('model step abandoned without writes', {
      agentId: ctx.taskId,
      stepNo: ctx.stepNo,
      signalReason: String(ctx.signal.reason),
    });
    return undefined;
  }
}

export interface ModelStepDeps {
  /** Reads the history outside the commit: only steps of this agent write it, one at a time. */
  readonly database: Database;
  readonly catalog: DefinitionCatalog;
  readonly registry: ToolRegistry;
  readonly modelClient: ModelClient;
  /** Children of the agent: the end of a turn waits for the unfinished ones (DC-3). */
  readonly tasks: Pick<Runtime['tasks'], 'listTree'>;
  /** `child_finished` notices still pending in the agent's queue (plan Notes 6). */
  readonly inbox: Pick<Runtime['inbox'], 'listPending'>;
}

/**
 * The model step (KD-1): the delivered messages, one model call, the answer with its open calls.
 * `prelude` — what the handler writes first (continuation, interrupt).
 */
export type ModelStep = (
  ctx: StepContext,
  session: Session,
  prelude?: StepPrelude,
) => Promise<StepResult>;

/** The tool calls of an answer as `agent_tool_calls` rows: a name the session does not offer stays as written. */
function newToolCalls(
  ctx: StepContext,
  answer: ModelAnswer,
  answerSeq: number,
  sessionTools: readonly SessionTool[],
): NewToolCall[] {
  const byName = new Map(sessionTools.map((tool) => [tool.name, tool]));
  return answer.toolCalls.map((call, position) => {
    const tool = byName.get(call.toolName);
    // An unknown name is refused by the tool step (`tool_not_in_definition`); it stays as the model wrote it.
    const target = tool === undefined ? { tool: call.toolName, server: null } : callTarget(tool);
    return {
      taskId: ctx.taskId,
      callId: call.toolCallId,
      answerSeq,
      position,
      tool: target.tool,
      server: target.server,
      args: call.args,
    };
  });
}

/**
 * Builds the model step (design-agents.md: KD-1, KD-2, KD-6, «Как шаг выбирает работу» d3–d4,
 * «Конец хода», Flow 1, Flow 2, DC-1, DC-3, DC-4, Invariants 4, 6).
 *
 * - The turn limit spent → `fail` `turn_limit`, the delivered messages written before the `failed` event.
 * - Otherwise the delivered messages go to history before the call, and the model of the session
 *   (Invariant 6) gets the history and the session's tools. A provider that keeps failing → `fail`
 *   `model_error`. Both failures close the session and reset the turn counter (DC-1).
 * - An answer with calls is written with its open calls (`requested`): `continue`, the tool step runs
 *   them. An answer without calls ends the turn (`endOfTurn`): `wait`, a notice and `continue`, or
 *   `complete` with `{ report }`, the session closed and its counter reset.
 * - Every commit writes the turn counter, `last_input_tokens` of the call (KD-7) and
 *   `agents.history_appended`.
 */
export function createModelStep(deps: ModelStepDeps): ModelStep {
  const { database, catalog, registry, modelClient } = deps;

  /** The last report of `finalAgent` among the session's child reports, the delivered ones included (DC-4). */
  async function finalAgentReport(
    finalAgent: string,
    ownEntries: readonly HistoryEntry[],
    delivered: readonly NewHistoryEntry[],
  ): Promise<FinalAgentReport | null> {
    const reports: HistoryContent<'child_report'>[] = [];
    for (const entry of [...ownEntries, ...delivered]) {
      if (entry.kind === 'child_report') reports.push(entry.content);
    }
    if (reports.length === 0) return null;
    const children = await sessions.getMany(
      database,
      reports.map((report) => report.agentId),
    );
    const last = reports
      .reverse()
      .find((report) => children.get(report.agentId)?.definition === finalAgent);
    return last === undefined ? null : { status: last.status, text: last.text };
  }

  /** Children not finished yet, and `child_finished` notices pending beyond this step's messages (Notes 6). */
  async function childrenInFlight(ctx: StepContext): Promise<{ unfinished: number; pending: number }> {
    const tree = await deps.tasks.listTree(ctx.rootId, ctx.ownerId);
    const unfinished = tree.filter(
      (task) => task.parentId === ctx.taskId && !FINISHED_STATUSES.has(task.status),
    ).length;
    const delivered = new Set(ctx.messages.map((message) => message.messageId));
    const pendingMessages = await deps.inbox.listPending(ctx.taskId, ctx.ownerId);
    const pending = pendingMessages.filter(
      (message) => message.kind === CHILD_FINISHED_KIND && !delivered.has(message.messageId),
    ).length;
    return { unfinished, pending };
  }

  return async function modelStep(ctx, session, prelude) {
    const startedAt = Date.now();
    const definition = definitionOf(catalog, ctx, session);
    const isRoot = ctx.parentId === null;
    const turns = rootTurnReset({
      turns: prelude?.patch.turns ?? session.turns,
      isRoot,
      messages: ctx.messages,
    });
    const delivered = await entriesOf(database, ctx.messages);
    const writeStepEntries = async (tx: RuntimeTx): Promise<NewHistoryEntry[]> => [
      ...(prelude === undefined ? [] : await prelude.write(tx)),
      ...delivered,
    ];
    const basePatch: SessionPatch = { ...prelude?.patch };

    if (turnLimitReached(turns, definition.maxTurns)) {
      logStep(ctx, STEP_KIND, startedAt, 'fail', { reason: FAILURE_REASONS.turnLimit, turns });
      return failResult({
        ctx,
        reason: FAILURE_REASONS.turnLimit,
        message: `Agent ${definition.name} used all ${definition.maxTurns} turns of its assignment`,
        writeEntries: writeStepEntries,
        patch: basePatch,
      });
    }

    const view = await readSessionHistory(database, session);
    const shown = previewEntries(view.lastSeq, [...(prelude?.entries ?? []), ...delivered]);
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
        messages: buildProviderMessages({
          ...(view.forkPrefix === undefined ? {} : { forkPrefix: view.forkPrefix }),
          entries: [...view.entries, ...shown],
          calls: view.calls,
        }),
        tools: sessionTools,
        streamsText: true,
        signal: ctx.signal,
        logger: ctx.logger,
      }),
    );
    if (result === undefined) return { outcome: 'continue' };

    if (result.kind === 'model_error') {
      logStep(ctx, STEP_KIND, startedAt, 'fail', {
        reason: FAILURE_REASONS.modelError,
        statusCode: result.error.statusCode,
      });
      return failResult({
        ctx,
        reason: FAILURE_REASONS.modelError,
        message: modelErrorMessage(session.model, result),
        writeEntries: writeStepEntries,
        patch: basePatch,
      });
    }

    const counted = nextTurns(turns, { kind: 'model_call' });
    const answerEntry: NewHistoryEntry = {
      kind: 'model_answer',
      content: { text: result.text },
      modelCallId: result.modelCallId,
    };
    const callPatch: SessionPatch = {
      ...basePatch,
      turns: counted,
      lastInputTokens: result.usage.inputTokens,
    };
    const writeAnswer = async (
      tx: RuntimeTx,
      effects: StepEffects,
      after: readonly NewHistoryEntry[],
      patch: SessionPatch,
    ): Promise<void> => {
      const appended = await appendWithEvent(tx, effects, ctx.taskId, [
        ...(await writeStepEntries(tx)),
        answerEntry,
        ...after,
      ]);
      if (result.toolCalls.length > 0) {
        const answer = appended.find((entry) => entry.kind === 'model_answer');
        if (answer === undefined) throw new Error(`The answer of agent ${ctx.taskId} was not appended`);
        await toolCalls.insertRequested(tx, newToolCalls(ctx, result, answer.seq, sessionTools));
      }
      await sessions.update(tx, ctx.taskId, patch);
    };

    if (result.toolCalls.length > 0) {
      logStep(ctx, STEP_KIND, startedAt, 'continue', { toolCalls: result.toolCalls.length, turns: counted });
      return {
        outcome: 'continue',
        commit: (tx, effects) => writeAnswer(tx, effects, [], callPatch),
      };
    }

    const finalAgent = session.limits?.finalAgent ?? null;
    const inFlight = isRoot ? { unfinished: 0, pending: 0 } : await childrenInFlight(ctx);
    const ending = endOfTurn({
      isRoot,
      unfinishedChildren: inFlight.unfinished,
      pendingChildNotices: inFlight.pending,
      finalAgent,
      finalAgentReport:
        isRoot || finalAgent === null
          ? null
          : await finalAgentReport(finalAgent, view.entries, delivered),
      text: result.text,
    });

    switch (ending.kind) {
      case 'wait':
        logStep(ctx, STEP_KIND, startedAt, 'wait', {
          turns: counted,
          unfinishedChildren: inFlight.unfinished,
          pendingChildNotices: inFlight.pending,
        });
        return { outcome: 'wait', commit: (tx, effects) => writeAnswer(tx, effects, [], callPatch) };
      case 'notice':
        logStep(ctx, STEP_KIND, startedAt, 'continue', { notice: true, turns: counted });
        return {
          outcome: 'continue',
          commit: (tx, effects) =>
            writeAnswer(tx, effects, [{ kind: 'notice', content: { text: ending.text } }], callPatch),
        };
      case 'complete':
        logStep(ctx, STEP_KIND, startedAt, 'complete', { turns: counted });
        return {
          outcome: 'complete',
          result: { report: ending.report },
          commit: (tx, effects) =>
            writeAnswer(tx, effects, [], {
              ...callPatch,
              turns: nextTurns(counted, { kind: 'report' }),
              closed: true,
            }),
        };
    }
  };
}
