import { randomUUID } from 'node:crypto';
import {
  RuntimeEventTypeSchema,
  type EventEnvelope,
  type RuntimeEventType,
} from '@agent-os/contracts';
import { and, desc, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import { researchEventDeliveries, researchEvents } from '@agent-os/db';
import { EventConsumerRegistry } from './event-consumer.registry.js';
import type { RuntimeTx } from './guarded-transition.js';

/** `LISTEN` channel of the runtime; the payload is the event type. A hint only (KD-4). */
export const RUNTIME_NOTIFY_CHANNEL = 'research_runtime';
/** `schemaVersion` of every runtime event type. */
export const RUNTIME_EVENT_SCHEMA_VERSION = 1;

/** An envelope as stored, with its insertion order. */
export type StoredEvent = EventEnvelope & { seq: number };

/** What the writer of an event decides; ids, correlation, version and time come from the log. */
export interface NewEvent {
  type: RuntimeEventType;
  investigationId: string;
  taskId: string | null;
  causationId: string | null;
  /** `state_version` of the task, or `revision` of the investigation. */
  stateRevision: number;
  payload: EventEnvelope['payload'];
  payloadRef?: EventEnvelope['payloadRef'];
}

/** The event whose cause is looked up, per the causal chain of EventEnvelope. */
export type CauseQuery =
  | {
      type: 'TaskStarted';
      taskId: string;
      dependencyTaskIds: readonly string[];
    }
  | {
      type:
        | 'ToolCallReserved'
        | 'EvidenceStored'
        | 'TaskSucceeded'
        | 'TaskFailed'
        | 'TaskCancelled';
      taskId: string;
    };

const {
  InvestigationCreated,
  TaskQueued,
  TaskStarted,
  ToolCallReserved,
  EvidenceStored,
  TaskSucceeded,
} = RuntimeEventTypeSchema.enum;

/** Cause of a task's own event: its latest earlier event of these types. */
const OWN_CAUSE_TYPES = {
  ToolCallReserved: [TaskStarted],
  EvidenceStored: [ToolCallReserved],
  TaskSucceeded: [EvidenceStored, TaskStarted],
  TaskFailed: [EvidenceStored, TaskStarted],
  TaskCancelled: [EvidenceStored, TaskStarted],
} as const satisfies Record<string, readonly RuntimeEventType[]>;

const ofTask = (
  taskId: string,
  types: readonly RuntimeEventType[],
): SQL | undefined =>
  and(
    eq(researchEvents.taskId, taskId),
    inArray(researchEvents.type, [...types]),
  );

/**
 * Transactional outbox (KD-4): the event, one delivery row per registered consumer of its type
 * and a `NOTIFY` — all in the caller's transaction, so the notification goes out at its commit
 * and nothing is written when it rolls back. The event insert takes FOR KEY SHARE on the
 * investigation through its FK, compatible with the investigation's FOR NO KEY UPDATE.
 */
export class EventLog {
  constructor(private readonly consumers: EventConsumerRegistry) {}

  async append(tx: RuntimeTx, event: NewEvent): Promise<StoredEvent> {
    const eventId = randomUUID();
    const correlationId =
      event.type === InvestigationCreated
        ? eventId
        : await this.correlationOf(tx, event.investigationId);
    const payloadRef = event.payloadRef ?? null;
    const [row] = await tx
      .insert(researchEvents)
      .values({
        eventId,
        type: event.type,
        schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
        investigationId: event.investigationId,
        taskId: event.taskId,
        causationId: event.causationId,
        correlationId,
        stateRevision: event.stateRevision,
        payloadRef,
        payload: event.payload,
      })
      .returning({
        seq: researchEvents.seq,
        createdAt: researchEvents.createdAt,
      });

    const consumerNames = this.consumers.consumerNamesFor(event.type);
    if (consumerNames.length > 0) {
      await tx
        .insert(researchEventDeliveries)
        .values(consumerNames.map((consumer) => ({ eventId, consumer })));
    }
    await tx.execute(
      sql`select pg_notify(${RUNTIME_NOTIFY_CHANNEL}, ${event.type})`,
    );

    return {
      eventId,
      seq: row.seq,
      type: event.type,
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      investigationId: event.investigationId,
      taskId: event.taskId,
      causationId: event.causationId,
      correlationId,
      stateRevision: event.stateRevision,
      payloadRef,
      payload: event.payload,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * `eventId` of the cause of the event about to be written (EventEnvelope causal chain):
   * `TaskStarted` ← latest `TaskSucceeded` of a dependency or `TaskQueued` of the task;
   * `ToolCallReserved` ← `TaskStarted`; `EvidenceStored` ← latest `ToolCallReserved`;
   * outcome ← latest `EvidenceStored` or `TaskStarted`. `null` when there is none.
   */
  async causeOf(tx: RuntimeTx, query: CauseQuery): Promise<string | null> {
    const condition =
      query.type === TaskStarted
        ? or(
            ofTask(query.taskId, [TaskQueued]),
            query.dependencyTaskIds.length > 0
              ? and(
                  inArray(researchEvents.taskId, [...query.dependencyTaskIds]),
                  eq(researchEvents.type, TaskSucceeded),
                )
              : undefined,
          )
        : ofTask(query.taskId, OWN_CAUSE_TYPES[query.type]);
    const [cause] = await tx
      .select({ eventId: researchEvents.eventId })
      .from(researchEvents)
      .where(condition)
      .orderBy(desc(researchEvents.seq))
      .limit(1);
    return cause?.eventId ?? null;
  }

  /** `correlationId` of the investigation: the `eventId` of its `InvestigationCreated`. */
  private async correlationOf(
    tx: RuntimeTx,
    investigationId: string,
  ): Promise<string> {
    const [created] = await tx
      .select({ eventId: researchEvents.eventId })
      .from(researchEvents)
      .where(
        and(
          eq(researchEvents.investigationId, investigationId),
          eq(researchEvents.type, InvestigationCreated),
        ),
      )
      .limit(1);
    if (!created) {
      throw new Error(
        `Investigation ${investigationId} has no InvestigationCreated event to correlate with`,
      );
    }
    return created.eventId;
  }
}
