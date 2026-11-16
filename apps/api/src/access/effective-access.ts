import type { GrantEffect, GrantTargetBody } from '@agent-os/contracts';

/** A grant of the employee's roles or a personal one, as read from `access_grants`. */
export interface GrantRow {
  readonly id: string;
  readonly effect: GrantEffect;
  readonly target: GrantTargetBody;
  /** Only on a model allow; `null` — no quota. */
  readonly quotaUsd: number | null;
}

export type ModelAccess =
  | { readonly allowed: false }
  | {
      readonly allowed: true;
      /** Sum of the parts; `null` — one allow without a quota lifts the limit. */
      readonly quotaUsd: number | null;
      readonly parts: readonly {
        readonly grantId: string;
        readonly quotaUsd: number | null;
      }[];
    };

export interface EffectiveAccess {
  tool(server: string, tool: string): boolean;
  model(model: string): ModelAccess;
  allowedModels(): string[];
}

type Match = (target: GrantTargetBody) => boolean;

/**
 * The employee's rights now (KD-2): a server deny closes all its tools, a tool deny that tool, a
 * model deny that model; a deny wins over any allow. A tool is open when its server or the tool
 * itself is allowed. Quotas of all allows of a model add up; one allow without a quota lifts the limit.
 */
export function effectiveAccess(rows: readonly GrantRow[]): EffectiveAccess {
  const allows = rows.filter((row) => row.effect === 'allow');
  const denies = rows.filter((row) => row.effect === 'deny');
  const allowed = (match: Match) =>
    allows.some((row) => match(row.target)) &&
    !denies.some((row) => match(row.target));

  const toolMatch =
    (server: string, tool: string): Match =>
    (target) =>
      (target.kind === 'server' && target.server === server) ||
      (target.kind === 'tool' &&
        target.server === server &&
        target.tool === tool);
  const modelMatch =
    (model: string): Match =>
    (target) =>
      target.kind === 'model' && target.model === model;

  function model(id: string): ModelAccess {
    if (!allowed(modelMatch(id))) return { allowed: false };
    const parts = allows
      .filter((row) => modelMatch(id)(row.target))
      .map((row) => ({ grantId: row.id, quotaUsd: row.quotaUsd }));
    return {
      allowed: true,
      quotaUsd: sumQuotas(parts.map((part) => part.quotaUsd)),
      parts,
    };
  }

  return {
    tool: (server, tool) => allowed(toolMatch(server, tool)),
    model,
    allowedModels: () => {
      const ids = allows.flatMap((row) =>
        row.target.kind === 'model' ? [row.target.model] : [],
      );
      return [...new Set(ids)].filter((id) => allowed(modelMatch(id)));
    },
  };
}

/** Quotas are in cents, so the sum is rounded to the cent against float drift. */
function sumQuotas(quotas: readonly (number | null)[]): number | null {
  if (quotas.some((quota) => quota === null)) return null;
  const cents = quotas.reduce<number>(
    (sum, quota) => sum + Math.round((quota ?? 0) * 100),
    0,
  );
  return cents / 100;
}
