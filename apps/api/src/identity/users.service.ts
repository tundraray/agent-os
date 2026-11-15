import {
  BadRequestException,
  type HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import {
  ADMIN_USER_PAGE_SIZE,
  IdentityValidationReason,
  UserStatusSchema,
  type AdminUserDetail,
  type AdminUserListQuery,
  type AdminUserPage,
  type AdminUserSummary,
  type CreateLocalUserBody,
  type PasswordChangeBody,
  type UserStatus,
} from '@agent-os/contracts';
import type { Database, DatabaseConnection } from '@agent-os/db';
import { z } from 'zod';
import { AuditLog } from '../audit/audit-log.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens.js';
import { identityError, validationFailed } from './identity.errors.js';
import { normalizeIdentifier } from './identity-input.js';
import { checkNewPassword, hashPassword, verifyPassword } from './password.js';
import { SessionStore } from './session.store.js';
import {
  findUserById,
  insertLocalUser,
  pageUsers,
  rolesOfUsers,
  setPasswordHash,
  setPersonalAdmin,
  setUserStatus,
  takenField,
  type MemberRole,
  type UserListPosition,
  type UserRow,
} from './users.repository.js';

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
  roles: MemberRole[],
): AdminUserSummary {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    login: user.login,
    status: UserStatusSchema.parse(user.status),
    lastSignInAt: user.lastSignInAt?.toISOString() ?? null,
    roles: roles.map(({ id, name }) => ({ id, name })),
  };
}

const IdSchema = z.uuid();

/**
 * The one check of an employee or role id from outside: anything that is not a UUID can name no row,
 * so callers treat it as missing instead of letting Postgres fail with 22P02.
 */
export function isUuid(id: string): boolean {
  return IdSchema.safeParse(id).success;
}

/** An employee id from a route that is not a UUID answers 404 USER_NOT_FOUND like a missing one. */
export function checkUserId(userId: string): void {
  if (!isUuid(userId)) throw identityError('USER_NOT_FOUND');
}

/** Opaque list cursor: base64url of `{ n: name, i: id }` of the last employee of the page. */
const UserCursorSchema = z.strictObject({ n: z.string(), i: z.uuid() });

function encodeUserCursor(user: UserListPosition): string {
  return Buffer.from(JSON.stringify({ n: user.name, i: user.id })).toString(
    'base64url',
  );
}

/** A cursor of `encodeUserCursor`; anything else is 400 VALIDATION_FAILED. */
function decodeUserCursor(cursor: string): UserListPosition {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    json = undefined;
  }
  const parsed = UserCursorSchema.safeParse(json);
  if (!parsed.success) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      errorCode: 'VALIDATION_FAILED',
      message: ['cursor: Invalid cursor'],
    });
  }
  return { name: parsed.data.n, id: parsed.data.i };
}

/** Employees managed by an administrator (FR-33) and the employee's own password (AC-33.3). */
@Injectable()
export class UsersService {
  private readonly db: Database;

