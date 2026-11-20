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
  Req,
} from '@nestjs/common';
import type { Agents } from '@agent-os/agents';
import {
  CreateRecordBodySchema,
  RecordAudienceBodySchema,
  UpdateRecordBodySchema,
  type CopyResult,
  type CreateRecordBody,
  type LibraryChoices,
  type RecordAudienceBody,
  type RecordDetail,
  type RecordSummary,
  type UpdateRecordBody,
} from '@agent-os/contracts';
import { AGENTS } from '../agents/agents.tokens.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { AuthedRequest } from '../identity/auth-user.js';
import { LibraryService } from './library.service.js';
import { serverFacts } from './server-facts.js';

/**
 * The employee's library (design-library.md, «Маршруты сотрудника», KD-6). The employee is only
 * `req.user`; the facts only `Agents` has — usable servers — are read here and handed to
 * `LibraryService`. A number that is not a UUID is answered by the service as 404, so no route
 * parses it. Static paths come before `:id`.
 */
@Controller('library')
export class LibraryController {
  constructor(
    private readonly library: LibraryService,
    @Inject(AGENTS) private readonly agents: Agents,
  ) {}

  /** The records the viewer sees, by name. */
  @Get()
  async list(@Req() req: AuthedRequest): Promise<RecordSummary[]> {
    return this.library.list(
      req.user,
      await serverFacts(this.agents, req.user.id),
    );
  }

  /** The servers usable to the employee and the model of a new record. */
  @Get('choices')
  async choices(@Req() req: AuthedRequest): Promise<LibraryChoices> {
    return this.library.choices(
      req.user,
      await serverFacts(this.agents, req.user.id),
    );
  }

  /** 404 RECORD_NOT_FOUND. */
  @Get(':id')
  async get(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<RecordDetail> {
    return this.library.get(
      req.user,
      id,
      await serverFacts(this.agents, req.user.id),
    );
  }

  /** A personal record of the viewer; 409 RECORD_NAME_TAKEN, 422 RECORD_REJECTED. */
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateRecordBodySchema)) body: CreateRecordBody,
    @Req() req: AuthedRequest,
  ): Promise<RecordDetail> {
    return this.library.create(
      req.user,
      body,
      await serverFacts(this.agents, req.user.id),
    );
  }

  /** 404, 403 RECORD_READ_ONLY, 409 RECORD_NAME_TAKEN / RECORD_VERSION_CONFLICT, 422. */
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateRecordBodySchema)) body: UpdateRecordBody,
    @Req() req: AuthedRequest,
  ): Promise<RecordDetail> {
    return this.library.update(
      req.user,
      id,
      body,
      await serverFacts(this.agents, req.user.id),
    );
  }

  /** 404, 403, 422 `role_not_member` / `sharing_banned`. */
  @Put(':id/audience')
  async setAudience(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RecordAudienceBodySchema))
    body: RecordAudienceBody,
    @Req() req: AuthedRequest,
  ): Promise<RecordDetail> {
    return this.library.setAudience(
      req.user,
      id,
      body,
      await serverFacts(this.agents, req.user.id),
    );
  }

  /** A personal copy of a visible record (Flow 3); 404 RECORD_NOT_FOUND. */
  @Post(':id/copy')
  async copy(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<CopyResult> {
    return this.library.copy(
      req.user,
      id,
      await serverFacts(this.agents, req.user.id),
    );
  }

  /** 204; 404, 403 RECORD_READ_ONLY. */
  @Delete(':id')
  @HttpCode(204)
  delete(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    return this.library.delete(req.user, id);
  }
}
