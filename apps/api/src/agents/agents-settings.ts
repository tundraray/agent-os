import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  'MCP_ACCESS_TABLE',
  'MCP_CALL_TIMEOUT_MS',
] as const;

/** `MCP_SERVERS_FILE` default, relative to the working directory of `apps/api`. */
const DEFAULT_MCP_SERVERS_FILE = 'config/mcp-servers.json';

/**
 * Reads the agents settings through `read` (the application's environment) and the servers file
 * (`MCP_SERVERS_FILE`, relative to `process.cwd()`), then parses both with `parseAgentsConfig`
 * (ADR-0004: only `apps/api` reads the environment and files). A missing or invalid file, or an invalid
 * value, throws naming the variable, which stops the start.
 */
export function readAgentsSettings(
  read: (name: string) => string | undefined,
): AgentsConfig {
  const variables = Object.fromEntries(
    AGENTS_VARIABLES.map((name) => [name, read(name)]),
  );
  return parseAgentsConfig(
    variables,
    readMcpServersFile(read('MCP_SERVERS_FILE')),
  );
}

/** The values of the servers' environment, for the logger (it skips the ones too short to redact by value). */
export function mcpServerSecrets(config: AgentsConfig): string[] {
  return config.mcpServers.flatMap((server) => Object.values(server.env));
}

function readMcpServersFile(file: string | undefined): unknown {
  const path = resolve(process.cwd(), file || DEFAULT_MCP_SERVERS_FILE);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Cannot load MCP servers (MCP_SERVERS_FILE) from ${path}`,
      { cause: error },
    );
  }
}
