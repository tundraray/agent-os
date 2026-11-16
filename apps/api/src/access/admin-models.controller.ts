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
  Req,
} from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import {
  CreateCatalogModelBodySchema,
  UpdateCatalogModelBodySchema,
  type CatalogModel,
  type CreateCatalogModelBody,
  type UpdateCatalogModelBody,
} from '@agent-os/contracts';
import { AuditLog } from '../audit/audit-log.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AdminOnly } from '../identity/admin-only.decorator.js';
import type { AuthedRequest } from '../identity/auth-user.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { recordAccessChange } from './admin-access.controller.js';
import { AccessService, type AccessChange } from './access.service.js';

/**
 * The model catalogue for an administrator (design-access.md, Contract «Операции администратора»).
 * The model id is a path segment encoded by the client (`anthropic%2F…`); Nest hands it decoded.
 * Every write is audited after it.
 */
@Controller('admin/models')
@AdminOnly()
export class AdminModelsController {
  constructor(
    private readonly access: AccessService,
    private readonly auditLog: AuditLog,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {}

  /** The catalogue by name. */
  @Get()
  list(): Promise<CatalogModel[]> {
    return this.access.listModels();
  }

  /** 201 `CatalogModel`; 409 MODEL_ID_TAKEN. */
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateCatalogModelBodySchema))
    body: CreateCatalogModelBody,
    @Req() req: AuthedRequest,
  ): Promise<CatalogModel> {
    const change = await this.access.createModel(body);
    await this.record(req, 'create', change);
    return change.view;
  }

  /** The new price counts from the next call. 404 MODEL_NOT_FOUND. */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateCatalogModelBodySchema))
    body: UpdateCatalogModelBody,
    @Req() req: AuthedRequest,
  ): Promise<CatalogModel> {
    const change = await this.access.updateModel(id, body);
    await this.record(req, 'update', change);
    return change.view;
  }

  /** 204; the model's grants go by cascade. 404 MODEL_NOT_FOUND. */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const change = await this.access.deleteModel(id);
    await this.record(req, 'delete', change);
  }

  private record(
    req: AuthedRequest,
    action: 'create' | 'update' | 'delete',
    change: AccessChange<CatalogModel>,
  ): Promise<void> {
    return recordAccessChange(this.auditLog, this.logger, {
      actor: req.user.id,
      objectType: 'model',
      objectId: change.view.id,
      action,
      change,
    });
  }
}
