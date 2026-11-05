import { Module } from '@nestjs/common';
import { ThreadDeletionHooks } from './thread-deletion-hooks.js';
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
  THREAD_RUN_SETTLE_TIMEOUT_MS,
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
    ThreadWriteLock,
    ThreadRunRegistry,
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
export class ThreadsModule {}
