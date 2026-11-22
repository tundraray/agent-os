import { Inject, Injectable } from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  ProviderTypeSchema,
  type CreateProviderBody,
  type ProviderButtonList,
  type ProviderList,
  type ProviderView,
  type UpdateProviderBody,
} from '@agent-os/contracts';
import {
  DATABASE_CONNECTION,
  type Database,
  type DatabaseConnection,
  IdentityProvidersRepository,
  type Transaction,
} from '@agent-os/db';
import { AuditLog } from '../audit/audit-log';
import { isUuid } from '../common/is-uuid';
import { identityError } from './identity.errors';
import { IdentitySettings } from './identity-settings';
import { redirectUriOf, SIGN_IN_SCOPES } from './oidc-sign-in';
import {
  isComplete,
  parseProviderType,
  resolveProviderOptions,
  toOptionsView,
  toProvider,
  type Provider,
  type ProviderOptionsInput,
} from './provider-options';

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
    @Inject(DATABASE_CONNECTION) database: DatabaseConnection,
    private readonly providers: IdentityProvidersRepository,
    private readonly auditLog: AuditLog,
    private readonly settings: IdentitySettings,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.db = database.db;
  }

  /** The providers in creation order. */
  async list(): Promise<ProviderList> {
    const rows = await this.providers.list(this.db);
    return rows.map((row) => ({
      ...row,
      type: ProviderTypeSchema.parse(row.type),
    }));
  }

  /** The enabled providers in creation order: the buttons of the sign-in page. */
  async buttons(): Promise<ProviderButtonList> {
    const rows = await this.providers.listEnabled(this.db);
    return rows.map((row) => ({
      ...row,
      type: ProviderTypeSchema.parse(row.type),
    }));
  }

  /** One provider with the data for its registration at the provider. 404 PROVIDER_NOT_FOUND. */
  async detail(providerId: string): Promise<ProviderView> {
    const provider = await this.findOr404(providerId);
    return this.toView(provider, await this.settings.publicUrlFor());
  }

  /** A disabled provider. 400 `unknown_type`, 409 PUBLIC_URL_REQUIRED, 422 PROVIDER_CHECK_FAILED. */
  async create(
    actorId: string,
    body: CreateProviderBody,
  ): Promise<ProviderView> {
    const startedAt = Date.now();
    const type = parseProviderType(body.type);
    const options = await resolveProviderOptions({
      type,
      stored: {},
      input: body.options,
      fetch: globalThis.fetch,
    });
    const publicUrl = await this.settings.publicUrlFor();
    const provider = await this.db.transaction(async (tx) => {
      const created = toProvider(
        await this.providers.insert(tx, { type, name: body.name, options }),
      );
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
    return this.toView(provider, publicUrl);
  }

  /**
   * Changes the name, the enabled mark and the settings; the type never changes and the secret is
   * replaced only when sent. 404 PROVIDER_NOT_FOUND, 409 PROVIDER_INCOMPLETE or PUBLIC_URL_REQUIRED,
   * 422 PROVIDER_CHECK_FAILED.
   */
  async update(
    actorId: string,
    providerId: string,
    body: UpdateProviderBody,
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
    const publicUrl = await this.settings.publicUrlFor();
    await this.db.transaction(async (tx) => {
      await this.providers.update(tx, providerId, after);
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
    return this.toView(after, publicUrl);
  }

  private toView(provider: Provider, publicUrl: string): ProviderView {
    return {
      id: provider.id,
      type: provider.type,
      name: provider.name,
      enabled: provider.enabled,
      complete: isComplete(provider.type, provider.options),
      options: toOptionsView(provider.type, provider.options),
      providerData: {
        redirectUri: redirectUriOf(publicUrl, provider.id),
        scopes: SIGN_IN_SCOPES,
      },
    };
  }

  private recordChange(
    tx: Transaction,
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
    const row = await this.providers.find(this.db, providerId);
    if (row === undefined) throw identityError('PROVIDER_NOT_FOUND');
    return toProvider(row);
  }
}
