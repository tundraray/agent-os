import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import type {
  AdminUserDetail,
  CreateRoleBody,
  RoleDetail,
  RoleList,
  RoleSummary,
  UpdateRoleBody,
} from '@agent-os/contracts';
import type { Database, DatabaseConnection } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { AuditLog } from '../audit/audit-log.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens.js';
import { identityError } from './identity.errors.js';
import {
  addRoleMember,
  deleteRole,
  findRoleById,
  findUserById,
  insertRole,
  removeRoleMember,
  roleMembers,
  roleSummaries,
  rolesOfUsers,
  takenField,
  updateRole,
  type Executor,
  type RoleRow,
} from './users.repository.js';
import { checkUserId, isUuid, UsersService } from './users.service.js';

/** The role fields an audit entry keeps in `before`/`after`. */
const roleState = (role: Pick<RoleRow, 'name' | 'isAdmin'>) => ({
  name: role.name,
  isAdmin: role.isAdmin,
});

/** A role id from a route that is not a UUID answers 404 ROLE_NOT_FOUND like a missing one. */
function checkRoleId(roleId: string): void {
  if (!isUuid(roleId)) throw identityError('ROLE_NOT_FOUND');
}

/** A unique violation of the role name (ignoring case) is 409 ROLE_NAME_TAKEN; anything else goes up. */
function roleNameTaken(error: unknown): never {
  if (takenField(error) === 'roleName') throw identityError('ROLE_NAME_TAKEN');
  throw error;
}

/**
 * Roles and their assignment, only by an administrator (FR-06, AC-06.1). The built-in
 * «Супер-администратор» cannot be deleted, renamed or lose the admin right: 409 BUILTIN_ROLE (KD-6,
 * DC-15). Every change writes `admin_change` with before and after.
 */
@Injectable()
export class RolesService {
  private readonly db: Database;

