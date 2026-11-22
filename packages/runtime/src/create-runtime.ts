import type { Logger } from '@agent-os/common';
import type { DatabaseConnection } from '@agent-os/db';
import type { Clock } from './clock';
import { CrashPoints } from './crash-points';
import { Decisions } from './decisions';
import { Dispatcher } from './dispatcher';
import { EventConsumerRegistry } from './event-consumer.registry';
import { EventLog } from './event-log';
import { HandlerRegistry } from './handler.registry';
import { Inbox } from './inbox';
import { OutboxRelay } from './outbox.relay';
import { RecoverySweeper } from './recovery.sweeper';
import { RunningTaskRegistry } from './running-task.registry';
import type { RuntimeConfig } from './runtime-config';
import { StepCommitter } from './step-commit';
import { TaskControl } from './task-control';
import { TaskRepository } from './task.repository';
import { TokenLedger } from './token-ledger';
import { type Tracker, TrackerRepository } from './tracker.repository';

/** What the composition root hands to {@link createRuntime}. */
export interface RuntimeOptions {
  /** The Drizzle client and the pool it runs over; the dispatcher LISTENs on the pool. */
  database: Pick<DatabaseConnection, 'db' | 'pool'>;
  /** Parsed by `parseRuntimeConfig`. */
  config: RuntimeConfig;
  logger: Logger;
  clock: Clock;
}

/**
 * The task runtime (ADR-0001, design-runtime.md): tasks run in steps, each step ends in one
 * transaction; events go through the outbox. Handlers and event consumers are registered before
 * {@link Runtime.start}.
 */
export interface Runtime {
  /** Handlers of the task types this process runs. */
  readonly handlers: HandlerRegistry;
  /** Creation and reading of tasks; interrupt, stop and deletion of a tree. */
  readonly tasks: TaskControl;
  /** Task queues: messages from employees and other tasks. */
  readonly inbox: Pick<Inbox, 'enqueue' | 'listPending'>;
  /** Decision requests of steps and their resolution. */
  readonly decisions: Pick<Decisions, 'resolve' | 'get' | 'listTree'>;
  /** Task trackers a step opened (deep-agents/design-task.md): the owner reads their tasks' outcomes. */
  readonly trackers: {
    /** The trackers of the owner's task, oldest first; `[]` for another owner's or a missing task. */
    list(taskId: string, ownerId: string): Promise<Tracker[]>;
  };
  /** The event log of a tree. */
  readonly events: Pick<EventLog, 'listAfter'>;
  /** Consumers of outbox events. */
  readonly eventConsumers: EventConsumerRegistry;
  /** The token ledger: the cost of each model call and an owner's spend per month, also by model. */
  readonly ledger: Pick<TokenLedger, 'record' | 'monthSpend' | 'monthSpendByModel'>;
  /**
   * Starts the workers — dispatcher, outbox relay, recovery sweeper — unless `RUNTIME_WORKERS`
   * is off.
   */
  start(): void;
  /**
   * Stops the workers started by {@link start}: steps in flight get `shutdown` and their tasks go
   * back to `queued`; the relay and the sweeper finish their pass in flight. The composition root
   * closes the pool after it.
   */
  stop(): Promise<void>;
}

/**
 * Builds the runtime from parsed settings and ports (ADR-0004): the package reads no environment
 * and knows nothing about Nest.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const { database, config, logger: rootLogger, clock } = options;
  const { db, pool } = database;
  const logger = rootLogger.child({ component: 'runtime' });
  // A pooled client has no `error` listener while it is checked out, so a session the server ends
  // (the `idle_in_transaction_session_timeout` of a bounded transaction) would crash the process.
  // The query in flight still fails, and the pool replaces the client.
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      logger.warn('database client error', { error });
    });
  });

  const crashPoints = CrashPoints.fromConfig(config);
  const handlers = new HandlerRegistry();
  const eventConsumers = new EventConsumerRegistry();
  const events = new EventLog(db, eventConsumers);
  const tasks = new TaskRepository();
  const trackers = new TrackerRepository();
  const inbox = new Inbox({
    db,
    tasks,
    events,
    crashPoints,
    logger: logger.child({ service: 'inbox' }),
    inboxPayloadMaxBytes: config.inboxPayloadMaxBytes,
  });
  const decisions = new Decisions({
    db,
    tasks,
    events,
    logger: logger.child({ service: 'decisions' }),
  });
  const running = new RunningTaskRegistry();
  const committer = new StepCommitter({
    db,
    tasks,
    trackers,
    events,
    inbox,
    decisions,
    handlers,
    crashPoints,
    inboxPayloadMaxBytes: config.inboxPayloadMaxBytes,
    leaseMs: config.leaseMs,
  });
  const dispatcher = new Dispatcher({
    db,
    pool,
    config,
    clock,
    logger: logger.child({ worker: 'dispatcher' }),
    handlers,
    tasks,
    trackers,
    events,
    inbox,
    decisions,
    running,
    committer,
    crashPoints,
  });
  const relay = new OutboxRelay({
    db,
    config,
    clock,
    logger: logger.child({ worker: 'relay' }),
    consumers: eventConsumers,
    tasks,
  });
  const sweeper = new RecoverySweeper({
    db,
    config,
    clock,
    logger: logger.child({ worker: 'sweeper' }),
    tasks,
    trackers,
    events,
    inbox,
    crashPoints,
  });

  const ledger = new TokenLedger({
    db,
    clock,
    logger: logger.child({ service: 'ledger' }),
  });

  let workersStarted = false;

  return {
    handlers,
    tasks: new TaskControl({
      db,
      handlers,
      tasks,
      trackers,
      events,
      inbox,
      running,
      logger,
      inboxPayloadMaxBytes: config.inboxPayloadMaxBytes,
    }),
    inbox,
    decisions,
    trackers: { list: (taskId, ownerId) => trackers.list(db, taskId, ownerId) },
    events,
    eventConsumers,
    ledger,
    start() {
      if (!config.workers) {
        logger.info('runtime workers off (RUNTIME_WORKERS=off)');
        return;
      }
      if (workersStarted) return;
      dispatcher.start();
      relay.start();
      sweeper.start();
      workersStarted = true;
      logger.info('runtime workers started', {
        concurrency: config.concurrency,
        handlerTypes: handlers.types(),
        eventConsumers: eventConsumers.names(),
      });
    },
    async stop() {
      if (!workersStarted) return;
      workersStarted = false;
      const startedAt = Date.now();
      await Promise.all([dispatcher.shutdown(), relay.shutdown(), sweeper.shutdown()]);
      logger.info('runtime workers stopped', { durationMs: Date.now() - startedAt });
    },
  };
}
