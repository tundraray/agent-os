import { HttpException, Inject, Injectable } from '@nestjs/common';
import { AgentsMcp } from '@agent-os/agents';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  AccessLevelsErrorCode,
  type LevelRole,
  type LevelsInvalidReason,
  type LevelTool,
  type McpServerStatus,
  type McpServerView,
  type RoleLevels,
  type SaveRoleLevelsBody,
  type SaveServerAccessBody,
  type SaveUserLevelsBody,
  type ServerAccess,
  type ToolMark,
  type UserLevels,
} from '@agent-os/contracts';
import {
  AccessGrantsRepository,
  IdentityRolesRepository,
  type GrantHolderQuery,
  type NewAccessGrantRow,
  type RoleSummaryRow,
  Db,
} from '@agent-os/db';
import { mcpAnswer } from '../agents/mcp.errors';
import { AuditLog } from '../audit/audit-log';
import { apiError } from '../common/api-error';
import { isUuid } from '../common/is-uuid';
import { IdentityDirectory } from '../identity/identity-directory';
import { identityError } from '../identity/identity.errors';
import { toGrantRow, type GrantRow } from './grant-rows';
import {
  grantsOfLevel,
  levelOf,
  NO_LEVEL,
  roleLevelOf,
  serverLevels,
  type LevelGrant,
  type ServerLevel,
} from './levels';

/** A registry server as a level tab needs it: `tools` is `null` until the server has given its list. */
interface ServerTools {
  readonly server: string;
  readonly status: McpServerStatus;
  readonly tools: LevelTool[] | null;
}

/** One level a save replaces: the holder, the server, the level stored now and the level asked for. */
interface LevelChange {
  readonly holder: GrantHolderQuery;
  readonly server: string;
  readonly before: ServerLevel;
  readonly after: ServerLevel;
}

/** A level row of a save body, as the checks read it: the marks a `pick` names. */
interface AskedLevel {
  readonly server: ServerTools;
  readonly level: ServerLevel;
  readonly saved: ServerLevel;
}

function serverToolsOf(view: McpServerView): ServerTools {
  return {
    server: view.name,
    status: view.status,
    // The registry answers an empty list for a server without one; only a server waiting for the admin's account has none.
    tools:
      view.status === 'awaiting_admin_account'
        ? null
        : view.tools.map(({ name, title, readOnly, enabled, isNew }) => ({
            name,
            title,
            readOnly,
            enabled,
            isNew,
          })),
  };
}

/** A role's level row of a body as a level with marks; a role's marks all allow. */
function roleLevel(level: ServerLevel['level'], picked: readonly string[]) {
  return {
    level,
    marks: picked.map((tool): ToolMark => ({ tool, effect: 'allow' })),
  };
}

/** The level a save stores, read back the way the screen reads it: `pick` without marks is `none` (KD-1). */
function storedLevel(server: string, level: ServerLevel): ServerLevel {
  return levelOf(grantsOfLevel(server, level));
}

function sameLevel(a: ServerLevel, b: ServerLevel): boolean {
  const key = (level: ServerLevel) =>
    JSON.stringify([
      level.level,
      level.marks.map((mark) => `${mark.effect}:${mark.tool}`).sort(),
    ]);
  return key(a) === key(b);
}

/** The columns of a level grant of the holder. */
function grantColumns(
  holder: GrantHolderQuery,
  { effect, target }: LevelGrant,
): NewAccessGrantRow {
  return {
    roleId: 'roleId' in holder ? holder.roleId : null,
    userId: 'userId' in holder ? holder.userId : null,
    effect,
    targetKind: target.kind,
    server: target.server,
    tool: target.kind === 'tool' ? target.tool : null,
    model: null,
    quotaUsd: null,
  };
}

/** The first check a level row fails, before any write (DC-2); `null` — the row passes. */
function invalidReason({
  server,
  level,
  saved,
}: AskedLevel): LevelsInvalidReason | null {
  if (level.level !== 'pick') return null;
  if (server.tools === null) return 'pick_without_list';
  const known = new Set([
    ...server.tools.map((tool) => tool.name),
    ...saved.marks.map((mark) => mark.tool),
  ]);
  return level.marks.every((mark) => known.has(mark.tool))
    ? null
    : 'tool_unknown';
}

