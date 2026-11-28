import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { ToolRegistry } from '@agent-os/agents';
import { LOGGER, type Logger } from '@agent-os/common';
import { BackgroundPasses, CLOCK, type Clock } from '@agent-os/runtime';
import { AgentsModule } from '../agents/agents.module';
import { ChatModule } from '../chat/chat.module';
import { IdentityModule } from '../identity/identity.module';
import { LibraryModule } from '../library/library.module';
import {
  SCHEDULE_PASS_PERIOD_MS,
  ScheduleTriggersService,
} from './schedule-triggers.service';
import { createScheduleTools } from './schedule-tools';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

/**
 * The schedules of employees (design-schedules.md, C3 api): the routes over `SchedulesService` and the pass and
 * triggers of `ScheduleTriggersService`. A trigger sends through the chat's `ConversationsService` (`ChatModule`),
 * the owner is checked in `IdentityModule`, the chip rule comes from `LibraryModule` and the views of agents from
 * `AgentsModule`. The pass registers in the runtime's background passes (KD-3), and the chat's `list_schedules` and
 * `manage_schedule` in the tools library of the agents (chat-scheduling KD-1): in `onModuleInit`, before the library
 * closes in `onApplicationBootstrap`.
 */
@Module({
  imports: [AgentsModule, ChatModule, IdentityModule, LibraryModule],
  controllers: [SchedulesController],
  providers: [SchedulesService, ScheduleTriggersService],
})
export class SchedulesModule implements OnModuleInit {
  constructor(
    @Inject(BackgroundPasses) private readonly passes: BackgroundPasses,
    private readonly triggers: ScheduleTriggersService,
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    private readonly schedules: SchedulesService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.passes.register({
      name: 'schedules',
      periodMs: SCHEDULE_PASS_PERIOD_MS,
      pass: () => this.triggers.pass(),
    });
    const tools = createScheduleTools({
      schedules: this.schedules,
      clock: this.clock,
      logger: this.logger,
    });
    for (const tool of tools) this.registry.register(tool);
  }
}
