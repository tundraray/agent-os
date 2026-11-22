import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Database, DatabaseConnection, Executor } from '@agent-os/db';
import {
  LanguageSchema,
  UserStatusSchema,
  type Language,
  type UserStatus,
} from '@agent-os/contracts';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens';
import { isSessionExpired, needsTouch } from './session-lifetime';
import {
  deleteSession,
  deleteSessionsOlderThan,
  findSessionByTokenHash,
  insertSession,
  touchSession,
} from './sessions.repository';
import { readSessionLimits } from './settings.repository';

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
    /** The chosen interface language, or null while there is no choice. */
    language: Language | null;
  };
}

/** SHA-256 of the token as the cookie carries it; the only form of a token in the database (Invariant 4). */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Opens a session of the employee and deletes his rows older than the absolute limit. */
export async function openSession(
  executor: Executor,
  userId: string,
): Promise<OpenedSession> {
  const limits = await readSessionLimits(executor);
  await deleteSessionsOlderThan(executor, userId, limits.absoluteMinutes);
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const sessionId = await insertSession(executor, userId, hashToken(token));
  return { sessionId, token };
}

/**
 * Sessions as rows of `identity_sessions` (KD-2, ADR-0001): the browser holds 32 random bytes in
 * base64url, the database their SHA-256. Limits are not stored in the row: they are read from
 * `identity_settings` with the session, so a new value applies from the next request. The request
 * path's own reads and writes, on the pool; the queries are in `sessions.repository.ts`.
 */
@Injectable()
export class SessionStore {
  private readonly db: Database;

  constructor(@Inject(RUNTIME_DATABASE) database: DatabaseConnection) {
    this.db = database.db;
  }

  /** The session of the token with its employee, admin right and expiry, or undefined when there is none. */
  async find(
    token: string,
    now: Date = new Date(),
  ): Promise<FoundSession | undefined> {
    const row = await findSessionByTokenHash(this.db, hashToken(token));
    if (row === undefined) return undefined;
    const {
      userId,
      email,
      name,
      status,
      isAdmin,
      hasPassword,
      language,
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
        language: LanguageSchema.nullable().parse(language),
      },
    };
  }

  /** Records the request time, at most once per 5 minutes. */
  async touch(
    session: Pick<FoundSession, 'sessionId' | 'lastSeenAt'>,
    now: Date = new Date(),
  ): Promise<void> {
    if (!needsTouch(session.lastSeenAt, now)) return;
    await touchSession(this.db, session.sessionId, now);
  }

  /** Sign-out: the row is deleted. */
  async end(sessionId: string): Promise<void> {
    await deleteSession(this.db, sessionId);
  }
}