/** A role's stored level as a response shows it; a role never holds a deny (`roleLevelOf`). */
function roleSaved(roleId: string, level: ServerLevel) {
  const { level: roleLevel, picked } = roleLevelOf(roleId, level);
  return { level: roleLevel, picked: [...picked] };
}

/**
 * Access levels of roles, employees and servers for an administrator (access-levels KD-1, KD-6, Flow 1). A read
 * gives what a tab computes from: every server's tools and the stored levels. A save, in one transaction, reads
 * the holder's saved marks, checks every row against them and the registry before any write (DC-2), replaces the
 * holder's MCP grants on each server of the body with the rows of the new level and writes one `admin_change` per
 * level that changed (AC-37.5, AC-37.6). «Супер-администратор» takes no level: 409 BUILTIN_ROLE.
 */
@Injectable()
export class AccessLevelsService {
  constructor(
    private readonly db: Db,
    private readonly grants: AccessGrantsRepository,
    private readonly roles: IdentityRolesRepository,
    private readonly identity: IdentityDirectory,
    private readonly auditLog: AuditLog,
    @Inject(AgentsMcp) private readonly mcp: AgentsMcp,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** The role's level on every registered server; 404 ROLE_NOT_FOUND. */
  async roleLevels(roleId: string): Promise<RoleLevels> {
    const role = await this.roleOr404(roleId);
    const [servers, rows] = await Promise.all([
      this.registry(),
      this.grants.mcpOf({ roleId: role.id }),
    ]);
    const levels = serverLevels(rows.map(toGrantRow));
    return {
      servers: servers.map((server) => ({
        ...server,
        ...roleSaved(role.id, levels.get(server.server) ?? NO_LEVEL),
      })),
    };
  }

  /** Replaces the role's levels on the servers of the body. 404 ROLE_NOT_FOUND, 409 BUILTIN_ROLE, 422 LEVELS_INVALID. */
  async saveRoleLevels(
    actorId: string,
    roleId: string,
    body: SaveRoleLevelsBody,
  ): Promise<RoleLevels> {
    const startedAt = Date.now();
    const role = await this.roleOr404(roleId);
    const holder = { roleId: role.id };
    if (role.builtinKind === 'super_admin')
      throw this.builtinRoleRefused(actorId, holder);
    await this.replace(actorId, startedAt, () =>
      this.checkedChanges(
        actorId,
        holder,
        body.servers.map((row) => ({
          server: row.server,
          level: roleLevel(row.level, row.picked),
        })),
      ),
    );
    return this.roleLevels(role.id);
  }

  /** The employee's personal levels and those of his roles, «Все сотрудники» included; 404 USER_NOT_FOUND. */
  async userLevels(userId: string): Promise<UserLevels> {
    await this.userOr404(userId);
    const [servers, held, everyone] = await Promise.all([
      this.registry(),
      this.roles.ofUsers([userId]),
      this.everyoneRole(),
    ]);
    const roles = [...held, everyone];
    const rows = (
      await this.grants.ofEmployee(
        roles.map((role) => role.id),
        userId,
      )
    ).map(toGrantRow);
    const personal = serverLevels(
      rows.filter((row) => row.holder.kind === 'user'),
    );
    const byRole = new Map(
      roles.map((role) => [role.id, serverLevels(heldBy(rows, role.id))]),
    );
    return {
      superAdmin: held.some((role) => role.builtinKind === 'super_admin'),
      servers: servers.map((server) => {
        const own = personal.get(server.server) ?? NO_LEVEL;
        return {
          ...server,
          personal: { level: own.level, marks: [...own.marks] },
          roles: roles.flatMap((role): LevelRole[] => {
            const level = byRole.get(role.id)?.get(server.server);
            if (level === undefined) return [];
            return [
              {
                id: role.id,
                name: role.name,
                builtinKind: role.builtinKind,
                ...roleSaved(role.id, level),
              },
            ];
          }),
        };
      }),
    };
  }

  /** Replaces the employee's personal levels on the servers of the body. 404 USER_NOT_FOUND, 422 LEVELS_INVALID. */
  async saveUserLevels(
    actorId: string,
    userId: string,
    body: SaveUserLevelsBody,
  ): Promise<UserLevels> {
    const startedAt = Date.now();
    await this.userOr404(userId);
    await this.replace(actorId, startedAt, () =>
      this.checkedChanges(
        actorId,
        { userId },
        body.servers.map((row) => ({
          server: row.server,
          level: { level: row.level, marks: row.marks },
        })),
      ),
    );
    return this.userLevels(userId);
  }

  /** The roles with a level on the server, «Супер-администратор» left out; 404 MCP_SERVER_NOT_FOUND. */
  async serverAccess(name: string): Promise<ServerAccess> {
    const server = serverToolsOf(await mcpAnswer(this.mcp.get(name)));
    const roles = (await this.roles.summaries()).filter(
      (role) => role.builtinKind !== 'super_admin',
    );
    const levels = await Promise.all(
      roles.map((role) => this.savedLevel({ roleId: role.id }, server.server)),
    );
    return {
      ...server,
      roles: roles.flatMap((role, index) => {
        const level = levels[index] ?? NO_LEVEL;
        if (level.level === 'none') return [];
        return [
          {
            id: role.id,
            name: role.name,
            builtinKind: role.builtinKind,
            memberCount:
              role.builtinKind === 'everyone' ? null : role.memberCount,
            ...roleSaved(role.id, level),
          },
        ];
      }),
    };
  }

  /**
   * Replaces the levels of the roles of the body on the server. 404 MCP_SERVER_NOT_FOUND; 409 BUILTIN_ROLE for
   * «Супер-администратор»; 422 LEVELS_INVALID.
   */
  async saveServerAccess(
    actorId: string,
    name: string,
    body: SaveServerAccessBody,
  ): Promise<ServerAccess> {
    const startedAt = Date.now();
    const server = serverToolsOf(await mcpAnswer(this.mcp.get(name)));
    await this.replace(actorId, startedAt, async () => {
      const roles = new Map(
        (await this.roles.summaries()).map((role) => [role.id, role]),
      );
      const changes: LevelChange[] = [];
      for (const row of body.roles) {
        const holder = { roleId: row.roleId };
        const role = roles.get(row.roleId);
        if (role === undefined)
          throw this.levelsRefused(actorId, holder, 'role_unknown');
        if (role.builtinKind === 'super_admin')
          throw this.builtinRoleRefused(actorId, holder);
        const saved = await this.savedLevel(holder, server.server);
        const level = roleLevel(row.level, row.picked);
        const reason = invalidReason({ server, level, saved });
        if (reason !== null) throw this.levelsRefused(actorId, holder, reason);
        changes.push({
          holder,
          server: server.server,
          before: saved,
          after: storedLevel(server.server, level),
        });
      }
      return changes;
    });
    return this.serverAccess(server.server);
  }

  /**
   * The body rows of one holder checked against the registry and his saved marks, as level changes (DC-2); run
   * inside the transaction of `replace`.
   */
  private async checkedChanges(
    actorId: string,
    holder: GrantHolderQuery,
    rows: readonly { server: string; level: ServerLevel }[],
  ): Promise<LevelChange[]> {
    const servers = new Map(
      (await this.registry()).map((server) => [server.server, server]),
    );
    const saved = serverLevels(
      (
        await this.grants.mcpOf(
          holder,
          rows.map((row) => row.server),
        )
      ).map(toGrantRow),
    );
    return rows.map((row) => {
      const server = servers.get(row.server);
      if (server === undefined)
        throw this.levelsRefused(actorId, holder, 'server_unknown');
      const before = saved.get(row.server) ?? NO_LEVEL;
      const reason = invalidReason({ server, level: row.level, saved: before });
      if (reason !== null) throw this.levelsRefused(actorId, holder, reason);
      return {
        holder,
        server: row.server,
        before,
        after: storedLevel(row.server, row.level),
      };
    });
  }

  /**
   * One transaction: `checked` reads the saved levels and checks the body against them — a refusal writes
   * nothing; then each change removes the holder's MCP grants on its server and writes the rows of the new
   * level; a level that changed gets one `admin_change` with the server and the level before and after.
   */
  private async replace(
    actorId: string,
    startedAt: number,
    checked: () => Promise<LevelChange[]>,
  ): Promise<void> {
    const { changes, changed } = await this.db.transaction(async () => {
      const changes = await checked();
      const changed = changes.filter(
        (change) => !sameLevel(change.before, change.after),
      );
      for (const change of changes) {
        await this.grants.deleteMcp(change.holder, [change.server]);
        await this.grants.insertMany(
          grantsOfLevel(change.server, change.after).map((grant) =>
            grantColumns(change.holder, grant),
          ),
        );
      }
      for (const change of changed) {
        const [objectType, objectId] = holderOf(change.holder);
        await this.auditLog.record({
          kind: 'admin_change',
          actor: actorId,
          objectType,
          objectId,
          before: { server: change.server, ...change.before },
          after: { server: change.server, ...change.after },
          outcome: 'ok',
        });
      }
      return { changes, changed };
    });
    this.logger.info('access levels saved', {
      actorId,
      holders: [
        ...new Set(changes.map((change) => holderOf(change.holder).join(':'))),
      ],
      servers: [...new Set(changes.map((change) => change.server))],
      levelsChanged: changed.length,
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
  }

  /** Logs the refused save and gives its answer: 422 LEVELS_INVALID with the reason. */
  private levelsRefused(
    actorId: string,
    holder: GrantHolderQuery,
    reason: LevelsInvalidReason,
  ): HttpException {
    this.logRefused(actorId, holder, reason);
    return apiError(
      422,
      AccessLevelsErrorCode.LEVELS_INVALID,
      'Access levels are invalid',
      reason,
    );
  }

  /** Logs the refused save of «Супер-администратор» and gives its answer: 409 BUILTIN_ROLE. */
  private builtinRoleRefused(
    actorId: string,
    holder: GrantHolderQuery,
  ): HttpException {
    this.logRefused(actorId, holder, 'builtin_role');
    return identityError('BUILTIN_ROLE');
  }

  private logRefused(
    actorId: string,
    holder: GrantHolderQuery,
    reason: string,
  ): void {
    this.logger.info('access levels save refused', {
      actorId,
      holder: holderOf(holder).join(':'),
      reason,
      outcome: 'rejected',
    });
  }

  /** The holder's stored level on one server. */
  private async savedLevel(
    holder: GrantHolderQuery,
    server: string,
  ): Promise<ServerLevel> {
    const rows = await this.grants.mcpOf(holder, [server]);
    return serverLevels(rows.map(toGrantRow)).get(server) ?? NO_LEVEL;
  }

  /** Every registered server by name with its tools. */
  private async registry(): Promise<ServerTools[]> {
    const summaries = await this.mcp.list();
    const views = await Promise.all(
      summaries.map((summary) => this.mcp.get(summary.name)),
    );
    return views.map(serverToolsOf);
  }

  /** «Все сотрудники» as a role of every employee: no membership row holds it (KD-5). */
  private async everyoneRole(): Promise<RoleSummaryRow> {
    const [role] = await this.roles.summaries(
      await this.roles.builtinId('everyone'),
    );
    if (role === undefined) throw new Error('«Все сотрудники» is missing');
    return role;
  }

  private async roleOr404(roleId: string): Promise<RoleSummaryRow> {
    const [role] = isUuid(roleId) ? await this.roles.summaries(roleId) : [];
    if (role === undefined) throw identityError('ROLE_NOT_FOUND');
    return role;
  }

  private async userOr404(userId: string): Promise<void> {
    const { userIds } = await this.identity.existing({
      roleIds: [],
      userIds: [userId],
    });
    if (userIds.length === 0) throw identityError('USER_NOT_FOUND');
  }
}

/** The rows the role holds. */
function heldBy(rows: readonly GrantRow[], roleId: string): GrantRow[] {
  return rows.filter(
    (row) => row.holder.kind === 'role' && row.holder.id === roleId,
  );
}

/** `objectType` and `objectId` of a level's audit entry: the role or the employee. */
function holderOf(holder: GrantHolderQuery): ['role' | 'user', string] {
  return 'roleId' in holder ? ['role', holder.roleId] : ['user', holder.userId];
}
