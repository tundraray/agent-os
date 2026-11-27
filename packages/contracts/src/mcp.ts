import { z } from 'zod';

/** Registry and employee connections of MCP servers (design-mcp-connect.md, Contract Definitions). */

/** Max length of a server name: it goes into tool names `mcp__<server>__<tool>`. */
export const MCP_SERVER_NAME_MAX_LENGTH = 32;
const MCP_SERVER_URL_MAX_LENGTH = 2048;
const MCP_SHARED_TOKEN_MAX_LENGTH = 4096;
/** Bound of a ready OAuth client's id and secret. */
const MCP_OAUTH_CLIENT_MAX_LENGTH = 1024;

/** Error codes of the mcp-connect part (`errorCode` of ApiErrorSchema). */
export const McpErrorCode = {
  MCP_SERVER_NOT_FOUND: 'MCP_SERVER_NOT_FOUND',
  MCP_SERVER_NAME_TAKEN: 'MCP_SERVER_NAME_TAKEN',
  MCP_SERVER_CHECK_FAILED: 'MCP_SERVER_CHECK_FAILED',
  MCP_SERVER_INCOMPLETE: 'MCP_SERVER_INCOMPLETE',
  MCP_ACCOUNT_REQUIRED: 'MCP_ACCOUNT_REQUIRED',
  /** The tool of PATCH /api/admin/mcp-servers/:name/tools/:tool is not in the server's list. */
  MCP_TOOL_NOT_FOUND: 'MCP_TOOL_NOT_FOUND',
} as const;
export type McpErrorCode = (typeof McpErrorCode)[keyof typeof McpErrorCode];

/** `reason` of a 422 MCP_SERVER_CHECK_FAILED. */
export const McpCheckFailureReasonSchema = z.enum([
  'unreachable',
  'timeout',
  'not_mcp',
  'unauthorized',
  'oauth_not_supported',
  'registration_rejected',
  'insecure_url',
]);
export type McpCheckFailureReason = z.infer<typeof McpCheckFailureReasonSchema>;

/** Registry name: kebab-case, never changes after registration. */
export const McpServerNameSchema = z
  .string()
  .max(MCP_SERVER_NAME_MAX_LENGTH)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'expected a kebab-case name');

/**
 * Server address. `http` passes here: outside development the server check answers 422
 * `insecure_url`, which carries a reason, unlike the pipe's 400.
 */
const McpServerUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(MCP_SERVER_URL_MAX_LENGTH);

const SharedTokenSchema = z.string().min(1).max(MCP_SHARED_TOKEN_MAX_LENGTH);

export const McpServerModeSchema = z.enum(['shared', 'oauth']);
export type McpServerMode = z.infer<typeof McpServerModeSchema>;

export const McpServerStatusSchema = z.enum([
  'enabled',
  'disabled',
  'awaiting_admin_account',
]);
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

// ---------- Admin: registry ----------

/**
 * A tool of the registry list (access-levels, «LevelTool и McpToolView»): `readOnly` is the effective class —
 * the admin's correction, else «changes» while the tool is new, else the server's mark, without a mark «changes»;
 * `serverReadOnly` is the server's mark, `null` when it gave none; `overridden` — the admin corrected the class;
 * `isNew` — a refresh added it and the admin has not marked the server's new tools reviewed since. A tool that is
 * new and not overridden is «changes» because it is new.
 */
export const McpToolViewSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  readOnly: z.boolean(),
  enabled: z.boolean(),
  isNew: z.boolean(),
  description: z.string(),
  serverReadOnly: z.boolean().nullable(),
  overridden: z.boolean(),
});
export type McpToolView = z.infer<typeof McpToolViewSchema>;

/**
 * The admin's setting of one tool in `mcp_servers.tool_settings` (access-levels KD-2): `enabled: false` — off for
 * everyone; `readOnly` — the corrected class. A missing field is no setting.
 */
export interface McpToolSetting {
  readonly enabled?: false;
  readonly readOnly?: boolean;
}

/** `mcp_servers.tool_settings`: the settings by tool name; an empty object — none. */
export type McpToolSettings = Readonly<Record<string, McpToolSetting>>;

/**
 * Body of PATCH /api/admin/mcp-servers/:name/tools/:tool: `enabled` and/or `readOnly`; `readOnly: null` returns
 * the class to the server's mark.
 */
export const UpdateMcpToolBodySchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    readOnly: z.boolean().nullable().optional(),
  })
  .refine((body) => body.enabled !== undefined || body.readOnly !== undefined, {
    message: 'enabled or readOnly is required',
  });
export type UpdateMcpToolBody = z.infer<typeof UpdateMcpToolBodySchema>;

/** Row of GET /api/admin/mcp-servers (by name). */
export const McpServerSummarySchema = z.object({
  name: McpServerNameSchema,
  url: McpServerUrlSchema,
  mode: McpServerModeSchema,
  status: McpServerStatusSchema,
  toolCount: z.number().int().nonnegative(),
});
export type McpServerSummary = z.infer<typeof McpServerSummarySchema>;

/**
 * A registry server as the admin sees it: no token or secret value, only whether it is set (AC-13.5, AC-35.5).
 * `oauthClientId` is the OAuth client of an `oauth` server — entered by the admin or registered by the platform —
 * and `null` for `shared`.
 */
export const McpServerViewSchema = McpServerSummarySchema.extend({
  sharedTokenSet: z.boolean(),
  oauthClientId: z.string().nullable(),
  oauthClientSecretSet: z.boolean(),
  /** By name. */
  tools: z.array(McpToolViewSchema),
});
export type McpServerView = z.infer<typeof McpServerViewSchema>;

const registerFields = { name: McpServerNameSchema, url: McpServerUrlSchema };

/**
 * Body of POST /api/admin/mcp-servers: the shared token is required for `shared` and absent for `oauth`.
 * `oauth` may carry a ready OAuth client (an app the admin created at the authorization server) for a server
 * that does not let clients register themselves; a secret goes only with its id.
 */
export const RegisterMcpServerBodySchema = z.discriminatedUnion('mode', [
  z.object({
    ...registerFields,
    mode: z.literal('shared'),
    sharedToken: SharedTokenSchema,
    oauthClientId: z.never().optional(),
    oauthClientSecret: z.never().optional(),
  }),
  z
    .object({
      ...registerFields,
      mode: z.literal('oauth'),
      sharedToken: z.never().optional(),
      oauthClientId: z
        .string()
        .trim()
        .min(1)
        .max(MCP_OAUTH_CLIENT_MAX_LENGTH)
        .optional(),
      oauthClientSecret: z
        .string()
        .min(1)
        .max(MCP_OAUTH_CLIENT_MAX_LENGTH)
        .optional(),
    })
    .refine(
      (body) =>
        body.oauthClientSecret === undefined ||
        body.oauthClientId !== undefined,
      { message: 'oauthClientSecret needs oauthClientId' },
    ),
]);
export type RegisterMcpServerBody = z.infer<typeof RegisterMcpServerBodySchema>;

/**
 * Response of GET /api/admin/mcp-servers/:name/callback-url: the OAuth return address (Redirect URI) of a server
 * of that name, registered or not yet — the admin enters it in the app he creates at the authorization server.
 */
export const McpCallbackUrlSchema = z.object({ url: z.string() });
export type McpCallbackUrl = z.infer<typeof McpCallbackUrlSchema>;

/** Body of PATCH /api/admin/mcp-servers/:name. Name, address and mode never change. */
export const UpdateMcpServerBodySchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    sharedToken: SharedTokenSchema.optional(),
  })
  .refine(
    (body) => body.enabled !== undefined || body.sharedToken !== undefined,
    {
      message: 'enabled or sharedToken is required',
    },
  );
export type UpdateMcpServerBody = z.infer<typeof UpdateMcpServerBodySchema>;

/** Response of POST /api/admin/mcp-servers/:name/tools/refresh: names of new and removed tools. */
export const RefreshMcpToolsResponseSchema = z.object({
  server: McpServerViewSchema,
  added: z.array(z.string()),
  removed: z.array(z.string()),
});
export type RefreshMcpToolsResponse = z.infer<
  typeof RefreshMcpToolsResponseSchema
>;

// ---------- Employee: connections ----------

export const McpConnectionStatusSchema = z.enum(['connected', 'needs_auth']);
export type McpConnectionStatus = z.infer<typeof McpConnectionStatusSchema>;

/** Row of GET /api/mcp/connections (by server name). */
export const McpConnectionSchema = z.object({
  server: McpServerNameSchema,
  url: McpServerUrlSchema,
  status: McpConnectionStatusSchema,
});
export type McpConnection = z.infer<typeof McpConnectionSchema>;
