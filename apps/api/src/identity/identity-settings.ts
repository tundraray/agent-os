import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import type {
  SignInSettings,
  UpdateSignInSettingsBody,
} from '@agent-os/contracts';
import type { Database, DatabaseConnection } from '@agent-os/db';
import { AuditLog } from '../audit/audit-log.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens.js';
import { identityError } from './identity.errors.js';
import { publicUrlOf, type AddressedRequest } from './public-url.js';
import {
  readSettings,
  savePublicUrlIfUnset,
  writeSettings,
  type SettingsChange,
  type SettingsRow,
} from './settings.repository.js';

/** The audit object of the sign-in settings (FR-11). */
const SETTINGS_OBJECT_TYPE = 'sign_in_settings';

function toSignInSettings(row: SettingsRow): SignInSettings {
  return {
    publicUrl: row.publicUrl,
    idleMinutes: row.idleMinutes,
    absoluteMinutes: row.absoluteMinutes,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

const auditState = ({
  publicUrl,
  idleMinutes,
  absoluteMinutes,
}: SettingsChange): SettingsChange => ({
  publicUrl,
  idleMinutes,
  absoluteMinutes,
});

/**
 * The sign-in settings of the part in the single `identity_settings` row (KD-2): session limits,
 * which the session check reads on every request, and the public address for return URLs.
 */
@Injectable()
export class IdentitySettings {
  private readonly db: Database;

  constructor(
    @Inject(RUNTIME_DATABASE) database: DatabaseConnection,
    private readonly auditLog: AuditLog,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {
    this.db = database.db;
  }

  /** The saved public address, or null: the sign-in reads only this, never the request's address. */
  async savedPublicUrl(): Promise<string | null> {
    return (await readSettings(this.db)).publicUrl;
  }

  /**
   * The public address for an administrator's provider view or change (AC-03.4): the saved one,
   * otherwise the address this administrator reached the API at, which is saved then (a concurrent
   * first save keeps whichever came first). 409 PUBLIC_URL_REQUIRED when that address is no valid
   * public address (e.g. `http` behind a TLS proxy): the administrator sets it in the sign-in settings.
   */
  async publicUrlFor(request: AddressedRequest): Promise<string> {
    const saved = await this.savedPublicUrl();
    if (saved !== null) return saved;
    const derived = publicUrlOf(request);
    if (derived === undefined) {
      this.logger.info('public url not derivable from request', {
        protocol: request.protocol,
        host: request.headers.host ?? null,
        outcome: 'rejected',
        reason: 'public_url_required',
      });
      throw identityError('PUBLIC_URL_REQUIRED');
    }
    if (!(await savePublicUrlIfUnset(this.db, derived)))
      return (await this.savedPublicUrl()) ?? derived;
    this.logger.info('public url saved from request', {
      publicUrl: derived,
      outcome: 'ok',
    });
    return derived;
  }

  /** GET /api/admin/settings/sign-in (FR-26). */
  async get(): Promise<SignInSettings> {
    return toSignInSettings(await readSettings(this.db));
  }

  /**
   * PUT /api/admin/settings/sign-in: the body is already checked against the bounds; new limits act
   * from the next request of every session (AC-07.5). Writes `admin_change` on `sign_in_settings`.
   */
  async update(
    actorId: string,
    body: UpdateSignInSettingsBody,
  ): Promise<SignInSettings> {
    const startedAt = Date.now();
    const { before, after } = await this.db.transaction(async (tx) => {
      const previous = await readSettings(tx);
      const updated = await writeSettings(tx, auditState(body), actorId);
      await this.auditLog.record(tx, {
        kind: 'admin_change',
        actor: actorId,
        objectType: SETTINGS_OBJECT_TYPE,
        before: auditState(previous),
        after: auditState(updated),
        outcome: 'ok',
      });
      return { before: previous, after: updated };
    });
    this.logger.info('sign-in settings updated', {
      actorId,
      objectType: SETTINGS_OBJECT_TYPE,
      before: auditState(before),
      after: auditState(after),
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
    return toSignInSettings(after);
  }
}
