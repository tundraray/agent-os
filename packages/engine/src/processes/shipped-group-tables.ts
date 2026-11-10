import deepResearchV3Verifier from './group-table.deep-research-v3-verifier.json' with { type: 'json' };

/**
 * The group tables shipped as data files of the package next to the shipped configurations (design-research-flow.md,
 * «Таблица групп v3»), one per pair of fingerprints of the checker agent, each imported as JSON like
 * `shipped-processes.ts` does. The `calibrate` command writes them; a claim with no table here gets the lowest group
 * (DC-11). Raw data: `createEngine` parses each through `GroupTableSchema`.
 */
export const shippedGroupTables: readonly unknown[] = [deepResearchV3Verifier];
