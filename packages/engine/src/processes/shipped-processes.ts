import deepResearchV2 from './deep-research.v2.json' with { type: 'json' };

/**
 * The deep-research configuration shipped as a data file of the package (KD-1, KD-7: version 2 replaced version 1;
 * investigations started on version 1 read their frozen configuration from their own rows). It is raw data: the
 * assembly point passes it through `loadProcessConfig` like any other configuration, there is no trusted path
 * (AC-12.3, ADR-0005).
 */
export const deepResearchProcessV2: unknown = deepResearchV2;
