import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import type { AdminUserSummary, CreateLocalUserBody } from '@agent-os/contracts';
import { UserStatusSchema } from '@agent-os/contracts';
import type { Database, DatabaseConnection } from '@agent-os/db';
import { AuditLog } from '../audit/audit-log.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens.js';
import { identityError } from './identity.errors.js';
import { normalizeIdentifier } from './identity-input.js';
import { checkNewPassword, hashPassword } from './password.js';
import { insertLocalUser, takenField, type UserRow } from './users.repository.js';

/** Audit actor of a change no employee made (operator command, rejected sign-in of an unknown login). */
export const SYSTEM_ACTOR = 'system';

/**
 * Stands in for the password in `before`/`after` of an audit entry: the field name makes `AuditLog`
 * write `password_changed`, and the value never is the password.
 */
export const PASSWORD_SET = 'set';

/** The admin view of an employee; roles are passed by the caller. */
function toAdminUserSummary(
  user: UserRow,
  roles: AdminUserSummary['roles'],
): AdminUserSummary {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    login: user.login,
    status: UserStatusSchema.parse(user.status),
    lastSignInAt: user.lastSignInAt?.toISOString() ?? null,
    roles,
  };
}

/** Employees managed by an administrator (FR-33). */
@Injectable()
export class UsersService {
  private readonly db: Database;

  constructor(
    @Inject(RUNTIME_DATABASE) database: DatabaseConnection,
    private readonly auditLog: AuditLog,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {
    this.db = database.db;
  }

  /**
   * A local account without roles (AC-33.1). 400 `weak_password`, 409 LOGIN_TAKEN or EMAIL_TAKEN;
   * the audit `admin_change` carries `password_changed` instead of the password.
   */
  async createLocal(actorId: string, body: CreateLocalUserBody): Promise<AdminUserSummary> {
    const startedAt = Date.now();
    checkNewPassword(body.password);
    const passwordHash = await hashPassword(body.password);
    const user = await this.db
      .transaction(async (tx) => {
        const created = await insertLocalUser(tx, {
          login: normalizeIdentifier(body.login),
          email: normalizeIdentifier(body.email),
          name: body.name,
          passwordHash,
        });
        await this.auditLog.record(tx, {
          kind: 'admin_change',
          actor: actorId,
          objectType: 'user',
          objectId: created.id,
          before: null,
          after: {
            login: created.login,
            email: created.email,
            name: created.name,
            status: created.status,
            password: PASSWORD_SET,
          },
          outcome: 'ok',
        });
        return created;
      })
      .catch((error: unknown) => {
        const taken = takenField(error);
        if (taken === 'login') throw identityError('LOGIN_TAKEN');
        if (taken === 'email') throw identityError('EMAIL_TAKEN');
        throw error;
      });
    this.logger.info('local account created', {
      actorId,
      userId: user.id,
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
    return toAdminUserSummary(user, []);
  }
}
