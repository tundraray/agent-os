import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { SettingsModule } from '../settings/settings.module';
import { AccessService } from './access.service';

/**
 * Rights, quotas and the model catalogue (design-access.md, KD-1): the only module that reads and
 * writes `access_*`. It does not import `AgentsModule`: the agents import it for the `AccessGate` port,
 * and the routes that need facts of the agents package (the MCP registry, provider readiness) live in
 * `AccessAdminModule`.
 */
@Module({
  imports: [IdentityModule, SettingsModule],
  providers: [AccessService],
  exports: [AccessService],
})
export class AccessModule {}
