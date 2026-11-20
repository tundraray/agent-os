import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { AccessModule } from './access.module.js';
import { AdminAccessController } from './admin-access.controller.js';
import { AdminModelDefaultsController } from './admin-model-defaults.controller.js';
import { AdminModelsController } from './admin-models.controller.js';
import { MyAccessController } from './my-access.controller.js';

/**
 * The routes of `access` that need facts of `AgentsModule`: the admin's catalogue (a new model's provider
 * kind), grants (the MCP registry), default models, and "my access" (provider readiness). Kept apart from
 * `AccessModule` because `AgentsModule` imports `AccessModule` for the `AccessGate` port — this way
 * neither import needs `forwardRef` (port-module-split.md).
 */
@Module({
  imports: [AccessModule, AgentsModule],
  controllers: [
    AdminModelsController,
    AdminAccessController,
    AdminModelDefaultsController,
    MyAccessController,
  ],
})
export class AccessAdminModule {}
