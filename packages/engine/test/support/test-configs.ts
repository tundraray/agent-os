import { deepResearchProcessV3, definitionMemoryFingerprint, type GroupTable } from '@agent-os/engine';
import { AgentProcessConfigSchema } from '../../src/config/agent-config.schema.js';
import { claimAssessmentAgent } from '../../src/research-flow/forms/claim-assessment.js';
import { type AgentPrompt, agentMarker } from './scriptedModel.js';

type Fields = Readonly<Record<string, unknown>>;

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
  /** The definitions whose template carries `{{sources}}` (UC-16, UC-2). */
  readonly sourcesField?: readonly ProbeAgent[];
  /** Tools a definition has beside its own, such as the tool marked as reading the run's sources. */
  readonly extraTools?: Partial<Readonly<Record<ProbeAgent, readonly string[]>>>;
  /** The process's `sources`; one counting-source pair by default. */
  readonly sources?: readonly { readonly sourceId: string; readonly toolName: string }[];
  /** The `sources` of a definition; a definition without them inherits its parent's. */
  readonly definitionSources?: Partial<Readonly<Record<ProbeAgent, readonly string[]>>>;
}

const PROBE_PROMPTS: Readonly<Record<ProbeAgent, string>> = {
  lead: 'You lead a probe investigation toward the goal: {{goal}}. Keep notes in memory and delegate to helper.',
  helper: 'You help the lead of a probe investigation toward the goal: {{goal}}. Delegate to leaf or recorder.',
  leaf: 'You answer one narrow part of a probe investigation toward the goal: {{goal}}.',
  recorder: 'You record one result of a probe investigation toward the goal: {{goal}}.',
};

/**
 * The process ceiling of a probe without `sources`: one pair of a counting source the harness connects, so the catalog
 * is not empty and the investigation runs in mode `sources` with `rootAgent` (an empty catalog means `modelKnowledgeRoot`).
 */
const DEFAULT_PROBE_CEILING = [{ sourceId: 'fixture', toolName: 'search_logs' }];

/** What a probe prompt with the field adds. */
const SOURCES_LINE = '\n\nSources:\n{{sources}}';

/**
 * The probe configuration as data (Test Strategy): `lead` (root; `memory_read`, `memory_write`, `call_agent` -> helper),
 * `helper` (`memory_read`, `memory_write`, `call_agent` -> leaf, recorder), `leaf` (`finish` only, form `text`, the
 * `modelKnowledgeRoot`), `recorder` (`finish` only, form `probe_record`); `agentLimits.maxDepth` 2; the ceiling is one counting-source pair. Every
 * prompt carries its agent's marker, so the model double tells the agent of a turn by its system prompt.
 */
