import deepResearchV1 from './deep-research.v1.json' with { type: 'json' };

/**
 * The deep-research configuration shipped as a data file of the package (KD-1). It is raw data: the assembly point
 * passes it through `loadProcessConfig` like any other configuration, there is no trusted path (AC-12.3, ADR-0005).
 */
export const deepResearchProcessV1: unknown = deepResearchV1;
