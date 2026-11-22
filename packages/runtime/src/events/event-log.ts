import { randomUUID } from 'node:crypto';
import {
  EVENT_PAYLOAD_MAX_BYTES,
  type RuntimeEventType,
} from '@agent-os/contracts';
import {
  Db,
  RuntimeEventDeliveriesRepository,
  RuntimeEventsRepository,
} from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  EventConsumerRegistry,
  type StoredEvent,
} from './event-consumer.registry';
import type { TaskRow } from '../tasks/guarded-transition';

/**
 * `LISTEN` channel of the runtime. The payload is JSON `{"rootId","taskId","type"}`: the dispatcher
 * ticks on any event and cuts its step off on `task.interrupted`/`task.stopped`; an observer of a
 * tree filters by `rootId`. A hint only: the log is read with `listAfter`.
 */
export const RUNTIME_EVENTS_CHANNEL = 'runtime_events';
/** `schemaVersion` of every event written by this runtime. */
export const RUNTIME_EVENT_SCHEMA_VERSION = 1;
/** Upper bound of `listAfter`'s `limit`. */
const LIST_AFTER_MAX_LIMIT = 500;

/** Prefixes of the runtime's own event types; an upper-layer event never carries them. */
const RESERVED_EVENT_PREFIXES = ['task.', 'inbox.', 'decision.'] as const;
/** An upper-layer type: its package prefix, a dot, a name (`agents.history_appended`). */
const UPPER_EVENT_TYPE_FORMAT = /^[a-z][a-z0-9-]*\.[a-z0-9_.-]+$/;

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
 * `NOTIFY` — all in the transaction open at the call, so the notification goes out at its commit and
 * nothing is written when it rolls back (ADR-0001).
 */
@Injectable()
export class EventLog {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(RuntimeEventsRepository) private readonly rows: RuntimeEventsRepository,
    @Inject(RuntimeEventDeliveriesRepository)
    private readonly deliveries: RuntimeEventDeliveriesRepository,
    @Inject(EventConsumerRegistry) private readonly consumers: EventConsumerRegistry,
  ) {}

  /** Writes an event of the runtime itself. */
  append(event: NewEvent): Promise<StoredEvent> {
    return this.write(event);
  }

  /** Writes an upper-layer event; throws when {@link upperEventProblem} finds one. */
  appendUpper(event: NewEvent<string>): Promise<StoredEvent> {
    const problem = upperEventProblem(event.type, event.payload);
    if (problem !== undefined) throw new Error(problem);
    return this.write(event);
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
    return this.rows.listAfter(rootId, ownerId, afterSeq, cappedLimit);
  }

  /** The event by its id, as its consumers receive it. */
  find(eventId: string): Promise<StoredEvent | undefined> {
    return this.rows.find(eventId);
  }

  /** The one way an event, its deliveries and its NOTIFY are written. */
  private async write(event: NewEvent<string>): Promise<StoredEvent> {
    const eventId = randomUUID();
    const { taskId, rootId, stepNo } = event.task;
    const causationId = event.causationId ?? null;
    const row = await this.rows.insert({
      eventId,
      type: event.type,
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      rootId,
      taskId,
      causationId,
      stateRevision: stepNo,
      payload: event.payload,
    });

    const consumerNames = this.consumers.consumerNamesFor(event.type);
    if (consumerNames.length > 0) {
      await this.deliveries.insert(eventId, consumerNames);
    }
    const notice = JSON.stringify({ rootId, taskId, type: event.type });
    await this.db.client.execute(sql`select pg_notify(${RUNTIME_EVENTS_CHANNEL}, ${notice})`);

    return {
      eventId,
      seq: row.seq,
      type: event.type,
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      rootId,
      taskId,
      causationId,
      stateRevision: stepNo,
      payload: event.payload,
      createdAt: row.createdAt,
    };
  }
}
