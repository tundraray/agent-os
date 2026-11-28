import { z } from 'zod';
import { GrantEffectSchema } from './access';
import { BuiltinRoleKindSchema } from './identity';
import { McpServerStatusSchema, McpToolViewSchema } from './mcp';
import { ApiErrorSchema } from './threads';

/** A role's level of access to one MCP server (access-levels KD-1). */
export const RoleLevelSchema = z.enum(['none', 'read', 'all', 'pick']);
export type RoleLevel = z.infer<typeof RoleLevelSchema>;

/** An employee's personal level: a role's levels and `denied` — no tool, whatever his roles give. */
export const UserLevelSchema = z.enum([...RoleLevelSchema.options, 'denied']);
export type UserLevel = z.infer<typeof UserLevelSchema>;

/** A tool picked in `pick`: a role's mark always allows, an employee's allows or denies it personally. */
export const ToolMarkSchema = z.object({
  tool: z.string().min(1),
  effect: GrantEffectSchema,
});
export type ToolMark = z.infer<typeof ToolMarkSchema>;

/** A role's level on the server of the tool asked about, with the tools it picked. */
export interface RoleCoverageLevel {
  readonly roleId: string;
  readonly level: RoleLevel;
  readonly picked: readonly string[];
}

/** The employee's personal level on the server of the tool asked about, with his marks. */
export interface PersonalCoverageLevel {
  readonly level: UserLevel;
  readonly marks: readonly ToolMark[];
}

/** What the coverage rule is asked: one tool of one server and the levels on that server (KD-3). */
export interface CoverageInput {
  /** The tool's name on its server, its effective class and whether the admin left it on. */
  readonly tool: {
    readonly tool: string;
    readonly readOnly: boolean;
    readonly enabled: boolean;
  };
  readonly superAdmin: boolean;
  /** The levels of the employee's roles, «Все сотрудники» included; a role absent here is `none`. */
  readonly roles: readonly RoleCoverageLevel[];
  readonly personal: PersonalCoverageLevel;
}

/** `disabled` — switched off for everyone; `denied` — denied personally; `none` — no level covers it. */
export type ToolCoverageState = 'disabled' | 'available' | 'denied' | 'none';

/** What gives the tool: the super-administrator role, a role's level or the personal level. */
export type AccessSource =
  | { readonly kind: 'super_admin' }
  | { readonly kind: 'role'; readonly roleId: string }
  | { readonly kind: 'personal' };

export interface ToolCoverage {
  readonly state: ToolCoverageState;
  /** Every level that covers the tool; under a personal deny the roles that would give it. */
  readonly sources: readonly AccessSource[];
}

/** Whether a level with its picked tools covers the tool: `all`, `read` of a read tool, or a pick of it. */
function covers(
  level: UserLevel,
  picked: readonly string[],
  tool: CoverageInput['tool'],
): boolean {
  if (level === 'all') return true;
  if (level === 'read') return tool.readOnly;
  if (level === 'pick') return picked.includes(tool.tool);
  return false;
}

/**
 * The coverage rule (access-levels KD-3, «How the tool check works», checks 2–5): a switched-off tool is
 * refused for everyone, the super-administrator included; then the super-administrator has every tool; then a
 * personal deny — `denied` or a deny mark — beats every role; then the tool is available when a role's level
 * or the personal level covers it.
 */
export function toolCoverage(input: CoverageInput): ToolCoverage {
  const { tool, personal } = input;
  if (!tool.enabled) return { state: 'disabled', sources: [] };
  if (input.superAdmin)
    return { state: 'available', sources: [{ kind: 'super_admin' }] };
  const roleSources: AccessSource[] = input.roles
    .filter((role) => covers(role.level, role.picked, tool))
    .map((role) => ({ kind: 'role', roleId: role.roleId }));
  const deniedPersonally =
    personal.level === 'denied' ||
    (personal.level === 'pick' &&
      personal.marks.some(
        (mark) => mark.tool === tool.tool && mark.effect === 'deny',
      ));
  if (deniedPersonally) return { state: 'denied', sources: roleSources };
  const personallyPicked = personal.marks
    .filter((mark) => mark.effect === 'allow')
    .map((mark) => mark.tool);
  const sources: AccessSource[] = covers(personal.level, personallyPicked, tool)
    ? [...roleSources, { kind: 'personal' }]
    : roleSources;
  return { state: sources.length === 0 ? 'none' : 'available', sources };
}

// ---------- Admin: levels of roles, employees and servers (access-levels KD-6) ----------

/** Error code of the level routes (`errorCode` of ApiErrorSchema). */
export const AccessLevelsErrorCode = {
  LEVELS_INVALID: 'LEVELS_INVALID',
} as const;

/**
 * `reason` of a 422 LEVELS_INVALID: `server_unknown` — no such server in the registry; `role_unknown` — no such
 * role; `tool_unknown` — a picked tool is neither in the server's list nor among the holder's saved marks;
 * `pick_without_list` — `pick` on a server that has not given its list. Nothing is changed (DC-2).
 */
export const LevelsInvalidReasonSchema = z.enum([
  'server_unknown',
  'role_unknown',
  'tool_unknown',
  'pick_without_list',
]);
export type LevelsInvalidReason = z.infer<typeof LevelsInvalidReasonSchema>;

