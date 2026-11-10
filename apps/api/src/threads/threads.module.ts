import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { DatabaseConnection } from '@agent-os/db';
import {
  RESEARCH_DATABASE,
  RUNTIME_CLOCK,
} from '../research/research.tokens.js';
import { ThreadDeletionHooks } from './thread-deletion-hooks.js';
import {
  THREAD_LOCK_POOL,
  threadLockPoolProvider,
} from './thread-lock.pool.js';
import {
  THREAD_MEMORY,
  threadMemoryProvider,
} from './thread-memory.provider.js';
import { threadTitleAgentProvider } from './thread-title.agent.js';
import {
  THREAD_TITLE_TIMEOUT_MS,
  ThreadTitleService,
} from './thread-title.service.js';
import {
  postgresThreadRunMarks,
  THREAD_RUN_MARKS,
  THREAD_RUN_SETTLE_TIMEOUT_MS,
  type ThreadRunClock,
  type ThreadRunMarks,
  ThreadRunRegistry,
} from './thread-run-registry.js';
import { ThreadWriteLock } from './thread-write-lock.js';
import { ThreadsController } from './threads.controller.js';
import { ThreadsService } from './threads.service.js';

@Module({
  controllers: [ThreadsController],
  providers: [
    threadMemoryProvider,
    threadTitleAgentProvider,
    { provide: THREAD_TITLE_TIMEOUT_MS, useValue: 8_000 },
    { provide: THREAD_RUN_SETTLE_TIMEOUT_MS, useValue: 5_000 },
    threadLockPoolProvider,
    {
      provide: ThreadWriteLock,
      useFactory: (locks: DatabaseConnection) =>
        new ThreadWriteLock(locks.pool),
      inject: [THREAD_LOCK_POOL],
    },
    // The pool and the clock of the run marks belong to `ResearchModule`, which imports this module; they are resolved
    // when a mark is written or read, so neither module imports the other (the precedent of `mastraProvider`).
    {
      provide: THREAD_RUN_MARKS,
      useFactory: (moduleRef: ModuleRef): ThreadRunMarks =>
        postgresThreadRunMarks(
          () =>
            moduleRef.get<DatabaseConnection>(RESEARCH_DATABASE, {
              strict: false,
            }).db,
        ),
      inject: [ModuleRef],
    },
    {
      provide: ThreadRunRegistry,
      useFactory: (
        settleTimeoutMs: number,
        marks: ThreadRunMarks,
        moduleRef: ModuleRef,
      ) => {
        const clock = () =>
          moduleRef.get<ThreadRunClock>(RUNTIME_CLOCK, { strict: false });
        return new ThreadRunRegistry({
          settleTimeoutMs,
          marks,
          clock: {
            now: () => clock().now(),
            setTimer: (ms, callback) => clock().setTimer(ms, callback),
          },
        });
      },
      inject: [THREAD_RUN_SETTLE_TIMEOUT_MS, THREAD_RUN_MARKS, ModuleRef],
    },
    ThreadDeletionHooks,
    ThreadsService,
    ThreadTitleService,
  ],
  exports: [
    THREAD_MEMORY,
    ThreadsService,
    ThreadTitleService,
    ThreadRunRegistry,
    ThreadDeletionHooks,
  ],
})
export class ThreadsModule implements OnApplicationShutdown {
  constructor(
    @Inject(THREAD_LOCK_POOL) private readonly lockPool: DatabaseConnection,
  ) {}

  /** The lock pool closes in the last phase, after every `beforeApplicationShutdown` stop (runtime, delivery loop). */
  async onApplicationShutdown(): Promise<void> {
    await this.lockPool.close();
  }
}
