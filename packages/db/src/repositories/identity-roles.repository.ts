import type { BuiltinRoleKind } from '@agent-os/contracts';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { identityRoleMembers, identityRoles, identityUsers } from '../schema';

/** A row of `identity_roles`. */
export type IdentityRoleRow = typeof identityRoles.$inferSelect;

/** A role with the number of its employees. */
export interface RoleSummaryRow {
  id: string;
  name: string;
  isAdmin: boolean;
  trainOwn: boolean;
  trainAny: boolean;
  builtinKind: BuiltinRoleKind | null;
  memberCount: number;
}

/** A role of an employee, with whether it gives the admin right. */
export interface MemberRoleRow {
  userId: string;
  id: string;
  name: string;
  isAdmin: boolean;
  builtinKind: BuiltinRoleKind | null;
}

/**
 * Drizzle queries of `identity_roles` and `identity_role_members`.
 */
export class IdentityRolesRepository {
  constructor(private readonly db: Db) {}

  /** Id of the built-in role of this kind the migration creates (access-levels KD-5). */
  async builtinId(kind: BuiltinRoleKind): Promise<string> {
    const [row] = await this.db.client
      .select({ id: identityRoles.id })
      .from(identityRoles)
      .where(eq(identityRoles.builtinKind, kind));
    if (row === undefined)
      throw new Error(
        `the built-in role ${kind} is missing from identity_roles`,
      );
    return row.id;
  }

  /** Assigns the role; assigning it again changes nothing. */
  async addMember(roleId: string, userId: string): Promise<void> {
    await this.db.client
      .insert(identityRoleMembers)
      .values({ roleId, userId })
      .onConflictDoNothing();
  }

  /** Takes the role from the employee; taking it again changes nothing. */
  async removeMember(roleId: string, userId: string): Promise<void> {
    await this.db.client
      .delete(identityRoleMembers)
      .where(
        and(
          eq(identityRoleMembers.roleId, roleId),
          eq(identityRoleMembers.userId, userId),
        ),
      );
  }

  /** The roles by name, then id, each with its employee count; only the given role when `roleId` is set. */
  async summaries(roleId?: string): Promise<RoleSummaryRow[]> {
    return this.db.client
      .select({
        id: identityRoles.id,
        name: identityRoles.name,
        isAdmin: identityRoles.isAdmin,
        trainOwn: identityRoles.trainOwn,
        trainAny: identityRoles.trainAny,
        builtinKind: identityRoles.builtinKind,
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

  /** Of the role ids given, those of roles that exist. */
  async existingIds(roleIds: string[]): Promise<string[]> {
    if (roleIds.length === 0) return [];
    const rows = await this.db.client
      .select({ id: identityRoles.id })
      .from(identityRoles)
      .where(inArray(identityRoles.id, roleIds));
    return rows.map((row) => row.id);
  }

  /** Id and name of the roles named, by name. */
  async names(roleIds: string[]): Promise<{ id: string; name: string }[]> {
    if (roleIds.length === 0) return [];
    return this.db.client
      .select({ id: identityRoles.id, name: identityRoles.name })
      .from(identityRoles)
      .where(inArray(identityRoles.id, roleIds))
      .orderBy(asc(identityRoles.name));
  }

  /** The employees of the role by name, then id. */
  async members(
    roleId: string,
  ): Promise<{ id: string; name: string; email: string }[]> {
    return this.db.client
      .select({
        id: identityUsers.id,
        name: identityUsers.name,
        email: identityUsers.email,
      })
      .from(identityRoleMembers)
      .innerJoin(
        identityUsers,
        eq(identityUsers.id, identityRoleMembers.userId),
      )
      .where(eq(identityRoleMembers.roleId, roleId))
      .orderBy(asc(identityUsers.name), asc(identityUsers.id));
  }

  /** The roles of the employees, by role name. */
  async ofUsers(userIds: string[]): Promise<MemberRoleRow[]> {
    if (userIds.length === 0) return [];
    return this.db.client
      .select({
        userId: identityRoleMembers.userId,
        id: identityRoles.id,
        name: identityRoles.name,
        isAdmin: identityRoles.isAdmin,
        builtinKind: identityRoles.builtinKind,
      })
      .from(identityRoleMembers)
      .innerJoin(
        identityRoles,
        eq(identityRoles.id, identityRoleMembers.roleId),
      )
      .where(inArray(identityRoleMembers.userId, userIds))
      .orderBy(asc(identityRoles.name), asc(identityRoles.id));
  }

  async insert(name: string): Promise<IdentityRoleRow> {
    const [row] = await this.db.client
      .insert(identityRoles)
      .values({ name })
      .returning();
    if (row === undefined)
      throw new Error('identity_roles insert returned no row');
    return row;
  }

  /** Changes the name and/or the rights of the role. */
  async update(
    roleId: string,
    change: Partial<
      Pick<IdentityRoleRow, 'name' | 'isAdmin' | 'trainOwn' | 'trainAny'>
    >,
  ): Promise<void> {
    await this.db.client
      .update(identityRoles)
      .set(change)
      .where(eq(identityRoles.id, roleId));
  }

  /** Deletes the role; its assignments and the rows of other parts that reference it go by cascade. */
  async delete(roleId: string): Promise<void> {
    await this.db.client
      .delete(identityRoles)
      .where(eq(identityRoles.id, roleId));
  }
}
