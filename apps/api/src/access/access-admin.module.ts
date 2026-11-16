import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { AccessModule } from './access.module.js';
import { AdminAccessController } from './admin-access.controller.js';
import { AdminModelsController } from './admin-models.controller.js';

/**
 * The admin routes of the catalogue and grants. Kept apart from `AccessModule` because a grant target
 * is checked against the MCP registry of `AgentsModule`, while `AgentsModule` imports `AccessModule`
 * for the `AccessGate` port — this way neither import needs `forwardRef`.
 */
@Module({
  imports: [AccessModule, AgentsModule],
  controllers: [AdminModelsController, AdminAccessController],
})
export class AccessAdminModule {}
