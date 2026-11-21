import type {
  CreateGrantBody,
  Grant,
  GrantEffect,
  GrantTargetBody,
  GrantTargetKind,
} from '@agent-os/contracts';
import { accessGrants, accessModels, identityRoles } from '@agent-os/db';
import { asc, eq, inArray, or, type SQL } from 'drizzle-orm';
import type { Executor } from '../common/executor';
import type { GrantRow } from './effective-access';

/**
 * Drizzle queries of `access_grants` (repository-over-transaction.md): each takes the caller's
 * transaction or the plain client first. Lists come by creation time, then id.
 */

/** Whose grants: a role's or an employee's personal ones. */
export type GrantHolderQuery = { roleId: string } | { userId: string };

interface TargetColumns {
  targetKind: string;
  server: string | null;
  tool: string | null;
  model: string | null;
}

/** The target of a row; the CHECK keeps exactly the columns of its kind set. */
function targetOf(row: TargetColumns): GrantTargetBody {
  const kind = row.targetKind as GrantTargetKind;
  if (kind === 'server' && row.server !== null)
    return { kind, server: row.server };
  if (kind === 'tool' && row.server !== null && row.tool !== null)
    return { kind, server: row.server, tool: row.tool };
  if (kind === 'model' && row.model !== null) return { kind, model: row.model };
  throw new Error(`access_grants row has a broken ${row.targetKind} target`);
}

/** The holder of a row; the CHECK keeps exactly one of role and employee, the FK the role's name. */
function holderOf(
  row: { roleId: string | null; userId: string | null },
  roleName: string | null,
): Grant['holder'] {
  if (row.roleId !== null && roleName !== null)
    return { kind: 'role', id: row.roleId, name: roleName };
  if (row.userId !== null) return { kind: 'user', id: row.userId };
  throw new Error('access_grants row has a broken holder');
}

function targetColumns(target: GrantTargetBody) {
  return {
    targetKind: target.kind,
    server: target.kind === 'model' ? null : target.server,
    tool: target.kind === 'tool' ? target.tool : null,
    model: target.kind === 'model' ? target.model : null,
  };
}

/** The grants of the employee's roles and his personal ones, in one query. */
export async function grantsOf(
  executor: Executor,
  roleIds: readonly string[],
  userId: string,
): Promise<GrantRow[]> {
  const holder =
    roleIds.length === 0
      ? eq(accessGrants.userId, userId)
      : or(
          inArray(accessGrants.roleId, [...roleIds]),
          eq(accessGrants.userId, userId),
        );
  const rows = await executor.select().from(accessGrants).where(holder);
  return rows.map((row) => ({
    id: row.id,
    effect: row.effect as GrantEffect,
    target: targetOf(row),
    quotaUsd: row.quotaUsd,
  }));
}

/** The grants as the admin sees them: holder with the role name, model target with the catalogue name. */
async function grantViews(
  executor: Executor,
  where: SQL | undefined,
): Promise<Grant[]> {
  const rows = await executor
    .select({
      grant: accessGrants,
      roleName: identityRoles.name,
      modelName: accessModels.name,
    })
    .from(accessGrants)
    .leftJoin(identityRoles, eq(identityRoles.id, accessGrants.roleId))
    .leftJoin(accessModels, eq(accessModels.id, accessGrants.model))
    .where(where)
    .orderBy(asc(accessGrants.createdAt), asc(accessGrants.id));
  return rows.map(({ grant, roleName, modelName }) => {
    const target = targetOf(grant);
    return {
      id: grant.id,
      holder: holderOf(grant, roleName),
      effect: grant.effect as GrantEffect,
      target:
        target.kind === 'model'
          ? { ...target, modelName: modelName ?? '' }
          : target,
      quotaUsd: grant.quotaUsd,
      createdAt: grant.createdAt.toISOString(),
    };
  });
}

export function listGrants(
  executor: Executor,
  holder: GrantHolderQuery,
): Promise<Grant[]> {
  return grantViews(
    executor,
    'roleId' in holder
      ? eq(accessGrants.roleId, holder.roleId)
      : eq(accessGrants.userId, holder.userId),
  );
}

export async function findGrant(
  executor: Executor,
  id: string,
): Promise<Grant | undefined> {
  const [grant] = await grantViews(executor, eq(accessGrants.id, id));
  return grant;
}

/** Adds the grant; `undefined` when the holder already has one with the same effect and target. */
export async function insertGrant(
  executor: Executor,
  body: CreateGrantBody,
): Promise<string | undefined> {
  const [row] = await executor
    .insert(accessGrants)
    .values({
      roleId: body.roleId ?? null,
      userId: body.userId ?? null,
      effect: body.effect,
      ...targetColumns(body.target),
      quotaUsd: body.quotaUsd ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: accessGrants.id });
  return row?.id;
}

export async function updateGrantQuota(
  executor: Executor,
  id: string,
  quotaUsd: number | null,
): Promise<void> {
  await executor
    .update(accessGrants)
    .set({ quotaUsd })
    .where(eq(accessGrants.id, id));
}

export async function deleteGrant(
  executor: Executor,
  id: string,
): Promise<void> {
  await executor.delete(accessGrants).where(eq(accessGrants.id, id));
}

/** Deletes every grant on the server and its tools; returns how many there were. */
export async function deleteServerGrants(
  executor: Executor,
  server: string,
): Promise<number> {
  const rows = await executor
    .delete(accessGrants)
    .where(eq(accessGrants.server, server))
    .returning({ id: accessGrants.id });
  return rows.length;
}
