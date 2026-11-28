import { Inject, Injectable } from '@nestjs/common';
import type {
  AccessGate,
  EmbeddingVerdict,
  ModelVerdict,
  ProviderReadiness,
  ToolAccess,
} from '@agent-os/agents';
import { LOGGER, type Logger } from '@agent-os/common';
import type {
  CatalogModel,
  CreateCatalogModelBody,
  CreateGrantBody,
  Grant,
  ModelDefaults,
  ModelProviderKind,
  ModelUnavailableReason,
  MyModels,
  UpdateCatalogModelBody,
  UpdateModelDefaultsBody,
} from '@agent-os/contracts';
import {
  AccessGrantsRepository,
  IdentityRolesRepository,
  ModelsRepository,
  type AccessGrantWithModelName,
  type GrantHolderQuery,
  Db,
} from '@agent-os/db';
import { CLOCK, monthOf, TokenLedger, type Clock } from '@agent-os/runtime';
import { AuditLog } from '../audit/audit-log';
import { isUuid } from '../common/is-uuid';
import { IdentityDirectory } from '../identity/identity-directory';
import { identityError } from '../identity/identity.errors';
import {
  SettingsService,
  settingsResponse,
  type StoredSettings,
} from '../settings/settings.service';
import {
  accessError,
  foreignFieldsError,
  modelDefaultError,
} from './access.errors';
import {
  modelAdditionRule,
  modelDefaultsRule,
  modelUpdateRule,
  type DefaultChoice,
} from './catalogue-rules';
import {
  allowedCatalogue,
  effectiveAccess,
  type EffectiveAccess,
} from './effective-access';
import {
  grantColumnsOf,
  toGrantRow,
  toStoredGrant,
  type GrantRow,
  type StoredGrant,
} from './grant-rows';
import { grantRules, type GrantRuleInput } from './grant-rules';
import {
  modelColumnsOf,
  toCatalogModel,
  toCatalogModelOrUndefined,
} from './model-rows';
import { modelVerdict, quotaExhausted } from './model-verdict';

/** The readiness of the named providers; given by the controller from `AgentsProviders.readiness`. */
export type ProviderReadinessOf = (
  names: readonly string[],
) => Promise<ReadonlyMap<string, ProviderReadiness>>;

type ChatModel = Extract<CatalogModel, { purpose: 'chat' }>;

/** The settings key of the default models; also the `objectType` of their `admin_change`. */
const MODEL_DEFAULTS = 'model_defaults';

function toModelDefaults(
  stored: StoredSettings<typeof MODEL_DEFAULTS>,
): ModelDefaults {
  return { ...settingsResponse(stored), updatedBy: stored.updatedBy };
}

/** The default models with every field that names the model cleared. */
function withoutModel(
  defaults: UpdateModelDefaultsBody,
  model: string,
): UpdateModelDefaultsBody {
  return {
    chatModel: defaults.chatModel === model ? null : defaults.chatModel,
    embeddingModel:
      defaults.embeddingModel === model ? null : defaults.embeddingModel,
  };
}

/** `unavailableReason` of "My access": `null` for a ready provider. */
function unavailableReasonOf(
  readiness: ProviderReadiness,
): ModelUnavailableReason | null {
  return readiness === 'ready' ? null : `provider_${readiness}`;
}

function isChatModel(model: CatalogModel): model is ChatModel {
  return model.purpose === 'chat';
}

/** The holder of a grant body; the schema lets exactly one of `roleId` and `userId` through. */
function holderOfBody(body: CreateGrantBody): GrantHolderQuery {
  if (body.roleId !== undefined) return { roleId: body.roleId };
  if (body.userId !== undefined) return { userId: body.userId };
  throw new Error('grant body without a holder passed the schema');
}

function isModelGrant({ grant }: AccessGrantWithModelName): boolean {
  return grant.targetKind === 'model';
}

/** The grant as `grantRules` takes it: a stored grant with a new quota (PATCH). */
function ruleInputOf(grant: Grant, quotaUsd: number | null): GrantRuleInput {
  const holder =
    grant.holder.kind === 'role'
      ? { roleId: grant.holder.id }
      : { userId: grant.holder.id };
  // The target passed the purpose rule when the grant was created; the purpose is not read again.
  return {
    ...holder,
    effect: grant.effect,
    modelPurpose: null,
    quotaUsd,
  };
}

