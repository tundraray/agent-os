import { Inject, Injectable } from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import type {
  AdminUserDetail,
  CreateRoleBody,
  RoleDetail,
  RoleList,
  RoleSummary,
  UpdateRoleBody,
} from '@agent-os/contracts';
import {
  AccessGrantsRepository,
  type AccessGrantRow,
  type IdentityRoleRow,
  IdentityRolesRepository,
  type NewAccessGrantRow,
  type RoleSummaryRow,
  Db,
} from '@agent-os/db';
import { AuditLog } from '../audit/audit-log';
import { isUuid } from '../common/is-uuid';
import { identityError } from './identity.errors';
import { takenField } from './taken-field';
import { roleRefs, UsersService } from './users.service';

/** The role fields an audit entry keeps in `before`/`after`. */
const roleState = (
  role: Pick<IdentityRoleRow, 'name' | 'isAdmin' | 'trainOwn' | 'trainAny'>,
) => ({
  name: role.name,
  isAdmin: role.isAdmin,
  trainOwn: role.trainOwn,
  trainAny: role.trainAny,
});

/** The role as the panel lists it: «Все сотрудники» has no member count, its membership is implicit (KD-5). */
function toRoleSummary(row: RoleSummaryRow): RoleSummary {
  return {
    ...row,
    memberCount: row.builtinKind === 'everyone' ? null : row.memberCount,
  };
}

/** The template's grant as the copy's own: same effect, target and quota, held by the new role (AC-37.8). */
function copiedGrant(grant: AccessGrantRow, roleId: string): NewAccessGrantRow {
  return {
    roleId,
    userId: null,
    effect: grant.effect,
    targetKind: grant.targetKind,
    server: grant.server,
    tool: grant.tool,
    model: grant.model,
    quotaUsd: grant.quotaUsd,
  };
}

/** A unique violation of the role name (ignoring case) is 409 ROLE_NAME_TAKEN; anything else goes up. */
function roleNameTaken(error: unknown): never {
  if (takenField(error) === 'roleName') throw identityError('ROLE_NAME_TAKEN');
  throw error;
}

