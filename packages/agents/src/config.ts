import { z } from 'zod';

/** An empty variable (`NAME=` in `.env`) means "not set": the default applies. */
const unsetWhenEmpty = (value: unknown) => (value === '' ? undefined : value);

const positiveInteger = (fallback: number) =>
  z.preprocess(unsetWhenEmpty, z.coerce.number().int().min(1).default(fallback));

const text = (fallback: string) =>
  z.preprocess(unsetWhenEmpty, z.string().min(1).default(fallback));

/** A model id the package resolves: only Anthropic models (`createResolveModel`). */
export const MODEL_ID_PATTERN = /^anthropic\/[^/\s]+$/;

/** Ids of servers and names of definitions: kebab-case. */
export const KEBAB_CASE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Runtime settings of design-agents.md: env names and defaults. */
const AgentsEnvSchema = z.object({
  AGENT_DEFAULT_MODEL: z.preprocess(
    unsetWhenEmpty,
    z
      .string()
      .regex(MODEL_ID_PATTERN, 'expected anthropic/<model id>')
      .default('anthropic/claude-haiku-5-5'),
  ),
  // May stay empty: a deployment without a key starts, and the provider refuses its calls.
  ANTHROPIC_API_KEY: z.preprocess(unsetWhenEmpty, z.string().default('')),
  AGENTS_ANTHROPIC_BASE_URL: text('https://api.anthropic.com'),
  AGENT_MAX_OUTPUT_TOKENS: positiveInteger(16_000),
  AGENT_MAX_DEPTH: positiveInteger(3),
  AGENT_TOOL_RESULT_MAX_BYTES: positiveInteger(16_384),
  AGENT_COMPACT_AT_TOKENS: positiveInteger(200_000),
  MCP_ACCESS_TABLE: z.preprocess(unsetWhenEmpty, z.string().optional()),
  MCP_CALL_TIMEOUT_MS: positiveInteger(60_000),
});

/** One MCP server of the deployment's servers file (`MCP_SERVERS_FILE`); stdio only (KD-5). */
const McpServerSchema = z.object({
  id: z.string().regex(KEBAB_CASE_PATTERN, 'expected a kebab-case id'),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
});

const McpServersFileSchema = z
  .array(McpServerSchema)
  .min(1, 'the servers file names no server')
  .superRefine((servers, context) => {
    const seen = new Set<string>();
    servers.forEach((server, index) => {
      if (seen.has(server.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `server id ${server.id} repeats`,
        });
      }
      seen.add(server.id);
    });
  });

const AccessTableSchema = z.record(z.string().min(1), z.array(z.string()));

export type McpServerConfig = z.infer<typeof McpServerSchema>;

/** «Employee id → ids of the servers they may use» (KD-5); a missing row means no servers. */
export type McpAccessTable = ReadonlyMap<string, ReadonlySet<string>>;

export interface AgentsConfig {
  /** `AGENT_DEFAULT_MODEL`: the model when neither the launch nor the definition names one. */
  readonly defaultModel: string;
  /** `ANTHROPIC_API_KEY`: a secret of the logger; empty when not set. */
  readonly anthropicApiKey: string;
  /** `AGENTS_ANTHROPIC_BASE_URL`. */
  readonly anthropicBaseUrl: string;
  readonly maxOutputTokens: number;
  /** `AGENT_MAX_DEPTH`: the largest depth of an agent; a conversation is at depth 0. */
  readonly maxDepth: number;
  /** `AGENT_TOOL_RESULT_MAX_BYTES`: a longer result is cut. */
  readonly toolResultMaxBytes: number;
  /** `AGENT_COMPACT_AT_TOKENS`: input tokens of the previous call that start compaction. */
  readonly compactAtTokens: number;
  /** `MCP_CALL_TIMEOUT_MS`: limit of one MCP call. */
  readonly mcpCallTimeoutMs: number;
  /** Content of `MCP_SERVERS_FILE`. */
  readonly mcpServers: readonly McpServerConfig[];
  /** `MCP_ACCESS_TABLE`. */
  readonly mcpAccess: McpAccessTable;
}

/**
 * Parses Runtime settings of the agents package. `variables` are the environment variables the
 * composition root hands over (ADR-0004: the package reads no environment), `mcpServers` the parsed
 * JSON of the servers file, which the application reads like the prices file. An invalid value, a
 * servers file without servers, a repeated server id, or an access row naming a server the file does
 * not hold throws, naming the variable — the start stops.
 */
export function parseAgentsConfig(
  variables: Readonly<Record<string, unknown>>,
  mcpServers: unknown,
): AgentsConfig {
  const env = parseOrThrow(AgentsEnvSchema, variables, 'Invalid agents settings');
  const servers = parseOrThrow(
    McpServersFileSchema,
    mcpServers,
    'Invalid agents settings — MCP_SERVERS_FILE',
  );
  return {
    defaultModel: env.AGENT_DEFAULT_MODEL,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    anthropicBaseUrl: env.AGENTS_ANTHROPIC_BASE_URL,
    maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS,
    maxDepth: env.AGENT_MAX_DEPTH,
    toolResultMaxBytes: env.AGENT_TOOL_RESULT_MAX_BYTES,
    compactAtTokens: env.AGENT_COMPACT_AT_TOKENS,
    mcpCallTimeoutMs: env.MCP_CALL_TIMEOUT_MS,
    mcpServers: servers,
    mcpAccess: parseAccessTable(
      env.MCP_ACCESS_TABLE,
      new Set(servers.map((server) => server.id)),
    ),
  };
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, prefix: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  throw new Error(`${prefix} — ${problems.join('; ')}`);
}

/** Unset means an empty table: nobody has servers. */
function parseAccessTable(
  value: string | undefined,
  serverIds: ReadonlySet<string>,
): McpAccessTable {
  const table = new Map<string, ReadonlySet<string>>();
  if (value === undefined || value.trim() === '') return table;
  const rows = parseOrThrow(
    AccessTableSchema,
    parseJson(value),
    'Invalid agents settings — MCP_ACCESS_TABLE, expected {"<employee id>": ["<server id>", …]}',
  );
  for (const [ownerId, servers] of Object.entries(rows)) {
    const unknown = servers.find((serverId) => !serverIds.has(serverId));
    if (unknown !== undefined) {
      throw new Error(
        `Invalid agents settings — MCP_ACCESS_TABLE: employee ${ownerId} is given server ${unknown}, ` +
          `which MCP_SERVERS_FILE does not hold (servers: ${[...serverIds].join(', ')})`,
      );
    }
    table.set(ownerId, new Set(servers));
  }
  return table;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      'Invalid agents settings — MCP_ACCESS_TABLE is not valid JSON: expected {"<employee id>": ["<server id>", …]}',
      { cause: error },
    );
  }
}
