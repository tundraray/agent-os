import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  TrackerCommentBodySchema,
  TrackerDelegationBodySchema,
  type TrackerDelegationBody,
  type TrackerDelegationResponse,
  TrackerTaskCreateBodySchema,
  TrackerTaskListQuerySchema,
  TrackerTaskPatchBodySchema,
  type TrackerCommentBody,
  type TrackerTaskCreateBody,
  type TrackerTaskListQuery,
  type TrackerTaskListResponse,
  type TrackerTaskPatchBody,
  type TrackerTaskView,
} from '@agent-os/contracts';
import { chatRoute } from '../chat/chat.errors';
import {
  loggedRoute,
  type RouteCall,
  type RouteStyle,
} from '../common/logged-route';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthedRequest } from '../identity/auth-user';
import { TrackerService } from './tracker.service';

/**
 * The routes that send through the chat (KD-2, KD-5): a refused start leaves as 409 `START_REFUSED` with its reason,
 * the service's own codes and the chip's 404 as they are.
 */
const SENDING: RouteStyle = {
  subject: 'route',
  toHttpError: chatRoute().toHttpError,
};

/** What a route logs of a task: ids, the status and counts, never a title, a description or a comment (NFR-03). */
const taskOutcome = (view: TrackerTaskView) => ({
  taskId: view.id,
  status: view.status,
  conversations: view.conversations.length,
});

/**
 * The tracker routes (task-tracker design-server.md, Contract Definitions «Маршруты»), under `SessionGuard`: the
 * owner is the session's, another employee's task answers 404 `TRACKER_TASK_NOT_FOUND` as a missing one. Every
 * route is logged once with its ids, the lengths of its texts, its outcome and duration.
 */
@Controller('tracker/tasks')
export class TrackerController {
  private readonly logger: Logger;

  constructor(
    private readonly tracker: TrackerService,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'tracker.routes' });
  }

  @Get()
  list(
    @Query(new ZodValidationPipe(TrackerTaskListQuerySchema))
    query: TrackerTaskListQuery,
    @Req() req: AuthedRequest,
  ): Promise<TrackerTaskListResponse> {
    const ownerId = req.user.id;
    return this.logged({
      route: 'GET /tracker/tasks',
      fields: { ownerId, status: query.status },
      work: () => this.tracker.list(ownerId, query.status),
      outcomeOf: (list) => ({ count: list.tasks.length }),
    });
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(TrackerTaskCreateBodySchema))
    body: TrackerTaskCreateBody,
    @Req() req: AuthedRequest,
  ): Promise<TrackerTaskView> {
    const ownerId = req.user.id;
    return this.logged({
      route: 'POST /tracker/tasks',
      fields: {
        ownerId,
        titleLength: body.title.length,
        descriptionLength: body.description.length,
      },
      work: () => this.tracker.create(ownerId, body),
      outcomeOf: taskOutcome,
    });
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<TrackerTaskView> {
    const ownerId = req.user.id;
    return this.logged({
      route: 'GET /tracker/tasks/:id',
      fields: { ownerId, taskId: id },
      work: () => this.tracker.get(id, ownerId),
      outcomeOf: taskOutcome,
    });
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(TrackerTaskPatchBodySchema))
    body: TrackerTaskPatchBody,
    @Req() req: AuthedRequest,
  ): Promise<TrackerTaskView> {
    const ownerId = req.user.id;
    return this.logged({
      route: 'PATCH /tracker/tasks/:id',
      fields: {
        ownerId,
        taskId: id,
        titleLength: body.title?.length,
        descriptionLength: body.description?.length,
        newStatus: body.status,
      },
      work: () => this.tracker.update(id, ownerId, body),
      outcomeOf: taskOutcome,
    });
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    const ownerId = req.user.id;
    return this.logged({
      route: 'DELETE /tracker/tasks/:id',
      fields: { ownerId, taskId: id },
      work: () => this.tracker.delete(id, ownerId),
    });
  }

  @Post(':id/comments')
  @HttpCode(201)
  comment(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(TrackerCommentBodySchema))
    body: TrackerCommentBody,
    @Req() req: AuthedRequest,
  ): Promise<TrackerTaskView> {
    const ownerId = req.user.id;
    return this.logged(
      {
        route: 'POST /tracker/tasks/:id/comments',
        fields: {
          ownerId,
          taskId: id,
          textLength: body.text.length,
          forward: body.forward,
        },
        work: () => this.tracker.comment(id, ownerId, body),
        outcomeOf: (view) => ({
          ...taskOutcome(view),
          forwardedTo: body.forward
            ? view.forwardTo?.conversationId
            : undefined,
        }),
      },
      SENDING,
    );
  }

  @Post(':id/delegations')
  @HttpCode(201)
  delegate(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(TrackerDelegationBodySchema))
    body: TrackerDelegationBody,
    @Req() req: AuthedRequest,
  ): Promise<TrackerDelegationResponse> {
    const ownerId = req.user.id;
    return this.logged(
      {
        route: 'POST /tracker/tasks/:id/delegations',
        fields: {
          ownerId,
          taskId: id,
          agentId: body.agentId,
          noteLength: body.note?.length,
          language: body.language,
        },
        work: () => this.tracker.delegate(id, ownerId, body),
        outcomeOf: (delegation) => ({
          ...taskOutcome(delegation.task),
          conversationId: delegation.conversationId,
        }),
      },
      SENDING,
    );
  }

  private logged<T>(call: RouteCall<T>, style?: RouteStyle): Promise<T> {
    return loggedRoute(this.logger, call, style);
  }
}
