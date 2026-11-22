import { z } from 'zod';

/** Registry and employee connections of MCP servers (design-mcp-connect.md, Contract Definitions). */

/** Max length of a server name: it goes into tool names `mcp__<server>__<tool>`. */
export const MCP_SERVER_NAME_MAX_LENGTH = 32;
const MCP_SERVER_URL_MAX_LENGTH = 2048;
const MCP_SHARED_TOKEN_MAX_LENGTH = 4096;

/** Error codes of the mcp-connect part (`errorCode` of ApiErrorSchema). */
export const McpErrorCode = {
  MCP_SERVER_NOT_FOUND: 'MCP_SERVER_NOT_FOUND',
  MCP_SERVER_NAME_TAKEN: 'MCP_SERVER_NAME_TAKEN',
  MCP_SERVER_CHECK_FAILED: 'MCP_SERVER_CHECK_FAILED',
  MCP_SERVER_INCOMPLETE: 'MCP_SERVER_INCOMPLETE',
  MCP_ACCOUNT_REQUIRED: 'MCP_ACCOUNT_REQUIRED',
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

/** A tool of the registry list; `readOnly` is `true` only for `readOnlyHint: true`. */
export const McpToolViewSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  readOnly: z.boolean(),
});
export type McpToolView = z.infer<typeof McpToolViewSchema>;

/** Row of GET /api/admin/mcp-servers (by name). */
export const McpServerSummarySchema = z.object({
  name: McpServerNameSchema,
  url: McpServerUrlSchema,
  mode: McpServerModeSchema,
  status: McpServerStatusSchema,
  toolCount: z.number().int().nonnegative(),
});
export type McpServerSummary = z.infer<typeof McpServerSummarySchema>;

/** A registry server as the admin sees it: no token value, only whether it is set (AC-13.5). */
export const McpServerViewSchema = McpServerSummarySchema.extend({
  sharedTokenSet: z.boolean(),
  /** By name. */
  tools: z.array(McpToolViewSchema),
});
export type McpServerView = z.infer<typeof McpServerViewSchema>;

const registerFields = { name: McpServerNameSchema, url: McpServerUrlSchema };

/** Body of POST /api/admin/mcp-servers: the shared token is required for `shared` and absent for `oauth`. */
export const RegisterMcpServerBodySchema = z.discriminatedUnion('mode', [
  z.object({
    ...registerFields,
    mode: z.literal('shared'),
    sharedToken: SharedTokenSchema,
  }),
  z.object({
    ...registerFields,
    mode: z.literal('oauth'),
    sharedToken: z.never().optional(),
  }),
]);
export type RegisterMcpServerBody = z.infer<typeof RegisterMcpServerBodySchema>;

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
