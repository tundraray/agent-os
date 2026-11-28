import type { GateTool } from '@agent-os/agents';
import { toolCoverage, type ToolCoverage } from '@agent-os/contracts';
import type { GrantRow, GrantRowTarget } from './grant-rows';
import {
  NO_LEVEL,
  roleLevelOf,
  serverLevels,
  type ServerLevel,
} from './levels';

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
  /** The coverage rule's answer for a tool the gate is asked about (access-levels KD-3, KD-4). */
  tool(tool: GateTool, superAdmin: boolean): ToolCoverage;
  model(model: string): ModelAccess;
  allowedModels(): string[];
}

type Match = (target: GrantRowTarget) => boolean;

/**
 * The employee's rights now. Tools (access-levels KD-1, KD-3): the MCP rows of each role and the personal ones
 * become levels by server, and the coverage rule answers for the tool. The gate is asked only of a tool the
 * admin left on: a switched-off one is refused before it (`checkCall`, the tool set). Models (design-access
 * KD-2): a model deny wins over any allow; quotas of all allows of a model add up, one allow without a quota
 * lifts the limit.
 */
export function effectiveAccess(rows: readonly GrantRow[]): EffectiveAccess {
  const allows = rows.filter((row) => row.effect === 'allow');
  const denies = rows.filter((row) => row.effect === 'deny');
  const allowed = (match: Match) =>
    allows.some((row) => match(row.target)) &&
    !denies.some((row) => match(row.target));

  const personal = serverLevels(
    rows.filter((row) => row.holder.kind === 'user'),
  );
  const roleIds = new Set(
    rows.flatMap((row) => (row.holder.kind === 'role' ? [row.holder.id] : [])),
  );
  const roles = [...roleIds].map((id) => ({
    id,
    levels: serverLevels(
      rows.filter((row) => row.holder.kind === 'role' && row.holder.id === id),
    ),
  }));
  const levelOn = (levels: ReadonlyMap<string, ServerLevel>, server: string) =>
    levels.get(server) ?? NO_LEVEL;

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
    tool: (tool, superAdmin) =>
      toolCoverage({
        tool: { tool: tool.tool, readOnly: tool.readOnly, enabled: true },
        superAdmin,
        roles: roles.map((role) =>
          roleLevelOf(role.id, levelOn(role.levels, tool.server)),
        ),
        personal: levelOn(personal, tool.server),
      }),
    model,
    allowedModels: () => {
      const ids = allows.flatMap((row) =>
        row.target.kind === 'model' ? [row.target.model] : [],
      );
      return [...new Set(ids)].filter((id) => allowed(modelMatch(id)));
    },
  };
}

/**
 * The catalogue models the rights allow, in catalogue order (by name, then id — `listModels`), quota
 * aside: an exhausted quota is temporary (KD-4). A model allowed but missing from the catalogue is left out.
 */
export function allowedCatalogue<Model extends { readonly id: string }>(
  access: EffectiveAccess,
  catalogue: readonly Model[],
): Model[] {
  const allowed = new Set(access.allowedModels());
  return catalogue.filter((model) => allowed.has(model.id));
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
