import { randomUUID } from 'node:crypto';
import {
  EVENT_PAYLOAD_MAX_BYTES,
  type RuntimeEventType,
} from '@agent-os/contracts';
import {
  type Database,
  runtimeEventDeliveries,
  runtimeEvents,
  runtimeTasks,
} from '@agent-os/db';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { EventConsumerRegistry } from './event-consumer.registry.js';
import type { TaskRow } from './guarded-transition.js';
import type { RuntimeTx } from './runtime-tx.js';

/**
 * `LISTEN` channel of the runtime. The payload is JSON `{"rootId","taskId","type"}`: the dispatcher
 * ticks on any event and cuts its step off on `task.interrupted`/`task.stopped`; an observer of a
 * tree filters by `rootId`. A hint only: the log is read with `listAfter`.
 */
export const RUNTIME_EVENTS_CHANNEL = 'runtime_events';
/** `schemaVersion` of every event written by this runtime. */
const RUNTIME_EVENT_SCHEMA_VERSION = 1;
/** Upper bound of `listAfter`'s `limit`. */
const LIST_AFTER_MAX_LIMIT = 500;

/** Prefixes of the runtime's own event types; an upper-layer event never carries them. */
const RESERVED_EVENT_PREFIXES = ['task.', 'inbox.', 'decision.'] as const;
/** An upper-layer type: its package prefix, a dot, a name (`agents.history_appended`). */
const UPPER_EVENT_TYPE_FORMAT = /^[a-z][a-z0-9-]*\.[a-z0-9_.-]+$/;

/** An event as stored, with its insertion order. */
export interface StoredEvent {
  eventId: string;
  /** Insertion order in the log; events of a tree are read by it. */
  seq: number;
  type: string;
  schemaVersion: number;
  rootId: string;
  taskId: string | null;
  causationId: string | null;
  /** `step_no` of the task when the event was written. */
  stateRevision: number;
  payloadRef: string | null;
  payload: unknown;
  createdAt: Date;
}

/** An event of a tree as `listAfter` returns it. */
export type TreeEvent = Pick<
  StoredEvent,
  'seq' | 'type' | 'taskId' | 'createdAt' | 'payload'
>;

/** The task an event is about: it gives the tree, the task and the revision. */
export type EventTask = Pick<TaskRow, 'taskId' | 'rootId' | 'stepNo'>;

/** What the writer of an event decides; ids, version and time come from the log. */
export interface NewEvent<Type extends string = RuntimeEventType> {
  type: Type;
  task: EventTask;
  payload: unknown;
  causationId?: string | null;
}

/**
 * Size of a payload as Postgres counts it in the CHECK of `runtime_events`
 * (`octet_length(payload::text)`): the JSON text with a space after every `:` and `,`.
 */
function jsonbTextBytes(value: unknown): number {
  const json = JSON.stringify(value) ?? 'null';
  let separators = 0;
  let inString = false;
  let escaped = false;
  for (const char of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === ':' || char === ',') separators += 1;
  }
  return Buffer.byteLength(json, 'utf8') + separators;
}

/**
 * Why an upper-layer event (`effects.emit`) cannot be written, or `undefined` when it can: its type
 * needs a package prefix other than `task.`, `inbox.` and `decision.`; its payload is at most 8 KiB.
 */
export function upperEventProblem(
  type: string,
  payload: unknown,
): string | undefined {
  if (RESERVED_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix))) {
    return `event type "${type}" uses a prefix reserved by the runtime`;
  }
  if (!UPPER_EVENT_TYPE_FORMAT.test(type)) {
    return `event type "${type}" has no package prefix`;
  }
  const bytes = jsonbTextBytes(payload);
  if (bytes > EVENT_PAYLOAD_MAX_BYTES) {
    return `payload of event "${type}" is ${bytes} bytes, over ${EVENT_PAYLOAD_MAX_BYTES}`;
  }
  return undefined;
}

/**
 * Transactional outbox: the event, one delivery row per registered consumer of its type and a
 * `NOTIFY` — all in the caller's transaction, so the notification goes out at its commit and
 * nothing is written when it rolls back (ADR-0001).
 */
export class EventLog {
  constructor(
    private readonly db: Database,
    private readonly consumers: EventConsumerRegistry,
  ) {}

  /** Writes an event of the runtime itself. */
  append(tx: RuntimeTx, event: NewEvent): Promise<StoredEvent> {
    return this.write(tx, event);
  }

  /** Writes an upper-layer event; throws when {@link upperEventProblem} finds one. */
  appendUpper(tx: RuntimeTx, event: NewEvent<string>): Promise<StoredEvent> {
    const problem = upperEventProblem(event.type, event.payload);
    if (problem !== undefined) throw new Error(problem);
    return this.write(tx, event);
  }

  /**
   * Events of the owner's tree with `seq > afterSeq`, by `seq`, at most `limit` (capped at 500).
   * Another owner's or a missing tree gives `[]`.
   */
  async listAfter(
    rootId: string,
    ownerId: string,
    afterSeq: number,
    limit: number,
  ): Promise<TreeEvent[]> {
    const cappedLimit = Math.min(Math.max(Math.trunc(limit), 0), LIST_AFTER_MAX_LIMIT);
    if (cappedLimit === 0) return [];
    return this.db
      .select({
        seq: runtimeEvents.seq,
        type: runtimeEvents.type,
        taskId: runtimeEvents.taskId,
        createdAt: runtimeEvents.createdAt,
        payload: runtimeEvents.payload,
      })
      .from(runtimeEvents)
      .innerJoin(
        runtimeTasks,
        and(
          eq(runtimeTasks.taskId, runtimeEvents.rootId),
          eq(runtimeTasks.ownerId, ownerId),
        ),
      )
      .where(and(eq(runtimeEvents.rootId, rootId), gt(runtimeEvents.seq, afterSeq)))
      .orderBy(asc(runtimeEvents.seq))
      .limit(cappedLimit);
  }

  /** The one way an event, its deliveries and its NOTIFY are written. */
  private async write(
    tx: RuntimeTx,
    event: NewEvent<string>,
  ): Promise<StoredEvent> {
    const eventId = randomUUID();
    const { taskId, rootId, stepNo } = event.task;
    const causationId = event.causationId ?? null;
    const [row] = await tx
      .insert(runtimeEvents)
      .values({
        eventId,
        type: event.type,
        schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
        rootId,
        taskId,
        causationId,
        stateRevision: stepNo,
        payloadRef: null,
        payload: event.payload,
      })
      .returning({ seq: runtimeEvents.seq, createdAt: runtimeEvents.createdAt });

    const consumerNames = this.consumers.consumerNamesFor(event.type);
    if (consumerNames.length > 0) {
      await tx
        .insert(runtimeEventDeliveries)
        .values(consumerNames.map((consumer) => ({ eventId, consumer })));
    }
    const notice = JSON.stringify({ rootId, taskId, type: event.type });
    await tx.execute(sql`select pg_notify(${RUNTIME_EVENTS_CHANNEL}, ${notice})`);

    return {
      eventId,
      seq: row.seq,
      type: event.type,
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      rootId,
      taskId,
      causationId,
      stateRevision: stepNo,
      payloadRef: null,
      payload: event.payload,
      createdAt: row.createdAt,
    };
  }
}
