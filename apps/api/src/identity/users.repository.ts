import { type Executor, identityRoleMembers, identityRoles, identityUsers } from '@agent-os/db';
import {
  UserStatusSchema,
  type Language,
  type UserStatus,
} from '@agent-os/contracts';
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';

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
const TAKEN_BY_INDEX: Record<string, 'login' | 'email' | 'roleName'> = {
  identity_users_login_idx: 'login',
  identity_users_email_idx: 'email',
  identity_roles_name_idx: 'roleName',
};

/**
 * Drizzle queries of `identity_users` and the roles of employees (repository-over-transaction.md):
 * each takes the caller's transaction or the plain client first. The id is always the database's
 * `gen_random_uuid()` (ADR-0012, Invariant 3).
 */
export async function findUserByLogin(
  executor: Executor,
  login: string,
): Promise<UserRow | undefined> {
  const [row] = await executor
    .select()
    .from(identityUsers)
    .where(eq(identityUsers.login, login));
  return row;
}

export async function insertLocalUser(
  executor: Executor,
  user: NewLocalUser,
): Promise<UserRow> {
  const [row] = await executor.insert(identityUsers).values(user).returning();
  if (row === undefined)
    throw new Error('identity_users insert returned no row');
  return row;
}

/**
 * The employee of a provider sign-in (AC-04.1, AC-04.2): the one with this normalized email, or a new
 * one without roles (JIT). The name from the ID token replaces the stored one when the token has it;
 * the status, roles, login and password stay as they are.
 */
export async function upsertProviderUser(
  executor: Executor,
  user: { email: string; name: string | undefined },
): Promise<UserRow> {
  const [row] = await executor
    .insert(identityUsers)
    .values({ email: user.email, name: user.name ?? '' })
    .onConflictDoUpdate({
      target: identityUsers.email,
      set:
        user.name === undefined ? { email: user.email } : { name: user.name },
    })
    .returning();
  if (row === undefined)
    throw new Error('identity_users upsert returned no row');
  return row;
}

export async function findUserById(
  executor: Executor,
  userId: string,
): Promise<UserRow | undefined> {
  const [row] = await executor
    .select()
    .from(identityUsers)
    .where(eq(identityUsers.id, userId));
  return row;
}

/** A column written with its table name: drizzle drops it in a query over one table, and the subquery below needs it. */
const col = (table: string, column: string) =>
  sql`${sql.identifier(table)}.${sql.identifier(column)}`;

/**
 * The admin right of the employee row: the personal mark or a membership in a role with the admin
 * right. The one rule of the session (`SessionStore.find`) and of `IdentityDirectory.isAdmin`.
 */
export const IS_ADMIN = sql<boolean>`(${col('identity_users', 'is_admin')} or exists (
  select 1 from ${identityRoleMembers}
  join ${identityRoles} on ${col('identity_roles', 'id')} = ${col('identity_role_members', 'role_id')}
  where ${col('identity_role_members', 'user_id')} = ${col('identity_users', 'id')} and ${col('identity_roles', 'is_admin')}
))`;

/** Whether the employee has the admin right now; `false` for an unknown one. */
export async function hasAdminRight(
  executor: Executor,
  userId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ isAdmin: IS_ADMIN })
    .from(identityUsers)
    .where(eq(identityUsers.id, userId));
  return row?.isAdmin ?? false;
}

/** Of the employee ids given, those of employees that exist. */
export async function existingUserIds(
  executor: Executor,
  userIds: string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await executor
    .select({ id: identityUsers.id })
    .from(identityUsers)
    .where(inArray(identityUsers.id, userIds));
  return rows.map((row) => row.id);
}

/** Id, name and status of the employees named, by name. */
export async function userNames(
  executor: Executor,
  userIds: string[],
): Promise<{ id: string; name: string; status: string }[]> {
  if (userIds.length === 0) return [];
  return executor
    .select({
      id: identityUsers.id,
      name: identityUsers.name,
      status: identityUsers.status,
    })
    .from(identityUsers)
    .where(inArray(identityUsers.id, userIds))
    .orderBy(asc(identityUsers.name));
}

