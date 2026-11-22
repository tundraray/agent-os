import { Inject, Injectable } from '@nestjs/common';
import { UserStatusSchema } from '@agent-os/contracts';
import type { Database, DatabaseConnection, Executor } from '@agent-os/db';
import { isUuid } from '../common/is-uuid';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens';
import { existingRoleIds, roleNames } from './roles.repository';
import {
  existingUserIds,
  findUserById,
  hasAdminRight,
  rolesOfUsers,
  userNames,
} from './users.repository';

/** Role ids and employee ids, read together. */
export interface HolderIds {
  readonly roleIds: readonly string[];
  readonly userIds: readonly string[];
}

/** A role as another module shows it. */
export interface RoleName {
  readonly id: string;
  readonly name: string;
}

/** An employee as another module shows him: the name and whether he is on. */
export interface UserName {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
}

function uniqueUuids(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter(isUuid);
}

/**
 * The employee for `access` and the owner check (design-identity.md, Contract «Сотрудник для
 * `access`»): read at each call, no cache, so a changed role or status counts from the next call.
 * An id that is not a UUID (owners left by the old development stub and `e2e-…` owners in the shared database) names nobody and
 * never reaches Postgres.
 */
@Injectable()
export class IdentityDirectory {
  private readonly db: Database;

  constructor(@Inject(RUNTIME_DATABASE) database: DatabaseConnection) {
    this.db = database.db;
  }

  /** Ids of the employee's roles at the moment of the call; none for an unknown employee. */
  async rolesOf(userId: string): Promise<string[]> {
    if (!isUuid(userId)) return [];
    const roles = await rolesOfUsers(this.db, [userId]);
    return roles.map((role) => role.id);
  }

  /** Whether the employee is on; `false` for an unknown one. */
  async isActive(userId: string): Promise<boolean> {
    if (!isUuid(userId)) return false;
    const user = await findUserById(this.db, userId);
    return user?.status === UserStatusSchema.enum.active;
  }

  /** Whether the employee has the admin right now, by the rule of the session; `false` for an unknown one. */
  async isAdmin(userId: string): Promise<boolean> {
    if (!isUuid(userId)) return false;
    return hasAdminRight(this.db, userId);
  }

  /** Of the roles and employees named, those that exist; an id that is not a UUID names nobody. */
  async existing(
    ids: HolderIds,
  ): Promise<{ roleIds: string[]; userIds: string[] }> {
    const [roleIds, userIds] = await Promise.all([
      existingRoleIds(this.db, ids.roleIds.filter(isUuid)),
      existingUserIds(this.db, ids.userIds.filter(isUuid)),
    ]);
    return { roleIds, userIds };
  }

  /**
   * The names of the roles named, in the database's order of names; a missing role and an id that is
   * not a UUID are left out. Read on the caller's executor, so a caller inside a transaction takes no
   * second connection.
   */
  roleNames(
    executor: Executor,
    roleIds: readonly string[],
  ): Promise<RoleName[]> {
    return roleNames(executor, uniqueUuids(roleIds));
  }

  /** The same for employees, each with whether he is on. */
  async userNames(
    executor: Executor,
    userIds: readonly string[],
  ): Promise<UserName[]> {
    const users = await userNames(executor, uniqueUuids(userIds));
    return users.map(({ id, name, status }) => ({
      id,
      name,
      active: status === UserStatusSchema.enum.active,
    }));
  }
}
