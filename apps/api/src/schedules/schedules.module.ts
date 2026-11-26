import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { BackgroundPasses } from '@agent-os/runtime';
import { AgentsModule } from '../agents/agents.module';
import { ChatModule } from '../chat/chat.module';
import { IdentityModule } from '../identity/identity.module';
import { LibraryModule } from '../library/library.module';
import {
  SCHEDULE_PASS_PERIOD_MS,
  ScheduleTriggersService,
} from './schedule-triggers.service';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

/**
 * The schedules of employees (design-schedules.md, C3 api): the routes over `SchedulesService` and the pass and
 * triggers of `ScheduleTriggersService`. A trigger sends through the chat's `ConversationsService` (`ChatModule`),
 * the owner is checked in `IdentityModule`, the chip rule comes from `LibraryModule` and the views of agents from
 * `AgentsModule`. The pass registers in the runtime's background passes (KD-3).
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
  ) {}

  onModuleInit(): void {
    this.passes.register({
      name: 'schedules',
      periodMs: SCHEDULE_PASS_PERIOD_MS,
      pass: () => this.triggers.pass(),
    });
  }
}
