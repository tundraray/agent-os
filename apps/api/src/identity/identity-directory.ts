import { Injectable } from '@nestjs/common';
import { UserStatusSchema } from '@agent-os/contracts';
import {
  IdentityRolesRepository,
  IdentityUsersRepository,
} from '@agent-os/db';
import { isUuid } from '../common/is-uuid';

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
  constructor(
    private readonly users: IdentityUsersRepository,
    private readonly roles: IdentityRolesRepository,
  ) {}

  /** Ids of the employee's roles at the moment of the call; none for an unknown employee. */
  async rolesOf(userId: string): Promise<string[]> {
    if (!isUuid(userId)) return [];
    const roles = await this.roles.ofUsers([userId]);
    return roles.map((role) => role.id);
  }

  /** Whether the employee is on; `false` for an unknown one. */
  async isActive(userId: string): Promise<boolean> {
    if (!isUuid(userId)) return false;
    const user = await this.users.findById(userId);
    return user?.status === UserStatusSchema.enum.active;
  }

  /** Whether the employee has the admin right now, by the rule of the session; `false` for an unknown one. */
  async isAdmin(userId: string): Promise<boolean> {
    if (!isUuid(userId)) return false;
    return this.users.hasAdminRight(userId);
  }

  /** Of the roles and employees named, those that exist; an id that is not a UUID names nobody. */
  async existing(
    ids: HolderIds,
  ): Promise<{ roleIds: string[]; userIds: string[] }> {
    const [roleIds, userIds] = await Promise.all([
      this.roles.existingIds(ids.roleIds.filter(isUuid)),
      this.users.existingIds(ids.userIds.filter(isUuid)),
    ]);
    return { roleIds, userIds };
  }

  /**
   * The names of the roles named, in the database's order of names; a missing role and an id that is
   * not a UUID are left out.
   */
  roleNames(
    roleIds: readonly string[],
  ): Promise<RoleName[]> {
    return this.roles.names(uniqueUuids(roleIds));
  }

  /** The same for employees, each with whether he is on. */
  async userNames(
    userIds: readonly string[],
  ): Promise<UserName[]> {
    const users = await this.users.names(uniqueUuids(userIds));
    return users.map(({ id, name, status }) => ({
      id,
      name,
      active: status === UserStatusSchema.enum.active,
    }));
  }
}
