import { AgentFailureReasonSchema, AGENTS_HISTORY_APPENDED, type ChipRecord, HistoryEventSchema } from '@agent-os/contracts';
import type { Executor, Transaction } from '@agent-os/db';
import type { StepContext, StepEffects, StepResult } from '@agent-os/runtime';

import type { AccessAudit } from '../access-gate';
import type { HistoryEntry } from '../history/history';
import { modelDeniedEntry, type ModelRefusal, modelRefusalMessage, refusalFields } from '../model/model-client';
import type { AgentTurnMessage } from '../model/mastra-turn';
import { buildProviderMessages, type ForkPrefix } from '../model/provider-messages';
import { history, type NewHistoryEntry } from '../store/history.repository';
import { type Session, type SessionPatch, sessions } from '../store/sessions.repository';

/** Failure reasons of the package (design-agents.md, AgentView `failureReason`). */
export const FAILURE_REASONS = AgentFailureReasonSchema.enum;

/**
 * What the agent writes before the step's own entries — a continuation (Flow 6, Flow 7) or
 * the closings of an interrupt (KD-3). The model sees `entries` in this step's call; `write` makes the
 * real writes in the commit transaction and returns the entries to append, ahead of the delivered
 * messages. `patch` — session fields the agent changes (the turn counter from zero, the
 * `interrupted` mark cleared); the step's own fields are applied over it.
 */
export interface StepPrelude {
  readonly entries: readonly NewHistoryEntry[];
  readonly write: (tx: Transaction) => Promise<readonly NewHistoryEntry[]>;
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
  reader: Executor,
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
  tx: Transaction,
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
  readonly writeEntries: (tx: Transaction, effects: StepEffects) => Promise<readonly NewHistoryEntry[]>;
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
  readonly writeEntries: (tx: Transaction, effects: StepEffects) => Promise<readonly NewHistoryEntry[]>;
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

/** The blocks of a step's system text, each `null` when empty (step-prompt-block.md). */
interface StepBlocks {
  readonly knowledge: string | null;
  readonly tasks: string | null;
}

/**
 * The system text of a step (step-prompt-block.md; self-learning KD-6): the definition's prompt, then each
 * block after an empty line in a fixed order — knowledge, then the tasks — so the start of the text stays the
 * same from step to step. The model step and the compaction step both build their `instructions` here, so a
 * compaction call carries the same text as the model call. No block — the prompt unchanged, byte for byte.
 */
export function withStepBlocks(prompt: string, blocks: StepBlocks): string {
  return [prompt, blocks.knowledge, blocks.tasks].filter((part) => part !== null).join('\n\n');
}
