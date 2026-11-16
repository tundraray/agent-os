import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  CreateCatalogModelBodySchema,
  UpdateCatalogModelBodySchema,
  type CatalogModel,
  type CreateCatalogModelBody,
  type UpdateCatalogModelBody,
} from '@agent-os/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AdminOnly } from '../identity/admin-only.decorator.js';
import type { AuthedRequest } from '../identity/auth-user.js';
import { AccessService } from './access.service.js';

/**
 * The model catalogue for an administrator (design-access.md, Contract «Операции администратора»).
 * The model id is a path segment encoded by the client (`anthropic%2F…`); Nest hands it decoded.
 * The service audits every write in the write's transaction.
 */
@Controller('admin/models')
@AdminOnly()
export class AdminModelsController {
  constructor(private readonly access: AccessService) {}

  /** The catalogue by name. */
  @Get()
  list(): Promise<CatalogModel[]> {
    return this.access.listModels();
  }

  /** 201 `CatalogModel`; 409 MODEL_ID_TAKEN. */
  @Post()
  create(
    @Body(new ZodValidationPipe(CreateCatalogModelBodySchema))
    body: CreateCatalogModelBody,
    @Req() req: AuthedRequest,
  ): Promise<CatalogModel> {
    return this.access.createModel(req.user.id, body);
  }

  /** The new price counts from the next call. 404 MODEL_NOT_FOUND. */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateCatalogModelBodySchema))
    body: UpdateCatalogModelBody,
    @Req() req: AuthedRequest,
  ): Promise<CatalogModel> {
    return this.access.updateModel(req.user.id, id, body);
  }

  /** 204; the model's grants go by cascade. 404 MODEL_NOT_FOUND. */
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    return this.access.deleteModel(req.user.id, id);
  }
}
