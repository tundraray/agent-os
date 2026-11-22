import {
  AgentFailureReasonSchema,
  AGENTS_HISTORY_APPENDED,
  CHILD_FINISHED_KIND,
  type ChipRecord,
  HistoryEventSchema,
  RUN_CODE_TOOL,
  type SessionTaskStatus,
  SessionTaskStatusSchema,
} from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import {
  isFinished,
  type Runtime,
  type RuntimeTx,
  type StepContext,
  type StepEffects,
  type StepResult,
} from '@agent-os/runtime';
import { z } from 'zod';

import type { AccessAudit } from '../access-gate';
import type { HistoryEntry } from '../history/history';
import { knowledgeBlock } from '../knowledge/knowledge-block';
import type { KnowledgeVectorStore } from '../knowledge/vector-store';
import {
  type ModelClient,
  modelDeniedEntry,
  modelErrorMessage,
  type ModelRefusal,
  modelRefusalMessage,
  refusalFields,
} from '../model/model-client';
import type { AgentToolCall, AgentToolDefinition, AgentTurnMessage } from '../model/mastra-turn';
import { buildProviderMessages, type ForkPrefix } from '../model/provider-messages';
import { snapshotDefinition } from '../start/snapshot-definition';
import { history, type NewHistoryEntry } from '../store/history.repository';
import {
  type Session,
  type SessionPatch,
  sessionInputOf,
  sessions,
  type StoreReader,
} from '../store/sessions.repository';
import { callTargetOf, type ToolRegistry } from '../tools/tool-registry';
import { entriesOf, rootTurnReset } from './deliver';
import { taskBlock, tasksOf, withStepBlocks } from './task-block';
import { endOfTurn, noticeContent, type FinalSubagentReport } from './turn-rules';

/** Tasks that keep an agent from finishing its turn (design-task-list.md KD-4). */
const OPEN_TASK_STATUSES: readonly SessionTaskStatus[] = [
  SessionTaskStatusSchema.enum.pending,
  SessionTaskStatusSchema.enum.in_progress,
];

/** The step kind in the step log. */
const STEP_KIND = 'model';

/** The `complete` result of an agent task: its report. */
const ReportSchema = z.object({ report: z.string() });

/** Failure reasons of the package (design-agents.md, AgentView `failureReason`). */
const FAILURE_REASONS = AgentFailureReasonSchema.enum;

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

/** The history the model sees, read outside the commit: the fork prefix and the own entries. */
export interface SessionHistory {
  readonly forkPrefix?: ForkPrefix;
  /** The own entries from the last compaction on, in `seq` order (`history.visible`). */
  readonly entries: readonly HistoryEntry[];
  /** `seq` of the last own entry; 0 for an empty history. */
  readonly lastSeq: number;
}

/**
 * The session's history as the model sees it: `own` — its entries from the last compaction on — and,
 * for a fork that has not compacted yet, the parent's part (KD-7); a summary covers that part too.
 */
