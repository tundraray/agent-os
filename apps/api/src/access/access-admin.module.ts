import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { IdentityModule } from '../identity/identity.module';
import { AccessLevelsService } from './access-levels.service';
import { AccessModule } from './access.module';
import { AdminAccessLevelsController } from './admin-access-levels.controller';
import { AdminAccessController } from './admin-access.controller';
import { AdminModelDefaultsController } from './admin-model-defaults.controller';
import { AdminModelsController } from './admin-models.controller';
import { MyAccessController } from './my-access.controller';

/**
 * The routes of `access` that need facts of `AgentsModule`: the admin's catalogue (a new model's provider
 * kind), grants and access levels (the MCP registry), default models, and "my access" (provider readiness). Kept apart from
 * `AccessModule` because `AgentsModule` imports `AccessModule` for the `AccessGate` port — this way
 * neither import needs `forwardRef` (port-module-split.md).
 */
@Module({
  imports: [AccessModule, AgentsModule, IdentityModule],
  controllers: [
    AdminModelsController,
    AdminAccessController,
    AdminAccessLevelsController,
    AdminModelDefaultsController,
    MyAccessController,
  ],
  providers: [AccessLevelsService],
})
export class AccessAdminModule {}
