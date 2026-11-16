import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { AccessService } from './access.service.js';
import { MyAccessController } from './my-access.controller.js';

/**
 * Rights, quotas and the model catalogue (design-access.md, KD-1): the only module that reads and
 * writes `access_*`. It does not import `AgentsModule`: the agents import it for the `AccessGate` port,
 * and the admin routes that need the MCP registry live in `AccessAdminModule`.
 */
@Module({
  imports: [RuntimeModule, IdentityModule],
  providers: [AccessService],
  controllers: [MyAccessController],
  exports: [AccessService],
})
export class AccessModule {}
