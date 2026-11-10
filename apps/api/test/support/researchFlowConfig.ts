import {
  claimAssessmentAgent,
  deepResearchProcessV3,
  definitionMemoryFingerprint,
  type GroupTable,
} from '@agent-os/engine';

/**
 * The configuration data of the v3 scenarios of `apps/api` (design-research-flow.md, Test Strategy). A copy of the idea
 * of `packages/engine/test/support/test-configs.ts`, which `apps/api` may not import (ADR-0004): the shipped v3 as data,
 * and the one number a scenario here changes.
 */

interface V3Definition {
  readonly limits: Readonly<Record<string, unknown>>;
}

interface V3Data {
  readonly agents: Readonly<Record<string, V3Definition>>;
}

/** What a scenario may change in the shipped data. */
export interface ResearchFlowOverrides {
  /** The worker's `limits.maxChildren`: the call over it is refused `children_limit`. */
  readonly workerMaxChildren?: number;
}

/** The shipped v3 as data, with only the named number changed; `createEngine` loads it as it loads the shipped one. */
export function researchFlowV3Config(
  overrides: ResearchFlowOverrides = {},
): unknown {
  if (overrides.workerMaxChildren === undefined) return deepResearchProcessV3;
  const shipped = deepResearchProcessV3 as V3Data;
  const worker = shipped.agents.worker;
  if (worker === undefined) {
    throw new Error('the shipped v3 has no worker definition');
  }
  return {
    ...shipped,
    agents: {
      ...shipped.agents,
      worker: {
        ...worker,
        limits: { ...worker.limits, maxChildren: overrides.workerMaxChildren },
      },
    },
  };
}

/** A definition's name and its prompt template. */
export interface AgentPrompt {
  readonly agent: string;
  readonly prompt: string;
}

/** The definitions of an agents-form configuration as the model doubles recognise them. */
export function agentPromptsOf(config: unknown): readonly AgentPrompt[] {
  const { agents } = config as {
    readonly agents?: Readonly<Record<string, { readonly prompt: string }>>;
  };
  if (agents === undefined) {
    throw new Error('the configuration has no agents');
  }
  return Object.entries(agents).map(([agent, { prompt }]) => ({
    agent,
    prompt,
  }));
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
 * The test group table of a v3 configuration: keyed by the pair of fingerprints of its loaded checker agent with an
 * empty memory, every profile in one group. It is built from the configuration, so an edited prompt still has a table.
 */
export function researchFlowGroupTable(config: unknown): GroupTable {
  const verifier = claimAssessmentAgent(config);
  if (verifier === null) {
    throw new Error(
      'the configuration has no definition of the form claim_assessment',
    );
  }
  const profiles = PROFILE_VALUES.claimType.flatMap((claimType) =>
    PROFILE_VALUES.valueCheck.flatMap((valueCheck) =>
      PROFILE_VALUES.independentRecords.flatMap((independentRecords) =>
        PROFILE_VALUES.contradictions.map((contradictions) => ({
          profile: {
            claimType,
            valueCheck,
            independentRecords,
            contradictions,
          },
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
    groups: [
      {
        group: RESEARCH_FLOW_TEST_GROUP,
        establishedPairs: 1,
        correctShare: 1,
      },
    ],
    pairKinds: [],
  };
}
