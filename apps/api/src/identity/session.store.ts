import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  IdentitySessionsRepository,
  IdentitySettingsRepository,
} from '@agent-os/db';
import {
  LanguageSchema,
  UserStatusSchema,
  type Language,
  type UserStatus,
} from '@agent-os/contracts';
import { isSessionExpired, needsTouch } from './session-lifetime';

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

/** `ended_reason` of a session ended by a block (KD-4, DC-9). */
export const ENDED_BY_BLOCK = 'account_disabled';

/**
 * Sessions as rows of `identity_sessions` (KD-2, ADR-0001): the browser holds 32 random bytes in
 * base64url, the database their SHA-256. Limits are not stored in the row: they are read from
 * `identity_settings` with the session, so a new value applies from the next request. The request
 * path's own reads and writes, on the pool; the queries are in `IdentitySessionsRepository`.
 */
@Injectable()
export class SessionStore {
  constructor(
    private readonly sessions: IdentitySessionsRepository,
    private readonly settings: IdentitySettingsRepository,
  ) {}

  /** Opens a session of the employee and deletes his rows older than the absolute limit. */
  async open(userId: string): Promise<OpenedSession> {
    const limits = await this.settings.readSessionLimits();
    await this.sessions.deleteOlderThan(userId, limits.absoluteMinutes);
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const sessionId = await this.sessions.insert(userId, hashToken(token));
    return { sessionId, token };
  }

  /** The session of the token with its employee, admin right and expiry, or undefined when there is none. */
  async find(
    token: string,
    now: Date = new Date(),
  ): Promise<FoundSession | undefined> {
    const row = await this.sessions.findByTokenHash(hashToken(token));
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
    await this.sessions.touch(session.sessionId, now);
  }

  /** Sign-out: the row is deleted. */
  async end(sessionId: string): Promise<void> {
    await this.sessions.delete(sessionId);
  }
}
