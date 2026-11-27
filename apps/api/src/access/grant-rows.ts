import type {
  CreateGrantBody,
  Grant,
  GrantEffect,
  GrantTargetKind,
} from '@agent-os/contracts';
import type {
  AccessGrantRow,
  AccessGrantWithModelName,
  NewAccessGrantRow,
} from '@agent-os/db';

/** The holder of a grant: a role, or the employee personally. */
export interface GrantHolder {
  readonly kind: 'role' | 'user';
  readonly id: string;
}

/** The target of a stored grant row, `server_read` included (access-levels KD-1). */
export type GrantRowTarget =
  | { readonly kind: 'server'; readonly server: string }
  | { readonly kind: 'server_read'; readonly server: string }
  | { readonly kind: 'tool'; readonly server: string; readonly tool: string }
  | { readonly kind: 'model'; readonly model: string };

/** A target of a server's tools: what an access level is stored as. */
export type McpGrantRowTarget = Exclude<GrantRowTarget, { kind: 'model' }>;

/** A grant of the employee's roles or a personal one, as `effectiveAccess` and the level derivation read it. */
export interface GrantRow {
  readonly id: string;
  readonly holder: GrantHolder;
  readonly effect: GrantEffect;
  readonly target: GrantRowTarget;
  /** Only on a model allow; `null` — no quota. */
  readonly quotaUsd: number | null;
}

/** A grant as stored: the holder by id — the role's name is read in `identity` by the service. */
export type StoredGrant = Omit<Grant, 'holder'> & {
  readonly holder: GrantHolder;
};

/** The target of a row; the CHECK keeps exactly the columns of its kind set. */
function targetOf(
  row: Pick<AccessGrantRow, 'targetKind' | 'server' | 'tool' | 'model'>,
): GrantRowTarget {
  const kind = row.targetKind as GrantTargetKind;
  if (kind === 'server' && row.server !== null)
    return { kind, server: row.server };
  if (kind === 'server_read' && row.server !== null)
    return { kind, server: row.server };
  if (kind === 'tool' && row.server !== null && row.tool !== null)
    return { kind, server: row.server, tool: row.tool };
  if (kind === 'model' && row.model !== null) return { kind, model: row.model };
  throw new Error(`access_grants row has a broken ${row.targetKind} target`);
}

/** The holder of a row; the CHECK keeps exactly one of role and employee. */
function holderOf(row: Pick<AccessGrantRow, 'roleId' | 'userId'>): GrantHolder {
  if (row.roleId !== null) return { kind: 'role', id: row.roleId };
  if (row.userId !== null) return { kind: 'user', id: row.userId };
  throw new Error('access_grants row has a broken holder');
}

/** A row as `effectiveAccess` reads it. */
export function toGrantRow(row: AccessGrantRow): GrantRow {
  return {
    id: row.id,
    holder: holderOf(row),
    effect: row.effect as GrantEffect,
    target: targetOf(row),
    quotaUsd: row.quotaUsd,
  };
}

/**
 * The grant as the admin sees it, but for the role's name: the model with its catalogue name.
 * `/api/admin/grants` shows only model rows (access-levels KD-6); the service passes no other.
 */
export function toStoredGrant({
  grant,
  modelName,
}: AccessGrantWithModelName): StoredGrant {
  const target = targetOf(grant);
  if (target.kind !== 'model')
    throw new Error(`grant ${grant.id} is a ${target.kind} level row`);
  return {
    id: grant.id,
    holder: holderOf(grant),
    effect: grant.effect as GrantEffect,
    target: { ...target, modelName: modelName ?? '' },
    quotaUsd: grant.quotaUsd,
    createdAt: grant.createdAt.toISOString(),
  };
}

/** The columns a new grant writes. */
export function grantColumnsOf(body: CreateGrantBody): NewAccessGrantRow {
  return {
    roleId: body.roleId ?? null,
    userId: body.userId ?? null,
    effect: body.effect,
    targetKind: body.target.kind,
    server: null,
    tool: null,
    model: body.target.model,
    quotaUsd: body.quotaUsd ?? null,
  };
}