/**
 * Rights, quotas, the model catalogue and the default models (design-access.md, C3 api, KD-1..KD-3;
 * model-providers design-core.md KD-4..KD-6, ADR-0015). Answers the agents' checks (`tools`, `model`,
 * `defaultChatModel`, `embedding`), "My access" and the admin operations. Every answer reads the
 * employee (`isActive`), his roles with his rights in one query and — only for a model with a quota —
 * the month's spend, without a cache; the rules are `effectiveAccess`, `modelVerdict` and the catalogue
 * rules alone. An admin write and its `admin_change` record are one transaction.
 */
@Injectable()
export class AccessService implements AccessGate {
  constructor(
    private readonly db: Db,
    @Inject(TokenLedger) private readonly ledger: TokenLedger,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly identity: IdentityDirectory,
    private readonly grants: AccessGrantsRepository,
    private readonly roles: IdentityRolesRepository,
    private readonly models: ModelsRepository,
    private readonly settings: SettingsService,
    private readonly auditLog: AuditLog,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * The employee's tool rights; `owner_disabled` for a disabled or unknown employee. Each tool is answered by
   * the coverage rule over the levels of his roles, «Все сотрудники» included, and his own (access-levels
   * KD-3, KD-4); a super-administrator is a branch of the rule.
   */
  async tools(ownerId: string): Promise<ToolAccess> {
    const startedAt = Date.now();
    if (!(await this.identity.isActive(ownerId))) {
      this.logger.info('tool access checked', {
        ownerId,
        ownerActive: false,
        durationMs: Date.now() - startedAt,
      });
      return { kind: 'owner_disabled' };
    }
    const { grants, superAdmin } = await this.grantRowsOf(ownerId);
    const access = effectiveAccess(grants);
    // Not a verdict on any tool: the owner is active and this many grants were read; tools are refused one by one.
    this.logger.info('tool access checked', {
      ownerId,
      ownerActive: true,
      superAdmin,
      grantsRead: grants.length,
      durationMs: Date.now() - startedAt,
    });
    return {
      kind: 'allowed',
      allows: (tool) => {
        const { state } = access.tool(tool, superAdmin);
        if (state !== 'available') {
          this.logger.info('tool refused', {
            ownerId,
            server: tool.server,
            tool: tool.tool,
            readOnly: tool.readOnly,
            state,
          });
        }
        return state === 'available';
      },
    };
  }

  /** Whether the employee may call the model now, with its price (design-access.md, «Как AccessGate решает»). */
  async model(ownerId: string, model: string): Promise<ModelVerdict> {
    const startedAt = Date.now();
    const month = monthOf(this.clock.now());
    // One after another: inside a caller's transaction (a schedule's start) every read shares one client.
    const active = await this.identity.isActive(ownerId);
    const catalogued = await this.findModel(model);
    const access = await this.accessOf(ownerId);
    const modelAccess = access.model(model);
    const quotaUsd = modelAccess.allowed ? modelAccess.quotaUsd : null;
    const spentUsd =
      active && catalogued !== undefined && quotaUsd !== null
        ? await this.spentOn(ownerId, model, month)
        : 0;
    const verdict = modelVerdict({
      active,
      catalogued,
      access,
      spentUsd,
      month,
    });
    this.logger.info('model access checked', {
      ownerId,
      model,
      verdict: verdict.kind === 'allowed' ? 'allowed' : verdict.reason,
      spentUsd,
      quotaUsd,
      grantIds: modelAccess.allowed
        ? modelAccess.parts.map((part) => part.grantId)
        : [],
      durationMs: Date.now() - startedAt,
    });
    return verdict;
  }

  /** The id of the default chat model, or `null` while none is chosen (KD-5); read at each call. */
  async defaultChatModel(): Promise<string | null> {
    const { chatModel } = (await this.settings.read(MODEL_DEFAULTS)).value;
    this.logger.info('default chat model read', { model: chatModel });
    return chatModel;
  }

  /**
   * Whether a call of the default embedding model may run (KD-6): the employee, when named, is enabled,
   * and a default embedding model is chosen. No right and no quota is read; `null` is the platform's call.
   */
  async embedding(ownerId: string | null): Promise<EmbeddingVerdict> {
    const startedAt = Date.now();
    const [active, model] = await Promise.all([
      ownerId === null ? true : this.identity.isActive(ownerId),
      this.defaultEmbeddingModel(),
    ]);
    if (model !== undefined && model.purpose !== 'embedding')
      throw new Error(`default embedding model ${model.id} is a chat model`);
    const verdict: EmbeddingVerdict = !active
      ? { kind: 'refused', reason: 'owner_disabled' }
      : model === undefined
        ? { kind: 'refused', reason: 'model_not_configured' }
        : {
            kind: 'allowed',
            model: model.id,
            inputUsdPerMTok: model.inputUsdPerMTok,
            dimensions: model.dimensions,
          };
    this.logger.info('embedding access checked', {
      ownerId,
      model: model?.id ?? null,
      verdict: verdict.kind === 'allowed' ? 'allowed' : verdict.reason,
      durationMs: Date.now() - startedAt,
    });
    return verdict;
  }

  /**
   * "My access": the chat models allowed to the employee now, by name, with the month's spend (DC-9)
   * and whether their provider is ready (`unavailableReason`). Embedding models are never listed (DC-5).
   */
  async myModels(
    ownerId: string,
    readinessOf: ProviderReadinessOf,
  ): Promise<MyModels> {
    const startedAt = Date.now();
    const month = monthOf(this.clock.now());
    const { access, catalogue } = await this.allowedOf(ownerId);
    const [spend, readiness] =
      catalogue.length === 0
        ? [new Map<string, number>(), new Map<string, ProviderReadiness>()]
        : await Promise.all([
            this.ledger.monthSpendByModel(ownerId, month),
            readinessOf([...new Set(catalogue.map((model) => model.provider))]),
          ]);
    const models = catalogue.map((model) => {
      const modelAccess = access.model(model.id);
      const quotaUsd = modelAccess.allowed ? modelAccess.quotaUsd : null;
      const spentUsd = spend.get(model.id) ?? 0;
      const providerReadiness = readiness.get(model.provider);
      if (providerReadiness === undefined)
        throw new Error(`no readiness of provider ${model.provider}`);
      return {
        model: model.id,
        name: model.name,
        unavailableReason: unavailableReasonOf(providerReadiness),
        spentUsd,
        quotaUsd,
        remainingUsd:
          quotaUsd === null ? null : Math.max(0, quotaUsd - spentUsd),
        exhausted: quotaUsd !== null && quotaExhausted(spentUsd, quotaUsd),
      };
    });
    this.logger.info('my access read', {
      ownerId,
      month,
      models: models.map((model) => model.model),
      unavailable: models.flatMap((model) =>
        model.unavailableReason === null
          ? []
          : [{ model: model.model, reason: model.unavailableReason }],
      ),
      durationMs: Date.now() - startedAt,
    });
    return { month, models };
  }

  /**
   * The chat models allowed to the employee and in the catalogue, by name then id, quota aside (KD-4): the
   * list of "My access", whose top model is "the first allowed" of the model choice.
   */
  async allowedModels(
    ownerId: string,
  ): Promise<{ id: string; name: string }[]> {
    const { catalogue } = await this.allowedOf(ownerId);
    return catalogue.map(({ id, name }) => ({ id, name }));
  }

  // ---------- Admin: catalogue ----------

  async listModels(): Promise<CatalogModel[]> {
    return (await this.models.list()).map(toCatalogModel);
  }

  /** How many catalogue models the provider has; a provider with models is not deleted (AC-01.3). */
  countModelsOfProvider(name: string): Promise<number> {
    return this.models.countByProvider(name);
  }

  /**
   * `providerKind` — the kind of the provider the id names, `null` when none is registered; the
   * controller reads it from `AgentsProviders.kindOf`. 422 MODEL_PROVIDER_INVALID (AC-05.2, AC-05.3),
   * 409 MODEL_ID_TAKEN.
   */
  async createModel(
    actorId: string,
    body: CreateCatalogModelBody,
    providerKind: ModelProviderKind | null,
  ): Promise<CatalogModel> {
    const rule = modelAdditionRule({ purpose: body.purpose, providerKind });
    if (rule.kind === 'invalid') {
      this.logger.info('access change refused', {
        actorId,
        objectType: 'model',
        objectId: body.id,
        action: 'create',
        providerKind,
        outcome: 'refused',
        reason: rule.reason,
      });
      throw accessError('MODEL_PROVIDER_INVALID', rule.reason);
    }
    const created = await this.db.transaction(async () => {
      const row = await this.models.insert(body.id, modelColumnsOf(body));
      if (row === undefined) throw accessError('MODEL_ID_TAKEN');
      const model = toCatalogModel(row);
      await this.audit(actorId, 'model', model.id, null, model);
      return model;
    });
    this.logChange(actorId, 'model', created.id, 'create');
    return created;
  }

  /** Only the fields of the model's purpose. 404 MODEL_NOT_FOUND, 400 VALIDATION_FAILED. */
  async updateModel(
    actorId: string,
    id: string,
    body: UpdateCatalogModelBody,
  ): Promise<CatalogModel> {
    const updated = await this.db.transaction(async () => {
      const before = toCatalogModelOrUndefined(await this.models.find(id));
      if (before === undefined) throw accessError('MODEL_NOT_FOUND');
      const rule = modelUpdateRule(before, body);
      if (rule.kind === 'invalid')
        throw foreignFieldsError(before.purpose, rule.foreignFields);
      const after = toCatalogModel(
        await this.models.update(rule.after.id, modelColumnsOf(rule.after)),
      );
      await this.audit(actorId, 'model', id, before, after);
      return after;
    });
    this.logChange(actorId, 'model', id, 'update');
    return updated;
  }

  /**
   * The model's grants go by cascade; a default that names it is cleared in the same transaction by the settings
   * service's conditional replace, without its own audit (data-model DC-7). 404 MODEL_NOT_FOUND.
   */
  async deleteModel(actorId: string, id: string): Promise<void> {
    await this.db.transaction(async () => {
      const deleted = toCatalogModelOrUndefined(await this.models.delete(id));
      if (deleted === undefined) throw accessError('MODEL_NOT_FOUND');
      await this.clearDefault(id);
      await this.audit(actorId, 'model', id, deleted, null);
    });
    this.logChange(actorId, 'model', id, 'delete');
  }

  // ---------- Admin: default models ----------

  /** GET /api/admin/model-defaults. */
  async modelDefaults(): Promise<ModelDefaults> {
    return toModelDefaults(await this.settings.read(MODEL_DEFAULTS));
  }

  /**
   * PUT /api/admin/model-defaults: each value is a catalogue model of its purpose or `null` (AC-06.2,
   * Invariant 3), checked before the write in the transaction in which `SettingsService` writes the key with its
   * `admin_change` record. 422 MODEL_DEFAULT_INVALID with the rejected id.
   */
  async setModelDefaults(
    actorId: string,
    body: UpdateModelDefaultsBody,
  ): Promise<ModelDefaults> {
    const { after } = await this.db.transaction(async () => {
      const rule = modelDefaultsRule(await this.defaultChoicesOf(body));
      if (rule.kind === 'invalid') {
        this.logger.info('model defaults update refused', {
          actorId,
          objectType: MODEL_DEFAULTS,
          requested: body,
          outcome: 'refused',
          reason: rule.reason,
          model: rule.model,
        });
        throw modelDefaultError(rule.reason, rule.model);
      }
      return this.settings.write(MODEL_DEFAULTS, body, actorId);
    });
    return toModelDefaults(after);
  }

  /** The catalogue row of the default embedding model; `undefined` while none is chosen. */
  private async defaultEmbeddingModel(): Promise<CatalogModel | undefined> {
    const { embeddingModel } = (await this.settings.read(MODEL_DEFAULTS)).value;
    return embeddingModel === null ? undefined : this.findModel(embeddingModel);
  }

  /** Clears every default that names the deleted model; a JSON value has no foreign key to do it. */
  private async clearDefault(model: string): Promise<void> {
    const { value } = await this.settings.read(MODEL_DEFAULTS);
    const cleared = withoutModel(value, model);
    if (
      cleared.chatModel === value.chatModel &&
      cleared.embeddingModel === value.embeddingModel
    )
      return;
    if (!(await this.settings.replaceIf(MODEL_DEFAULTS, value, cleared)))
      this.logger.warn(
        'default model not cleared: defaults changed meanwhile',
        {
          model,
          objectType: MODEL_DEFAULTS,
        },
      );
  }

  /** The values of the body that name a model, with their catalogue rows read in the write's transaction. */
  private defaultChoicesOf(
    body: UpdateModelDefaultsBody,
  ): Promise<DefaultChoice[]> {
    const wanted = [
      { purpose: 'chat', model: body.chatModel },
      { purpose: 'embedding', model: body.embeddingModel },
    ] as const;
    return Promise.all(
      wanted.flatMap(({ purpose, model }) =>
        model === null
          ? []
          : [
              this.findModel(model).then((catalogued) => ({
                purpose,
                model,
                catalogued,
              })),
            ],
      ),
    );
  }

  // ---------- Admin: grants ----------

  /**
   * The model grants of a role or an employee by creation time; the rows of access levels are not
   * grants here (access-levels KD-6). 404 ROLE_NOT_FOUND, USER_NOT_FOUND.
   */
  async listGrants(holder: GrantHolderQuery): Promise<Grant[]> {
    await this.holderOr404(holder);
    const rows = await this.grants.list(holder);
    return this.named(rows.filter(isModelGrant).map(toStoredGrant));
  }

  /**
   * Checks the grant fully before writing, so a refusal saves nothing (DC-2): 422 GRANT_INVALID (an
   * embedding model among its reasons, DC-5), 404 ROLE_NOT_FOUND/USER_NOT_FOUND, 422
   * GRANT_TARGET_UNKNOWN, 409 GRANT_EXISTS.
   */
  async createGrant(actorId: string, body: CreateGrantBody): Promise<Grant> {
    const targetModel = await this.findModel(body.target.model);
    const rules = grantRules({
      ...body,
      modelPurpose: targetModel?.purpose ?? null,
    });
    if (rules.kind === 'invalid')
      throw accessError('GRANT_INVALID', rules.reason);
    await this.holderOr404(holderOfBody(body));
    if (targetModel === undefined)
      throw accessError('GRANT_TARGET_UNKNOWN', 'model_unknown');
    const created = await this.db.transaction(async () => {
      const id = await this.grants.insert(grantColumnsOf(body));
      if (id === undefined) throw accessError('GRANT_EXISTS');
      const grant = await this.grantOr404(id);
      await this.audit(actorId, 'grant', id, null, grant);
      return grant;
    });
    this.logChange(actorId, 'grant', created.id, 'create');
    return created;
  }

  /** `null` removes the quota. 404 GRANT_NOT_FOUND, 422 GRANT_INVALID. */
  async updateGrantQuota(
    actorId: string,
    id: string,
    quotaUsd: number | null,
  ): Promise<Grant> {
    const updated = await this.db.transaction(async () => {
      const before = await this.grantOr404(id);
      const rules = grantRules(ruleInputOf(before, quotaUsd));
      if (rules.kind === 'invalid')
        throw accessError('GRANT_INVALID', rules.reason);
      await this.grants.updateQuota(id, quotaUsd);
      const after = await this.grantOr404(id);
      await this.audit(actorId, 'grant', id, before, after);
      return after;
    });
    this.logChange(actorId, 'grant', id, 'update');
    return updated;
  }

  /** 404 GRANT_NOT_FOUND. */
  async deleteGrant(actorId: string, id: string): Promise<void> {
    await this.db.transaction(async () => {
      const before = await this.grantOr404(id);
      await this.grants.delete(id);
      await this.audit(actorId, 'grant', id, before, null);
    });
    this.logChange(actorId, 'grant', id, 'delete');
  }

  /**
   * `admin_change` with «было» and «стало» in the transaction of the write it records (design-access.md,
   * Contract «Операции администратора»), as identity does: a write without its record is rolled back.
   */
  private audit(
    actorId: string,
    objectType: 'model' | 'grant',
    objectId: string,
    before: CatalogModel | Grant | null,
    after: CatalogModel | Grant | null,
  ): Promise<void> {
    return this.auditLog.record({
      kind: 'admin_change',
      actor: actorId,
      objectType,
      objectId,
      before,
      after,
      outcome: 'ok',
    });
  }

  private logChange(
    actorId: string,
    objectType: 'model' | 'grant',
    objectId: string,
    action: 'create' | 'update' | 'delete',
  ): void {
    this.logger.info('access changed', {
      actorId,
      objectType,
      objectId,
      action,
      outcome: 'ok',
    });
  }

  // ---------- Reads ----------

  /** The employee's rights now: his roles, then their grants and his own in one query. */
  private async accessOf(ownerId: string): Promise<EffectiveAccess> {
    return effectiveAccess((await this.grantRowsOf(ownerId)).grants);
  }

  /** The employee's rights and the catalogue chat models they allow, in catalogue order (DC-5). */
  private async allowedOf(
    ownerId: string,
  ): Promise<{ access: EffectiveAccess; catalogue: ChatModel[] }> {
    const [access, models] = await Promise.all([
      this.accessOf(ownerId),
      this.listModels(),
    ]);
    return {
      access,
      catalogue: allowedCatalogue(access, models.filter(isChatModel)),
    };
  }

  /**
   * The grants of the employee's roles, «Все сотрудники» among them without a membership row (access-levels
   * KD-5), and his own: the roles first, then the rows in one query (NFR-04). `superAdmin` — he is in the
   * built-in «Супер-администратор» role, read from the same roles.
   */
  private async grantRowsOf(
    ownerId: string,
  ): Promise<{ grants: GrantRow[]; superAdmin: boolean }> {
    if (!isUuid(ownerId)) return { grants: [], superAdmin: false };
    const held = await this.roles.ofUsers([ownerId]);
    const everyone = await this.roles.builtinId('everyone');
    const rows = await this.grants.ofEmployee(
      [...held.map((role) => role.id), everyone],
      ownerId,
    );
    return {
      grants: rows.map(toGrantRow),
      superAdmin: held.some((role) => role.builtinKind === 'super_admin'),
    };
  }

  /** The catalogue model of the id; `undefined` for a missing one. */
  private async findModel(id: string): Promise<CatalogModel | undefined> {
    return toCatalogModelOrUndefined(await this.models.find(id));
  }

  /** Spend on one model this month; read at each check, no cache (KD-1). */
  private async spentOn(
    ownerId: string,
    model: string,
    month: string,
  ): Promise<number> {
    const spend = await this.ledger.monthSpendByModel(ownerId, month);
    return spend.get(model) ?? 0;
  }

  /** A level row is no grant of this route: 404 like a missing one (access-levels KD-6). */
  private async grantOr404(id: string): Promise<Grant> {
    const stored = isUuid(id) ? await this.grants.find(id) : undefined;
    if (stored === undefined || !isModelGrant(stored))
      throw accessError('GRANT_NOT_FOUND');
    const [grant] = await this.named([toStoredGrant(stored)]);
    if (grant === undefined) throw new Error(`grant ${id} lost its holder`);
    return grant;
  }

  /** The grants with the name of each role holder, read in `identity`. */
  private async named(grants: readonly StoredGrant[]): Promise<Grant[]> {
    const roles = await this.identity.roleNames(
      grants.flatMap(({ holder }) => (holder.kind === 'role' ? holder.id : [])),
    );
    const names = new Map(roles.map((role) => [role.id, role.name]));
    return grants.map((grant) => {
      const { kind, id } = grant.holder;
      if (kind === 'user') return { ...grant, holder: { kind, id } };
      const name = names.get(id);
      // The FK keeps the role of a grant in place.
      if (name === undefined)
        throw new Error('access_grants row has a broken holder');
      return { ...grant, holder: { kind, id, name } };
    });
  }

  private async holderOr404(holder: GrantHolderQuery): Promise<void> {
    if ('roleId' in holder) {
      const { roleIds } = await this.identity.existing({
        roleIds: [holder.roleId],
        userIds: [],
      });
      if (roleIds.length === 0) throw identityError('ROLE_NOT_FOUND');
      return;
    }
    const { userIds } = await this.identity.existing({
      roleIds: [],
      userIds: [holder.userId],
    });
    if (userIds.length === 0) throw identityError('USER_NOT_FOUND');
  }
}
