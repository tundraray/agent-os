import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { BackgroundPasses } from '@agent-os/runtime';
import { AgentsModule } from '../agents/agents.module';
import { AgentsPortsModule } from '../agents/agents-ports.module';
import { LibraryModule } from '../library/library.module';
import { SchedulesController } from './schedules.controller';
import { SCHEDULE_PASS_PERIOD_MS, SchedulesService } from './schedules.service';

/**
 * The schedules of employees (design-schedules.md, C3 api): the routes and the pass over `SchedulesService`. The
 * agents' operations come from `AgentsModule`, the chip rule from `LibraryModule`, the access gate from
 * `AgentsPortsModule`. The pass registers in the runtime's background passes (KD-3); `ChatModule` imports this
 * module to pause the schedules of a deleted conversation.
 */
@Module({
  imports: [AgentsModule, LibraryModule, AgentsPortsModule],
  controllers: [SchedulesController],
  providers: [SchedulesService],
  exports: [SchedulesService],
})
export class SchedulesModule implements OnModuleInit {
  constructor(
    @Inject(BackgroundPasses) private readonly passes: BackgroundPasses,
    private readonly schedules: SchedulesService,
  ) {}

  onModuleInit(): void {
    this.passes.register({
      name: 'schedules',
      periodMs: SCHEDULE_PASS_PERIOD_MS,
      pass: () => this.schedules.pass(),
    });
  }
}
