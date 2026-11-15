import {
  identityRoleMembers,
  identityRoles,
  identityUsers,
  type Database,
} from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { UserStatusSchema } from '@agent-os/contracts';
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';

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
const TAKEN_BY_INDEX: Record<string, 'login' | 'email' | 'roleName'> = {
  identity_users_login_idx: 'login',
  identity_users_email_idx: 'email',
  identity_roles_name_idx: 'roleName',
};

/**
 * Drizzle queries of `identity_users` and role membership (repository-over-transaction.md): each
 * takes the caller's transaction or the plain client. The id is always the database's
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

export async function markSignedIn(
  executor: Executor,
  userId: string,
): Promise<void> {
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
  if (row === undefined)
    throw new Error('the built-in role is missing from identity_roles');
  return row.id;
}

/** Assigns the role; assigning it again changes nothing. */
export async function addRoleMember(
  executor: Executor,
  roleId: string,
  userId: string,
): Promise<void> {
  await executor
    .insert(identityRoleMembers)
    .values({ roleId, userId })
    .onConflictDoNothing();
}

/** Takes the role from the employee; taking it again changes nothing. */
export async function removeRoleMember(
  executor: Executor,
  roleId: string,
  userId: string,
): Promise<void> {
  await executor
    .delete(identityRoleMembers)
    .where(
      and(
        eq(identityRoleMembers.roleId, roleId),
        eq(identityRoleMembers.userId, userId),
      ),
    );
}

/** A row of `identity_roles`. */
export type RoleRow = typeof identityRoles.$inferSelect;

/** A role with the number of its employees. */
export interface RoleWithCount {
  id: string;
  name: string;
  isAdmin: boolean;
  builtin: boolean;
  memberCount: number;
}

/** The roles by name, then id, each with its employee count; only the given role when `roleId` is set. */
export async function roleSummaries(
  executor: Executor,
  roleId?: string,
): Promise<RoleWithCount[]> {
  return executor
    .select({
      id: identityRoles.id,
      name: identityRoles.name,
      isAdmin: identityRoles.isAdmin,
      builtin: identityRoles.builtin,
      memberCount: sql<number>`count(${identityRoleMembers.userId})::int`,
    })
    .from(identityRoles)
    .leftJoin(
      identityRoleMembers,
      eq(identityRoleMembers.roleId, identityRoles.id),
    )
    .where(roleId === undefined ? undefined : eq(identityRoles.id, roleId))
    .groupBy(identityRoles.id)
    .orderBy(asc(identityRoles.name), asc(identityRoles.id));
}

/** The employees of the role by name, then id. */
export async function roleMembers(
  executor: Executor,
  roleId: string,
): Promise<{ id: string; name: string; email: string }[]> {
  return executor
    .select({
      id: identityUsers.id,
      name: identityUsers.name,
      email: identityUsers.email,
    })
    .from(identityRoleMembers)
    .innerJoin(identityUsers, eq(identityUsers.id, identityRoleMembers.userId))
    .where(eq(identityRoleMembers.roleId, roleId))
    .orderBy(asc(identityUsers.name), asc(identityUsers.id));
}

export async function findRoleById(
  executor: Executor,
  roleId: string,
): Promise<RoleRow | undefined> {
  const [row] = await executor
    .select()
    .from(identityRoles)
    .where(eq(identityRoles.id, roleId));
  return row;
}

export async function insertRole(
  executor: Executor,
  name: string,
): Promise<RoleRow> {
  const [row] = await executor
    .insert(identityRoles)
    .values({ name })
    .returning();
  if (row === undefined)
    throw new Error('identity_roles insert returned no row');
  return row;
}

/** Changes the name and/or the admin right of the role. */
export async function updateRole(
  executor: Executor,
  roleId: string,
  change: { name?: string; isAdmin?: boolean },
): Promise<void> {
  await executor
    .update(identityRoles)
    .set(change)
    .where(eq(identityRoles.id, roleId));
}

/** Deletes the role; its assignments and the rows of other parts that reference it go by cascade. */
export async function deleteRole(
  executor: Executor,
  roleId: string,
): Promise<void> {
  await executor.delete(identityRoles).where(eq(identityRoles.id, roleId));
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
