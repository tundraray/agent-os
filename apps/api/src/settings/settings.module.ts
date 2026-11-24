import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettingsService } from './settings.service';

/**
 * The settings table (data-model design-schema.md KD-3): `SettingsService` is the one writer of `settings`; the
 * groups of settings — sign-in, library, tool results, default models — read and write through it.
 */
@Module({
  imports: [AuditModule],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
