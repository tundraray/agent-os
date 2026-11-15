import type { Logger } from '@agent-os/common';
import { DeliveryStatusSchema } from '@agent-os/contracts';
import {
  type Database,
  runtimeEventDeliveries,
  runtimeEvents,
} from '@agent-os/db';
import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import type { CancelTimer, Clock } from './clock.js';
import type {
  EventConsumer,
  EventConsumerRegistry,
} from './event-consumer.registry.js';
import type { StoredEvent } from './event-log.js';
import type { RuntimeConfig } from './runtime-config.js';
import type { RuntimeTx } from './runtime-tx.js';
import type { TaskRepository } from './task.repository.js';

const { pending, done, needs_attention } = DeliveryStatusSchema.enum;

/** Backoff of a worker loop doubles from `RUNTIME_POLL_MS` up to 16 × `RUNTIME_POLL_MS`. */
const MAX_LOOP_BACKOFF_DOUBLINGS = 4;
/** Deliveries taken by one pass of the relay. */
const DELIVERY_BATCH = 50;
/** Backoff of a failed delivery: 1 s, doubling up to 60 s, with jitter. */
const DELIVERY_BACKOFF_BASE_MS = 1_000;
const DELIVERY_BACKOFF_MAX_MS = 60_000;
const LAST_ERROR_MAX = 500;

const errorText = (error: unknown): string =>
  (error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error)
  ).slice(0, LAST_ERROR_MAX);

/**
 * Delay before the next try of a delivery that has failed `attempts` times: the ceiling doubles
 * from 1 s up to 60 s; the delay is uniform in its upper half (`random` ∈ [0, 1)).
 */
function deliveryBackoffMs(attempts: number, random: number): number {
  const ceiling = Math.min(
    DELIVERY_BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0),
    DELIVERY_BACKOFF_MAX_MS,
  );
  return Math.round(ceiling / 2 + (random * ceiling) / 2);
}

export interface WorkerLoopOptions {
  /** Name in the log. */
  name: string;
  /** Delay after a pass that left no work behind. */
  periodMs: number;
  /** `RUNTIME_POLL_MS`: the first delay after a failed pass. */
  pollMs: number;
  clock: Clock;
  logger: Logger;
  /** One pass; resolves `true` when work may remain, and the next pass runs at once. */
  pass: () => Promise<boolean>;
}

/**
 * A periodic worker of the runtime (relay, sweeper). A failed pass — the database is unreachable —
 * is logged and retried with backoff doubling from `RUNTIME_POLL_MS` up to 16 × `RUNTIME_POLL_MS`;
 * the state is not changed.
 */
export class WorkerLoop {
  private running = false;
  private failures = 0;
  private cancelTimer: CancelTimer | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly options: WorkerLoopOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  /** Stops scheduling passes and waits for the pass in flight. */
  async stop(): Promise<void> {
    this.running = false;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    await this.inFlight;
  }

  private schedule(delayMs: number): void {
    this.cancelTimer = this.options.clock.setTimer(delayMs, () => {
      this.cancelTimer = undefined;
      this.inFlight = this.run().finally(() => {
        this.inFlight = undefined;
      });
    });
  }

  private async run(): Promise<void> {
    const { name, periodMs, pollMs, logger, pass } = this.options;
    let delay = periodMs;
    try {
      const more = await pass();
      this.failures = 0;
      if (more) delay = 0;
    } catch (error) {
      this.failures += 1;
      delay =
        pollMs * 2 ** Math.min(this.failures - 1, MAX_LOOP_BACKOFF_DOUBLINGS);
      logger.error('worker pass failed', { worker: name, error, retryInMs: delay });
    }
    if (this.running) this.schedule(delay);
  }
}

/** One delivery row: the event and the consumer it is owed to. */
export interface DeliveryKey {
  eventId: string;
  consumer: string;
}

/**
 * What one delivery did: the consumer ran and the delivery is `done`; it failed and waits for its
 * next try; it is parked as `needs_attention`; or there was nothing to deliver (not `pending`, not
 * due, locked by another relay, its tree deleted, its consumer not registered here).
 */
