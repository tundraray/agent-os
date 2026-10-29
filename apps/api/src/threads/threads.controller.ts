import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import {
  ThreadIdSchema,
  type ThreadMessagesResponse,
  type ThreadSummary,
} from '@agent-os/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ThreadsService } from './threads.service.js';

@Controller('threads')
@UseGuards(SessionGuard)
export class ThreadsController {
  constructor(private readonly threads: ThreadsService) {}

  @Get(':threadId')
  get(
    @Param('threadId', new ZodValidationPipe(ThreadIdSchema)) threadId: string,
    @Req() req: AuthedRequest,
  ): Promise<ThreadSummary> {
    return this.threads.get(threadId, req.user.id);
  }

  @Get(':threadId/messages')
  messages(
    @Param('threadId', new ZodValidationPipe(ThreadIdSchema)) threadId: string,
    @Req() req: AuthedRequest,
  ): Promise<ThreadMessagesResponse> {
    return this.threads.listMessages(threadId, req.user.id);
  }
}
