import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  identityRoleMembers,
  identityRoles,
  identitySessions,
  identitySettings,
  identityUsers,
  type Database,
  type DatabaseConnection,
} from '@agent-os/db';
import { UserStatusSchema, type UserStatus } from '@agent-os/contracts';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens.js';
import { readSessionLimits, sessionLimitColumns } from './identity-settings.js';
import { isSessionExpired, needsTouch } from './session-lifetime.js';
import type { Executor } from './users.repository.js';

/** `ended_reason` of a session ended by a block (KD-4, DC-9). */
export const ENDED_BY_BLOCK = 'account_disabled';

/** Random bytes of a session token (KD-2). */
const TOKEN_BYTES = 32;

/** A session just opened: the token goes to the cookie, only its hash is stored. */
export interface OpenedSession {
  sessionId: string;
  token: string;
}

/** A session found by its token, with its employee, read in one query. */
export interface FoundSession {
  sessionId: string;
  createdAt: Date;
  lastSeenAt: Date;
  /** Why the session was ended (`account_disabled`), or null while it is live. */
  endedReason: string | null;
  /** Past the idle or the absolute limit of the current settings (session-lifetime.ts). */
  expired: boolean;
  user: {
    id: string;
    email: string;
    name: string;
    status: UserStatus;
    /** The personal mark or any role with the admin right. */
    isAdmin: boolean;
    /** A local account: it has a password. */
    hasPassword: boolean;
  };
}

/** SHA-256 of the token as the cookie carries it; the only form of a token in the database (Invariant 4). */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The personal admin mark or a membership in a role with the admin right. */
const IS_ADMIN = sql<boolean>`(${identityUsers.isAdmin} or exists (
  select 1 from ${identityRoleMembers}
  join ${identityRoles} on ${identityRoles.id} = ${identityRoleMembers.roleId}
  where ${identityRoleMembers.userId} = ${identityUsers.id} and ${identityRoles.isAdmin}
))`;

/**
 * Sessions as rows of `identity_sessions` (KD-2, ADR-0001): the browser holds 32 random bytes in
 * base64url, the database their SHA-256. Limits are not stored in the row: they are read from
 * `identity_settings` with the session, so a new value applies from the next request.
 */
@Injectable()
export class SessionStore {
  private readonly db: Database;

  constructor(@Inject(RUNTIME_DATABASE) database: DatabaseConnection) {
    this.db = database.db;
  }

  /** Opens a session of the employee and deletes his rows older than the absolute limit. */
  async open(
    userId: string,
    executor: Executor = this.db,
  ): Promise<OpenedSession> {
    const limits = await readSessionLimits(executor);
    await executor
      .delete(identitySessions)
      .where(
        and(
          eq(identitySessions.userId, userId),
          lt(
            identitySessions.createdAt,
            sql`now() - make_interval(mins => ${limits.absoluteMinutes})`,
          ),
        ),
      );
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const [row] = await executor
      .insert(identitySessions)
      .values({ tokenHash: hashToken(token), userId })
      .returning({ id: identitySessions.id });
    if (row === undefined)
      throw new Error('identity_sessions insert returned no row');
    return { sessionId: row.id, token };
  }

  /** The session of the token with its employee, admin right and expiry, or undefined when there is none. */
  async find(
    token: string,
    now: Date = new Date(),
  ): Promise<FoundSession | undefined> {
    const [row] = await this.db
      .select({
        sessionId: identitySessions.id,
        createdAt: identitySessions.createdAt,
        lastSeenAt: identitySessions.lastSeenAt,
        endedReason: identitySessions.endedReason,
        userId: identityUsers.id,
        email: identityUsers.email,
        name: identityUsers.name,
        status: identityUsers.status,
        isAdmin: IS_ADMIN,
        hasPassword: sql<boolean>`${identityUsers.passwordHash} is not null`,
        ...sessionLimitColumns,
      })
      .from(identitySessions)
      .innerJoin(identityUsers, eq(identityUsers.id, identitySessions.userId))
      .innerJoin(identitySettings, sql`true`)
      .where(eq(identitySessions.tokenHash, hashToken(token)));
    if (row === undefined) return undefined;
    const {
      userId,
      email,
      name,
      status,
      isAdmin,
      hasPassword,
      idleMinutes,
      absoluteMinutes,
    } = row;
    return {
      sessionId: row.sessionId,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      endedReason: row.endedReason,
      expired: isSessionExpired(row, { idleMinutes, absoluteMinutes }, now),
      user: {
        id: userId,
        email,
        name,
        status: UserStatusSchema.parse(status),
        isAdmin,
        hasPassword,
      },
    };
  }

  /** Records the request time, at most once per 5 minutes. */
  async touch(
    session: Pick<FoundSession, 'sessionId' | 'lastSeenAt'>,
    now: Date = new Date(),
  ): Promise<void> {
    if (!needsTouch(session.lastSeenAt, now)) return;
    await this.db
      .update(identitySessions)
      .set({ lastSeenAt: now })
      .where(eq(identitySessions.id, session.sessionId));
  }

  /** Sign-out: the row is deleted. */
  async end(sessionId: string): Promise<void> {
    await this.db
      .delete(identitySessions)
      .where(eq(identitySessions.id, sessionId));
  }

  /**
   * Ends every live session of the employee with the block's reason (KD-4): the rows stay, so a
   * request with such a cookie can answer ACCOUNT_DISABLED instead of AUTH_REQUIRED (DC-9).
   */
  async endAllByBlock(
    userId: string,
    executor: Executor = this.db,
  ): Promise<void> {
    await executor
      .update(identitySessions)
      .set({ endedReason: ENDED_BY_BLOCK })
      .where(
        and(
          eq(identitySessions.userId, userId),
          isNull(identitySessions.endedReason),
        ),
      );
  }

  /** Deletes every session of the employee. */
  async endAllOf(userId: string, executor: Executor = this.db): Promise<void> {
    await executor
      .delete(identitySessions)
      .where(eq(identitySessions.userId, userId));
  }
}
