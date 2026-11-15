import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import {
  ProviderTypeSchema,
  type CreateProviderBody,
  type ProviderList,
  type ProviderType,
  type ProviderView,
  type UpdateProviderBody,
} from '@agent-os/contracts';
import {
  identityProviders,
  type Database,
  type DatabaseConnection,
} from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuditLog } from '../audit/audit-log.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens.js';
import { identityError } from './identity.errors.js';
import { IdentitySettings } from './identity-settings.js';
import { redirectUriOf } from './oidc-sign-in.js';
import {
  isComplete,
  parseProviderType,
  resolveProviderOptions,
  toOptionsView,
  type ProviderOptions,
  type ProviderOptionsInput,
} from './provider-options.js';
import type { AddressedRequest } from './public-url.js';
import type { Executor } from './users.repository.js';
import { isUuid } from './users.service.js';

/** Scopes the sign-in asks the provider for (ProviderView.providerData). */
const PROVIDER_SCOPES = 'openid email profile';

/** `identity_providers.options` as stored; the table accepts any JSON, so it is read through a schema. */
const StoredOptionsSchema = z.object({
  issuer: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

type ProviderRow = typeof identityProviders.$inferSelect;

/** A provider row with its type and settings read. */
interface Provider {
  id: string;
  type: ProviderType;
  name: string;
  enabled: boolean;
  options: ProviderOptions;
}

function toProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    type: ProviderTypeSchema.parse(row.type),
    name: row.name,
    enabled: row.enabled,
    options: StoredOptionsSchema.parse(row.options),
  };
}

// ---------- Repository over `identity_providers` (repository-over-transaction) ----------

/** The providers in creation order (`created_at`, then `id`). */
function listProviders(executor: Executor): Promise<ProviderList> {
  return executor
    .select({
      id: identityProviders.id,
      type: identityProviders.type,
      name: identityProviders.name,
      enabled: identityProviders.enabled,
    })
    .from(identityProviders)
    .orderBy(asc(identityProviders.createdAt), asc(identityProviders.id))
    .then((rows) =>
      rows.map((row) => ({ ...row, type: ProviderTypeSchema.parse(row.type) })),
    );
}

async function findProvider(
  executor: Executor,
  id: string,
): Promise<Provider | undefined> {
  const [row] = await executor
    .select()
    .from(identityProviders)
    .where(eq(identityProviders.id, id));
  return row === undefined ? undefined : toProvider(row);
}

async function insertProvider(
  executor: Executor,
  values: Pick<Provider, 'type' | 'name' | 'options'>,
): Promise<Provider> {
  const [row] = await executor
    .insert(identityProviders)
    .values({ ...values, enabled: false })
    .returning();
  if (row === undefined)
    throw new Error('identity_providers insert returned no row');
  return toProvider(row);
}

/** Writes the change and raises `version`, so the sign-in rebuilds its client config (AC-03.3). */
async function updateProvider(
  executor: Executor,
  id: string,
  values: Pick<Provider, 'name' | 'enabled' | 'options'>,
): Promise<void> {
  await executor
    .update(identityProviders)
    .set({ ...values, version: sql`${identityProviders.version} + 1` })
    .where(eq(identityProviders.id, id));
}

// ---------- Service ----------

/**
 * The provider fields an audit entry keeps. The secret appears only when the admin sent a new one,
 * under its own name, so `AuditLog` writes `secret_changed` (AC-11.2).
 */
function auditState(
  provider: Omit<Provider, 'id'>,
  input?: ProviderOptionsInput,
) {
  return {
    type: provider.type,
    name: provider.name,
    enabled: provider.enabled,
    issuer: provider.options.issuer ?? null,
    clientId: provider.options.clientId ?? null,
    ...(input?.clientSecret === undefined
      ? {}
      : { clientSecret: input.clientSecret }),
  };
}

/** The log fields of a provider change: never a settings value that could be the secret. */
function logState(provider: Omit<Provider, 'id'>) {
  return {
    name: provider.name,
    enabled: provider.enabled,
    complete: isComplete(provider.type, provider.options),
  };
}

/**
 * Sign-in providers under an administrator (KD-1, DC-6, AC-03.1, AC-03.5). A provider is created
 * disabled; the settings of its type are checked before anything is stored; the secret never leaves
 * the server in an answer, the log or the audit.
 */
@Injectable()
export class ProvidersService {
  private readonly db: Database;

