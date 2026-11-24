import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Req,
} from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import type { AgentMemoryView, MyMemoryView } from '@agent-os/contracts';
import { loggedRoute } from '../common/logged-route';
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
