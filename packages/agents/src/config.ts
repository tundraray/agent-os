import { z } from 'zod';

/** The limit of a `run_code` result, bytes (AC-07.3): the executor's protocol, not a setting. */
const CODE_RUN_RESULT_MAX_BYTES = 16_384;

/** An empty variable (`NAME=` in `.env`) means "not set": the default applies. */
const unsetWhenEmpty = (value: unknown) => (value === '' ? undefined : value);

const positiveInteger = (fallback: number) =>
  z.preprocess(unsetWhenEmpty, z.coerce.number().int().min(1).default(fallback));

/**
 * Runtime settings of design-agents.md: env names and defaults. Model providers, their keys and the
 * default models live in the database, never here (model-providers FR-02).
 */
const AgentsEnvSchema = z.object({
  AGENT_MAX_OUTPUT_TOKENS: positiveInteger(16_000),
  AGENT_MAX_DEPTH: positiveInteger(3),
  AGENT_COMPACT_AT_TOKENS: positiveInteger(200_000),
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

export interface AgentsConfig {
  readonly maxOutputTokens: number;
  /** `AGENT_MAX_DEPTH`: the largest depth of an agent; a conversation is at depth 0. */
  readonly maxDepth: number;
  /** `AGENT_COMPACT_AT_TOKENS`: input tokens of the previous call that start compaction. */
  readonly compactAtTokens: number;
  /** `MCP_CALL_TIMEOUT_MS`: limit of one MCP call. */
  readonly mcpCallTimeoutMs: number;
  /** `NODE_ENV` is not `production`: `http` server and authorization addresses pass the address rule. */
  readonly allowHttpUrls: boolean;
  /** `CODE_RUN_*` and the run's result limit. */
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
  /** The limit of a run's result, bytes: the executor's protocol, not a setting (AC-07.3). */
  readonly resultMaxBytes: number;
}

/**
 * Parses Runtime settings of the agents package. `variables` are the environment variables the
 * composition root hands over, `NODE_ENV` among them (ADR-0004: the package reads no environment). An
 * invalid value throws naming the variable — the start stops. Rights and model prices are not settings: they
 * come from the access gate (design-access.md KD-1).
 */
export function parseAgentsConfig(variables: Readonly<Record<string, unknown>>): AgentsConfig {
  const env = parseOrThrow(AgentsEnvSchema, variables, 'Invalid agents settings');
  return {
    maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS,
    maxDepth: env.AGENT_MAX_DEPTH,
    compactAtTokens: env.AGENT_COMPACT_AT_TOKENS,
    mcpCallTimeoutMs: env.MCP_CALL_TIMEOUT_MS,
    allowHttpUrls: env.NODE_ENV !== 'production',
    codeRun: {
      timeoutMs: env.CODE_RUN_TIMEOUT_MS,
      memoryMb: env.CODE_RUN_MEMORY_MB,
      maxToolCalls: env.CODE_RUN_MAX_TOOL_CALLS,
      maxConcurrent: env.CODE_RUN_MAX_CONCURRENT,
      maxConcurrentPerUser: env.CODE_RUN_MAX_CONCURRENT_PER_USER,
      resultMaxBytes: CODE_RUN_RESULT_MAX_BYTES,
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
