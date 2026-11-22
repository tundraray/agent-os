import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { Db } from '../db';
import { identitySessions, identitySettings, identityUsers } from '../schema';
import { IS_ADMIN, sessionLimitColumns } from './identity-columns';

/**
 * Drizzle queries of `identity_sessions`. Tokens and expiry rules live in the api's `SessionStore`.
 */
@Injectable()
export class IdentitySessionsRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** Deletes the employee's sessions created more than `absoluteMinutes` ago. */
  async deleteOlderThan(userId: string, absoluteMinutes: number): Promise<void> {
    await this.db.client
      .delete(identitySessions)
      .where(
        and(
          eq(identitySessions.userId, userId),
          lt(identitySessions.createdAt, sql`now() - make_interval(mins => ${absoluteMinutes})`),
        ),
      );
  }

  /** Inserts a session of the employee under the hash of its token; returns the session id. */
  async insert(userId: string, tokenHash: string): Promise<string> {
    const [row] = await this.db.client
      .insert(identitySessions)
      .values({ tokenHash, userId })
      .returning({ id: identitySessions.id });
    if (row === undefined) throw new Error('identity_sessions insert returned no row');
    return row.id;
  }

  /**
   * Ends every live session of the employee with the reason given: the rows stay, so a request
   * with such a cookie can still be told from one without a session.
   */
  async endLive(userId: string, endedReason: string): Promise<void> {
    await this.db.client
      .update(identitySessions)
      .set({ endedReason })
      .where(and(eq(identitySessions.userId, userId), isNull(identitySessions.endedReason)));
  }

  /** Deletes every session of the employee (a password reset, a repair by the operator command). */
  async deleteOfUser(userId: string): Promise<void> {
    await this.db.client.delete(identitySessions).where(eq(identitySessions.userId, userId));
  }

  /** The session of the token hash with its employee, admin right and the current session limits, in one query. */
  async findByTokenHash(tokenHash: string) {
    const [row] = await this.db.client
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
        language: identityUsers.language,
        ...sessionLimitColumns,
      })
      .from(identitySessions)
      .innerJoin(identityUsers, eq(identityUsers.id, identitySessions.userId))
      .innerJoin(identitySettings, sql`true`)
      .where(eq(identitySessions.tokenHash, tokenHash));
    return row;
  }

  /** Writes the time of the session's last request. */
  async touch(sessionId: string, now: Date): Promise<void> {
    await this.db.client
      .update(identitySessions)
      .set({ lastSeenAt: now })
      .where(eq(identitySessions.id, sessionId));
  }

  /** Deletes the session. */
  async delete(sessionId: string): Promise<void> {
    await this.db.client.delete(identitySessions).where(eq(identitySessions.id, sessionId));
  }
}
