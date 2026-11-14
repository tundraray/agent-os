import { Module } from '@nestjs/common';
import type { Agents } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import { createWorkflows, type Workflows } from '@agent-os/workflows';
import { AgentsModule } from '../agents/agents.module.js';
import { AGENTS } from '../agents/agents.tokens.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { WORKFLOWS } from './workflows.tokens.js';

/**
 * Composition root of the workflows package in `apps/api` (composition-root.md, design-workflows.md
 * «Сборка»). The registration runs in the `WORKFLOWS` factory: Nest builds every provider before any
 * `onModuleInit`, and `AgentsModule.onModuleInit` calls `agents.start()`, which seals the catalog. The
 * package has no background work, so the module has no lifecycle hooks; a bad template throws from the
 * factory and stops the start (DC-1).
 */
@Module({
  imports: [AgentsModule],
  providers: [
    {
      provide: WORKFLOWS,
      useFactory: (agents: Agents, logger: Logger): Workflows => createWorkflows({ agents, logger }),
      inject: [AGENTS, APP_LOGGER],
    },
  ],
  exports: [WORKFLOWS],
})
export class WorkflowsModule {}