/**
 * Roles and their assignment, only by an administrator (FR-06, AC-06.1). The built-in
 * «Супер-администратор» cannot be deleted, renamed or lose the admin or a training right; «Все сотрудники»
 * cannot be renamed, deleted, given the admin or a training right, assigned or taken: 409 BUILTIN_ROLE (KD-6,
 * DC-15; training KD-8; access-levels KD-5, AC-38.2). Every change writes `admin_change` with before and after.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly db: Db,
    private readonly roles: IdentityRolesRepository,
    private readonly grants: AccessGrantsRepository,
    private readonly auditLog: AuditLog,
    private readonly users: UsersService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** The roles by name with their employee count. */
  async list(): Promise<RoleList> {
    return (await this.roles.summaries()).map(toRoleSummary);
  }

  /** One role with its employees; «Все сотрудники» lists none. 404 ROLE_NOT_FOUND. */
  async detail(roleId: string): Promise<RoleDetail> {
    const role = await this.findOr404(roleId);
    const members =
      role.builtinKind === 'everyone' ? [] : await this.roles.members(role.id);
    return { ...toRoleSummary(role), members };
  }

  /**
   * A role without the admin right and without employees; with `copyFrom` it gets a copy of every grant of the
   * template — server levels with their marks, model grants with quotas — in the same transaction as the role and
   * its audit (AC-37.8). 409 ROLE_NAME_TAKEN; 404 ROLE_NOT_FOUND and 409 BUILTIN_ROLE for the template.
   */
  async create(actorId: string, body: CreateRoleBody): Promise<RoleSummary> {
    const startedAt = Date.now();
    const template =
      body.copyFrom === undefined
        ? undefined
        : await this.findOr404(body.copyFrom);
    if (template?.builtinKind === 'super_admin')
      throw this.refuseBuiltin(actorId, template.id, 'copy');
    const { role, copied } = await this.db
      .transaction(async () => {
        const created = await this.roles.insert(body.name);
        const grants =
          template === undefined ? [] : await this.grants.ofRole(template.id);
        await this.grants.insertMany(
          grants.map((grant) => copiedGrant(grant, created.id)),
        );
        await this.recordRoleChange(actorId, created.id, null, {
          ...roleState(created),
          ...(template === undefined ? {} : { copyFrom: template.id }),
        });
        return { role: created, copied: grants.length };
      })
      .catch(roleNameTaken);
    this.logger.info('role created', {
      actorId,
      roleId: role.id,
      copyFrom: template?.id ?? null,
      grantsCopied: copied,
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
    return {
      id: role.id,
      name: role.name,
      isAdmin: role.isAdmin,
      trainOwn: role.trainOwn,
      trainAny: role.trainAny,
      builtinKind: role.builtinKind,
      memberCount: 0,
    };
  }

  /** Renames the role and/or gives or takes its rights. 404 ROLE_NOT_FOUND, 409 ROLE_NAME_TAKEN, BUILTIN_ROLE. */
  async update(
    actorId: string,
    roleId: string,
    body: UpdateRoleBody,
  ): Promise<RoleDetail> {
    const startedAt = Date.now();
    const role = await this.findOr404(roleId);
    const renamed = body.name !== undefined && body.name !== role.name;
    const rightTaken =
      body.isAdmin === false ||
      body.trainOwn === false ||
      body.trainAny === false;
    const rightGiven =
      body.isAdmin === true || body.trainOwn === true || body.trainAny === true;
    if (role.builtinKind === 'super_admin' && (renamed || rightTaken))
      throw this.refuseBuiltin(actorId, role.id, 'update');
    if (role.builtinKind === 'everyone' && (renamed || rightGiven))
      throw this.refuseBuiltin(actorId, role.id, 'update');
    const after = {
      name: body.name ?? role.name,
      isAdmin: body.isAdmin ?? role.isAdmin,
      trainOwn: body.trainOwn ?? role.trainOwn,
      trainAny: body.trainAny ?? role.trainAny,
    };
    await this.db
      .transaction(async () => {
        await this.roles.update(role.id, after);
        await this.recordRoleChange(actorId, role.id, roleState(role), after);
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
    if (role.builtinKind !== null)
      throw this.refuseBuiltin(actorId, role.id, 'delete');
    await this.db.transaction(async () => {
      await this.roles.delete(role.id);
      await this.recordRoleChange(actorId, role.id, roleState(role), null);
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
    await this.users.findOr404(userId);
    const role = await this.findOr404(roleId);
    if (role.builtinKind === 'everyone')
      throw this.refuseBuiltin(actorId, role.id, change);
    const changed = await this.db.transaction(async () => {
      const before = await this.roleRefsOf(userId);
      const has = before.some((held) => held.id === role.id);
      if (has === (change === 'assign')) return false;
      if (change === 'assign') await this.roles.addMember(role.id, userId);
      else await this.roles.removeMember(role.id, userId);
      await this.auditLog.record({
        kind: 'admin_change',
        actor: actorId,
        objectType: 'user',
        objectId: userId,
        before: { roles: before },
        after: { roles: await this.roleRefsOf(userId) },
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
    userId: string,
  ): Promise<{ id: string; name: string }[]> {
    return roleRefs(await this.roles.ofUsers([userId]));
  }

  private recordRoleChange(
    actorId: string,
    roleId: string,
    before: ReturnType<typeof roleState> | null,
    after: (ReturnType<typeof roleState> & { copyFrom?: string }) | null,
  ): Promise<void> {
    return this.auditLog.record({
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
    action: 'update' | 'delete' | 'copy' | 'assign' | 'unassign',
  ): Error {
    this.logger.info('built-in role change refused', {
      actorId,
      roleId,
      action,
      outcome: 'rejected',
    });
    return identityError('BUILTIN_ROLE');
  }

  /** The role with its employee count, or 404 ROLE_NOT_FOUND: for a missing one and for an id that is not a UUID alike. */
  private async findOr404(roleId: string): Promise<RoleSummaryRow> {
    const [role] = isUuid(roleId) ? await this.roles.summaries(roleId) : [];
    if (role === undefined) throw identityError('ROLE_NOT_FOUND');
    return role;
  }
}
