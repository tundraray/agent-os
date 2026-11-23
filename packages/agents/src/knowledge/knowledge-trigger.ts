import type {
  AgentKnowledgeRunsRepository,
  Db,
  ConversationsRepository,
  KnowledgeEmbeddingRow,
  RoundOutcome,
} from '@agent-os/db';
import type { Logger } from '@agent-os/common';
import { RuntimeEventTypeSchema } from '@agent-os/contracts';
import {
  type EventConsumer,
  type TaskControl,
  RUNTIME_EVENT_SCHEMA_VERSION,
} from '@agent-os/runtime';

import { type KnowledgeRun, knowledgeRunOf } from './knowledge-runs';
import {
  embedPassRequest,
  holdKnowledgeOf,
  KNOWLEDGE_EXTRACT_TASK_TYPE,
  type KnowledgeExtractInput,
} from './knowledge-tasks';

/*
 * The consumer `agents.knowledge-trigger` (design-core.md, KD-3, KD-8): the end of a run that
 * learns creates one extraction task in the delivery transaction, the end of an extraction queues
 * the deep agent's vector pass. The event carries neither the task type nor the owner, and `agents`
 * does not read `runtime_tasks` (plan Notes 6): the task is recognised by the knowledge rows that
 * name it. Every decision is the pure `triggerDecision`; `handle` only reads and writes those rows
 * and creates tasks in the delivery transaction — no model, embeddings or network call.
 */

/** A delivered runtime event (`StoredEvent` of `runtime`, not exported by name). */
type DeliveredEvent = Parameters<EventConsumer['handle']>[0];

const CONSUMER_NAME = 'agents.knowledge-trigger';
const COMPLETED = RuntimeEventTypeSchema.enum['task.completed'];
const FAILED = RuntimeEventTypeSchema.enum['task.failed'];
const STOPPED = RuntimeEventTypeSchema.enum['task.stopped'];

// ---------- The decision (pure) ----------

export interface TriggerEvent {
  readonly type: string;
  readonly taskId: string;
}

/** What the decision reads of a run row. */
export type TriggerRun = Pick<
  KnowledgeRun,
  'runId' | 'extractTaskId' | 'lastExtractTaskId' | 'needsRound'
>;

/** What the decision reads of a deep agent vector row. */
export type TriggerEmbedding = Pick<
  KnowledgeEmbeddingRow,
  'recordId' | 'passTaskId' | 'needsPass'
>;

/** `not_learning` — no knowledge row names the task; `record_deleted` — the deep agent record is gone. */
export type TriggerIgnoreReason = 'not_learning' | 'record_deleted';

export type TriggerDecision<
  R extends TriggerRun = TriggerRun,
  E extends TriggerEmbedding = TriggerEmbedding,
> =
  /** Deep agent ended, no extraction in progress: a new extraction task. */
  | { readonly action: 'create_extract'; readonly run: R }
  /** Deep agent ended while an extraction is in progress: «one more round». */
  | { readonly action: 'mark_round'; readonly run: R }
  /** Deep agent stopped: «skipped: stopped», the mark moves to the stop; no task (AC-03.2). */
  | { readonly action: 'stopped'; readonly run: R }
  /** Extraction task failed or was stopped: id released, «failed: interrupted», a new task on the mark. */
  | {
      readonly action: 'interrupted';
      readonly run: R;
      readonly nextRound: boolean;
    }
  /** Extraction completed, no pass in progress: a vector pass, the starter pays. */
  | { readonly action: 'queue_embed'; readonly run: R }
  /** Extraction completed while a pass is in progress: «one more pass», the starter pays. */
  | { readonly action: 'mark_pass'; readonly run: R }
  /** Pass task ended without releasing itself (failed, stopped): id released, a new pass on the mark. */
  | {
      readonly action: 'release_pass';
      readonly embedding: E;
      readonly nextPass: boolean;
    }
  | { readonly action: 'ignore'; readonly reason: TriggerIgnoreReason };

/**
 * Decides what the event of a task means for self-learning. `run` is the run row found for the task
 * (by `run_id`, or by `last_extract_task_id` on `task.completed` / `extract_task_id` otherwise);
 * `embedding` is the vector row of an ended extraction's deep agent, or the row whose pass is the task.
 */