export async function readSessionHistory(
  reader: StoreReader,
  session: Session,
  own: readonly HistoryEntry[],
): Promise<SessionHistory> {
  const lastSeq = own.at(-1)?.seq ?? 0;
  const compacted = own.some((entry) => entry.kind === 'compaction');
  if (compacted || session.forkedFromTaskId === null || session.forkedThroughSeq === null) {
    return { entries: own, lastSeq };
  }
  const throughSeq = session.forkedThroughSeq;
  const forkPrefix: ForkPrefix = {
    throughSeq,
    entries: await history.through(reader, session.forkedFromTaskId, throughSeq),
  };
  return { forkPrefix, entries: own, lastSeq };
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

/** A message's record chip as the model reads it (KD-4): the record's id, kind and name after the text. */
function withChip(text: string, record: ChipRecord | null): string {
  return record === null
    ? text
    : `${text}\n\n[The employee chose a record: ${record.kind} ${record.id} "${record.name}"]`;
}

/** The entries as the model reads them: a task or a message with a chip carries it as a line. */
function withChipLines(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return entries.map((entry) => {
    if (entry.kind === 'task' || entry.kind === 'user_message') {
      const text = withChip(entry.content.text, entry.content.record);
      return entry.kind === 'task'
        ? { ...entry, content: { ...entry.content, text } }
        : { ...entry, content: { ...entry.content, text } };
    }
    return entry;
  });
}

/** The provider messages of a step: the history read, then the entries not written yet (`shown`). */
export function providerMessagesOf(
  view: SessionHistory,
  shown: readonly HistoryEntry[],
): AgentTurnMessage[] {
  const { forkPrefix } = view;
  return buildProviderMessages({
    ...(forkPrefix === undefined
      ? {}
      : { forkPrefix: { ...forkPrefix, entries: withChipLines(forkPrefix.entries) } }),
    entries: withChipLines([...view.entries, ...shown]),
  });
}

/**
 * Appends the entries and writes `agents.history_appended` with the last `seq` (§ «Сообщения и события»).
 * `before` — entries the same transaction appended already, such as the results of closed calls: the
 * event names the last of them when nothing follows.
 */
export async function appendWithEvent(
  tx: RuntimeTx,
  effects: StepEffects,
  taskId: string,
  entries: readonly NewHistoryEntry[],
  before: readonly HistoryEntry[] = [],
): Promise<HistoryEntry[]> {
  const appended = await history.append(tx, taskId, entries);
  const last = appended.at(-1) ?? before.at(-1);
  if (last !== undefined) {
    await effects.emit(AGENTS_HISTORY_APPENDED, { agentId: taskId, seq: last.seq });
  }
  return appended;
}

/** The `failed` event the history shows before the step fails. */
function failedEvent(reason: string): NewHistoryEntry {
  return { kind: 'event', content: { event: HistoryEventSchema.enum.failed, reason } };
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
  readonly writeEntries: (tx: RuntimeTx, effects: StepEffects) => Promise<readonly NewHistoryEntry[]>;
  readonly patch: SessionPatch;
}): StepResult {
  const { ctx, reason, message } = input;
  return {
    outcome: 'fail',
    reason,
    message,
    commit: async (tx, effects) => {
      const entries = await input.writeEntries(tx, effects);
      await appendWithEvent(tx, effects, ctx.taskId, [...entries, failedEvent(reason)]);
      await sessions.update(tx, ctx.taskId, {
        ...input.patch,
        turns: 0,
        closed: true,
      });
    },
  };
}

/**
 * `AccessGate` refused the agent's call (KD-4, KD-5, DC-3): no call started, and the agent fails with the
 * verdict's reason by `failResult`, as on `model_error` — no pause. Every reason but `owner_disabled` is
 * written to the audit first (KD-6, plan Notes 3): a failing hook rejects, and the runtime repeats the step.
 */
