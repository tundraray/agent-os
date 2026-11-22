import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Executor } from '../database';
import { identityRoleMembers, identityRoles, identityUsers } from '../schema';

/** A row of `identity_roles`. */
export type IdentityRoleRow = typeof identityRoles.$inferSelect;

/** A role with the number of its employees. */
export interface RoleSummaryRow {
  id: string;
  name: string;
  isAdmin: boolean;
  builtin: boolean;
  memberCount: number;
}

/** A role of an employee, with whether it gives the admin right. */
export interface MemberRoleRow {
  userId: string;
  id: string;
  name: string;
  isAdmin: boolean;
}

/**
 * Drizzle queries of `identity_roles` and `identity_role_members` (repository over a transaction):
 * each takes the caller's transaction or the plain client first.
 */
@Injectable()
export class IdentityRolesRepository {
  /** Id of the built-in «Супер-администратор» role the migration creates (KD-6). */
  async builtinId(executor: Executor): Promise<string> {
    const [row] = await executor
      .select({ id: identityRoles.id })
      .from(identityRoles)
      .where(eq(identityRoles.builtin, true));
    if (row === undefined) throw new Error('the built-in role is missing from identity_roles');
    return row.id;
  }

  /** Assigns the role; assigning it again changes nothing. */
  async addMember(executor: Executor, roleId: string, userId: string): Promise<void> {
    await executor.insert(identityRoleMembers).values({ roleId, userId }).onConflictDoNothing();
  }

  /** Takes the role from the employee; taking it again changes nothing. */
  async removeMember(executor: Executor, roleId: string, userId: string): Promise<void> {
    await executor
      .delete(identityRoleMembers)
      .where(and(eq(identityRoleMembers.roleId, roleId), eq(identityRoleMembers.userId, userId)));
  }

  /** The roles by name, then id, each with its employee count; only the given role when `roleId` is set. */
  async summaries(executor: Executor, roleId?: string): Promise<RoleSummaryRow[]> {
    return executor
      .select({
        id: identityRoles.id,
        name: identityRoles.name,
        isAdmin: identityRoles.isAdmin,
        builtin: identityRoles.builtin,
        memberCount: sql<number>`count(${identityRoleMembers.userId})::int`,
      })
      .from(identityRoles)
      .leftJoin(identityRoleMembers, eq(identityRoleMembers.roleId, identityRoles.id))
      .where(roleId === undefined ? undefined : eq(identityRoles.id, roleId))
      .groupBy(identityRoles.id)
      .orderBy(asc(identityRoles.name), asc(identityRoles.id));
  }

  /** Of the role ids given, those of roles that exist. */
  async existingIds(executor: Executor, roleIds: string[]): Promise<string[]> {
    if (roleIds.length === 0) return [];
    const rows = await executor
      .select({ id: identityRoles.id })
      .from(identityRoles)
      .where(inArray(identityRoles.id, roleIds));
    return rows.map((row) => row.id);
  }

  /** Id and name of the roles named, by name. */
  async names(executor: Executor, roleIds: string[]): Promise<{ id: string; name: string }[]> {
    if (roleIds.length === 0) return [];
    return executor
      .select({ id: identityRoles.id, name: identityRoles.name })
      .from(identityRoles)
      .where(inArray(identityRoles.id, roleIds))
      .orderBy(asc(identityRoles.name));
  }

  /** The employees of the role by name, then id. */
  async members(
    executor: Executor,
    roleId: string,
  ): Promise<{ id: string; name: string; email: string }[]> {
    return executor
      .select({ id: identityUsers.id, name: identityUsers.name, email: identityUsers.email })
      .from(identityRoleMembers)
      .innerJoin(identityUsers, eq(identityUsers.id, identityRoleMembers.userId))
      .where(eq(identityRoleMembers.roleId, roleId))
      .orderBy(asc(identityUsers.name), asc(identityUsers.id));
  }

  /** The roles of the employees, by role name. */
  async ofUsers(executor: Executor, userIds: string[]): Promise<MemberRoleRow[]> {
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

  async insert(executor: Executor, name: string): Promise<IdentityRoleRow> {
    const [row] = await executor.insert(identityRoles).values({ name }).returning();
    if (row === undefined) throw new Error('identity_roles insert returned no row');
    return row;
  }

  /** Changes the name and/or the admin right of the role. */
  async update(
    executor: Executor,
    roleId: string,
    change: { name?: string; isAdmin?: boolean },
  ): Promise<void> {
    await executor.update(identityRoles).set(change).where(eq(identityRoles.id, roleId));
  }

  /** Deletes the role; its assignments and the rows of other parts that reference it go by cascade. */
  async delete(executor: Executor, roleId: string): Promise<void> {
    await executor.delete(identityRoles).where(eq(identityRoles.id, roleId));
  }
}
