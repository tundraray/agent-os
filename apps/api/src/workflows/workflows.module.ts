import { Module } from '@nestjs/common';
import type { Agents } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import { createWorkflows, type Workflows } from '@agent-os/workflows';
import { AgentsModule } from '../agents/agents.module';
import { AGENTS } from '../agents/agents.tokens';
import { APP_LOGGER } from '../logging/app-logger';
import { WORKFLOWS } from './workflows.tokens';

/**
 * Composition root of the workflows package in `apps/api` (composition-root.md, design-workflows.md
 * «Сборка», design-runtime.md KD-5). The factory registers `start_workflow`, a tool of the conversation
 * root: Nest builds every provider before any `onModuleInit`, and `AgentsModule.onModuleInit` calls
 * `agents.start()`, which closes the tool registration. Workflows themselves are library records read at
 * each start; the package has no background work, so the module has no lifecycle hooks.
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
