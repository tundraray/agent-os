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
  SystemRecordAudienceBodySchema,
  UpdateLibrarySettingsBodySchema,
  UpdateRecordBodySchema,
  type BannedRecord,
  type CreateRecordBody,
  type LibrarySettings,
  type RecordDetail,
  type RecordSummary,
  type SystemRecordAudienceBody,
  type UpdateLibrarySettingsBody,
  type UpdateRecordBody,
} from '@agent-os/contracts';
import { AGENTS } from '../agents/agents.tokens';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminOnly } from '../identity/admin-only.decorator';
import type { AuthedRequest } from '../identity/auth-user';
import { LibrarySettingsService } from './library-settings';
import { LibraryPanelService } from './library-panel.service';
import type { PanelServerFacts } from './library.types';
import { serverFacts } from './server-facts';

/**
 * The library of the admin panel (design-library.md, «Маршруты панели», FR-09): system records, records
 * shared with roles, the bans. `@AdminOnly()` answers anyone else 403 ADMIN_REQUIRED. A system record
 * chooses from the whole MCP registry, read through `Agents.mcp` (ADR-0014). Static paths come before `:id`.
 */
@Controller('admin/library')
@AdminOnly()
export class AdminLibraryController {
  constructor(
    private readonly library: LibraryPanelService,
    private readonly settings: LibrarySettingsService,
    @Inject(AGENTS) private readonly agents: Agents,
  ) {}

  /** Every system record, whole audience and `builtinKey`. */
  @Get('system')
  async system(@Req() req: AuthedRequest): Promise<RecordSummary[]> {
    return this.library.panelList(
      req.user,
      'system',
      await serverFacts(this.agents, req.user.id),
    );
  }

  /** Employee records with at least one role holder (AC-24.1). */
  @Get('shared')
  async shared(@Req() req: AuthedRequest): Promise<RecordSummary[]> {
    return this.library.panelList(
      req.user,
      'shared',
      await serverFacts(this.agents, req.user.id),
    );
  }

  /** Records banned from sharing, without description and content (AC-09.4). */
  @Get('bans')
  bans(@Req() req: AuthedRequest): Promise<BannedRecord[]> {
    return this.library.bans(req.user);
  }

  /** «Максимум шагов» a new record starts with. */
  @Get('settings')
  getSettings(): Promise<LibrarySettings> {
    return this.settings.get();
  }

  /** 400 VALIDATION_FAILED for a value out of bounds, nothing changed. */
  @Put('settings')
  updateSettings(
    @Body(new ZodValidationPipe(UpdateLibrarySettingsBodySchema))
    body: UpdateLibrarySettingsBody,
    @Req() req: AuthedRequest,
  ): Promise<LibrarySettings> {
    return this.settings.update(req.user.id, body);
  }

  /** A system record or a role-shared employee record; any other — 404 RECORD_NOT_FOUND. */
  @Get(':id')
  async get(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<RecordDetail> {
    return this.library.panelGet(
      req.user,
      id,
      await serverFacts(this.agents, req.user.id),
    );
  }

  /** A system record without holders; 409 RECORD_NAME_TAKEN, 422 RECORD_REJECTED. */
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateRecordBodySchema)) body: CreateRecordBody,
    @Req() req: AuthedRequest,
  ): Promise<RecordDetail> {
    return this.library.createSystem(
      req.user,
      body,
      await this.panelServerFacts(req.user.id),
    );
  }

  /** A role-shared employee record — 403 RECORD_READ_ONLY (FR-09). */
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateRecordBodySchema)) body: UpdateRecordBody,
    @Req() req: AuthedRequest,
  ): Promise<RecordDetail> {
    return this.library.updateSystem(
      req.user,
      id,
      body,
      await this.panelServerFacts(req.user.id),
    );
  }

  /** 422 `audience_fixed` for the chat record, `holder_not_found` for a missing role or employee. */
  @Put(':id/audience')
  async setAudience(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SystemRecordAudienceBodySchema))
    body: SystemRecordAudienceBody,
    @Req() req: AuthedRequest,
  ): Promise<RecordDetail> {
    return this.library.setSystemAudience(
      req.user,
      id,
      body,
      await serverFacts(this.agents, req.user.id),
    );
  }

  /** 204; a built-in record — 422 `builtin`. */
  @Delete(':id')
  @HttpCode(204)
  delete(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    return this.library.deleteSystem(req.user, id);
  }

  /** 204: holders removed and the ban set (Flow 4); otherwise 404 RECORD_NOT_FOUND. */
  @Post(':id/close')
  @HttpCode(204)
  close(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    return this.library.close(req.user, id);
  }

  /** 204; no ban — 404 RECORD_NOT_FOUND. */
  @Delete(':id/ban')
  @HttpCode(204)
  unban(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    return this.library.unban(req.user, id);
  }

  private async panelServerFacts(adminId: string): Promise<PanelServerFacts> {
    const [facts, registry] = await Promise.all([
      serverFacts(this.agents, adminId),
      this.agents.mcp.list(),
    ]);
    return { ...facts, registryServers: registry.map((server) => server.name) };
  }
}
