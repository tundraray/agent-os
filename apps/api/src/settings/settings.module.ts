import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AdminAppearanceController } from './admin-appearance.controller';
import { AdminInstructionsController } from './admin-instructions.controller';
import { SettingsService } from './settings.service';

/**
 * The settings table (data-model design-schema.md KD-3): `SettingsService` is the one writer of `settings`; the
 * groups of settings — sign-in, library, tool results, default models — read and write through it. The organisation's
 * instruction (agent-guidance KD-4) and the organisation's theme (theming KD-2) have no group service: their routes
 * write the key directly.
 */
@Module({
  imports: [AuditModule],
  controllers: [AdminInstructionsController, AdminAppearanceController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
