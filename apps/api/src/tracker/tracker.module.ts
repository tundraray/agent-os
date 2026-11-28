import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { ToolRegistry } from '@agent-os/agents';
import { LOGGER, type Logger } from '@agent-os/common';
import { AgentsModule } from '../agents/agents.module';
import { ChatModule } from '../chat/chat.module';
import { createTrackerReportTool } from './tracker-report-tool';
import { TrackerController } from './tracker.controller';
import { TrackerService } from './tracker.service';

/**
 * The employee's task tracker (task-tracker design-server.md, C3 api): the routes over `TrackerService`, which sends
 * delegations and forwarded comments through the chat's `ConversationsService` (`ChatModule`). `ChatModule` does not
 * import this module: the conversation's view reads the link through `TrackerTasksRepository` itself. The chat's
 * `tracker_report` registers in the tools library of the agents in `onModuleInit`, before the library closes.
 */
@Module({
  imports: [AgentsModule, ChatModule],
  controllers: [TrackerController],
  providers: [TrackerService],
})
export class TrackerModule implements OnModuleInit {
  constructor(
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    private readonly tracker: TrackerService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      createTrackerReportTool({ tracker: this.tracker, logger: this.logger }),
    );
  }
}