/** 422 LEVELS_INVALID of a level save. */
export const LevelsInvalidErrorSchema = ApiErrorSchema.extend({
  errorCode: z.literal(AccessLevelsErrorCode.LEVELS_INVALID),
  reason: LevelsInvalidReasonSchema,
});
export type LevelsInvalidError = z.infer<typeof LevelsInvalidErrorSchema>;

/** A tool of a server as a level tab shows it: `readOnly` is the effective class (access-levels «LevelTool»). */
export const LevelToolSchema = McpToolViewSchema.pick({
  name: true,
  title: true,
  readOnly: true,
  enabled: true,
  isNew: true,
});
export type LevelTool = z.infer<typeof LevelToolSchema>;

/** The server of a level row: `tools` is `null` while the server has not given its list (no `pick` then). */
const levelServerFields = {
  server: z.string(),
  status: McpServerStatusSchema,
  tools: z.array(LevelToolSchema).nullable(),
};

const ToolNameSchema = z.string().min(1);

/** Picked tool names, each once. */
const PickedSchema = z
  .array(ToolNameSchema)
  .refine((picked) => new Set(picked).size === picked.length, {
    message: 'a tool is picked twice',
  });

/** An employee's marks, one per tool. */
const MarksSchema = z
  .array(ToolMarkSchema)
  .refine(
    (marks) => new Set(marks.map((mark) => mark.tool)).size === marks.length,
    { message: 'a tool is marked twice' },
  );

/** A role's level on one server; `picked` — its marks, orphans too (AC-37.7). */
export const RoleServerLevelSchema = z.object({
  ...levelServerFields,
  level: RoleLevelSchema,
  picked: z.array(z.string()),
});
export type RoleServerLevel = z.infer<typeof RoleServerLevelSchema>;

/** Response of GET and PUT /api/admin/roles/:id/levels: every registered server, by name. */
export const RoleLevelsSchema = z.object({
  servers: z.array(RoleServerLevelSchema),
});
export type RoleLevels = z.infer<typeof RoleLevelsSchema>;

/** A role with its level on one server, as the employee and server tabs show it. */
export const LevelRoleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  builtinKind: BuiltinRoleKindSchema.nullable(),
  level: RoleLevelSchema,
  picked: z.array(z.string()),
});
export type LevelRole = z.infer<typeof LevelRoleSchema>;

/** An employee's personal level on one server and the levels of his roles there that are not `none`. */
export const UserServerLevelSchema = z.object({
  ...levelServerFields,
  personal: z.object({
    level: UserLevelSchema,
    marks: z.array(ToolMarkSchema),
  }),
  /** «Все сотрудники» included. */
  roles: z.array(LevelRoleSchema),
});
export type UserServerLevel = z.infer<typeof UserServerLevelSchema>;

/** Response of GET and PUT /api/admin/users/:id/levels. */
export const UserLevelsSchema = z.object({
  /** In «Супер-администратор»: his personal levels are kept but do not act (uxrd EA-01). */
  superAdmin: z.boolean(),
  servers: z.array(UserServerLevelSchema),
});
export type UserLevels = z.infer<typeof UserLevelsSchema>;

/** Response of GET and PUT /api/admin/mcp-servers/:name/access: roles with a level, «Супер-администратор» left out. */
export const ServerAccessSchema = z.object({
  ...levelServerFields,
  roles: z.array(
    LevelRoleSchema.extend({
      memberCount: z.number().int().nonnegative().nullable(),
    }),
  ),
});
export type ServerAccess = z.infer<typeof ServerAccessSchema>;

/** Body of PUT /api/admin/roles/:id/levels: only the changed servers, each once; `picked` with `pick`. */
export const SaveRoleLevelsBodySchema = z.object({
  servers: z
    .array(
      z.object({
        server: z.string().min(1),
        level: RoleLevelSchema,
        picked: PickedSchema.default([]),
      }),
    )
    .refine(
      (rows) => new Set(rows.map((row) => row.server)).size === rows.length,
      { message: 'a server is named twice' },
    ),
});
export type SaveRoleLevelsBody = z.infer<typeof SaveRoleLevelsBodySchema>;

/** Body of PUT /api/admin/users/:id/levels: only the changed servers, each once; `marks` with `pick`. */
export const SaveUserLevelsBodySchema = z.object({
  servers: z
    .array(
      z.object({
        server: z.string().min(1),
        level: UserLevelSchema,
        marks: MarksSchema.default([]),
      }),
    )
    .refine(
      (rows) => new Set(rows.map((row) => row.server)).size === rows.length,
      { message: 'a server is named twice' },
    ),
});
export type SaveUserLevelsBody = z.infer<typeof SaveUserLevelsBodySchema>;

/** Body of PUT /api/admin/mcp-servers/:name/access: only the changed roles, each once; `picked` with `pick`. */
export const SaveServerAccessBodySchema = z.object({
  roles: z
    .array(
      z.object({
        roleId: z.uuid(),
        level: RoleLevelSchema,
        picked: PickedSchema.default([]),
      }),
    )
    .refine(
      (rows) => new Set(rows.map((row) => row.roleId)).size === rows.length,
      { message: 'a role is named twice' },
    ),
});
export type SaveServerAccessBody = z.infer<typeof SaveServerAccessBodySchema>;