  constructor(
    @Inject(RUNTIME_DATABASE) database: DatabaseConnection,
    private readonly auditLog: AuditLog,
    private readonly sessions: SessionStore,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {
    this.db = database.db;
  }

  /** A page of employees by name, then id; the search matches name, email and login ignoring case. */
  async list(query: AdminUserListQuery): Promise<AdminUserPage> {
    const after =
      query.cursor === undefined ? undefined : decodeUserCursor(query.cursor);
    const rows = await pageUsers(this.db, {
      search: query.query,
      after,
      limit: ADMIN_USER_PAGE_SIZE + 1,
    });
    const page = rows.slice(0, ADMIN_USER_PAGE_SIZE);
    const roles = await rolesOfUsers(
      this.db,
      page.map((user) => user.id),
    );
    const last = page.at(-1);
    return {
      users: page.map((user) =>
        toAdminUserSummary(
          user,
          roles.filter((role) => role.userId === user.id),
        ),
      ),
      nextCursor:
        rows.length > ADMIN_USER_PAGE_SIZE && last !== undefined
          ? encodeUserCursor(last)
          : null,
    };
  }

  /** The employee with where his admin right comes from. 404 USER_NOT_FOUND. */
  async detail(userId: string): Promise<AdminUserDetail> {
    const user = await this.findOr404(userId);
    const roles = await rolesOfUsers(this.db, [user.id]);
    return {
      ...toAdminUserSummary(user, roles),
      adminRight: {
        personal: user.isAdmin,
        roles: roles
          .filter((role) => role.isAdmin)
          .map(({ id, name }) => ({ id, name })),
      },
    };
  }

  /**
   * A local account without roles (AC-33.1). 400 `weak_password`, 409 LOGIN_TAKEN or EMAIL_TAKEN;
   * the audit `admin_change` carries `password_changed` instead of the password.
   */
  async createLocal(
    actorId: string,
    body: CreateLocalUserBody,
  ): Promise<AdminUserSummary> {
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

  /**
   * The administrator sets a new password of a local account and ends all its sessions in the same
   * transaction (DC-16, Invariant 1). 404 USER_NOT_FOUND, 409 NOT_LOCAL_ACCOUNT, 400 `weak_password`.
   */
  async resetPassword(
    actorId: string,
    userId: string,
    password: string,
  ): Promise<void> {
    const startedAt = Date.now();
    const user = await this.findOr404(userId);
    if (user.passwordHash === null) throw identityError('NOT_LOCAL_ACCOUNT');
    checkNewPassword(password);
    const passwordHash = await hashPassword(password);
    await this.db.transaction(async (tx) => {
      await setPasswordHash(tx, user.id, passwordHash);
      await this.sessions.endAllOf(user.id, tx);
      const target = {
        actor: actorId,
        objectType: 'user',
        objectId: user.id,
        outcome: 'ok',
      };
      await this.auditLog.record(tx, { kind: 'password_reset', ...target });
      await this.auditLog.record(tx, {
        kind: 'admin_change',
        ...target,
        before: null,
        after: { password: PASSWORD_SET, sessionsEnded: true },
      });
    });
    this.logger.info('password reset by administrator', {
      actorId,
      userId: user.id,
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
  }

  /** Gives or takes the personal admin right; `admin_change` with before and after. 404 USER_NOT_FOUND. */
  async setPersonalAdmin(
    actorId: string,
    userId: string,
    enabled: boolean,
  ): Promise<AdminUserDetail> {
    const startedAt = Date.now();
    const user = await this.findOr404(userId);
    await this.db.transaction(async (tx) => {
      await setPersonalAdmin(tx, user.id, enabled);
      await this.auditLog.record(tx, {
        kind: 'admin_change',
        actor: actorId,
        objectType: 'user',
        objectId: user.id,
        before: { isAdmin: user.isAdmin },
        after: { isAdmin: enabled },
        outcome: 'ok',
      });
    });
    this.logger.info('personal admin right set', {
      actorId,
      userId: user.id,
      before: user.isAdmin,
      after: enabled,
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
    return this.detail(user.id);
  }

  /**
   * Blocks the employee (KD-4, Flow 4, AC-07.2): in one transaction the status becomes `disabled`,
   * every live session ends with `account_disabled` and `admin_change` is written. Running agents are
   * not stopped here: each ends at its next model or tool call through `OwnerGate`. 404 USER_NOT_FOUND.
   */
  async disable(actorId: string, userId: string): Promise<AdminUserSummary> {
    return this.changeStatus(actorId, userId, UserStatusSchema.enum.disabled);
  }

  /** Unblocks the employee (AC-07.4): only the status; old sessions stay ended. 404 USER_NOT_FOUND. */
  async enable(actorId: string, userId: string): Promise<AdminUserSummary> {
    return this.changeStatus(actorId, userId, UserStatusSchema.enum.active);
  }

  private async changeStatus(
    actorId: string,
    userId: string,
    status: UserStatus,
  ): Promise<AdminUserSummary> {
    const startedAt = Date.now();
    const user = await this.findOr404(userId);
    const disabling = status === UserStatusSchema.enum.disabled;
    await this.db.transaction(async (tx) => {
      await setUserStatus(tx, user.id, status);
      if (disabling) await this.sessions.endAllByBlock(user.id, tx);
      await this.auditLog.record(tx, {
        kind: 'admin_change',
        actor: actorId,
        objectType: 'user',
        objectId: user.id,
        before: { status: user.status },
        after: disabling ? { status, sessionsEnded: true } : { status },
        outcome: 'ok',
      });
    });
    this.logger.info(disabling ? 'employee blocked' : 'employee unblocked', {
      actorId,
      userId: user.id,
      before: user.status,
      after: status,
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
    const roles = await rolesOfUsers(this.db, [user.id]);
    return toAdminUserSummary({ ...user, status }, roles);
  }

  /**
   * The employee changes his own password (AC-33.3, AC-33.4); his sessions stay (KD-5). 400
   * VALIDATION_FAILED with `not_local_account`, `wrong_current_password` or `weak_password`.
   */
  async changeOwnPassword(
    userId: string,
    body: PasswordChangeBody,
  ): Promise<void> {
    const startedAt = Date.now();
    const user = await findUserById(this.db, userId);
    if (user?.passwordHash == null) {
      throw this.refuseOwnChange(
        userId,
        IdentityValidationReason.NOT_LOCAL_ACCOUNT,
      );
    }
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      throw this.refuseOwnChange(
        userId,
        IdentityValidationReason.WRONG_CURRENT_PASSWORD,
      );
    }
    checkNewPassword(body.newPassword);
    const passwordHash = await hashPassword(body.newPassword);
    await this.db.transaction(async (tx) => {
      await setPasswordHash(tx, userId, passwordHash);
      await this.auditLog.record(tx, {
        kind: 'password_changed',
        actor: userId,
        objectType: 'user',
        objectId: userId,
        outcome: 'ok',
      });
    });
    this.logger.info('own password changed', {
      userId,
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
  }

  /** Logs a refused own change and gives its 400 answer; the password stays as it was (AC-33.4). */
  private refuseOwnChange(
    userId: string,
    reason: IdentityValidationReason,
  ): HttpException {
    this.logger.info('own password change refused', {
      userId,
      outcome: 'rejected',
      reason,
    });
    return validationFailed(reason);
  }

  private async findOr404(userId: string): Promise<UserRow> {
    checkUserId(userId);
    const user = await findUserById(this.db, userId);
    if (user === undefined) throw identityError('USER_NOT_FOUND');
    return user;
  }
}