/** Position of the last employee of a list page: the order is name, then id. */
export interface UserListPosition {
  name: string;
  id: string;
}

export interface UserPageQuery {
  /** Matched against name, email and login ignoring case; absent or blank lists everyone. */
  search?: string;
  /** The employees strictly after this position; absent for the first page. */
  after?: UserListPosition;
  limit: number;
}

/** `%`, `_` and `\` of the search are literal characters, not `ilike` wildcards. */
const escapeLikePattern = (text: string): string =>
  text.replace(/[\\%_]/g, '\\$&');

/** Up to `limit` employees by name, then id, strictly after `after` (keyset over the pair). */
export async function pageUsers(
  executor: Executor,
  query: UserPageQuery,
): Promise<UserRow[]> {
  const search = query.search?.trim();
  const pattern = search ? `%${escapeLikePattern(search)}%` : undefined;
  return executor
    .select()
    .from(identityUsers)
    .where(
      and(
        pattern === undefined
          ? undefined
          : or(
              ilike(identityUsers.name, pattern),
              ilike(identityUsers.email, pattern),
              ilike(identityUsers.login, pattern),
            ),
        query.after === undefined
          ? undefined
          : sql`(${identityUsers.name}, ${identityUsers.id}) > (${query.after.name}, ${query.after.id}::uuid)`,
      ),
    )
    .orderBy(asc(identityUsers.name), asc(identityUsers.id))
    .limit(query.limit);
}

/** A role of an employee, with whether it gives the admin right. */
export interface MemberRole {
  userId: string;
  id: string;
  name: string;
  isAdmin: boolean;
}

/** The roles of the employees, by role name. */
export async function rolesOfUsers(
  executor: Executor,
  userIds: string[],
): Promise<MemberRole[]> {
  if (userIds.length === 0) return [];
  return executor
    .select({
      userId: identityRoleMembers.userId,
      id: identityRoles.id,
      name: identityRoles.name,
      isAdmin: identityRoles.isAdmin,
    })
    .from(identityRoleMembers)
    .innerJoin(identityRoles, eq(identityRoles.id, identityRoleMembers.roleId))
    .where(inArray(identityRoleMembers.userId, userIds))
    .orderBy(asc(identityRoles.name), asc(identityRoles.id));
}

/** Replaces the password hash; the status stays as it is. */
export async function setPasswordHash(
  executor: Executor,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await executor
    .update(identityUsers)
    .set({ passwordHash })
    .where(eq(identityUsers.id, userId));
}

/** Gives or takes the personal admin right. */
export async function setPersonalAdmin(
  executor: Executor,
  userId: string,
  enabled: boolean,
): Promise<void> {
  await executor
    .update(identityUsers)
    .set({ isAdmin: enabled })
    .where(eq(identityUsers.id, userId));
}

/** Turns the account on or off; nothing else of the employee changes. */
export async function setUserStatus(
  executor: Executor,
  userId: string,
  status: UserStatus,
): Promise<void> {
  await executor
    .update(identityUsers)
    .set({ status })
    .where(eq(identityUsers.id, userId));
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

/** Records the employee's interface language. */
export async function setLanguage(
  executor: Executor,
  userId: string,
  language: Language,
): Promise<void> {
  await executor
    .update(identityUsers)
    .set({ language })
    .where(eq(identityUsers.id, userId));
}

export async function markSignedIn(
  executor: Executor,
  userId: string,
): Promise<void> {
  await executor
    .update(identityUsers)
    .set({ lastSignInAt: sql`now()` })
    .where(eq(identityUsers.id, userId));
}

/** Which unique field of `identity_users` or `identity_roles` the error violated, if it is such a violation (drizzle wraps the driver's error). */
export function takenField(
  error: unknown,
): 'login' | 'email' | 'roleName' | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { code, constraint } = current as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code === UNIQUE_VIOLATION && typeof constraint === 'string')
      return TAKEN_BY_INDEX[constraint];
  }
  return undefined;
}
