import type {
  GrantEffect,
  RoleCoverageLevel,
  ToolMark,
  UserLevel,
} from '@agent-os/contracts';
import type { GrantRow, McpGrantRowTarget } from './grant-rows';

/** A holder's level on one server with its marks (access-levels KD-1); a role's marks all allow. */
export interface ServerLevel {
  readonly level: UserLevel;
  readonly marks: readonly ToolMark[];
}

/** A grant the save of a level writes: its effect and its target on the server. */
export interface LevelGrant {
  readonly effect: GrantEffect;
  readonly target: McpGrantRowTarget;
}

/** The MCP rows of one holder on one server, as the derivation reads them. */
type LevelRow = Pick<GrantRow, 'effect'> & {
  readonly target: McpGrantRowTarget;
};

export const NO_LEVEL: ServerLevel = { level: 'none', marks: [] };

/**
 * The level of one holder's MCP rows on one server («Как уровень выводится из прав»): of mixed kinds the first
 * wins — a server deny, a server allow, `server_read`, then the tool rows as `pick`. A mark of a tool the server
 * no longer lists stays a mark (AC-37.7).
 */
export function levelOf(rows: readonly LevelRow[]): ServerLevel {
  const has = (effect: GrantEffect, kind: McpGrantRowTarget['kind']) =>
    rows.some((row) => row.effect === effect && row.target.kind === kind);
  if (has('deny', 'server')) return { level: 'denied', marks: [] };
  if (has('allow', 'server')) return { level: 'all', marks: [] };
  if (has('allow', 'server_read')) return { level: 'read', marks: [] };
  const marks = rows.flatMap((row) =>
    row.target.kind === 'tool'
      ? [{ tool: row.target.tool, effect: row.effect }]
      : [],
  );
  return marks.length === 0 ? NO_LEVEL : { level: 'pick', marks };
}

/** The rows the save of a level writes on the server; `pick` without marks writes nothing, as `none`. */
export function grantsOfLevel(
  server: string,
  { level, marks }: ServerLevel,
): LevelGrant[] {
  switch (level) {
    case 'none':
      return [];
    case 'read':
      return [{ effect: 'allow', target: { kind: 'server_read', server } }];
    case 'all':
      return [{ effect: 'allow', target: { kind: 'server', server } }];
    case 'denied':
      return [{ effect: 'deny', target: { kind: 'server', server } }];
    case 'pick':
      return marks.map((mark) => ({
        effect: mark.effect,
        target: { kind: 'tool', server, tool: mark.tool },
      }));
  }
}

/** The levels of one holder's rows by server; model rows are not levels and are left out. */
export function serverLevels(
  rows: readonly GrantRow[],
): Map<string, ServerLevel> {
  const byServer = new Map<string, LevelRow[]>();
  for (const { effect, target } of rows) {
    if (target.kind === 'model') continue;
    byServer.set(target.server, [
      ...(byServer.get(target.server) ?? []),
      { effect, target },
    ]);
  }
  return new Map(
    [...byServer].map(([server, serverRows]) => [server, levelOf(serverRows)]),
  );
}

/** A role's level as the coverage rule takes it; the CHECK keeps denies off roles. */
export function roleLevelOf(
  roleId: string,
  { level, marks }: ServerLevel,
): RoleCoverageLevel {
  if (level === 'denied') throw new Error(`role ${roleId} holds a server deny`);
  return { roleId, level, picked: marks.map((mark) => mark.tool) };
}
