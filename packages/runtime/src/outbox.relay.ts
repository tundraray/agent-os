import {
  DeliveryStatusSchema,
  type EventEnvelope,
  EventEnvelopeSchema,
  RuntimeEventTypeSchema,
} from '@agent-os/contracts';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type { RuntimeLogger } from './ports.js';
import type { RuntimeConfig } from './runtime-config.js';
import {
  type Database,
  researchEventDeliveries,
  researchEvents,
} from '@agent-os/db';
import type { CancelTimer, Clock } from './clock.js';
import { CrashPoints } from './crash-points.js';
import {
  type EventConsumer,
  EventConsumerRegistry,
} from './event-consumer.registry.js';
import type { RuntimeTx } from './guarded-transition.js';
import { TaskRepository } from './task.repository.js';

const { pending, done, needs_attention } = DeliveryStatusSchema.enum;

/** Backoff of a worker loop doubles from `RUNTIME_POLL_MS` up to 16 × `RUNTIME_POLL_MS`. */
const MAX_LOOP_BACKOFF_DOUBLINGS = 4;
/** Deliveries taken by one pass of the relay. */
const DELIVERY_BATCH = 50;
/** Backoff of a failed delivery: 1 s, doubling up to 60 s, with jitter (Runtime Settings). */
const DELIVERY_BACKOFF_BASE_MS = 1_000;
const DELIVERY_BACKOFF_MAX_MS = 60_000;
const LAST_ERROR_MAX = 500;

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : 'Unknown';

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
  logger: RuntimeLogger;
  /** One pass; resolves `true` when work may remain, and the next pass runs at once. */
  pass: () => Promise<boolean>;
}

/**
 * A periodic worker of the runtime (relay, reaper). A failed pass — the database is unreachable —
 * is logged and retried with backoff doubling from `RUNTIME_POLL_MS` up to 16 × `RUNTIME_POLL_MS`;
 * the state is not changed (Error Handling).
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
      logger.error(
        `${name} pass failed error=${errorName(error)} retryInMs=${delay}`,
      );
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
 * due, locked by another relay, its investigation deleted, its consumer not registered here).
 */
export type DeliveryOutcome = 'done' | 'retry' | 'needs_attention' | 'skipped';

type EventRow = typeof researchEvents.$inferSelect;
type DeliveryRow = typeof researchEventDeliveries.$inferSelect;

/**
 * Delivery of outbox events to their consumers (Flow 3, KD-4). Every `RUNTIME_POLL_MS` it takes
 * the due `pending` deliveries of the consumers registered in this process and delivers each in
 * its own transaction: the event's `investigation_id` is read without a lock, the investigation is
 * locked FOR NO KEY UPDATE, then the delivery FOR UPDATE SKIP LOCKED, still `pending`; the
 * consumer runs in a savepoint and the delivery is marked `done` in the same transaction. A
 * failing consumer is rolled back to the savepoint while its counters are written; after
 * `RUNTIME_DELIVERY_MAX_ATTEMPTS` — or at once for an unknown `schemaVersion` — the delivery is
 * parked as `needs_attention` and the others go on.
 */
export class OutboxRelay {
  private readonly loop: WorkerLoop;

