import { Module } from '@nestjs/common';
import {
  THREAD_MEMORY,
  threadMemoryProvider,
} from './thread-memory.provider.js';
import { ThreadWriteLock } from './thread-write-lock.js';
import { ThreadsController } from './threads.controller.js';
import { ThreadsService } from './threads.service.js';

@Module({
  controllers: [ThreadsController],
  providers: [threadMemoryProvider, ThreadWriteLock, ThreadsService],
  exports: [THREAD_MEMORY, ThreadsService],
})
export class ThreadsModule {}
