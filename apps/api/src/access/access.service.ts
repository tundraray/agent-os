import { Inject, Injectable } from '@nestjs/common';
import type {
  AccessGate,
  EmbeddingVerdict,
  ModelVerdict,
  ProviderReadiness,
  ToolAccess,
} from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import type {
  CatalogModel,
  CreateCatalogModelBody,
  CreateGrantBody,
  Grant,
  GrantTargetBody,
  ModelDefaults,
  ModelProviderKind,
  ModelUnavailableReason,
  MyModels,
  UpdateCatalogModelBody,
  UpdateModelDefaultsBody,
} from '@agent-os/contracts';
import type { Database, DatabaseConnection } from '@agent-os/db';
import {
  monthOf,
  PLATFORM_OWNER_ID,
  type Clock,
  type Runtime,
  type RuntimeTx,
} from '@agent-os/runtime';
import { AuditLog } from '../audit/audit-log.js';
import type { Executor } from '../common/executor.js';
import { isUuid } from '../common/is-uuid.js';
import { IdentityDirectory } from '../identity/identity-directory.js';
import { identityError } from '../identity/identity.errors.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import {
  RUNTIME,
  RUNTIME_CLOCK,
  RUNTIME_DATABASE,
} from '../runtime/runtime.tokens.js';
import {
  accessError,
  foreignFieldsError,
  modelDefaultError,
} from './access.errors.js';
import {
  modelAdditionRule,
  modelDefaultsRule,
  modelUpdateRule,
  type DefaultChoice,
} from './catalogue-rules.js';
import {
  allowedCatalogue,
  effectiveAccess,
  type EffectiveAccess,
  type GrantRow,
} from './effective-access.js';
import { grantRules, type GrantRuleInput } from './grant-rules.js';
import {
  deleteGrant,
  deleteServerGrants,
  findGrant,
  grantsOf,
  insertGrant,
  listGrants,
  updateGrantQuota,
  type GrantHolderQuery,
} from './grants.repository.js';
import { modelVerdict, quotaExhausted } from './model-verdict.js';
import {
  countByProvider,
  deleteModel,
  findDefaultEmbeddingModel,
  findModel,
  insertModel,
  listModels,
  lockModel,
  readModelDefaults,
  updateModel,
  writeModelDefaults,
  type ModelDefaultsRow,
} from './models.repository.js';

/** A server or tool target of a grant. */
export type McpGrantTarget = Exclude<GrantTargetBody, { kind: 'model' }>;

/** Whether the server and tool of a target are in the MCP registry; given by the controller (ADR-0014). */
export type McpTargetCheck = (
  target: McpGrantTarget,
) => Promise<'server_unknown' | 'tool_unknown' | null>;

/** The readiness of the named providers; given by the controller from `Agents.providers.readiness`. */
export type ProviderReadinessOf = (
  names: readonly string[],
) => Promise<ReadonlyMap<string, ProviderReadiness>>;

type ChatModel = Extract<CatalogModel, { purpose: 'chat' }>;

const MODEL_DEFAULTS_OBJECT_TYPE = 'model_defaults';

type AuditObjectType = 'model' | 'grant' | typeof MODEL_DEFAULTS_OBJECT_TYPE;

/** The two default models as the audit and the log show them, «было» and «стало». */
type DefaultModels = Pick<ModelDefaultsRow, 'chatModel' | 'embeddingModel'>;

function defaultModelsOf(row: ModelDefaultsRow): DefaultModels {
  return { chatModel: row.chatModel, embeddingModel: row.embeddingModel };
}

function toModelDefaults(row: ModelDefaultsRow): ModelDefaults {
  return {
    ...defaultModelsOf(row),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    updatedBy: row.updatedBy,
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
    target: grant.target,
    modelPurpose: null,
    quotaUsd,
  };
}

