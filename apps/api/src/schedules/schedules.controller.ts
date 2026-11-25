import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  ScheduleBodySchema,
  ScheduleNextRunRequestSchema,
  ScheduleRunsQuerySchema,
  type ScheduleBody,
  type ScheduleListResponse,
  type ScheduleNextRunRequest,
  type ScheduleNextRunResponse,
  type ScheduleRunsPage,
  type ScheduleRunsQuery,
  type ScheduleRunView,
  type ScheduleView,
} from '@agent-os/contracts';
import { loggedRoute, type RouteCall } from '../common/logged-route';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthedRequest } from '../identity/auth-user';
import { SchedulesService } from './schedules.service';

/** What a route logs of a schedule: ids and the state, never the instruction (Security Considerations). */
const scheduleOutcome = (view: ScheduleView) => ({
  scheduleId: view.id,
  state: view.state,
  target: view.target,
});

/**
 * The schedule routes (design-schedules.md, Contract Definitions «Маршруты»), under `SessionGuard`: the owner is
 * the session's, another employee's schedule answers 404 `SCHEDULE_NOT_FOUND` as a missing one. Every route is
 * logged once with its ids, outcome and duration.
 */
@Controller('schedules')
export class SchedulesController {
  private readonly logger: Logger;

  constructor(
    private readonly schedules: SchedulesService,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'schedules.routes' });
  }

  @Get()
  list(@Req() req: AuthedRequest): Promise<ScheduleListResponse> {
    const ownerId = req.user.id;
    return this.logged({
      route: 'GET /schedules',
      fields: { ownerId },
      work: () => this.schedules.list(ownerId),
      outcomeOf: (list) => ({ count: list.schedules.length }),
    });
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(ScheduleBodySchema)) body: ScheduleBody,
    @Req() req: AuthedRequest,
  ): Promise<ScheduleView> {
    const ownerId = req.user.id;
    return this.logged({
      route: 'POST /schedules',
      fields: {
        ownerId,
        agentId: body.agentId,
        conversationId: body.conversationId,
        ruleKind: body.rule.kind,
        instructionLength: body.instruction.length,
      },
      work: () => this.schedules.create(ownerId, body),
      outcomeOf: scheduleOutcome,
    });
  }

  /** Declared before `:id` routes: `next-run` is not an id. */
  @Post('next-run')
  @HttpCode(200)
  nextRun(
    @Body(new ZodValidationPipe(ScheduleNextRunRequestSchema))
    body: ScheduleNextRunRequest,
    @Req() req: AuthedRequest,
  ): Promise<ScheduleNextRunResponse> {
    const ownerId = req.user.id;
    return this.logged({
      route: 'POST /schedules/next-run',
      fields: { ownerId, ruleKind: body.rule.kind },
      work: () => Promise.resolve(this.schedules.nextRun(body)),
      outcomeOf: (next) => ({ nextRunAt: next.nextRunAt }),
    });
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<ScheduleView> {
    const ownerId = req.user.id;
    return this.logged({
      route: 'GET /schedules/:id',
      fields: { ownerId, scheduleId: id },
      work: () => this.schedules.get(id, ownerId),
      outcomeOf: scheduleOutcome,
    });
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ScheduleBodySchema)) body: ScheduleBody,
    @Req() req: AuthedRequest,
  ): Promise<ScheduleView> {
    const ownerId = req.user.id;
    return this.logged({
      route: 'PUT /schedules/:id',
      fields: {
        ownerId,
        scheduleId: id,
        agentId: body.agentId,
        ruleKind: body.rule.kind,
        instructionLength: body.instruction.length,
      },
      work: () => this.schedules.update(id, ownerId, body),
      outcomeOf: scheduleOutcome,
    });
  }

  @Post(':id/pause')
  @HttpCode(200)
  pause(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<ScheduleView> {
    const ownerId = req.user.id;
    return this.logged({
      route: 'POST /schedules/:id/pause',
      fields: { ownerId, scheduleId: id },
      work: () => this.schedules.pause(id, ownerId),
      outcomeOf: scheduleOutcome,
    });
  }

  @Post(':id/resume')
  @HttpCode(200)
  resume(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<ScheduleView> {
    const ownerId = req.user.id;
    return this.logged({
      route: 'POST /schedules/:id/resume',
      fields: { ownerId, scheduleId: id },
      work: () => this.schedules.resume(id, ownerId),
      outcomeOf: scheduleOutcome,
    });
  }

  @Post(':id/run')
  @HttpCode(200)
  runNow(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<ScheduleRunView> {
    const ownerId = req.user.id;
    return this.logged({
      route: 'POST /schedules/:id/run',
      fields: { ownerId, scheduleId: id },
      work: () => this.schedules.runNow(id, ownerId),
      outcomeOf: (run) => ({
        runId: run.id,
        outcome: run.outcome,
        skipReason: run.skipReason,
        conversationId: run.conversationId,
      }),
    });
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    const ownerId = req.user.id;
    return this.logged({
      route: 'DELETE /schedules/:id',
      fields: { ownerId, scheduleId: id },
      work: () => this.schedules.delete(id, ownerId),
    });
  }

  @Get(':id/runs')
  runs(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(ScheduleRunsQuerySchema))
    query: ScheduleRunsQuery,
    @Req() req: AuthedRequest,
  ): Promise<ScheduleRunsPage> {
    const ownerId = req.user.id;
    return this.logged({
      route: 'GET /schedules/:id/runs',
      fields: { ownerId, scheduleId: id },
      work: () => this.schedules.runs(id, ownerId, query.cursor),
      outcomeOf: (page) => ({ count: page.runs.length }),
    });
  }

  private logged<T>(call: RouteCall<T>): Promise<T> {
    return loggedRoute(this.logger, call);
  }
}
