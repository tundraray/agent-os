import {
  toolCoverage,
  type LevelTool,
  type RoleLevel,
} from '@agent-os/contracts';
import type { LevelValue } from './use-level-draft';

/** A role's level on one server with its picked tools — the value of a row of «Серверы роли» and «Роли сервера». */
export type RoleLevelValue = LevelValue<RoleLevel, readonly string[]>;

export const ROLE_LEVELS: readonly RoleLevel[] = [
  'none',
  'read',
  'all',
  'pick',
];

export const NO_ROLE_LEVEL: RoleLevelValue = { level: 'none', marks: [] };

/** Picks compare as sets: the order the admin checked them in is not a change. */
export function samePicked(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const names = new Set(a);
  return names.size === new Set(b).size && b.every((name) => names.has(name));
}

/** A tool of a level tab as the coverage rule takes it (access-levels KD-3). */
export const coverageTool = (tool: LevelTool) => ({
  tool: tool.name,
  readOnly: tool.readOnly,
  enabled: tool.enabled,
});

/**
 * How many of the server's tools the level gives now, by the coverage rule (access-levels KD-3): a tool switched
 * off for everyone never counts. `null` — the level gives nothing, or the server has not given its list: «—».
 */
export function roleGives(
  tools: readonly LevelTool[] | null,
  { level, marks }: RoleLevelValue,
): { n: number; total: number } | null {
  if (tools === null) return null;
  const n = tools.filter(
    (tool) =>
      toolCoverage({
        tool: coverageTool(tool),
        superAdmin: false,
        roles: [{ roleId: '', level, picked: marks }],
        personal: { level: 'none', marks: [] },
      }).state === 'available',
  ).length;
  return n === 0 ? null : { n, total: tools.length };
}

/**
 * The marks «Выборочно» starts with (UXRD KD-10): what the previous level gave — after «Все» every tool, after
 * «Только чтение» the read ones, after «Нет» none. Switched-off tools are marked too: the mark acts once they are on.
 */
export function rolePickStart(
  tools: readonly LevelTool[] | null,
  from: RoleLevel,
): readonly string[] {
  const listed = tools ?? [];
  if (from === 'all') return listed.map((tool) => tool.name);
  if (from === 'read')
    return listed.filter((tool) => tool.readOnly).map((tool) => tool.name);
  return [];
}
