import {
  type GroupTable,
  GroupTableSchema,
  shippedGroupTables,
} from '@agent-os/engine';

/**
 * `ENGINE_GROUP_TABLES` in every test boot: the shipped table of v3, keyed by the fingerprints of the shipped checker
 * agent. With an empty `deployment` memory it fits, so `Engine.checkCalibration` passes on each boot without a real
 * calibration.
 */
export const TEST_GROUP_TABLES: readonly GroupTable[] = shippedGroupTables.map(
  (table) => GroupTableSchema.parse(table),
);
