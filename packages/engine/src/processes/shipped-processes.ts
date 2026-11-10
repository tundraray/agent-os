import deepResearchV3 from './deep-research.v3.json' with { type: 'json' };

/**
 * The deep-research configuration shipped as a data file of the package (KD-1, KD-7, ADR-0009): version 3, the agents
 * form; investigations started on an earlier version read their frozen configuration from their own rows. It is raw
 * data: the assembly point passes it through the same load as any other configuration, there is no trusted path
 * (AC-12.3).
 */
export const deepResearchProcessV3: unknown = deepResearchV3;