  constructor(
    @Inject(RUNTIME_DATABASE) database: DatabaseConnection,
    private readonly auditLog: AuditLog,
    private readonly settings: IdentitySettings,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {
    this.db = database.db;
  }

  /** The providers in creation order. */
  list(): Promise<ProviderList> {
    return listProviders(this.db);
  }

  /** One provider with the data for its registration at the provider. 404 PROVIDER_NOT_FOUND. */
  async detail(
    providerId: string,
    request: AddressedRequest,
  ): Promise<ProviderView> {
    return this.toView(await this.findOr404(providerId), request);
  }

  /** A disabled provider. 400 `unknown_type`, 422 PROVIDER_CHECK_FAILED. */
  async create(
    actorId: string,
    body: CreateProviderBody,
    request: AddressedRequest,
  ): Promise<ProviderView> {
    const startedAt = Date.now();
    const type = parseProviderType(body.type);
    const options = await resolveProviderOptions({
      type,
      stored: {},
      input: body.options,
      fetch: globalThis.fetch,
    });
    const provider = await this.db.transaction(async (tx) => {
      const created = await insertProvider(tx, {
        type,
        name: body.name,
        options,
      });
      await this.recordChange(
        tx,
        actorId,
        created.id,
        null,
        auditState(created, body.options),
      );
      return created;
    });
    this.logger.info('provider created', {
      actorId,
      objectType: 'provider',
      providerId: provider.id,
      type,
      ...logState(provider),
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
    return this.toView(provider, request);
  }

  /**
   * Changes the name, the enabled mark and the settings; the type never changes and the secret is
   * replaced only when sent. 404 PROVIDER_NOT_FOUND, 409 PROVIDER_INCOMPLETE, 422 PROVIDER_CHECK_FAILED.
   */
  async update(
    actorId: string,
    providerId: string,
    body: UpdateProviderBody,
    request: AddressedRequest,
  ): Promise<ProviderView> {
    const startedAt = Date.now();
    const before = await this.findOr404(providerId);
    const after: Provider = {
      ...before,
      name: body.name ?? before.name,
      enabled: body.enabled ?? before.enabled,
      options: await resolveProviderOptions({
        type: before.type,
        stored: before.options,
        input: body.options,
        fetch: globalThis.fetch,
      }),
    };
    if (after.enabled && !isComplete(after.type, after.options)) {
      this.logger.info('provider enable refused', {
        actorId,
        objectType: 'provider',
        providerId,
        outcome: 'rejected',
        reason: 'incomplete',
      });
      throw identityError('PROVIDER_INCOMPLETE');
    }
    await this.db.transaction(async (tx) => {
      await updateProvider(tx, providerId, after);
      await this.recordChange(
        tx,
        actorId,
        providerId,
        auditState(before),
        auditState(after, body.options),
      );
    });
    this.logger.info('provider updated', {
      actorId,
      objectType: 'provider',
      providerId,
      before: logState(before),
      after: logState(after),
      secretReplaced: body.options?.clientSecret !== undefined,
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
    return this.toView(after, request);
  }

  private async toView(
    provider: Provider,
    request: AddressedRequest,
  ): Promise<ProviderView> {
    const publicUrl = await this.settings.publicUrl(request);
    return {
      id: provider.id,
      type: provider.type,
      name: provider.name,
      enabled: provider.enabled,
      complete: isComplete(provider.type, provider.options),
      options: toOptionsView(provider.type, provider.options),
      providerData: {
        redirectUri: redirectUriOf(publicUrl, provider.id),
        scopes: PROVIDER_SCOPES,
      },
    };
  }

  private recordChange(
    tx: RuntimeTx,
    actorId: string,
    providerId: string,
    before: ReturnType<typeof auditState> | null,
    after: ReturnType<typeof auditState>,
  ): Promise<void> {
    return this.auditLog.record(tx, {
      kind: 'admin_change',
      actor: actorId,
      objectType: 'provider',
      objectId: providerId,
      before,
      after,
      outcome: 'ok',
    });
  }

  /** A provider id that is not a UUID answers 404 like a missing one. */
  private async findOr404(providerId: string): Promise<Provider> {
    if (!isUuid(providerId)) throw identityError('PROVIDER_NOT_FOUND');
    const provider = await findProvider(this.db, providerId);
    if (provider === undefined) throw identityError('PROVIDER_NOT_FOUND');
    return provider;
  }
}
