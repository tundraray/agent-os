import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AuditModule } from '../audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { LibraryModule } from '../library/library.module';
import { SettingsModule } from '../settings/settings.module';
import { TestRunController } from './test-run.controller';
import { TestRunService } from './test-run.service';
import { TrainingController } from './training.controller';
import { TrainingService } from './training.service';

/**
 * The training routes (self-learning design-training.md, KD-8) and the test run's (design-test-run.md, KD-6): the
 * agent for the actor comes from `LibraryModule`, the starts from `AgentsModule`.
 */
@Module({
  imports: [
    LibraryModule,
    SettingsModule,
    IdentityModule,
    AuditModule,
    AgentsModule,
  ],
  controllers: [TrainingController, TestRunController],
  providers: [TrainingService, TestRunService],
})
export class TrainingApiModule {}
