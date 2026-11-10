/**
 * Settings of the research engine (design-engine.md, Runtime settings) the assembly point reads from its
 * environment: the package reads none (ADR-0004). One base serves both `resolveModel` and `AnthropicTokenCounter`,
 * so a role call and its count go to the same address.
 */
export interface EngineSettings {
  /** Unversioned provider base: the model client gets `<base>/v1`, the counter `<base>/v1/messages/count_tokens`. */
  readonly anthropicBaseUrl: string;
  /** `ANTHROPIC_API_KEY`; empty when unset — the provider then refuses the call, the start does not stop. */
  readonly anthropicApiKey: string;
}

/** Everything the assembly point reads for the engine: the model provider's settings and the agent settings. */
export interface EngineStartSettings extends EngineSettings {
  /** The agent settings of design-agent-core.md (Runtime Settings) that `createEngine` takes. */
  readonly agent: AgentSettings;
  /** `RESEARCH_GROUP_TABLES_DIR` (design-research-flow.md, Runtime Settings): the deployment's group tables; empty when none. */
  readonly groupTablesDir: string;
}

/** design-agent-core.md, Runtime Settings: the agent runs' timings and the definition memory's admin role. */
export interface AgentSettings {
  /** `AGENT_ATTEMPT_SLICE_MS`: how long an attempt of an agent run works before it yields its slot. */
  readonly attemptSliceMs: number;
  /** `AGENT_BUSY_WAIT_MS`: how long a turn's reserve waits for other calls' reserves. */
  readonly busyWaitMs: number;
  /** `AGENT_TURN_MS`: how long one agent turn may take (DC-27). */
  readonly turnMs: number;
  /** `AGENT_DEADLINE_MARGIN_MS`: how much earlier a run's deadline is than its task's (DC-27). */
  readonly deadlineMarginMs: number;
  /** `AGENT_MEMORY_ADMIN_ROLE`: the role that writes and reads the definition memory's scope `deployment`. */
  readonly memoryAdminRole: string;
}

const BASE_URL_VARIABLE = 'RESEARCH_ANTHROPIC_BASE_URL';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** The variables and defaults of the agent timings (design-agent-core.md, Runtime Settings). */
const AGENT_MS_SETTINGS = {
  attemptSliceMs: { variable: 'AGENT_ATTEMPT_SLICE_MS', fallback: 300_000 },
  busyWaitMs: { variable: 'AGENT_BUSY_WAIT_MS', fallback: 30_000 },
  turnMs: { variable: 'AGENT_TURN_MS', fallback: 60_000 },
  deadlineMarginMs: { variable: 'AGENT_DEADLINE_MARGIN_MS', fallback: 90_000 },
} as const;
const MEMORY_ADMIN_ROLE_VARIABLE = 'AGENT_MEMORY_ADMIN_ROLE';
const DEFAULT_MEMORY_ADMIN_ROLE = 'agent-memory-admin';

/**
 * Parses the engine settings from `read` (the assembly point's environment). An empty or unset
 * `RESEARCH_ANTHROPIC_BASE_URL` takes the default; a value that is not an http(s) URL throws naming the variable.
 * The chat agent's base variable is never read: Mastra reads that one for its string models as a base with the version.
 * The five `AGENT_*` settings take the design's defaults when unset or empty; an invalid one throws naming it.
 * `RESEARCH_GROUP_TABLES_DIR` is taken as it is, empty when unset.
 */
export function parseEngineSettings(
  read: (name: string) => string | undefined,
): EngineStartSettings {
  return {
    anthropicBaseUrl: parseBaseUrl(read(BASE_URL_VARIABLE)),
    anthropicApiKey: read('ANTHROPIC_API_KEY') ?? '',
    agent: parseAgentSettings(read),
    groupTablesDir: read('RESEARCH_GROUP_TABLES_DIR') ?? '',
  };
}

/**
 * Stops the start when `AGENT_DEADLINE_MARGIN_MS` is less than the runtime's lease plus `AGENT_TURN_MS`
 * (design-agent-core.md, Runtime Settings, DC-27): the tool calls of a run's last turn may go on past its deadline,
 * and a child's deadline is its parent's minus one lease. The message names the three settings.
 */
export function assertDeadlineMargin(
  agent: AgentSettings,
  leaseMs: number,
): void {
  if (agent.deadlineMarginMs >= leaseMs + agent.turnMs) return;
  throw new Error(
    `AGENT_DEADLINE_MARGIN_MS (${agent.deadlineMarginMs}) must not be less than RUNTIME_LEASE_MS (${leaseMs}) + AGENT_TURN_MS (${agent.turnMs})`,
  );
}

function parseAgentSettings(
  read: (name: string) => string | undefined,
): AgentSettings {
  const ms = (key: keyof typeof AGENT_MS_SETTINGS): number => {
    const { variable, fallback } = AGENT_MS_SETTINGS[key];
    return parseMilliseconds(variable, read(variable), fallback);
  };
  const role = read(MEMORY_ADMIN_ROLE_VARIABLE);
  return {
    attemptSliceMs: ms('attemptSliceMs'),
    busyWaitMs: ms('busyWaitMs'),
    turnMs: ms('turnMs'),
    deadlineMarginMs: ms('deadlineMarginMs'),
    memoryAdminRole:
      role === undefined || role === '' ? DEFAULT_MEMORY_ADMIN_ROLE : role,
  };
}

/** Unset or empty takes `fallback`; anything but a whole number of milliseconds not less than 1 throws naming the variable. */
function parseMilliseconds(
  variable: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === '') return fallback;
  const ms = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(ms) || ms < 1) {
    throw new Error(
      `${variable} must be a whole number of milliseconds not less than 1, got "${value}"`,
    );
  }
  return ms;
}

function parseBaseUrl(value: string | undefined): string {
  if (value === undefined || value === '') return DEFAULT_ANTHROPIC_BASE_URL;
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
    throw new Error(
      `${BASE_URL_VARIABLE} must be an http(s) URL without the API version, got "${value}"`,
    );
  }
  return value;
}
