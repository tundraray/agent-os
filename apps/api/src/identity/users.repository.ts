import { identityRoleMembers, identityRoles, identityUsers, type Database } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { UserStatusSchema } from '@agent-os/contracts';
import { eq, sql } from 'drizzle-orm';

/** A transaction of the caller or the plain client: both run the same queries. */
export type Executor = Database | RuntimeTx;

/** A row of `identity_users`. */
export type UserRow = typeof identityUsers.$inferSelect;

export interface NewLocalUser {
  /** Normalized (identity-input.ts). */
  login: string;
  /** Normalized (identity-input.ts). */
  email: string;
  name: string;
  passwordHash: string;
}

/** SQLSTATE unique_violation. */
const UNIQUE_VIOLATION = '23505';
const TAKEN_BY_INDEX: Record<string, 'login' | 'email'> = {
  identity_users_login_idx: 'login',
  identity_users_email_idx: 'email',
};

/**
 * Drizzle queries of `identity_users` and role membership (repository-over-transaction.md): each
 * takes the caller's transaction or the plain client. The id is always the database's
 * `gen_random_uuid()` (ADR-0012, Invariant 3).
 */
export async function findUserByLogin(executor: Executor, login: string): Promise<UserRow | undefined> {
  const [row] = await executor.select().from(identityUsers).where(eq(identityUsers.login, login));
  return row;
}

export async function insertLocalUser(executor: Executor, user: NewLocalUser): Promise<UserRow> {
  const [row] = await executor.insert(identityUsers).values(user).returning();
  if (row === undefined) throw new Error('identity_users insert returned no row');
  return row;
}

/** Sets a new password hash and turns the account on. */
export async function setPasswordAndEnable(
  executor: Executor,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await executor
    .update(identityUsers)
    .set({ passwordHash, status: UserStatusSchema.enum.active })
    .where(eq(identityUsers.id, userId));
}

export async function markSignedIn(executor: Executor, userId: string): Promise<void> {
  await executor
    .update(identityUsers)
    .set({ lastSignInAt: sql`now()` })
    .where(eq(identityUsers.id, userId));
}

/** Id of the built-in «Супер-администратор» role the migration creates (KD-6). */
export async function builtinRoleId(executor: Executor): Promise<string> {
  const [row] = await executor
    .select({ id: identityRoles.id })
    .from(identityRoles)
    .where(eq(identityRoles.builtin, true));
  if (row === undefined) throw new Error('the built-in role is missing from identity_roles');
  return row.id;
}

/** Assigns the role; assigning it again changes nothing. */
export async function addRoleMember(executor: Executor, roleId: string, userId: string): Promise<void> {
  await executor.insert(identityRoleMembers).values({ roleId, userId }).onConflictDoNothing();
}

/** Which unique field of `identity_users` the error violated, if it is such a violation (drizzle wraps the driver's error). */
export function takenField(error: unknown): 'login' | 'email' | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { code, constraint } = current as { code?: unknown; constraint?: unknown };
    if (code === UNIQUE_VIOLATION && typeof constraint === 'string') return TAKEN_BY_INDEX[constraint];
  }
  return undefined;
}