  constructor(
    private readonly db: Database,
    private readonly config: RuntimeConfig,
    private readonly clock: Clock,
    private readonly logger: RuntimeLogger,
    private readonly consumers: EventConsumerRegistry,
    private readonly tasks: TaskRepository,
    private readonly crashPoints: CrashPoints,
  ) {
    this.loop = new WorkerLoop({
      name: 'relay',
      periodMs: config.pollMs,
      pollMs: config.pollMs,
      clock,
      logger: this.logger,
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
    const consumer = this.consumers.get(key.consumer);
    if (!consumer) return 'skipped';
    const outcome = await this.db.transaction((tx) =>
      this.deliverIn(tx, key, consumer),
    );
    if (outcome === 'done') this.crashPoints.hit('relay.after-done');
    return outcome;
  }

  /** One pass: the oldest due deliveries of the local consumers; `true` when the batch was full. */
  private async deliverDue(): Promise<boolean> {
    const names = this.localConsumerNames();
    if (names.length === 0) return false;
    const due = await this.db
      .select({
        eventId: researchEventDeliveries.eventId,
        consumer: researchEventDeliveries.consumer,
      })
      .from(researchEventDeliveries)
      .innerJoin(
        researchEvents,
        eq(researchEvents.eventId, researchEventDeliveries.eventId),
      )
      .where(
        and(
          eq(researchEventDeliveries.status, pending),
          lte(researchEventDeliveries.nextAttemptAt, this.clock.now()),
          inArray(researchEventDeliveries.consumer, names),
        ),
      )
      .orderBy(
        asc(researchEventDeliveries.nextAttemptAt),
        asc(researchEvents.seq),
      )
      .limit(DELIVERY_BATCH);
    for (const key of due) await this.deliver(key);
    return due.length === DELIVERY_BATCH;
  }

  /** Consumers registered in this process: another process's consumer is never delivered here. */
  private localConsumerNames(): string[] {
    return [
      ...new Set(
        RuntimeEventTypeSchema.options.flatMap((type) =>
          this.consumers.consumerNamesFor(type),
        ),
      ),
    ];
  }

  private async deliverIn(
    tx: RuntimeTx,
    key: DeliveryKey,
    consumer: EventConsumer,
  ): Promise<DeliveryOutcome> {
    const now = this.clock.now();
    const [event] = await tx
      .select()
      .from(researchEvents)
      .where(eq(researchEvents.eventId, key.eventId));
    if (!event) return 'skipped';
    // Lock order: the investigation, then the delivery (System Invariants).
    const investigation = await this.tasks.lockInvestigation(
      tx,
      event.investigationId,
    );
    if (!investigation) return 'skipped';
    const [delivery] = await tx
      .select()
      .from(researchEventDeliveries)
      .where(
        and(
          eq(researchEventDeliveries.eventId, key.eventId),
          eq(researchEventDeliveries.consumer, key.consumer),
          // Checked again under the lock: a done delivery is never applied twice (AC-08.3).
          eq(researchEventDeliveries.status, pending),
          lte(researchEventDeliveries.nextAttemptAt, now),
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
    this.crashPoints.hit('relay.before-done');
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
        consumer.handle(savepoint, toEnvelope(event)),
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
    const context = `eventId=${delivery.eventId} consumer=${delivery.consumer} attempts=${attempts} error=${errorName(failure.error)}`;
    if (attempts >= this.config.deliveryMaxAttempts) {
      await this.updateDelivery(tx, delivery, {
        status: needs_attention,
        attempts,
        lastError: errorText(failure.error),
      });
      this.logger.error(`delivery needs_attention ${context}`);
      return 'needs_attention';
    }
    const delayMs = deliveryBackoffMs(attempts, this.clock.random());
    await this.updateDelivery(tx, delivery, {
      attempts,
      lastError: errorText(failure.error),
      nextAttemptAt: new Date(now.getTime() + delayMs),
    });
    this.logger.warn(`delivery failed ${context} retryInMs=${delayMs}`);
    return 'retry';
  }

  /** An event of a `schemaVersion` the consumer does not know: parked without calling it (AC-09.2). */
  private async parkUnknownVersion(
    tx: RuntimeTx,
    delivery: DeliveryRow,
    event: EventRow,
  ): Promise<DeliveryOutcome> {
    await this.updateDelivery(tx, delivery, {
      status: needs_attention,
      lastError: `Unknown schemaVersion ${event.schemaVersion} of ${event.type}`,
    });
    this.logger.error(
      `delivery needs_attention eventId=${delivery.eventId} consumer=${delivery.consumer} schemaVersion=${event.schemaVersion}`,
    );
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
      .update(researchEventDeliveries)
      .set(fields)
      .where(
        and(
          eq(researchEventDeliveries.eventId, delivery.eventId),
          eq(researchEventDeliveries.consumer, delivery.consumer),
        ),
      );
  }
}

/** The stored event as its consumer sees it; a malformed row fails the delivery like a consumer. */
function toEnvelope(event: EventRow): EventEnvelope {
  return EventEnvelopeSchema.parse({
    eventId: event.eventId,
    type: event.type,
    schemaVersion: event.schemaVersion,
    investigationId: event.investigationId,
    taskId: event.taskId,
    causationId: event.causationId,
    correlationId: event.correlationId,
    stateRevision: event.stateRevision,
    payloadRef: event.payloadRef,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  });
}