  constructor(
    @Inject(RUNTIME_DATABASE) database: DatabaseConnection,
    private readonly auditLog: AuditLog,
    private readonly users: UsersService,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {
    this.db = database.db;
  }

  /** The roles by name with their employee count. */
  list(): Promise<RoleList> {
    return roleSummaries(this.db);
  }

  /** One role with its employees. 404 ROLE_NOT_FOUND. */
  async detail(roleId: string): Promise<RoleDetail> {
    checkRoleId(roleId);
    const [role] = await roleSummaries(this.db, roleId);
    if (role === undefined) throw identityError('ROLE_NOT_FOUND');
    return { ...role, members: await roleMembers(this.db, roleId) };
  }

  /** A role without the admin right and without employees. 409 ROLE_NAME_TAKEN. */
  async create(actorId: string, body: CreateRoleBody): Promise<RoleSummary> {
    const startedAt = Date.now();
    const role = await this.db
      .transaction(async (tx) => {
        const created = await insertRole(tx, body.name);
        await this.recordRoleChange(
          tx,
          actorId,
          created.id,
          null,
          roleState(created),
        );
        return created;
      })
      .catch(roleNameTaken);
    this.logger.info('role created', {
      actorId,
      roleId: role.id,
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
    return {
      id: role.id,
      name: role.name,
      isAdmin: role.isAdmin,
      builtin: role.builtin,
      memberCount: 0,
    };
  }

  /** Renames the role and/or gives or takes its admin right. 404 ROLE_NOT_FOUND, 409 ROLE_NAME_TAKEN, BUILTIN_ROLE. */
  async update(
    actorId: string,
    roleId: string,
    body: UpdateRoleBody,
  ): Promise<RoleDetail> {
    const startedAt = Date.now();
    const role = await this.findOr404(roleId);
    const renamed = body.name !== undefined && body.name !== role.name;
    if (role.builtin && (renamed || body.isAdmin === false))
      throw this.refuseBuiltin(actorId, role.id, 'update');
    const after = {
      name: body.name ?? role.name,
      isAdmin: body.isAdmin ?? role.isAdmin,
    };
    await this.db
      .transaction(async (tx) => {
        await updateRole(tx, role.id, after);
        await this.recordRoleChange(
          tx,
          actorId,
          role.id,
          roleState(role),
          after,
        );
      })
      .catch(roleNameTaken);
    this.logger.info('role updated', {
      actorId,
      roleId: role.id,
      before: roleState(role),
      after,
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
    return this.detail(role.id);
  }

  /** Deletes the role with its assignments (cascade). 404 ROLE_NOT_FOUND, 409 BUILTIN_ROLE. */
  async remove(actorId: string, roleId: string): Promise<void> {
    const startedAt = Date.now();
    const role = await this.findOr404(roleId);
    if (role.builtin) throw this.refuseBuiltin(actorId, role.id, 'delete');
    await this.db.transaction(async (tx) => {
      await deleteRole(tx, role.id);
      await this.recordRoleChange(tx, actorId, role.id, roleState(role), null);
    });
    this.logger.info('role deleted', {
      actorId,
      roleId: role.id,
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
  }

  /** Assigns the role to the employee; a repeat answers the same without a second row. 404 USER_NOT_FOUND, ROLE_NOT_FOUND. */
  assign(
    actorId: string,
    userId: string,
    roleId: string,
  ): Promise<AdminUserDetail> {
    return this.changeMembership(actorId, userId, roleId, 'assign');
  }

  /** Takes the role from the employee; a repeat answers the same. 404 USER_NOT_FOUND, ROLE_NOT_FOUND. */
  unassign(
    actorId: string,
    userId: string,
    roleId: string,
  ): Promise<AdminUserDetail> {
    return this.changeMembership(actorId, userId, roleId, 'unassign');
  }

  /**
   * One assignment change in a transaction with its `admin_change` (the employee and his roles before
   * and after); nothing is written when the employee already has (or has not) the role.
   */
  private async changeMembership(
    actorId: string,
    userId: string,
    roleId: string,
    change: 'assign' | 'unassign',
  ): Promise<AdminUserDetail> {
    const startedAt = Date.now();
    checkUserId(userId);
    if ((await findUserById(this.db, userId)) === undefined)
      throw identityError('USER_NOT_FOUND');
    const role = await this.findOr404(roleId);
    const changed = await this.db.transaction(async (tx) => {
      const before = await this.roleRefsOf(tx, userId);
      const has = before.some((held) => held.id === role.id);
      if (has === (change === 'assign')) return false;
      if (change === 'assign') await addRoleMember(tx, role.id, userId);
      else await removeRoleMember(tx, role.id, userId);
      await this.auditLog.record(tx, {
        kind: 'admin_change',
        actor: actorId,
        objectType: 'user',
        objectId: userId,
        before: { roles: before },
        after: { roles: await this.roleRefsOf(tx, userId) },
        outcome: 'ok',
      });
      return true;
    });
    this.logger.info(
      change === 'assign' ? 'role assigned' : 'role unassigned',
      {
        actorId,
        userId,
        roleId: role.id,
        changed,
        outcome: 'ok',
        durationMs: Date.now() - startedAt,
      },
    );
    return this.users.detail(userId);
  }

  private async roleRefsOf(
    executor: Executor,
    userId: string,
  ): Promise<{ id: string; name: string }[]> {
    const roles = await rolesOfUsers(executor, [userId]);
    return roles.map(({ id, name }) => ({ id, name }));
  }

  private recordRoleChange(
    tx: RuntimeTx,
    actorId: string,
    roleId: string,
    before: ReturnType<typeof roleState> | null,
    after: ReturnType<typeof roleState> | null,
  ): Promise<void> {
    return this.auditLog.record(tx, {
      kind: 'admin_change',
      actor: actorId,
      objectType: 'role',
      objectId: roleId,
      before,
      after,
      outcome: 'ok',
    });
  }

  /** Logs the refused change of the built-in role and gives its 409 answer. */
  private refuseBuiltin(
    actorId: string,
    roleId: string,
    action: 'update' | 'delete',
  ): Error {
    this.logger.info('built-in role change refused', {
      actorId,
      roleId,
      action,
      outcome: 'rejected',
    });
    return identityError('BUILTIN_ROLE');
  }

  private async findOr404(roleId: string): Promise<RoleRow> {
    checkRoleId(roleId);
    const role = await findRoleById(this.db, roleId);
    if (role === undefined) throw identityError('ROLE_NOT_FOUND');
    return role;
  }
}
