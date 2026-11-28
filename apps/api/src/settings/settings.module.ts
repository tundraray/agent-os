import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AdminInstructionsController } from './admin-instructions.controller';
import { SettingsService } from './settings.service';

/**
 * The settings table (data-model design-schema.md KD-3): `SettingsService` is the one writer of `settings`; the
 * groups of settings — sign-in, library, tool results, default models — read and write through it. The organisation's
 * instruction (agent-guidance KD-4) has no group service: its route writes the key directly.
 */
@Module({
  imports: [AuditModule],
  controllers: [AdminInstructionsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
