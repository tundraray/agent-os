import { Module } from '@nestjs/common';
import {
  THREAD_MEMORY,
  threadMemoryProvider,
} from './thread-memory.provider.js';
import { threadTitleAgentProvider } from './thread-title.agent.js';
import {
  THREAD_TITLE_TIMEOUT_MS,
  ThreadTitleService,
} from './thread-title.service.js';
import { ThreadWriteLock } from './thread-write-lock.js';
import { ThreadsController } from './threads.controller.js';
import { ThreadsService } from './threads.service.js';

@Module({
  controllers: [ThreadsController],
  providers: [
    threadMemoryProvider,
    threadTitleAgentProvider,
    { provide: THREAD_TITLE_TIMEOUT_MS, useValue: 8_000 },
    ThreadWriteLock,
    ThreadsService,
    ThreadTitleService,
  ],
  exports: [THREAD_MEMORY, ThreadsService, ThreadTitleService],
})
export class ThreadsModule {}