export function agentProbeConfig(options: AgentProbeOptions = {}) {
  const limitsOf = (agent: ProbeAgent): ProbeLimits => ({ ...PROBE_LIMITS[agent], ...options.limits?.[agent] });
  const definition = (agent: ProbeAgent, fields: { tools: string[]; calls?: string[]; result: string }) => ({
    model: PROBE_MODELS[agent],
    effort: 'low',
    prompt: `${agentMarker(agent)} ${PROBE_PROMPTS[agent]}${options.sourcesField?.includes(agent) === true ? SOURCES_LINE : ''}`,
    tools: [...fields.tools, ...(options.extraTools?.[agent] ?? [])],
    calls: fields.calls ?? [],
    ...(options.definitionSources?.[agent] === undefined ? {} : { sources: options.definitionSources[agent] }),
    result: fields.result,
    limits: limitsOf(agent),
  });
  return {
    processId: options.processId ?? PROBE_PROCESS_ID,
    version: options.version ?? 1,
    goal: 'Exercise the agent runtime on data only.',
    sources: options.sources ?? DEFAULT_PROBE_CEILING,
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

// ---------------------------------------------------------------------------------------------------------------
// The shipped deep-research v3 (design-research-flow.md, Test Strategy)
// ---------------------------------------------------------------------------------------------------------------

/** The six definitions of the shipped v3. */
export type ResearchFlowAgent = 'controller' | 'planner' | 'worker' | 'subworker' | 'verifier' | 'synthesis';

/** The limits of a definition a scenario may change; a window stays the shipped one, so the load still accepts the result. */
export type ResearchFlowLimits = Pick<ProbeLimits, 'runTokens' | 'deadlineMs' | 'maxTurns' | 'maxChildren'>;

/** The numbers a scenario may change in the shipped data, and only them. */
export interface ResearchFlowOverrides {
  /** `limits.investigationTokens`. */
  readonly investigationTokens?: { readonly default: number; readonly max: number };
  readonly agents?: Partial<Readonly<Record<ResearchFlowAgent, Partial<ResearchFlowLimits>>>>;
  /** `agentLimits.maxDepth`. */
  readonly maxDepth?: number;
  /**
   * Text added at the end of a definition's prompt template: for the row that proves the load refuses it (UC-5), and for
   * the versions of C6, whose prompts carry their version's marker.
   */
  readonly promptSuffix?: Partial<Readonly<Record<ResearchFlowAgent, string>>>;
  /** `version`, for a second version of the process loaded beside the first (C6). */
  readonly version?: number;
}

interface V3Definition extends Fields {
  readonly prompt: string;
  readonly limits: Fields;
}

interface V3Data extends Fields {
  readonly sources: readonly SourcePair[];
  readonly agents: Readonly<Record<ResearchFlowAgent, V3Definition>>;
  readonly limits: Fields;
  readonly agentLimits: Fields;
}

interface SourcePair {
  readonly sourceId: string;
  readonly toolName: string;
}

/**
 * The ceiling of the catalog-planning scenarios (design-catalog-planning.md, Test Strategy): the shipped pairs and both
 * tools of `backoffice`, each pair once — the shipped v3 that names `backoffice` itself gets nothing twice.
 */
const BACKOFFICE_CEILING: readonly SourcePair[] = [
  { sourceId: 'backoffice', toolName: 'search_orders' },
  { sourceId: 'backoffice', toolName: 'get_order' },
];

function twoSourceCeiling(shipped: readonly SourcePair[]): readonly SourcePair[] {
  const named = new Set(shipped.map(({ sourceId, toolName }) => `${sourceId}/${toolName}`));
  return [...shipped, ...BACKOFFICE_CEILING.filter(({ sourceId, toolName }) => !named.has(`${sourceId}/${toolName}`))];
}

/**
 * The shipped v3 as data on the two-source ceiling (`fixture` and `backoffice`), with only the named numbers changed;
 * `createEngine` loads it as it loads the shipped one.
 */
export function researchFlowV3Config(overrides: ResearchFlowOverrides = {}) {
  const shipped = deepResearchProcessV3 as V3Data;
  const agents = Object.fromEntries(
    (Object.entries(shipped.agents) as [ResearchFlowAgent, V3Definition][]).map(([name, definition]) => [
      name,
      {
        ...definition,
        prompt: definition.prompt + (overrides.promptSuffix?.[name] ?? ''),
        limits: { ...definition.limits, ...overrides.agents?.[name] },
      },
    ]),
  );
  return {
    ...shipped,
    ...(overrides.version === undefined ? {} : { version: overrides.version }),
    sources: twoSourceCeiling(shipped.sources),
    agents,
    limits: { ...shipped.limits, ...(overrides.investigationTokens === undefined ? {} : { investigationTokens: overrides.investigationTokens }) },
    agentLimits: { ...shipped.agentLimits, ...(overrides.maxDepth === undefined ? {} : { maxDepth: overrides.maxDepth }) },
  };
}

/** The definitions of a process as the model double recognises them; data that does not load has none. */
export function agentPromptsOf(process: unknown): readonly AgentPrompt[] {
  const loaded = AgentProcessConfigSchema.safeParse(process);
  if (!loaded.success) return [];
  return Object.entries(loaded.data.agents).map(([agent, definition]) => ({ agent, prompt: definition.prompt }));
}

const PROFILE_VALUES = {
  claimType: ['observation', 'quantitative'],
  valueCheck: ['matched', 'unmatched', 'not_applicable'],
  independentRecords: ['one', 'two_or_more'],
  contradictions: [false, true],
} as const;

/** The group of every `supported` claim under {@link researchFlowGroupTable}: not `low`, which a claim gets with no table too. */
const RESEARCH_FLOW_TEST_GROUP = 'medium' as const;

/**
 * The test group table of a v3 configuration: keyed by the pair of fingerprints of its loaded `verifier` with an empty
 * memory, every profile in one group. It is built from the configuration, so a prompt edit does not turn a test red.
 */
export function researchFlowGroupTable(config: unknown): GroupTable {
  const verifier = claimAssessmentAgent(config);
  if (verifier === null) throw new Error('the configuration has no claim_assessment definition');
  const profiles = PROFILE_VALUES.claimType.flatMap((claimType) =>
    PROFILE_VALUES.valueCheck.flatMap((valueCheck) =>
      PROFILE_VALUES.independentRecords.flatMap((independentRecords) =>
        PROFILE_VALUES.contradictions.map((contradictions) => ({
          profile: { claimType, valueCheck, independentRecords, contradictions },
          group: RESEARCH_FLOW_TEST_GROUP,
        })),
      ),
    ),
  );
  return {
    model: verifier.model,
    agentFingerprint: verifier.agentFingerprint,
    definitionMemoryFingerprint: definitionMemoryFingerprint([]),
    scenarioSet: 'research-flow-test',
    pairsFingerprint: '000000000000',
    calibratedAt: '2026-11-09T00:00:00.000Z',
    groupCount: 3,
    profiles,
    groups: [{ group: RESEARCH_FLOW_TEST_GROUP, establishedPairs: 1, correctShare: 1 }],
    pairKinds: [],
  };
}
