import type { DatabaseConnection } from '@agent-os/db';
import type { Clock } from './clock.js';
import { CrashPoints } from './crash-points.js';
import { Dispatcher } from './dispatcher.js';
import { EventConsumerRegistry } from './event-consumer.registry.js';
import { EventLog } from './event-log.js';
import { EvidenceReader } from './evidence.reader.js';
import { EvidenceStore } from './evidence.store.js';
import { HandlerRegistry } from './handler.registry.js';
import { InvestigationService } from './investigation.service.js';
import { OutboxRelay } from './outbox.relay.js';
import type { RuntimeLogger, ThreadOwnership } from './ports.js';
import { RecoverySweeper } from './recovery.sweeper.js';
import { RunningTaskRegistry } from './running-task.registry.js';
import type { RuntimeConfig } from './runtime-config.js';
import { SchedulerConsumer } from './scheduler.consumer.js';
import { TaskScheduler } from './task-scheduler.js';
import { TaskRepository } from './task.repository.js';

/** What the composition root hands to {@link createRuntime}. */
export interface RuntimeOptions {
  /** The Drizzle client and the pool it runs over; the dispatcher LISTENs on the pool. */
  database: Pick<DatabaseConnection, 'db' | 'pool'>;
  config: RuntimeConfig;
  threads: ThreadOwnership;
  logger: RuntimeLogger;
  clock: Clock;
}

/**
 * The research runtime (ADR-0001): investigations, admission and execution of tasks, evidence
 * and the outbox. Handlers and event consumers are registered before {@link Runtime.start}.
 */
export interface Runtime {
  readonly handlers: HandlerRegistry;
  readonly eventConsumers: EventConsumerRegistry;
  readonly scheduler: TaskScheduler;
  readonly investigations: InvestigationService;
  readonly evidence: EvidenceReader;
  /**
   * Starts the workers — dispatcher, outbox relay, recovery sweeper — unless `RUNTIME_WORKERS`
   * is off.
   */
  start(): void;
  /**
   * Stops the workers started by {@link start}: running attempts return to `queued`, the relay
   * and the sweeper finish their pass in flight. The composition root closes the pool after it.
   */
  stop(): Promise<void>;
}

/**
 * Builds the runtime from settings and ports (ADR-0004): the package reads no environment and
 * knows nothing about threads or the logging framework. The runtime's own scheduler consumer is
 * registered here, with or without workers: its delivery rows are written either way.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const { database, config, threads, logger, clock } = options;
  const { db, pool } = database;

  const crashPoints = CrashPoints.fromConfig(config);
  const handlers = new HandlerRegistry();
  const eventConsumers = new EventConsumerRegistry();
  const events = new EventLog(eventConsumers);
  const tasks = new TaskRepository();
  const evidenceStore = new EvidenceStore();
  const running = new RunningTaskRegistry();
  const scheduler = new TaskScheduler(
    db,
    clock,
    handlers,
    tasks,
    events,
    crashPoints,
  );
  const investigations = new InvestigationService(
    db,
    clock,
    logger,
    threads,
    events,
    tasks,
    crashPoints,
    running,
  );
  const dispatcher = new Dispatcher(
    db,
    pool,
    config,
    clock,
    logger,
    handlers,
    tasks,
    events,
    evidenceStore,
    scheduler,
    running,
    crashPoints,
  );
  const relay = new OutboxRelay(
    db,
    config,
    clock,
    logger,
    eventConsumers,
    tasks,
    crashPoints,
  );
  const sweeper = new RecoverySweeper(
    db,
    config,
    clock,
    logger,
    tasks,
    events,
    crashPoints,
  );
  eventConsumers.register(new SchedulerConsumer(clock, tasks, events));

  let workersStarted = false;

  return {
    handlers,
    eventConsumers,
    scheduler,
    investigations,
    evidence: new EvidenceReader(db),
    start() {
      if (!config.workers) {
        logger.log('Runtime workers off (RUNTIME_WORKERS=off)');
        return;
      }
      if (workersStarted) return;
      dispatcher.start();
      relay.start();
      sweeper.start();
      workersStarted = true;
      logger.log(`Runtime workers started concurrency=${config.concurrency}`);
    },
    async stop() {
      if (!workersStarted) return;
      workersStarted = false;
      await Promise.all([
        dispatcher.shutdown(),
        relay.shutdown(),
        sweeper.shutdown(),
      ]);
      logger.log('Runtime workers stopped');
    },
  };
}