export async function refusedResult(input: {
  readonly ctx: StepContext;
  readonly stepKind: string;
  readonly startedAt: number;
  /** The model of the refused call (the session's). */
  readonly model: string;
  readonly refusal: ModelRefusal;
  readonly audit: AccessAudit;
  readonly writeEntries: (tx: RuntimeTx, effects: StepEffects) => Promise<readonly NewHistoryEntry[]>;
  readonly patch: SessionPatch;
}): Promise<StepResult> {
  const { ctx, model, refusal } = input;
  if (refusal.reason !== FAILURE_REASONS.owner_disabled) {
    await input.audit(modelDeniedEntry(ctx.ownerId, model, refusal));
  }
  logStep(ctx, input.stepKind, input.startedAt, 'fail', { model, ...refusalFields(refusal) });
  return failResult({
    ctx,
    reason: refusal.reason,
    message: `Agent ${ctx.taskId}: ${modelRefusalMessage(ctx.ownerId, model, refusal)}`,
    writeEntries: input.writeEntries,
    patch: input.patch,
  });
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

export interface ModelStepDeps {
  /** Reads the history outside the commit: only steps of this agent write it, one at a time. */
  readonly database: Database;
  readonly registry: ToolRegistry;
  readonly modelClient: ModelClient;
  /** Gets the `access_denied` record of a refused model call (KD-6). */
  readonly audit: AccessAudit;
  /** Children of the agent: the end of a turn waits for the unfinished ones (DC-3). */
  readonly tasks: Pick<Runtime['tasks'], 'listTree'>;
  /** `child_finished` notices still pending in the agent's queue (plan Notes 6). */
  readonly inbox: Pick<Runtime['inbox'], 'listPending'>;
  /** The outcomes of a deep agent's subagent tasks: the final subagent's answer is read there (deep-agents KD-6). */
  readonly trackers: Pick<Runtime['trackers'], 'list'>;
  /** Closeness of the graph's records to the session's question, for the knowledge block (KD-6). */
  readonly vectorStore: KnowledgeVectorStore;
}

/**
 * The model step (KD-1): the delivered messages, one model call, the answer with its open calls.
 * `prelude` — what the handler writes first (continuation, interrupt).
 */
export type ModelStep = (
  ctx: StepContext,
  session: Session,
  /** The session's entries from its last compaction on, as the handler read them. */
  own: readonly HistoryEntry[],
  prelude?: StepPrelude,
) => Promise<StepResult>;

/**
 * Builds the model step (design-agents.md: KD-1, KD-2, KD-6, «Как шаг выбирает работу» d3–d4,
 * «Конец хода», Flow 1, Flow 2, DC-1, DC-3, DC-4, Invariants 4, 6).
 *
 * - The turn limit spent → `fail` `turn_limit`, the delivered messages written before the `failed` event.
 * - Otherwise the delivered messages go to history before the call, and the model of the session
 *   (Invariant 6) gets the history and the session's tools. A provider that keeps failing → `fail`
 *   `model_error`; a call `AccessGate` refused → `fail` with the verdict's reason, the model not called.
 *   Each failure closes the session and resets the turn counter (DC-1).
 * - An answer with calls is written with them: they are open (`requested`) until their results;
 *   `continue`, the tool step runs them. An answer without calls ends the turn (`endOfTurn`): `wait`, a notice and `continue`, or
 *   `complete` with `{ report }`, the session closed and its counter reset.
 * - Every commit writes the turn counter, `last_input_tokens` of the call (KD-7) and
 *   `agents.history_appended`.
 */
export function createModelStep(deps: ModelStepDeps): ModelStep {
  const { database, registry, modelClient, audit, vectorStore } = deps;

  /**
   * How the last finished single `task` of the final subagent ended, and its last message (DC-4; deep-agents
   * design-task.md KD-6): its call's result names the subagent's task, whose outcome the tracker keeps. Read by
   * kind, not from the step's entries: the result may stand before the last compaction.
   */
  async function finalSubagentReport(
    ctx: StepContext,
    finalSubagent: string,
  ): Promise<FinalSubagentReport | null> {
    const childTaskId = await history.lastSingleTask(database, ctx.taskId, finalSubagent);
    if (childTaskId === undefined) return null;
    const trackers = await deps.trackers.list(ctx.taskId, ctx.ownerId);
    const task = trackers.flatMap((tracker) => tracker.tasks).find((candidate) => candidate.taskId === childTaskId);
    if (task === undefined) throw new Error(`Subagent task ${childTaskId} of agent ${ctx.taskId} is in no tracker`);
    if (task.status === 'completed') return { status: 'completed', text: ReportSchema.parse(task.result).report };
    return { status: task.status === 'failed' ? 'failed' : 'stopped', text: null };
  }

  /** Children not finished yet, and `child_finished` notices pending beyond this step's messages (Notes 6). */
  async function childrenInFlight(ctx: StepContext): Promise<{ unfinished: number; pending: number }> {
    const tree = await deps.tasks.listTree(ctx.rootId, ctx.ownerId);
    const unfinished = tree.filter(
      (task) => task.parentId === ctx.taskId && !isFinished(task.status),
    ).length;
    const delivered = new Set(ctx.messages.map((message) => message.messageId));
    const pendingMessages = await deps.inbox.listPending(ctx.taskId, ctx.ownerId);
    const pending = pendingMessages.filter(
      (message) => message.kind === CHILD_FINISHED_KIND && !delivered.has(message.messageId),
    ).length;
    return { unfinished, pending };
  }

  return async function modelStep(ctx, session, own, prelude) {
    const startedAt = Date.now();
    // The run's definition comes from its snapshot only, never from the library now (ADR-0017).
    const { snapshot, answerFields: askedFields } = sessionInputOf(ctx.input);
    const definition = snapshotDefinition(snapshot);
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

    // The snapshot's `maxTurns` is spent: the step fails instead of calling the model.
    if (turns >= definition.maxTurns) {
      logStep(ctx, STEP_KIND, startedAt, 'fail', { reason: FAILURE_REASONS.turn_limit, turns });
      return failResult({
        ctx,
        reason: FAILURE_REASONS.turn_limit,
        message: `Agent ${definition.name} used all ${definition.maxTurns} turns of its assignment`,
        writeEntries: writeStepEntries,
        patch: basePatch,
      });
    }

    const view = await readSessionHistory(database, session, own);
    const shown = previewEntries(view.lastSeq, [...(prelude?.entries ?? []), ...delivered]);
    // The graph is live data read beside the snapshot on every step (KD-6); a failed read fails the step.
    const knowledge = await knowledgeBlock(
      { database, store: vectorStore },
      { snapshot, taskId: ctx.taskId, logger: ctx.logger },
    );
    // The task list too (design-task-list.md KD-2): only a tool step changes it, so `endOfTurn` below reads the
    // same tasks.
    const tasks = await tasksOf(database, { snapshot, root: isRoot, sessionId: ctx.taskId });
    const sessionTools = await registry.sessionTools({
      snapshot,
      ownerId: session.ownerId,
      agentId: ctx.taskId,
      root: isRoot,
    });
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
      tx: RuntimeTx,
      effects: StepEffects,
      after: readonly NewHistoryEntry[],
      patch: SessionPatch,
    ): Promise<void> => {
      await appendWithEvent(tx, effects, ctx.taskId, [
        ...(await writeStepEntries(tx)),
        answerEntry,
        ...after,
      ]);
      await sessions.update(tx, ctx.taskId, patch);
    };

    if (result.toolCalls.length > 0) {
      logStep(ctx, STEP_KIND, startedAt, 'continue', {
        toolCalls: result.toolCalls.length,
        turns: counted,
        ...answered,
      });
      return {
        outcome: 'continue',
        commit: (tx, effects) => writeAnswer(tx, effects, [], callPatch),
      };
    }

    const { finalSubagent } = definition;
    const inFlight = isRoot ? { unfinished: 0, pending: 0 } : await childrenInFlight(ctx);
    const ending = endOfTurn({
      isRoot,
      unfinishedChildren: inFlight.unfinished,
      pendingChildNotices: inFlight.pending,
      finalSubagent,
      finalSubagentReport:
        isRoot || finalSubagent === null ? null : await finalSubagentReport(ctx, finalSubagent),
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
        return { outcome: 'wait', commit: (tx, effects) => writeAnswer(tx, effects, [], callPatch) };
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
          commit: (tx, effects) =>
            writeAnswer(tx, effects, [{ kind: 'notice', content: noticeContent(ending) }], callPatch),
        };
      case 'complete':
        logStep(ctx, STEP_KIND, startedAt, 'complete', { turns: counted, ...answered });
        return {
          outcome: 'complete',
          result: { report: ending.report },
          commit: (tx, effects) =>
            writeAnswer(tx, effects, [], { ...callPatch, turns: 0, closed: true }),
        };
    }
  };
}