export type DeliveryOutcome = 'done' | 'retry' | 'needs_attention' | 'skipped';

type EventRow = typeof runtimeEvents.$inferSelect;
type DeliveryRow = typeof runtimeEventDeliveries.$inferSelect;

export interface OutboxRelayDeps {
  db: Database;
  config: RuntimeConfig;
  clock: Clock;
  logger: Logger;
  consumers: EventConsumerRegistry;
  tasks: TaskRepository;
}

/**
 * Delivery of outbox events to their consumers. Every `RUNTIME_POLL_MS` it takes the due `pending`
 * deliveries of the consumers registered in this process and delivers each in its own
 * transaction: the event's root is locked FOR KEY SHARE (the tree cannot be deleted meanwhile),
 * then the delivery FOR UPDATE SKIP LOCKED, still `pending`; the consumer runs in a savepoint and
 * the delivery is marked `done` in the same transaction. A failing consumer is rolled back to the
 * savepoint while its counters are written; after `RUNTIME_DELIVERY_MAX_ATTEMPTS` — or at once for
 * an unknown `schemaVersion` — the delivery is parked as `needs_attention` and the others go on.
 */
export class OutboxRelay {
  private readonly loop: WorkerLoop;

  constructor(private readonly deps: OutboxRelayDeps) {
    this.loop = new WorkerLoop({
      name: 'relay',
      periodMs: deps.config.pollMs,
      pollMs: deps.config.pollMs,
      clock: deps.clock,
      logger: deps.logger,
      pass: () => this.deliverDue(),
    });
  }

  start(): void {
    this.loop.start();
  }

  shutdown(): Promise<void> {
    return this.loop.stop();
  }

  /** Delivers one delivery in its own transaction; a delivery that is not due is `skipped`. */
  async deliver(key: DeliveryKey): Promise<DeliveryOutcome> {
    const consumer = this.deps.consumers.get(key.consumer);
    if (!consumer) return 'skipped';
    return this.deps.db.transaction((tx) => this.deliverIn(tx, key, consumer));
  }

  /** One pass: the oldest due deliveries of the local consumers; `true` when the batch was full. */
  private async deliverDue(): Promise<boolean> {
    const names = this.deps.consumers.names();
    if (names.length === 0) return false;
    const due = await this.deps.db
      .select({
        eventId: runtimeEventDeliveries.eventId,
        consumer: runtimeEventDeliveries.consumer,
      })
      .from(runtimeEventDeliveries)
      .innerJoin(
        runtimeEvents,
        eq(runtimeEvents.eventId, runtimeEventDeliveries.eventId),
      )
      .where(
        and(
          eq(runtimeEventDeliveries.status, pending),
          lte(runtimeEventDeliveries.nextAttemptAt, this.deps.clock.now()),
          inArray(runtimeEventDeliveries.consumer, names),
        ),
      )
      .orderBy(
        asc(runtimeEventDeliveries.nextAttemptAt),
        asc(runtimeEvents.seq),
        // Only for determinism: the deliveries of one event share `next_attempt_at` and `seq`.
        desc(runtimeEventDeliveries.consumer),
      )
      .limit(DELIVERY_BATCH);
    for (const key of due) await this.deliver(key);
    return due.length === DELIVERY_BATCH;
  }

