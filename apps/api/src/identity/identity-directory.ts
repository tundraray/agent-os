import { Inject, Injectable } from '@nestjs/common';
import { UserStatusSchema } from '@agent-os/contracts';
import type { Database, DatabaseConnection } from '@agent-os/db';
import { isUuid } from '../common/is-uuid.js';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens.js';
import { existingRoleIds } from './roles.repository.js';
import {
  existingUserIds,
  findUserById,
  rolesOfUsers,
} from './users.repository.js';

/** Role ids and employee ids, read together. */
export interface HolderIds {
  readonly roleIds: readonly string[];
  readonly userIds: readonly string[];
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
}
