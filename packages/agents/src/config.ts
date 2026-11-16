import { McpServerNameSchema } from '@agent-os/contracts';
import { z } from 'zod';

/** An empty variable (`NAME=` in `.env`) means "not set": the default applies. */
const unsetWhenEmpty = (value: unknown) => (value === '' ? undefined : value);

const positiveInteger = (fallback: number) =>
  z.preprocess(unsetWhenEmpty, z.coerce.number().int().min(1).default(fallback));

/** A model id the package resolves: only Anthropic models (`createResolveModel`). */
export const MODEL_ID_PATTERN = /^anthropic\/[^/\s]+$/;

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
  AGENTS_ANTHROPIC_BASE_URL: z.preprocess(unsetWhenEmpty, z.string().default('https://api.anthropic.com')),
  AGENT_MAX_OUTPUT_TOKENS: positiveInteger(16_000),
  AGENT_MAX_DEPTH: positiveInteger(3),
  AGENT_TOOL_RESULT_MAX_BYTES: positiveInteger(16_384),
  AGENT_COMPACT_AT_TOKENS: positiveInteger(200_000),
  MCP_ACCESS_TABLE: z.preprocess(unsetWhenEmpty, z.string().optional()),
  MCP_CALL_TIMEOUT_MS: positiveInteger(60_000),
  // design-code-execution.md, Runtime settings.
  CODE_RUN_TIMEOUT_MS: positiveInteger(30_000),
  CODE_RUN_MEMORY_MB: positiveInteger(512),
  CODE_RUN_MAX_TOOL_CALLS: positiveInteger(50),
  CODE_RUN_MAX_CONCURRENT: positiveInteger(4),
  CODE_RUN_MAX_CONCURRENT_PER_USER: positiveInteger(2),
  // Development is anything but `production`, unset included (plan Notes 10).
  NODE_ENV: z.preprocess(unsetWhenEmpty, z.string().optional()),
});

/** Keys are employee ids or `*`; values are registry server names, which are checked only for their form. */
const AccessTableSchema = z.record(z.string().min(1), z.array(McpServerNameSchema));

/** «Employee id → names of the servers they may use» (KD-5); a missing row means no servers. */
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
  /** `NODE_ENV` is not `production`: `http` server and authorization addresses pass the address rule. */
  readonly allowHttpUrls: boolean;
  /** `MCP_ACCESS_TABLE`. */
  readonly mcpAccess: McpAccessTable;
  /** `CODE_RUN_*`; a run's result limit is `toolResultMaxBytes`. */
  readonly codeRun: CodeRunConfig;
}

/** `CODE_RUN_*` (design-code-execution.md, Runtime settings). */
export interface CodeRunConfig {
  /** `CODE_RUN_TIMEOUT_MS`. */
  readonly timeoutMs: number;
  /** `CODE_RUN_MEMORY_MB`. */
  readonly memoryMb: number;
  /** `CODE_RUN_MAX_TOOL_CALLS`. */
  readonly maxToolCalls: number;
  /** `CODE_RUN_MAX_CONCURRENT`: runs at once in one API process (DC-13). */
  readonly maxConcurrent: number;
  /** `CODE_RUN_MAX_CONCURRENT_PER_USER`: runs of one employee at once in one API process (KD-11). */
  readonly maxConcurrentPerUser: number;
}

/**
 * The secret values of the settings (FR-11): the provider key. The logger redacts it, and `run_code` masks
 * it in a run's output and result. MCP tokens live in the database, never in the settings.
 */
export function secretValuesOf(config: AgentsConfig): string[] {
  return [config.anthropicApiKey].filter((secret) => secret !== '');
}

/**
 * Parses Runtime settings of the agents package. `variables` are the environment variables the
 * composition root hands over, `NODE_ENV` among them (ADR-0004: the package reads no environment). An
 * invalid value, or an access row with a server name that is not kebab-case, throws naming the variable —
 * the start stops.
 */
export function parseAgentsConfig(variables: Readonly<Record<string, unknown>>): AgentsConfig {
  const env = parseOrThrow(AgentsEnvSchema, variables, 'Invalid agents settings');
  return {
    defaultModel: env.AGENT_DEFAULT_MODEL,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    anthropicBaseUrl: env.AGENTS_ANTHROPIC_BASE_URL,
    maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS,
    maxDepth: env.AGENT_MAX_DEPTH,
    toolResultMaxBytes: env.AGENT_TOOL_RESULT_MAX_BYTES,
    compactAtTokens: env.AGENT_COMPACT_AT_TOKENS,
    mcpCallTimeoutMs: env.MCP_CALL_TIMEOUT_MS,
    allowHttpUrls: env.NODE_ENV !== 'production',
    mcpAccess: parseAccessTable(env.MCP_ACCESS_TABLE),
    codeRun: {
      timeoutMs: env.CODE_RUN_TIMEOUT_MS,
      memoryMb: env.CODE_RUN_MEMORY_MB,
      maxToolCalls: env.CODE_RUN_MAX_TOOL_CALLS,
      maxConcurrent: env.CODE_RUN_MAX_CONCURRENT,
      maxConcurrentPerUser: env.CODE_RUN_MAX_CONCURRENT_PER_USER,
    },
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
function parseAccessTable(value: string | undefined): McpAccessTable {
  const table = new Map<string, ReadonlySet<string>>();
  if (value === undefined || value.trim() === '') return table;
  const rows = parseOrThrow(
    AccessTableSchema,
    parseJson(value),
    'Invalid agents settings — MCP_ACCESS_TABLE, expected {"<employee id>": ["<server name>", …]}',
  );
  for (const [ownerId, servers] of Object.entries(rows)) {
    table.set(ownerId, new Set(servers));
  }
  return table;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      'Invalid agents settings — MCP_ACCESS_TABLE is not valid JSON: expected {"<employee id>": ["<server name>", …]}',
      { cause: error },
    );
  }
}
