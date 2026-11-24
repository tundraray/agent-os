import type {
  CreateGrantBody,
  Grant,
  GrantEffect,
  GrantTargetBody,
  GrantTargetKind,
} from '@agent-os/contracts';
import type {
  AccessGrantRow,
  AccessGrantWithModelName,
  NewAccessGrantRow,
} from '@agent-os/db';
import type { GrantRow } from './effective-access';

/** A grant as stored: the holder by id — the role's name is read in `identity` by the service. */
export type StoredGrant = Omit<Grant, 'holder'> & {
  readonly holder: { readonly kind: 'role' | 'user'; readonly id: string };
};

/** The target of a row; the CHECK keeps exactly the columns of its kind set. */
function targetOf(
  row: Pick<AccessGrantRow, 'targetKind' | 'server' | 'tool' | 'model'>,
): GrantTargetBody {
  const kind = row.targetKind as GrantTargetKind;
  if (kind === 'server' && row.server !== null)
    return { kind, server: row.server };
  if (kind === 'tool' && row.server !== null && row.tool !== null)
    return { kind, server: row.server, tool: row.tool };
  if (kind === 'model' && row.model !== null) return { kind, model: row.model };
  throw new Error(`access_grants row has a broken ${row.targetKind} target`);
}

/** The holder of a row; the CHECK keeps exactly one of role and employee. */
function holderOf(
  row: Pick<AccessGrantRow, 'roleId' | 'userId'>,
): StoredGrant['holder'] {
  if (row.roleId !== null) return { kind: 'role', id: row.roleId };
  if (row.userId !== null) return { kind: 'user', id: row.userId };
  throw new Error('access_grants row has a broken holder');
}

/** A row as `effectiveAccess` reads it. */
export function toGrantRow(row: AccessGrantRow): GrantRow {
  return {
    id: row.id,
    effect: row.effect as GrantEffect,
    target: targetOf(row),
    quotaUsd: row.quotaUsd,
  };
}

/** The grant as the admin sees it, but for the role's name: model target with the catalogue name. */
export function toStoredGrant({
  grant,
  modelName,
}: AccessGrantWithModelName): StoredGrant {
  const target = targetOf(grant);
  return {
    id: grant.id,
    holder: holderOf(grant),
    effect: grant.effect as GrantEffect,
    target:
      target.kind === 'model'
        ? { ...target, modelName: modelName ?? '' }
        : target,
    quotaUsd: grant.quotaUsd,
    createdAt: grant.createdAt.toISOString(),
  };
}

/** The columns a new grant writes. */
export function grantColumnsOf(body: CreateGrantBody): NewAccessGrantRow {
  const { target } = body;
  return {
    roleId: body.roleId ?? null,
    userId: body.userId ?? null,
    effect: body.effect,
    targetKind: target.kind,
    server: target.kind === 'model' ? null : target.server,
    tool: target.kind === 'tool' ? target.tool : null,
    model: target.kind === 'model' ? target.model : null,
    quotaUsd: body.quotaUsd ?? null,
  };
}
