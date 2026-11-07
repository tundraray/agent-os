/**
 * The group tables shipped as data files of the package next to the shipped configurations (design-engine.md, Data
 * Model: «Таблицы групп»), one per `verifier` model and prompt version, each imported as JSON like
 * `shipped-processes.ts` does. The `calibrate` command writes them; none is calibrated yet, so a claim of the shipped
 * configuration gets the lowest group (DC-11). Raw data: `createEngine` parses each through `GroupTableSchema`.
 */
export const shippedGroupTables: readonly unknown[] = [];