async function grantOr404(executor: Executor, id: string): Promise<Grant> {
  const grant = isUuid(id) ? await findGrant(executor, id) : undefined;
  if (grant === undefined) throw accessError('GRANT_NOT_FOUND');
  return grant;
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
  private readonly db: Database;

  constructor(
    @Inject(RUNTIME_DATABASE) database: DatabaseConnection,
    @Inject(RUNTIME) private readonly runtime: Runtime,
    @Inject(RUNTIME_CLOCK) private readonly clock: Clock,
    private readonly identity: IdentityDirectory,
    private readonly auditLog: AuditLog,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {
    this.db = database.db;
  }

  /** The employee's tool rights; `owner_disabled` for a disabled or unknown employee. */
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
    const grants = await this.grantRowsOf(ownerId);
    const access = effectiveAccess(grants);
    // Not a verdict on any tool: the owner is active and this many grants were read; pairs are refused one by one.
    this.logger.info('tool access checked', {
      ownerId,
      ownerActive: true,
      grantsRead: grants.length,
      durationMs: Date.now() - startedAt,
    });
    return {
      kind: 'allowed',
      allows: (server, tool) => {
        const allowed = access.tool(server, tool);
        if (!allowed) {
          this.logger.info('tool pair refused', { ownerId, server, tool });
        }
        return allowed;
      },
    };
  }

  /** Whether the employee may call the model now, with its price (design-access.md, «Как AccessGate решает»). */
  async model(ownerId: string, model: string): Promise<ModelVerdict> {
    const startedAt = Date.now();
    const month = monthOf(this.clock.now());
    const [active, catalogued, access] = await Promise.all([
      this.identity.isActive(ownerId),
      findModel(this.db, model),
      this.accessOf(ownerId),
    ]);
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
    const { chatModel } = await readModelDefaults(this.db);
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
      findDefaultEmbeddingModel(this.db),
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
      ownerId: ownerId ?? PLATFORM_OWNER_ID,
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
            this.runtime.ledger.monthSpendByModel(ownerId, month),
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

  listModels(): Promise<CatalogModel[]> {
    return listModels(this.db);
  }

  /** How many catalogue models the provider has; a provider with models is not deleted (AC-01.3). */
  countModelsOfProvider(name: string): Promise<number> {
    return countByProvider(this.db, name);
  }

  /**
   * `providerKind` — the kind of the provider the id names, `null` when none is registered; the
   * controller reads it from `Agents.providers.kindOf`. 422 MODEL_PROVIDER_INVALID (AC-05.2, AC-05.3),
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
    const created = await this.db.transaction(async (tx) => {
      const model = await insertModel(tx, body);
      if (model === undefined) throw accessError('MODEL_ID_TAKEN');
      await this.audit(tx, actorId, 'model', model.id, null, model);
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
    const updated = await this.db.transaction(async (tx) => {
      const before = await lockModel(tx, id);
      if (before === undefined) throw accessError('MODEL_NOT_FOUND');
      const rule = modelUpdateRule(before, body);
      if (rule.kind === 'invalid')
        throw foreignFieldsError(before.purpose, rule.foreignFields);
      const after = await updateModel(tx, rule.after);
      await this.audit(tx, actorId, 'model', id, before, after);
      return after;
    });
    this.logChange(actorId, 'model', id, 'update');
    return updated;
  }

  /** The model's grants go by cascade, a default on it is cleared (DC-6). 404 MODEL_NOT_FOUND. */
  async deleteModel(actorId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const deleted = await deleteModel(tx, id);
      if (deleted === undefined) throw accessError('MODEL_NOT_FOUND');
      await this.audit(tx, actorId, 'model', id, deleted, null);
    });
    this.logChange(actorId, 'model', id, 'delete');
  }

  // ---------- Admin: default models ----------

  /** GET /api/admin/model-defaults. */
  async modelDefaults(): Promise<ModelDefaults> {
    return toModelDefaults(await readModelDefaults(this.db));
  }

  /**
   * PUT /api/admin/model-defaults: each value is a catalogue model of its purpose or `null` (AC-06.2,
   * Invariant 3), checked and written in one transaction with its `admin_change` record
   * (settings-row.md). 422 MODEL_DEFAULT_INVALID with the rejected id.
   */
  async setModelDefaults(
    actorId: string,
    body: UpdateModelDefaultsBody,
  ): Promise<ModelDefaults> {
    const startedAt = Date.now();
    const { before, after } = await this.db.transaction(async (tx) => {
      const rule = modelDefaultsRule(await this.defaultChoicesOf(tx, body));
      if (rule.kind === 'invalid') {
        this.logger.info('model defaults update refused', {
          actorId,
          objectType: MODEL_DEFAULTS_OBJECT_TYPE,
          requested: body,
          outcome: 'refused',
          reason: rule.reason,
          model: rule.model,
        });
        throw modelDefaultError(rule.reason, rule.model);
      }
      const previous = await readModelDefaults(tx);
      const updated = await writeModelDefaults(tx, body, actorId);
      await this.audit(
        tx,
        actorId,
        MODEL_DEFAULTS_OBJECT_TYPE,
        undefined,
        defaultModelsOf(previous),
        defaultModelsOf(updated),
      );
      return { before: previous, after: updated };
    });
    this.logger.info('model defaults updated', {
      actorId,
      objectType: MODEL_DEFAULTS_OBJECT_TYPE,
      before: defaultModelsOf(before),
      after: defaultModelsOf(after),
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
    return toModelDefaults(after);
  }

  /** The values of the body that name a model, with their catalogue rows read in the write's transaction. */
  private defaultChoicesOf(
    tx: RuntimeTx,
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
              findModel(tx, model).then((catalogued) => ({
                purpose,
                model,
                catalogued,
              })),
            ],
      ),
    );
  }

  // ---------- Admin: grants ----------

  /** The grants of a role or an employee by creation time. 404 ROLE_NOT_FOUND, USER_NOT_FOUND. */
  async listGrants(holder: GrantHolderQuery): Promise<Grant[]> {
    await this.holderOr404(holder);
    return listGrants(this.db, holder);
  }

  /**
   * Checks the grant fully before writing, so a refusal saves nothing (DC-2): 422 GRANT_INVALID (an
   * embedding model among its reasons, DC-5), 404 ROLE_NOT_FOUND/USER_NOT_FOUND, 422
   * GRANT_TARGET_UNKNOWN, 409 GRANT_EXISTS.
   */
  async createGrant(
    actorId: string,
    body: CreateGrantBody,
    mcpTargetCheck: McpTargetCheck,
  ): Promise<Grant> {
    const targetModel =
      body.target.kind === 'model'
        ? await findModel(this.db, body.target.model)
        : undefined;
    const rules = grantRules({
      ...body,
      modelPurpose: targetModel?.purpose ?? null,
    });
    if (rules.kind === 'invalid')
      throw accessError('GRANT_INVALID', rules.reason);
    await this.holderOr404(holderOfBody(body));
    const unknown =
      body.target.kind === 'model'
        ? targetModel === undefined
          ? 'model_unknown'
          : null
        : await mcpTargetCheck(body.target);
    if (unknown !== null) throw accessError('GRANT_TARGET_UNKNOWN', unknown);
    const created = await this.db.transaction(async (tx) => {
      const id = await insertGrant(tx, body);
      if (id === undefined) throw accessError('GRANT_EXISTS');
      const grant = await grantOr404(tx, id);
      await this.audit(tx, actorId, 'grant', id, null, grant);
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
    const updated = await this.db.transaction(async (tx) => {
      const before = await grantOr404(tx, id);
      const rules = grantRules(ruleInputOf(before, quotaUsd));
      if (rules.kind === 'invalid')
        throw accessError('GRANT_INVALID', rules.reason);
      await updateGrantQuota(tx, id, quotaUsd);
      const after = await grantOr404(tx, id);
      await this.audit(tx, actorId, 'grant', id, before, after);
      return after;
    });
    this.logChange(actorId, 'grant', id, 'update');
    return updated;
  }

  /** 404 GRANT_NOT_FOUND. */
  async deleteGrant(actorId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const before = await grantOr404(tx, id);
      await deleteGrant(tx, id);
      await this.audit(tx, actorId, 'grant', id, before, null);
    });
    this.logChange(actorId, 'grant', id, 'delete');
  }

  /**
   * Deletes the grants on an MCP server that is being removed from the registry: a grant names its
   * server as text without FK, so a grant left behind would attach to a new server of the same name.
   * The removal of the server is the audited change; the grants go with it, as a cascade does.
   */
  async removeServerGrants(actorId: string, server: string): Promise<void> {
    const grants = await deleteServerGrants(this.db, server);
    this.logger.info('grants of a removed mcp server deleted', { actorId, server, grants });
  }

  /**
   * `admin_change` with «было» and «стало» in the transaction of the write it records (design-access.md,
   * Contract «Операции администратора»), as identity does: a write without its record is rolled back.
   */
  private audit(
    tx: RuntimeTx,
    actorId: string,
    objectType: AuditObjectType,
    objectId: string | undefined,
    before: CatalogModel | Grant | DefaultModels | null,
    after: CatalogModel | Grant | DefaultModels | null,
  ): Promise<void> {
    return this.auditLog.record(tx, {
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
    return effectiveAccess(await this.grantRowsOf(ownerId));
  }

  /** The employee's rights and the catalogue chat models they allow, in catalogue order (DC-5). */
  private async allowedOf(
    ownerId: string,
  ): Promise<{ access: EffectiveAccess; catalogue: ChatModel[] }> {
    const [access, models] = await Promise.all([
      this.accessOf(ownerId),
      listModels(this.db),
    ]);
    return {
      access,
      catalogue: allowedCatalogue(access, models.filter(isChatModel)),
    };
  }

  /** The grants of the employee's roles and his own. */
  private async grantRowsOf(ownerId: string): Promise<GrantRow[]> {
    if (!isUuid(ownerId)) return [];
    const roleIds = await this.identity.rolesOf(ownerId);
    return grantsOf(this.db, roleIds, ownerId);
  }

  /** Spend on one model this month; read at each check, no cache (KD-1). */
  private async spentOn(
    ownerId: string,
    model: string,
    month: string,
  ): Promise<number> {
    const spend = await this.runtime.ledger.monthSpendByModel(ownerId, month);
    return spend.get(model) ?? 0;
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