  private async deliverIn(
    tx: RuntimeTx,
    key: DeliveryKey,
    consumer: EventConsumer,
  ): Promise<DeliveryOutcome> {
    const now = this.deps.clock.now();
    const [event] = await tx
      .select()
      .from(runtimeEvents)
      .where(eq(runtimeEvents.eventId, key.eventId));
    if (!event) return 'skipped';
    // Lock order: the root task, then the delivery.
    if (!(await this.deps.tasks.lockAgainstDelete(tx, event.rootId))) {
      return 'skipped';
    }
    const [delivery] = await tx
      .select()
      .from(runtimeEventDeliveries)
      .where(
        and(
          eq(runtimeEventDeliveries.eventId, key.eventId),
          eq(runtimeEventDeliveries.consumer, key.consumer),
          // Checked again under the lock: a done delivery is never applied twice.
          eq(runtimeEventDeliveries.status, pending),
          lte(runtimeEventDeliveries.nextAttemptAt, now),
        ),
      )
      .for('update', { skipLocked: true });
    if (!delivery) return 'skipped';

    if (!consumer.schemaVersions.includes(event.schemaVersion)) {
      return this.parkUnknownVersion(tx, delivery, event);
    }
    const failure = await this.runConsumer(tx, consumer, event);
    if (failure !== undefined) {
      return this.recordFailure(tx, delivery, failure, now);
    }
    await this.updateDelivery(tx, delivery, {
      status: done,
      attempts: delivery.attempts + 1,
      lastError: null,
    });
    return 'done';
  }

  /**
   * The consumer in a savepoint: its writes are rolled back on failure while the delivery
   * transaction goes on. Returns the failure, `undefined` on success.
   */
  private async runConsumer(
    tx: RuntimeTx,
    consumer: EventConsumer,
    event: EventRow,
  ): Promise<{ error: unknown } | undefined> {
    try {
      await tx.transaction((savepoint) =>
        consumer.handle(savepoint, toStoredEvent(event)),
      );
      return undefined;
    } catch (error) {
      return { error };
    }
  }

  private async recordFailure(
    tx: RuntimeTx,
    delivery: DeliveryRow,
    failure: { error: unknown },
    now: Date,
  ): Promise<DeliveryOutcome> {
    const attempts = delivery.attempts + 1;
    const fields = {
      eventId: delivery.eventId,
      consumer: delivery.consumer,
      attempts,
      error: failure.error,
    };
    if (attempts >= this.deps.config.deliveryMaxAttempts) {
      await this.updateDelivery(tx, delivery, {
        status: needs_attention,
        attempts,
        lastError: errorText(failure.error),
      });
      this.deps.logger.error('delivery needs attention', fields);
      return 'needs_attention';
    }
    const retryInMs = deliveryBackoffMs(attempts, this.deps.clock.random());
    await this.updateDelivery(tx, delivery, {
      attempts,
      lastError: errorText(failure.error),
      nextAttemptAt: new Date(now.getTime() + retryInMs),
    });
    this.deps.logger.warn('delivery failed', { ...fields, retryInMs });
    return 'retry';
  }

  /** An event of a `schemaVersion` the consumer does not know: parked without calling it. */
  private async parkUnknownVersion(
    tx: RuntimeTx,
    delivery: DeliveryRow,
    event: EventRow,
  ): Promise<DeliveryOutcome> {
    await this.updateDelivery(tx, delivery, {
      status: needs_attention,
      lastError: `Unknown schemaVersion ${event.schemaVersion} of ${event.type}`,
    });
    this.deps.logger.error('delivery needs attention', {
      eventId: delivery.eventId,
      consumer: delivery.consumer,
      schemaVersion: event.schemaVersion,
    });
    return 'needs_attention';
  }

  private async updateDelivery(
    tx: RuntimeTx,
    delivery: DeliveryRow,
    fields: Partial<
      Pick<DeliveryRow, 'status' | 'attempts' | 'nextAttemptAt' | 'lastError'>
    >,
  ): Promise<void> {
    await tx
      .update(runtimeEventDeliveries)
      .set(fields)
      .where(
        and(
          eq(runtimeEventDeliveries.eventId, delivery.eventId),
          eq(runtimeEventDeliveries.consumer, delivery.consumer),
        ),
      );
  }
}

function toStoredEvent(event: EventRow): StoredEvent {
  return {
    eventId: event.eventId,
    seq: event.seq,
    type: event.type,
    schemaVersion: event.schemaVersion,
    rootId: event.rootId,
    taskId: event.taskId,
    causationId: event.causationId,
    stateRevision: event.stateRevision,
    payloadRef: event.payloadRef,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}
