import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  type AgentMemoryView,
  type MemoryHistoryView,
  type MyMemoryView,
  type RevertMemoryBody,
  RevertMemoryBodySchema,
} from '@agent-os/contracts';
import { loggedRoute } from '../common/logged-route';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthedRequest } from '../identity/auth-user';
import { MemoryService } from './memory.service';

/** The memory of a deep agent for its author, and for an admin when it is in the panel (KD-5). */
@Controller('library/:id/memory')
export class MemoryController {
  private readonly logger: Logger;

  constructor(
    private readonly memory: MemoryService,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'memory.routes' });
  }

  /** `AgentMemoryView`; 404 RECORD_NOT_FOUND, 403 MEMORY_FORBIDDEN. */
  @Get()
  view(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<AgentMemoryView> {
    return loggedRoute(this.logger, {
      route: 'GET /library/:id/memory',
      fields: { actorId: req.user.id, agentId: id },
      work: () => this.memory.agentMemory(req.user, id),
      outcomeOf: (view) => ({ records: view.records.length }),
    });
  }

  /** `MemoryHistoryView`; 404 RECORD_NOT_FOUND (also for a record the agent does not have), 403 MEMORY_FORBIDDEN. */
  @Get(':memoryId/history')
  history(
    @Param('id') id: string,
    @Param('memoryId') memoryId: string,
    @Req() req: AuthedRequest,
  ): Promise<MemoryHistoryView> {
    return loggedRoute(this.logger, {
      route: 'GET /library/:id/memory/:memoryId/history',
      fields: { actorId: req.user.id, agentId: id, memoryId },
      work: () => this.memory.agentHistory(req.user, id, memoryId),
      outcomeOf: (view) => ({ versions: view.versions.length }),
    });
  }

  /** The new `MemoryHistoryView`; 409 RECORD_VERSION_CONFLICT, 400 VALIDATION_FAILED, 404, 403. */
  @Post(':memoryId/revert')
  @HttpCode(200)
  revert(
    @Param('id') id: string,
    @Param('memoryId') memoryId: string,
    @Body(new ZodValidationPipe(RevertMemoryBodySchema)) body: RevertMemoryBody,
    @Req() req: AuthedRequest,
  ): Promise<MemoryHistoryView> {
    return loggedRoute(this.logger, {
      route: 'POST /library/:id/memory/:memoryId/revert',
      fields: { actorId: req.user.id, agentId: id, memoryId, ...body },
      work: () => this.memory.revertAgentMemory(req.user, id, memoryId, body),
      outcomeOf: (view) => ({ version: view.versions[0]?.version }),
    });
  }

  /** 204, also when the agent has no such record; 404, 403. */
  @Delete(':memoryId')
  @HttpCode(204)
  delete(
    @Param('id') id: string,
    @Param('memoryId') memoryId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    return loggedRoute(this.logger, {
      route: 'DELETE /library/:id/memory/:memoryId',
      fields: { actorId: req.user.id, agentId: id, memoryId },
      work: () => this.memory.deleteAgentMemory(req.user, id, memoryId),
    });
  }
}

/** «Моя память»: the records about the signed-in employee, only theirs, admins included (KD-5, AC-33.2). */
@Controller('memory')
export class MyMemoryController {
  private readonly logger: Logger;

  constructor(
    private readonly memory: MemoryService,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'memory.routes' });
  }

  /** `MyMemoryView`. */
  @Get()
  view(@Req() req: AuthedRequest): Promise<MyMemoryView> {
    return loggedRoute(this.logger, {
      route: 'GET /memory',
      fields: { actorId: req.user.id },
      work: () => this.memory.myMemory(req.user.id),
      outcomeOf: (view) => ({ records: view.records.length }),
    });
  }

  /** `MemoryHistoryView`; 404 RECORD_NOT_FOUND for a missing record or another employee's. */
  @Get(':memoryId/history')
  history(
    @Param('memoryId') memoryId: string,
    @Req() req: AuthedRequest,
  ): Promise<MemoryHistoryView> {
    return loggedRoute(this.logger, {
      route: 'GET /memory/:memoryId/history',
      fields: { actorId: req.user.id, memoryId },
      work: () => this.memory.myHistory(req.user.id, memoryId),
      outcomeOf: (view) => ({ versions: view.versions.length }),
    });
  }

  /** The new `MemoryHistoryView`; 409 RECORD_VERSION_CONFLICT, 400 VALIDATION_FAILED, 404. */
  @Post(':memoryId/revert')
  @HttpCode(200)
  revert(
    @Param('memoryId') memoryId: string,
    @Body(new ZodValidationPipe(RevertMemoryBodySchema)) body: RevertMemoryBody,
    @Req() req: AuthedRequest,
  ): Promise<MemoryHistoryView> {
    return loggedRoute(this.logger, {
      route: 'POST /memory/:memoryId/revert',
      fields: { actorId: req.user.id, memoryId, ...body },
      work: () => this.memory.revertMyMemory(req.user.id, memoryId, body),
      outcomeOf: (view) => ({ version: view.versions[0]?.version }),
    });
  }

  /** 204, also when the record is gone or another employee's: then nothing changes. */
  @Delete(':memoryId')
  @HttpCode(204)
  delete(
    @Param('memoryId') memoryId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    return loggedRoute(this.logger, {
      route: 'DELETE /memory/:memoryId',
      fields: { actorId: req.user.id, memoryId },
      work: () => this.memory.deleteMyMemory(req.user.id, memoryId),
    });
  }
}
