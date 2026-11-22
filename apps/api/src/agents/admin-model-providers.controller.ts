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
import type {
  Agents,
  ModelProviderAuditState,
  ProviderRegistryView,
} from '@agent-os/agents';
import {
  CreateModelProviderBodySchema,
  UpdateModelProviderBodySchema,
  type CreateModelProviderBody,
  type ModelProviderCheck,
  type ModelProviderView,
  type UpdateModelProviderBody,
} from '@agent-os/contracts';
import { AccessService } from '../access/access.service';
import { AuditLog } from '../audit/audit-log.repository';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminOnly } from '../identity/admin-only.decorator';
import type { AuthedRequest } from '../identity/auth-user';
import { AGENTS } from './agents.tokens';
import { providerAnswer } from './model-providers.errors';

const MODEL_PROVIDER_OBJECT_TYPE = 'model_provider';

/**
 * The `admin_change` record of a registry write, made after it (ADR-0014, ADR-0019): «было/стало» carry no
 * key value — a set, replaced or removed key is the mark `changed` in `apiKey`, which `AuditLog` writes as
 * `secret_changed`.
 */
async function recordProviderChange(
  auditLog: AuditLog,
  {
    actor,
    provider,
    change,
  }: {
    readonly actor: string;
    readonly provider: string;
    readonly change: {
      readonly before: ModelProviderAuditState | null;
      readonly after: ModelProviderAuditState | null;
    };
  },
): Promise<void> {
  await auditLog.record(null, {
    kind: 'admin_change',
    actor,
    objectType: MODEL_PROVIDER_OBJECT_TYPE,
    objectId: provider,
    before: change.before === null ? null : { ...change.before },
    after: change.after === null ? null : { ...change.after },
    outcome: 'ok',
  });
}

/**
 * The model provider registry for an administrator (design-core.md of model-providers, Contract «Для части
 * `web`»). Every write goes through `Agents.providers` and is audited after it as `admin_change` on
 * `model_provider`; no answer carries a key value, only `apiKeySet` and `apiKeyLast4` (DC-2). The number of
 * the provider's catalogue models comes from `AccessService` (KD-1): the registry does not read the catalogue.
 */
@Controller('admin/model-providers')
@AdminOnly()
export class AdminModelProvidersController {
  constructor(
    @Inject(AGENTS) private readonly agents: Agents,
    private readonly access: AccessService,
    private readonly auditLog: AuditLog,
  ) {}

  /** The providers by name. */
  @Get()
  async list(): Promise<ModelProviderView[]> {
    const views = await this.agents.providers.list();
    return Promise.all(views.map((view) => this.withCatalogModels(view)));
  }

  /** 201 `ModelProviderView`, the provider enabled; 409 MODEL_PROVIDER_NAME_TAKEN. */
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateModelProviderBodySchema))
    body: CreateModelProviderBody,
    @Req() req: AuthedRequest,
  ): Promise<ModelProviderView> {
    const actor = req.user.id;
    const write = await providerAnswer(this.agents.providers.create(body));
    await recordProviderChange(this.auditLog, {
      actor,
      provider: body.name,
      change: write,
    });
    return this.withCatalogModels(write.view);
  }

  /** `ModelProviderView`; 404 MODEL_PROVIDER_NOT_FOUND. */
  @Get(':name')
  async detail(@Param('name') name: string): Promise<ModelProviderView> {
    const view = await providerAnswer(this.agents.providers.get(name));
    return this.withCatalogModels(view);
  }

  /** `baseUrl: null` — the kind's default address, `apiKey: null` — remove the key. 404 MODEL_PROVIDER_NOT_FOUND. */
  @Patch(':name')
  async update(
    @Param('name') name: string,
    @Body(new ZodValidationPipe(UpdateModelProviderBodySchema))
    body: UpdateModelProviderBody,
    @Req() req: AuthedRequest,
  ): Promise<ModelProviderView> {
    const actor = req.user.id;
    const write = await providerAnswer(this.agents.providers.update(name, body));
    await recordProviderChange(this.auditLog, {
      actor,
      provider: name,
      change: write,
    });
    return this.withCatalogModels(write.view);
  }

  /** 204; 409 MODEL_PROVIDER_HAS_MODELS with `count` while the catalogue has its models (AC-01.3); 404. */
  @Delete(':name')
  @HttpCode(204)
  async remove(
    @Param('name') name: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const actor = req.user.id;
    // A registered name holds no LIKE wildcard, so the count below reads only this provider's models.
    await providerAnswer(this.agents.providers.get(name));
    const catalogModels = await this.access.countModelsOfProvider(name);
    const removal = await providerAnswer(
      this.agents.providers.remove({ name, catalogModels }),
    );
    await recordProviderChange(this.auditLog, {
      actor,
      provider: name,
      change: removal,
    });
  }

  /** One request with the stored address and key, no model call (FR-15): no ledger row, no audit. 404. */
  @Post(':name/check')
  @HttpCode(200)
  check(@Param('name') name: string): Promise<ModelProviderCheck> {
    return providerAnswer(this.agents.providers.check(name));
  }

  private async withCatalogModels(
    view: ProviderRegistryView,
  ): Promise<ModelProviderView> {
    return {
      ...view,
      catalogModels: await this.access.countModelsOfProvider(view.name),
    };
  }
}
