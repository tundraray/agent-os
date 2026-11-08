import { deepResearchProcessV2 } from '@agent-os/engine';
import { agentMarker } from './scriptedModel.js';

/**
 * Process configurations of the integration file, as data — each passes the same loader as the shipped one (KD-1).
 * They are derived from the shipped deep-research configuration and differ only where a case needs it; the counting
 * source impersonates the fixture, so their `sources` pass the DC-14 check unchanged.
 */

type Fields = Readonly<Record<string, unknown>>;
type Role = 'plan' | 'controller' | 'worker' | 'verifier' | 'synthesis';

/** The fields of the shipped data a test configuration overrides. */
interface ConfigData extends Fields {
  readonly roles: Readonly<Record<Role, Fields>>;
  readonly limits: Fields;
}

const base = deepResearchProcessV2 as ConfigData;

function withRoles(overrides: Partial<Record<Role, Fields>>): ConfigData['roles'] {
  const roles: Record<Role, Fields> = { ...base.roles };
  for (const [name, fields] of Object.entries(overrides) as [Role, Fields][]) {
    roles[name] = { ...base.roles[name], ...fields };
  }
  return roles;
}

/**
 * The second configuration of AC-12.1 (UC-9): another goal, no `verify` and no `analyze`, other prompt text and other
 * windows. Its prompts carry markers a test finds in the packets the model double received.
 */
export const SECOND_CONFIG_MARKER = 'SECOND-CONFIG-PROMPT';
const secondConfig = {
  ...base,
  processId: 'incident-summary',
  version: 1,
  goal: 'Summarise the incident the question names from the logs, without deep analysis.',
  capabilities: ['plan', 'gather', 'synthesize'],
  roles: withRoles({
    plan: {
      prompt: `${SECOND_CONFIG_MARKER} plan. Goal: {{goal}}\nQuestion: {{query}}\nWrite readiness criteria and branches.`,
      windowTokens: 5_000,
      marginTokens: 250,
    },
    controller: {
      prompt: `${SECOND_CONFIG_MARKER} controller. Goal: {{goal}}\nQuestion: {{query}}\nChoose one admissible decision.`,
      windowTokens: 6_000,
      marginTokens: 300,
    },
  }),
};

/** C5 step_limit (AC-03.2): two steps at most. */
const twoStepConfig = { ...base, processId: 'two-steps', limits: { ...base.limits, maxSteps: 2 } };

/**
 * C5 context_overflow (DC-8): a controller window smaller than its mandatory input — the rendered prompt alone is
 * longer than 400 counted tokens of the harness counter (one per character).
 */
const narrowControllerConfig = {
  ...base,
  processId: 'narrow-controller',
  roles: withRoles({ controller: { windowTokens: 400, marginTokens: 20 } }),
};

/** C6 (DC-15): versions of one process that differ only in the controller prompt's marker. */
export const VERSIONED_PROCESS_ID = 'versioned';
export const versionMarker = (version: number) => `VERSION-${version}-PROMPT`;
export function versionedConfig(version: number) {
  return {
    ...base,
    processId: VERSIONED_PROCESS_ID,
    version,
    roles: withRoles({
      plan: { prompt: `${versionMarker(version)} plan. Goal: {{goal}}\nQuestion: {{query}}` },
      controller: { prompt: `${versionMarker(version)} controller. Goal: {{goal}}\nQuestion: {{query}}` },
    }),
  };
}

/** Every configuration a default harness of the file loads. */
export const TEST_PROCESSES: readonly unknown[] = [base, secondConfig, twoStepConfig, narrowControllerConfig];

// ---------------------------------------------------------------------------------------------------------------
// The probe process of agent-core (design-agent-core.md, Test Strategy): the agents form, data only
// ---------------------------------------------------------------------------------------------------------------

/** The probe's process id: nothing in `src` names it (ADR-0009, «второй процесс из одних данных»). */
export const PROBE_PROCESS_ID = 'agent-probe';

/** The four definitions of the probe. */
export type ProbeAgent = 'lead' | 'helper' | 'leaf' | 'recorder';

/** The `limits` of one probe definition. */
export interface ProbeLimits {
  readonly maxTurns: number;
  readonly maxCallsPerTurn: number;
  readonly maxChildren: number;
  readonly runTokens: number;
  readonly deadlineMs: number;
  readonly windowTokens: number;
  readonly marginTokens: number;
  readonly maxOutputTokens: number;
}

/**
 * Plausible windows (design 1.6.1, Test Strategy): each is above its definition's least view as the load estimates it
 * (bytes over `BYTES_PER_TOKEN`, DC-1), and the input the counting doubles count for the scenarios (one token per
 * character, test/support/turnCount.ts) fits every one of them without a window step. `runTokens` is at least one turn.
 */
