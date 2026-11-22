import type { Logger } from '@agent-os/common';
import { DeliveryStatusSchema } from '@agent-os/contracts';
import {
  Db,
  type RuntimeEventDeliveryKey,
  RuntimeEventDeliveriesRepository,
  type RuntimeEventDeliveryRow,
  RuntimeTasksRepository,
} from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../clock';
import {
  type EventConsumer,
  EventConsumerRegistry,
  type StoredEvent,
} from './event-consumer.registry';
import type { RuntimeConfig } from '../runtime-config';
import { CLOCK, RUNTIME_CONFIG, RUNTIME_LOGGER } from '../runtime.tokens';
import { EventLog } from './event-log';
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
 * due, its tree deleted, its consumer not registered here).
 */
export type DeliveryOutcome = 'done' | 'retry' | 'needs_attention' | 'skipped';

interface OutboxRelayDeps {
  db: Db;
  config: RuntimeConfig;
  clock: Clock;
  logger: Logger;
  consumers: EventConsumerRegistry;
  taskRows: RuntimeTasksRepository;
  events: EventLog;
  deliveries: RuntimeEventDeliveriesRepository;
}

/**
 * Delivery of outbox events to their consumers. Every `RUNTIME_POLL_MS` it takes the due `pending`
 * deliveries of the consumers registered in this process and delivers each in its own
 * transaction: the event's root is checked to exist, then the delivery is read, still `pending`
 * and due; the consumer runs in a savepoint and
 * the delivery is marked `done` in the same transaction. A failing consumer is rolled back to the
 * savepoint while its counters are written; after `RUNTIME_DELIVERY_MAX_ATTEMPTS` — or at once for
 * an unknown `schemaVersion` — the delivery is parked as `needs_attention` and the others go on.
 */
@Injectable()
export class OutboxRelay {
  private readonly loop: WorkerLoop;
  private readonly deps: OutboxRelayDeps;

  constructor(
    @Inject(Db) db: Db,
    @Inject(RUNTIME_CONFIG) config: RuntimeConfig,
    @Inject(CLOCK) clock: Clock,
    @Inject(RUNTIME_LOGGER) runtimeLogger: Logger,
    @Inject(EventConsumerRegistry) consumers: EventConsumerRegistry,
    @Inject(RuntimeTasksRepository) taskRows: RuntimeTasksRepository,
    @Inject(EventLog) events: EventLog,
    @Inject(RuntimeEventDeliveriesRepository)
    deliveries: RuntimeEventDeliveriesRepository,
  ) {
    const logger = runtimeLogger.child({ worker: 'relay' });
    this.deps = {
      db,
      config,
      clock,
      logger,
      consumers,
      taskRows,
      events,
      deliveries,
    };
    this.loop = new WorkerLoop({
      name: 'relay',
      periodMs: config.pollMs,
      pollMs: config.pollMs,
      clock,
      logger,
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
  async deliver(key: RuntimeEventDeliveryKey): Promise<DeliveryOutcome> {
    const consumer = this.deps.consumers.get(key.consumer);
    if (!consumer) return 'skipped';
    return this.deps.db.transaction(() => this.deliverIn(key, consumer));
  }

  /** One pass: the oldest due deliveries of the local consumers; `true` when the batch was full. */
  private async deliverDue(): Promise<boolean> {
    const names = this.deps.consumers.names();
    if (names.length === 0) return false;
    const { deliveries, clock } = this.deps;
    const due = await deliveries.listDue(names, clock.now(), DELIVERY_BATCH);
    for (const key of due) await this.deliver(key);
    return due.length === DELIVERY_BATCH;
  }

  private async deliverIn(
    key: RuntimeEventDeliveryKey,
    consumer: EventConsumer,
  ): Promise<DeliveryOutcome> {
    const now = this.deps.clock.now();
    const event = await this.deps.events.find(key.eventId);
    if (!event) return 'skipped';
    if (!(await this.deps.taskRows.exists(event.rootId))) {
      return 'skipped';
    }
    const delivery = await this.deps.deliveries.findDue(key, now);
    if (!delivery) return 'skipped';

    if (!consumer.schemaVersions.includes(event.schemaVersion)) {
      return this.parkUnknownVersion(delivery, event);
    }
    const failure = await this.runConsumer(consumer, event);
    if (failure !== undefined) {
      return this.recordFailure(delivery, failure, now);
    }
    await this.deps.deliveries.update(delivery, {
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
    consumer: EventConsumer,
    event: StoredEvent,
  ): Promise<{ error: unknown } | undefined> {
    try {
      await this.deps.db.savepoint(() => consumer.handle(event));
      return undefined;
    } catch (error) {
      return { error };
    }
  }

  private async recordFailure(
    delivery: RuntimeEventDeliveryRow,
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
      await this.deps.deliveries.update(delivery, {
        status: needs_attention,
        attempts,
        lastError: errorText(failure.error),
      });
      this.deps.logger.error('delivery needs attention', fields);
      return 'needs_attention';
    }
    const retryInMs = deliveryBackoffMs(attempts, this.deps.clock.random());
    await this.deps.deliveries.update(delivery, {
      attempts,
      lastError: errorText(failure.error),
      nextAttemptAt: new Date(now.getTime() + retryInMs),
    });
    this.deps.logger.warn('delivery failed', { ...fields, retryInMs });
    return 'retry';
  }

  /** An event of a `schemaVersion` the consumer does not know: parked without calling it. */
  private async parkUnknownVersion(
    delivery: RuntimeEventDeliveryRow,
    event: StoredEvent,
  ): Promise<DeliveryOutcome> {
    await this.deps.deliveries.update(delivery, {
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
