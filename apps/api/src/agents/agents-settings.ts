import { parseAgentsConfig, type AgentsConfig } from '@agent-os/agents';

/** The variables of Runtime settings (design-agents.md) that `parseAgentsConfig` checks. */
const AGENTS_VARIABLES = [
  'AGENT_DEFAULT_MODEL',
  'ANTHROPIC_API_KEY',
  'AGENTS_ANTHROPIC_BASE_URL',
  'AGENT_MAX_OUTPUT_TOKENS',
  'AGENT_MAX_DEPTH',
  'AGENT_TOOL_RESULT_MAX_BYTES',
  'AGENT_COMPACT_AT_TOKENS',
  'MCP_CALL_TIMEOUT_MS',
  'CODE_RUN_TIMEOUT_MS',
  'CODE_RUN_MEMORY_MB',
  'CODE_RUN_MAX_TOOL_CALLS',
  'CODE_RUN_MAX_CONCURRENT',
  'CODE_RUN_MAX_CONCURRENT_PER_USER',
  // Development (`http` MCP addresses allowed) is anything but `production`.
  'NODE_ENV',
] as const;

/**
 * Reads the agents settings through `read` (the application's environment) and parses them with
 * `parseAgentsConfig` (ADR-0004: only `apps/api` reads the environment). An invalid value throws naming
 * the variable, which stops the start.
 */
export function readAgentsSettings(
  read: (name: string) => string | undefined,
): AgentsConfig {
  return parseAgentsConfig(
    Object.fromEntries(AGENTS_VARIABLES.map((name) => [name, read(name)])),
  );
}