const PROBE_LIMITS: Readonly<Record<ProbeAgent, ProbeLimits>> = {
  lead: {
    maxTurns: 8,
    maxCallsPerTurn: 4,
    maxChildren: 4,
    runTokens: 400_000,
    deadlineMs: 900_000,
    windowTokens: 32_000,
    marginTokens: 1_000,
    maxOutputTokens: 1_000,
  },
  helper: {
    maxTurns: 6,
    maxCallsPerTurn: 4,
    maxChildren: 2,
    runTokens: 150_000,
    deadlineMs: 600_000,
    windowTokens: 32_000,
    marginTokens: 1_000,
    maxOutputTokens: 1_000,
  },
  leaf: {
    maxTurns: 4,
    maxCallsPerTurn: 2,
    maxChildren: 0,
    runTokens: 66_000,
    deadlineMs: 300_000,
    windowTokens: 32_000,
    marginTokens: 1_000,
    maxOutputTokens: 1_000,
  },
  recorder: {
    maxTurns: 4,
    maxCallsPerTurn: 2,
    maxChildren: 0,
    runTokens: 66_000,
    deadlineMs: 300_000,
    windowTokens: 32_000,
    marginTokens: 1_000,
    maxOutputTokens: 1_000,
  },
};

/** The model of each definition: `lead` on another catalog model than the rest, so NFR-02 checks each call's model. */
export const PROBE_MODELS: Readonly<Record<ProbeAgent, string>> = {
  lead: 'anthropic/claude-sonnet-5-5',
  helper: 'anthropic/claude-haiku-5-5',
  leaf: 'anthropic/claude-haiku-5-5',
  recorder: 'anthropic/claude-haiku-5-5',
};

export interface AgentProbeOptions {
  /** Another id, for a variant loaded beside the probe in one engine; {@link PROBE_PROCESS_ID} by default. */
  readonly processId?: string;
  readonly version?: number;
  /** Limits over {@link PROBE_LIMITS}, by definition. */
  readonly limits?: Partial<Readonly<Record<ProbeAgent, Partial<ProbeLimits>>>>;
  /** The form of `helper`: `text`, or `probe_deadline` in the variant of UC-E14. */
  readonly helperResult?: 'text' | 'probe_deadline';
  /** The investigation's token budget range; a test passes its exact budget at the start. */
  readonly investigationTokens?: { readonly default: number; readonly max: number };
  readonly maxTasks?: number;
  readonly maxToolCalls?: number;
}

const PROBE_PROMPTS: Readonly<Record<ProbeAgent, string>> = {
  lead: 'You lead a probe investigation toward the goal: {{goal}}. Keep notes in memory and delegate to helper.',
  helper: 'You help the lead of a probe investigation toward the goal: {{goal}}. Delegate to leaf or recorder.',
  leaf: 'You answer one narrow part of a probe investigation toward the goal: {{goal}}.',
  recorder: 'You record one result of a probe investigation toward the goal: {{goal}}.',
};

/**
 * The probe configuration as data (Test Strategy): `lead` (root; `memory_read`, `memory_write`, `call_agent` -> helper),
 * `helper` (`memory_read`, `memory_write`, `call_agent` -> leaf, recorder), `leaf` (`finish` only, form `text`, the
 * `modelKnowledgeRoot`), `recorder` (`finish` only, form `probe_record`); `agentLimits.maxDepth` 2; no sources. Every
 * prompt carries its agent's marker, so the model double tells the agent of a turn by its system prompt.
 */
export function agentProbeConfig(options: AgentProbeOptions = {}) {
  const limitsOf = (agent: ProbeAgent): ProbeLimits => ({ ...PROBE_LIMITS[agent], ...options.limits?.[agent] });
  const definition = (agent: ProbeAgent, fields: { tools: string[]; calls?: string[]; result: string }) => ({
    model: PROBE_MODELS[agent],
    effort: 'low',
    prompt: `${agentMarker(agent)} ${PROBE_PROMPTS[agent]}`,
    tools: fields.tools,
    calls: fields.calls ?? [],
    result: fields.result,
    limits: limitsOf(agent),
  });
  return {
    processId: options.processId ?? PROBE_PROCESS_ID,
    version: options.version ?? 1,
    goal: 'Exercise the agent runtime on data only.',
    sources: [],
    agents: {
      lead: definition('lead', { tools: ['memory_read', 'memory_write', 'call_agent'], calls: ['helper'], result: 'text' }),
      helper: definition('helper', {
        tools: ['memory_read', 'memory_write', 'call_agent'],
        calls: ['leaf', 'recorder'],
        result: options.helperResult ?? 'text',
      }),
      leaf: definition('leaf', { tools: [], result: 'text' }),
      recorder: definition('recorder', { tools: [], result: 'probe_record' }),
    },
    rootAgent: 'lead',
    modelKnowledgeRoot: 'leaf',
    agentLimits: { maxDepth: 2 },
    limits: {
      investigationTokens: options.investigationTokens ?? { default: 1_000_000, max: 2_000_000 },
      maxTasks: options.maxTasks ?? 40,
      maxToolCalls: options.maxToolCalls ?? 80,
    },
    answer: { sections: ['summary', 'established', 'unknown'] },
  };
}
