import { Inject, Injectable } from '@nestjs/common';
import type { AccessGate, ModelVerdict, ToolAccess } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import type {
  CatalogModel,
  CreateCatalogModelBody,
  CreateGrantBody,
  Grant,
  GrantTargetBody,
  MyModels,
  UpdateCatalogModelBody,
} from '@agent-os/contracts';
import type { Database, DatabaseConnection } from '@agent-os/db';
import {
  monthOf,
  type Clock,
  type Runtime,
  type RuntimeTx,
} from '@agent-os/runtime';
import { AuditLog } from '../audit/audit-log.js';
import type { Executor } from '../common/executor.js';
import { isUuid } from '../common/is-uuid.js';
import { IdentityDirectory } from '../identity/identity-directory.js';
import { identityError } from '../identity/identity.errors.js';
import { roleSummaries } from '../identity/roles.repository.js';
import { findUserById } from '../identity/users.repository.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import {
  RUNTIME,
  RUNTIME_CLOCK,
  RUNTIME_DATABASE,
} from '../runtime/runtime.tokens.js';
import { accessError } from './access.errors.js';
import { effectiveAccess, type EffectiveAccess } from './effective-access.js';
import { grantRules, type GrantRuleInput } from './grant-rules.js';
import {
  deleteGrant,
  findGrant,
  grantsOf,
  insertGrant,
  listGrants,
  updateGrantQuota,
  type GrantHolderQuery,
} from './grants.repository.js';
import { modelVerdict, quotaExhausted } from './model-verdict.js';
import {
  deleteModel,
  findModel,
  insertModel,
  listModels,
  updateModel,
} from './models.repository.js';

/** A server or tool target of a grant. */
export type McpGrantTarget = Exclude<GrantTargetBody, { kind: 'model' }>;

/** Whether the server and tool of a target are in the MCP registry; given by the controller (ADR-0014). */
export type McpTargetCheck = (
  target: McpGrantTarget,
) => Promise<'server_unknown' | 'tool_unknown' | null>;

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
  return { ...holder, effect: grant.effect, target: grant.target, quotaUsd };
}

async function grantOr404(executor: Executor, id: string): Promise<Grant> {
  const grant = isUuid(id) ? await findGrant(executor, id) : undefined;
  if (grant === undefined) throw accessError('GRANT_NOT_FOUND');
  return grant;
}

/**
 * Rights, quotas and the model catalogue (design-access.md, C3 api, KD-1..KD-3). Answers the agents'
 * checks (`tools`, `model`), "My access" and the admin operations. Every answer reads the employee
 * (`isActive`), his roles with his rights in one query and — only for a model with a quota — the
 * month's spend, without a cache; the rules are `effectiveAccess` and `modelVerdict` alone. An admin
 * write and its `admin_change` record are one transaction.
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
        verdict: 'owner_disabled',
        durationMs: Date.now() - startedAt,
      });
      return { kind: 'owner_disabled' };
    }
    const access = await this.accessOf(ownerId);
    this.logger.info('tool access checked', {
      ownerId,
      verdict: 'allowed',
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

  /** "My access": the models allowed to the employee now, by name, with the month's spend (DC-9). */
  async myModels(ownerId: string): Promise<MyModels> {
    const startedAt = Date.now();
    const month = monthOf(this.clock.now());
    const access = await this.accessOf(ownerId);
    const allowed = new Set(access.allowedModels());
    const catalogue = (await listModels(this.db)).filter((model) =>
      allowed.has(model.id),
    );
    const spend =
      catalogue.length === 0
        ? new Map<string, number>()
        : await this.runtime.ledger.monthSpendByModel(ownerId, month);
    const models = catalogue.map((model) => {
      const modelAccess = access.model(model.id);
      const quotaUsd = modelAccess.allowed ? modelAccess.quotaUsd : null;
      const spentUsd = spend.get(model.id) ?? 0;
      return {
        model: model.id,
        name: model.name,
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
      durationMs: Date.now() - startedAt,
    });
    return { month, models };
  }

  // ---------- Admin: catalogue ----------

  listModels(): Promise<CatalogModel[]> {
    return listModels(this.db);
  }

  /** 409 MODEL_ID_TAKEN. */
  async createModel(
    actorId: string,
    body: CreateCatalogModelBody,
  ): Promise<CatalogModel> {
    const created = await this.db.transaction(async (tx) => {
      const model = await insertModel(tx, body);
      if (model === undefined) throw accessError('MODEL_ID_TAKEN');
      await this.audit(tx, actorId, 'model', model.id, null, model);
      return model;
    });
    this.logChange(actorId, 'model', created.id, 'create');
    return created;
  }

  /** 404 MODEL_NOT_FOUND. */
  async updateModel(
    actorId: string,
    id: string,
    body: UpdateCatalogModelBody,
  ): Promise<CatalogModel> {
    const updated = await this.db.transaction(async (tx) => {
      const change = await updateModel(tx, id, body);
      if (change === undefined) throw accessError('MODEL_NOT_FOUND');
      await this.audit(tx, actorId, 'model', id, change.before, change.after);
      return change.after;
    });
    this.logChange(actorId, 'model', id, 'update');
    return updated;
  }

  /** The model's grants go by cascade. 404 MODEL_NOT_FOUND. */
  async deleteModel(actorId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const deleted = await deleteModel(tx, id);
      if (deleted === undefined) throw accessError('MODEL_NOT_FOUND');
      await this.audit(tx, actorId, 'model', id, deleted, null);
    });
    this.logChange(actorId, 'model', id, 'delete');
  }

  // ---------- Admin: grants ----------

  /** The grants of a role or an employee by creation time. 404 ROLE_NOT_FOUND, USER_NOT_FOUND. */
  async listGrants(holder: GrantHolderQuery): Promise<Grant[]> {
    await this.holderOr404(holder);
    return listGrants(this.db, holder);
  }

  /**
   * Checks the grant fully before writing, so a refusal saves nothing (DC-2): 422 GRANT_INVALID, 404
   * ROLE_NOT_FOUND/USER_NOT_FOUND, 422 GRANT_TARGET_UNKNOWN, 409 GRANT_EXISTS.
   */
  async createGrant(
    actorId: string,
    body: CreateGrantBody,
    mcpTargetCheck: McpTargetCheck,
  ): Promise<Grant> {
    const rules = grantRules(body);
    if (rules.kind === 'invalid')
      throw accessError('GRANT_INVALID', rules.reason);
    await this.holderOr404(holderOfBody(body));
    const unknown =
      body.target.kind === 'model'
        ? (await findModel(this.db, body.target.model)) === undefined
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
   * `admin_change` with «было» and «стало» in the transaction of the write it records (design-access.md,
   * Contract «Операции администратора»), as identity does: a write without its record is rolled back.
   */
  private audit(
    tx: RuntimeTx,
    actorId: string,
    objectType: 'model' | 'grant',
    objectId: string,
    before: CatalogModel | Grant | null,
    after: CatalogModel | Grant | null,
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
    if (!isUuid(ownerId)) return effectiveAccess([]);
    const roleIds = await this.identity.rolesOf(ownerId);
    return effectiveAccess(await grantsOf(this.db, roleIds, ownerId));
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
      const [role] = isUuid(holder.roleId)
        ? await roleSummaries(this.db, holder.roleId)
        : [];
      if (role === undefined) throw identityError('ROLE_NOT_FOUND');
      return;
    }
    const user = isUuid(holder.userId)
      ? await findUserById(this.db, holder.userId)
      : undefined;
    if (user === undefined) throw identityError('USER_NOT_FOUND');
  }
}
