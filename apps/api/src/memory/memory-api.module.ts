import { Module } from '@nestjs/common';
import { LibraryModule } from '../library/library.module';
import { SettingsModule } from '../settings/settings.module';
import { AdminSelfLearningSettingsController } from './admin-self-learning-settings.controller';
import { MemoryController, MyMemoryController } from './memory.controller';
import { MemoryService } from './memory.service';

/** The memory routes (self-learning design-memory.md KD-5, KD-6): the access rule comes from `LibraryModule`. */
@Module({
  imports: [LibraryModule, SettingsModule],
  controllers: [
    MemoryController,
    MyMemoryController,
    AdminSelfLearningSettingsController,
  ],
  providers: [MemoryService],
})
export class MemoryApiModule {}
