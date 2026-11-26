import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { LibraryModule } from '../library/library.module';
import { SettingsModule } from '../settings/settings.module';
import { AdminSelfLearningSettingsController } from './admin-self-learning-settings.controller';
import { MemoryController, MyMemoryController } from './memory.controller';
import { MemoryService } from './memory.service';

/**
 * The memory routes (self-learning design-memory.md KD-5, KD-6; memory-hygiene KD-7): the access rule comes from
 * `LibraryModule`, the change of a record (`MemoryRecords`) from `AgentsModule`.
 */
@Module({
  imports: [LibraryModule, SettingsModule, AgentsModule],
  controllers: [
    MemoryController,
    MyMemoryController,
    AdminSelfLearningSettingsController,
  ],
  providers: [MemoryService],
})
export class MemoryApiModule {}
