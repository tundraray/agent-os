import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  LaunchKeySchema,
  ResearchStopResponseSchema,
  ThreadIdSchema,
  type ResearchStopResponse,
  type ThreadResearchResponse,
} from '@agent-os/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ResearchLaunchService } from './research-launch.service.js';
import {
  researchLaunchNotFound,
  researchStopFailed,
} from './research-stop.errors.js';

/**
 * The research routes of a thread. `GET /api/threads/:threadId/research` (design-chat-entry.md, Contract Definitions)
 * reads the launches of the owner's thread for its cards; confirm and decline travel as chat turns (KD-2).
 * `POST /api/threads/:threadId/research/:launchKey/stop` (design-lifecycle.md, KD-4) stops a card's research without
 * a model call. A missing, foreign or deleted thread is 404 `THREAD_NOT_FOUND`, as in the threads API.
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

  /** 200 with the launch `stopped`, or as it already was (DC-8); 404 `RESEARCH_LAUNCH_NOT_FOUND`; 500 `RESEARCH_STOP_FAILED`. */
  @Post(':threadId/research/:launchKey/stop')
  @HttpCode(200)
  async stop(
    @Param('threadId', new ZodValidationPipe(ThreadIdSchema)) threadId: string,
    @Param('launchKey', new ZodValidationPipe(LaunchKeySchema))
    launchKey: string,
    @Req() req: AuthedRequest,
  ): Promise<ResearchStopResponse> {
    const stopped = await this.launches.stopLaunch({
      threadId,
      resourceId: req.user.id,
      launchKey,
    });
    if (stopped.error === 'not_found') throw researchLaunchNotFound();
    if (stopped.error === 'stop_failed') throw researchStopFailed();
    return ResearchStopResponseSchema.parse({ launch: stopped.launch });
  }
}
