import { Module, type OnModuleInit } from '@nestjs/common';
import {
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../database/runtime-config.js';
import { ThreadDeletionHooks } from '../threads/thread-deletion-hooks.js';
import { ThreadsModule } from '../threads/threads.module.js';
import { CLOCK, systemClock } from './clock.js';
import { CrashPoints } from './crash-points.js';
import { Dispatcher } from './dispatcher.js';
import { EventConsumerRegistry } from './event-consumer.registry.js';
import { EventLog } from './event-log.js';
import { EvidenceReader } from './evidence.reader.js';
import { EvidenceStore } from './evidence.store.js';
import { HandlerRegistry } from './handler.registry.js';
import { InvestigationService } from './investigation.service.js';
import { OutboxRelay } from './outbox.relay.js';
import { RecoverySweeper } from './recovery.sweeper.js';
import { RunningTaskRegistry } from './running-task.registry.js';
import { RuntimeLifecycle } from './runtime.lifecycle.js';
import { SchedulerConsumer } from './scheduler.consumer.js';
import { TaskScheduler } from './task-scheduler.js';
import { TaskRepository } from './task.repository.js';

/**
 * The research runtime (ADR-0001): investigations, admission and execution of tasks, evidence
 * and the outbox. Depends on `threads` only (the ownership check of `withOwnedThread`), never
 * the other way round. `DatabaseModule` is global: `DRIZZLE`, `PG_POOL` and `RUNTIME_CONFIG`
 * come from it. Workers start and stop with the application (`RuntimeLifecycle`, KD-7). A thread's
 * investigations are deleted with it through the thread deletion hook registered at start (KD-5).
 */
@Module({
  imports: [ThreadsModule],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    {
      provide: CrashPoints,
      useFactory: (config: RuntimeConfig) => CrashPoints.fromConfig(config),
      inject: [RUNTIME_CONFIG],
    },
    HandlerRegistry,
    EventConsumerRegistry,
    EventLog,
    TaskRepository,
    EvidenceStore,
    EvidenceReader,
    TaskScheduler,
    InvestigationService,
    RunningTaskRegistry,
    Dispatcher,
    SchedulerConsumer,
    OutboxRelay,
    RecoverySweeper,
    RuntimeLifecycle,
  ],
  exports: [
    HandlerRegistry,
    TaskScheduler,
    InvestigationService,
    EvidenceReader,
  ],
})
export class ResearchModule implements OnModuleInit {
  constructor(
    private readonly deletionHooks: ThreadDeletionHooks,
    private readonly investigations: InvestigationService,
  ) {}

  onModuleInit(): void {
    this.deletionHooks.register({
      stop: (ref, window) => this.investigations.stopThread(ref, window),
      purge: (ref) => this.investigations.purgeThread(ref),
    });
  }
}
