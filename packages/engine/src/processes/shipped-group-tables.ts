import deepResearchV2Verifier from './group-table.deep-research-v2-verifier.json' with { type: 'json' };

/**
 * The group tables shipped as data files of the package next to the shipped configurations (design-engine.md, Data
 * Model: «Таблицы групп»), one per `verifier` model and prompt version, each imported as JSON like
 * `shipped-processes.ts` does. The `calibrate` command writes them; a claim of a configuration with no table here gets
 * the lowest group (DC-11). Raw data: `createEngine` parses each through `GroupTableSchema`.
 */
export const shippedGroupTables: readonly unknown[] = [deepResearchV2Verifier];