export function triggerDecision<
  R extends TriggerRun,
  E extends TriggerEmbedding,
>(
  event: TriggerEvent,
  run: R | undefined,
  embedding: E | undefined,
): TriggerDecision<R, E> {
  const { type, taskId } = event;
  if (run !== undefined && run.runId === taskId) {
    if (type === STOPPED) return { action: 'stopped', run };
    return run.extractTaskId === null
      ? { action: 'create_extract', run }
      : { action: 'mark_round', run };
  }
  if (
    run !== undefined &&
    type === COMPLETED &&
    run.lastExtractTaskId === taskId
  ) {
    if (embedding === undefined)
      return { action: 'ignore', reason: 'record_deleted' };
    return embedding.passTaskId === null
      ? { action: 'queue_embed', run }
      : { action: 'mark_pass', run };
  }
  if (run !== undefined && type !== COMPLETED && run.extractTaskId === taskId) {
    return { action: 'interrupted', run, nextRound: run.needsRound };
  }
  if (embedding !== undefined && embedding.passTaskId === taskId) {
    return { action: 'release_pass', embedding, nextPass: embedding.needsPass };
  }
  return { action: 'ignore', reason: 'not_learning' };
}

// ---------- The consumer ----------

export interface KnowledgeTriggerDeps {
  /** The savepoint of the vector row of a deep agent that may have been deleted. */
  readonly db: Db;
  readonly tasks: Pick<TaskControl, 'create'>;
  readonly sessionRows: ConversationsRepository;
  readonly knowledgeRunRows: AgentKnowledgeRunsRepository;
  readonly logger: Logger;
}

