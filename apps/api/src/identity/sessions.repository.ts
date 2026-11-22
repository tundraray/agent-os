import {
  type Executor,
  identitySessions,
  identitySettings,
  identityUsers,
} from '@agent-os/db';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { sessionLimitColumns } from './settings.repository';
import { IS_ADMIN } from './users.repository';

/**
 * Drizzle queries of `identity_sessions` (repository-over-transaction.md): the executor is always
 * the first parameter. Tokens and expiry rules live in `session.store.ts`.
 */

/** `ended_reason` of a session ended by a block (KD-4, DC-9). */
export const ENDED_BY_BLOCK = 'account_disabled';

/** Deletes the employee's sessions created more than `absoluteMinutes` ago. */
export async function deleteSessionsOlderThan(
  executor: Executor,
  userId: string,
  absoluteMinutes: number,
): Promise<void> {
  await executor
    .delete(identitySessions)
    .where(
      and(
        eq(identitySessions.userId, userId),
        lt(
          identitySessions.createdAt,
          sql`now() - make_interval(mins => ${absoluteMinutes})`,
        ),
      ),
    );
}

/** Inserts a session of the employee under the hash of its token; returns the session id. */
export async function insertSession(
  executor: Executor,
  userId: string,
  tokenHash: string,
): Promise<string> {
  const [row] = await executor
    .insert(identitySessions)
    .values({ tokenHash, userId })
    .returning({ id: identitySessions.id });
  if (row === undefined)
    throw new Error('identity_sessions insert returned no row');
  return row.id;
}

/**
 * Ends every live session of the employee with the block's reason (KD-4): the rows stay, so a
 * request with such a cookie can answer ACCOUNT_DISABLED instead of AUTH_REQUIRED (DC-9).
 */
export async function endSessionsByBlock(
  executor: Executor,
  userId: string,
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

/** Deletes every session of the employee (a password reset, a repair by the operator command). */
export async function deleteSessionsOf(
  executor: Executor,
  userId: string,
): Promise<void> {
  await executor
    .delete(identitySessions)
    .where(eq(identitySessions.userId, userId));
}

/** The session of the token hash with its employee, admin right and the current session limits, in one query. */
export async function findSessionByTokenHash(
  executor: Executor,
  tokenHash: string,
) {
  const [row] = await executor
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
export async function touchSession(
  executor: Executor,
  sessionId: string,
  now: Date,
): Promise<void> {
  await executor
    .update(identitySessions)
    .set({ lastSeenAt: now })
    .where(eq(identitySessions.id, sessionId));
}

/** Deletes the session. */
export async function deleteSession(
  executor: Executor,
  sessionId: string,
): Promise<void> {
  await executor
    .delete(identitySessions)
    .where(eq(identitySessions.id, sessionId));
}
