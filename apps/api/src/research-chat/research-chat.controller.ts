import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import {
  ThreadIdSchema,
  type ThreadResearchResponse,
} from '@agent-os/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ResearchLaunchService } from './research-launch.service.js';

/**
 * `GET /api/threads/:threadId/research` (design-chat-entry.md, Contract Definitions): the launches of the owner's
 * thread for its cards. It changes nothing — decisions travel as chat turns (KD-2). A missing, foreign or deleted
 * thread is 404 `THREAD_NOT_FOUND`, as in the threads API.
 */
@Controller('threads')
@UseGuards(SessionGuard)
export class ResearchChatController {
  constructor(private readonly launches: ResearchLaunchService) {}

  @Get(':threadId/research')
  research(
    @Param('threadId', new ZodValidationPipe(ThreadIdSchema)) threadId: string,
    @Req() req: AuthedRequest,
  ): Promise<ThreadResearchResponse> {
    return this.launches.listForThread({ threadId, resourceId: req.user.id });
  }
}