export function createKnowledgeTrigger(
  deps: KnowledgeTriggerDeps,
): EventConsumer {
  const logger = deps.logger.child({ consumer: CONSUMER_NAME });
  const { sessionRows, knowledgeRunRows: runRows } = deps;

  async function createExtract(
    run: KnowledgeRun,
    rootId: string,
  ): Promise<string> {
    const input: KnowledgeExtractInput = { runId: run.runId, rootId };
    return deps.tasks.create({
      type: KNOWLEDGE_EXTRACT_TASK_TYPE,
      ownerId: run.ownerId,
      input,
    });
  }

  async function createPass(recordId: string): Promise<string> {
    return deps.tasks.create(embedPassRequest(recordId));
  }

  /** Applies the decision; returns the id of the task it created, if any. */
  async function apply(
    event: DeliveredEvent,
    decision: TriggerDecision<KnowledgeRun, KnowledgeEmbeddingRow>,
  ): Promise<string | undefined> {
    switch (decision.action) {
      case 'create_extract': {
        const taskId = await createExtract(decision.run, event.rootId);
        await runRows.updateRun(decision.run.runId, { extractTaskId: taskId });
        return taskId;
      }
      case 'mark_round':
        await runRows.updateRun(decision.run.runId, { needsRound: true });
        return undefined;
      case 'stopped':
        // A round in progress commits later and writes its own outcome over this one; the mark
        // never goes back (Invariant 2), so calls of the stopped stretch are never extracted.
        await runRows.writeRoundOutcome(
          decision.run.runId,
          outcomeOf('skipped', 'stopped', event),
        );
        await runRows.advanceExtractedUpTo(decision.run.runId, event.createdAt);
        return undefined;
      case 'interrupted': {
        const { run } = decision;
        await runRows.writeRoundOutcome(
          run.runId,
          outcomeOf('failed', 'interrupted', event),
        );
        if (!decision.nextRound) {
          await runRows.updateRun(run.runId, { extractTaskId: null });
          return undefined;
        }
        // The failed task's event is rooted at itself; the next round needs the conversation root. It is
        // read from the run's own session: the runtime answers a deleted conversation's tree as missing.
        const rootId = await sessionRows.rootIdOf(run.runId);
        if (rootId === undefined)
          throw new Error(`Learning run ${run.runId} has no session`);
        const taskId = await createExtract(run, rootId);
        await runRows.updateRun(run.runId, {
          extractTaskId: taskId,
          needsRound: false,
        });
        return taskId;
      }
      case 'queue_embed': {
        const { run } = decision;
        const taskId = await createPass(run.recordId);
        await runRows.updateEmbeddingRow(run.recordId, {
          passTaskId: taskId,
          payerId: run.ownerId,
        });
        return taskId;
      }
      case 'mark_pass':
        await runRows.updateEmbeddingRow(decision.run.recordId, {
          needsPass: true,
          payerId: decision.run.ownerId,
        });
        return undefined;
      case 'release_pass': {
        const { recordId } = decision.embedding;
        if (!decision.nextPass) {
          await runRows.updateEmbeddingRow(recordId, { passTaskId: null });
          return undefined;
        }
        const taskId = await createPass(recordId);
        await runRows.updateEmbeddingRow(recordId, {
          passTaskId: taskId,
          needsPass: false,
        });
        return taskId;
      }
      case 'ignore':
        return undefined;
    }
  }

  return {
    name: CONSUMER_NAME,
    eventTypes: [COMPLETED, FAILED, STOPPED],
    schemaVersions: [RUNTIME_EVENT_SCHEMA_VERSION],
    async handle(event) {
      const startedAt = Date.now();
      if (event.taskId === null) return;
      const taskId = event.taskId;

      const run = await findRunOfTask(runRows, event.type, taskId);
      const embedding = await findEmbeddingOfTask(
        deps.db,
        runRows,
        event.type,
        taskId,
        run,
      );
      const decision = triggerDecision(
        { type: event.type, taskId },
        run,
        embedding,
      );
      const createdTaskId = await apply(event, decision);

      // Every task of the platform comes here; one that no knowledge row names is logged at debug.
      const quiet =
        decision.action === 'ignore' && decision.reason === 'not_learning';
      logger[quiet ? 'debug' : 'info']('knowledge trigger decided', {
        eventId: event.eventId,
        eventType: event.type,
        taskId,
        rootId: event.rootId,
        runId: run?.runId ?? null,
        recordId: run?.recordId ?? embedding?.recordId ?? null,
        ownerId: run?.ownerId ?? null,
        decision: decision.action,
        ...(decision.action === 'ignore' ? { reason: decision.reason } : {}),
        ...(decision.action === 'interrupted'
          ? { nextRound: decision.nextRound }
          : {}),
        ...(decision.action === 'release_pass'
          ? { nextPass: decision.nextPass }
          : {}),
        createdTaskId: createdTaskId ?? null,
        durationMs: Date.now() - startedAt,
      });
    },
  };
}

/**
 * The run row naming the task: the deep agent by `run_id`; an extraction by
 * `last_extract_task_id` when it completed (its last round committed), by `extract_task_id` otherwise.
 */
async function findRunOfTask(
  runRows: AgentKnowledgeRunsRepository,
  type: string,
  taskId: string,
): Promise<KnowledgeRun | undefined> {
  const deepAgentRun = knowledgeRunOf(await runRows.findRunById(taskId));
  if (deepAgentRun !== undefined) return deepAgentRun;
  return knowledgeRunOf(
    type === COMPLETED
      ? await runRows.findRunByLastExtractTask(taskId)
      : await runRows.findRunByExtractTask(taskId),
  );
}

/**
 * The vector row the decision needs: the deep agent's row (created when missing) for an ended
 * extraction, the row whose pass is the task when no run row names it.
 */
async function findEmbeddingOfTask(
  db: Db,
  runRows: AgentKnowledgeRunsRepository,
  type: string,
  taskId: string,
  run: KnowledgeRun | undefined,
): Promise<KnowledgeEmbeddingRow | undefined> {
  if (run === undefined) return runRows.findEmbeddingByPassTask(taskId);
  if (run.runId === taskId || type !== COMPLETED) return undefined;
  return holdKnowledgeOf(db, runRows, run.recordId);
}

function outcomeOf(
  status: 'skipped' | 'failed',
  reason: 'stopped' | 'interrupted',
  event: DeliveredEvent,
): RoundOutcome {
  return {
    status,
    reason,
    added: 0,
    confirmed: 0,
    outdated: 0,
    model: null,
    at: event.createdAt,
  };
}
