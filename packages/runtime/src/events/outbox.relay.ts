import type { Logger } from '@agent-os/common';
import { DeliveryStatusSchema } from '@agent-os/contracts';
import type { Database, Transaction } from '@agent-os/db';
import type { Clock } from '../clock';
import type {
  EventConsumer,
  EventConsumerRegistry,
  StoredEvent,
} from './event-consumer.registry';
import type { RuntimeConfig } from '../runtime-config';
import type { TaskRepository } from '../tasks/task.repository';
import type { DeliveryKey, DeliveryRepository, DeliveryRow } from './delivery.repository';
import type { EventLog } from './event-log.repository';
import { WorkerLoop } from '../workers/worker-loop';

const { done, needs_attention } = DeliveryStatusSchema.enum;

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

/**
 * What one delivery did: the consumer ran and the delivery is `done`; it failed and waits for its
 * next try; it is parked as `needs_attention`; or there was nothing to deliver (not `pending`, not
 * due, locked by another relay, its tree deleted, its consumer not registered here).
 */
export type DeliveryOutcome = 'done' | 'retry' | 'needs_attention' | 'skipped';

export interface OutboxRelayDeps {
  db: Database;
  config: RuntimeConfig;
  clock: Clock;
  logger: Logger;
  consumers: EventConsumerRegistry;
  tasks: TaskRepository;
  events: EventLog;
  deliveries: DeliveryRepository;
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
    const { db, deliveries, clock } = this.deps;
    const due = await deliveries.listDue(db, names, clock.now(), DELIVERY_BATCH);
    for (const key of due) await this.deliver(key);
    return due.length === DELIVERY_BATCH;
  }

  private async deliverIn(
    tx: Transaction,
    key: DeliveryKey,
    consumer: EventConsumer,
  ): Promise<DeliveryOutcome> {
    const now = this.deps.clock.now();
    const event = await this.deps.events.find(tx, key.eventId);
    if (!event) return 'skipped';
    // Lock order: the root task, then the delivery.
    if (!(await this.deps.tasks.lockAgainstDelete(tx, event.rootId))) {
      return 'skipped';
    }
    const delivery = await this.deps.deliveries.lockDue(tx, key, now);
    if (!delivery) return 'skipped';

    if (!consumer.schemaVersions.includes(event.schemaVersion)) {
      return this.parkUnknownVersion(tx, delivery, event);
    }
    const failure = await this.runConsumer(tx, consumer, event);
    if (failure !== undefined) {
      return this.recordFailure(tx, delivery, failure, now);
    }
    await this.deps.deliveries.update(tx, delivery, {
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
    tx: Transaction,
    consumer: EventConsumer,
    event: StoredEvent,
  ): Promise<{ error: unknown } | undefined> {
    try {
      await tx.transaction((savepoint) =>
        consumer.handle(savepoint, event),
      );
      return undefined;
    } catch (error) {
      return { error };
    }
  }

  private async recordFailure(
    tx: Transaction,
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
      await this.deps.deliveries.update(tx, delivery, {
        status: needs_attention,
        attempts,
        lastError: errorText(failure.error),
      });
      this.deps.logger.error('delivery needs attention', fields);
      return 'needs_attention';
    }
    const retryInMs = deliveryBackoffMs(attempts, this.deps.clock.random());
    await this.deps.deliveries.update(tx, delivery, {
      attempts,
      lastError: errorText(failure.error),
      nextAttemptAt: new Date(now.getTime() + retryInMs),
    });
    this.deps.logger.warn('delivery failed', { ...fields, retryInMs });
    return 'retry';
  }

  /** An event of a `schemaVersion` the consumer does not know: parked without calling it. */
  private async parkUnknownVersion(
    tx: Transaction,
    delivery: DeliveryRow,
    event: StoredEvent,
  ): Promise<DeliveryOutcome> {
    await this.deps.deliveries.update(tx, delivery, {
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
}
