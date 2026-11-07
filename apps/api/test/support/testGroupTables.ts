import {
  deepResearchProcessV2,
  type GroupTable,
  loadProcessConfig,
  promptVersion,
} from '@agent-os/engine';

/**
 * A group table for the `verifier` role of a process configuration, so a test can boot `AppModule` (it passes
 * `requireCalibration`, DC-2) without the owner's real calibration. It names no profile: every claim gets the lowest
 * group, as without a table (DC-11), so the tests that boot the app keep the behaviour they had before the start
 * required a table. The fingerprint is `promptVersion` of the role's prompt template, as the engine looks it up.
 */
function testGroupTablesFor(processes: readonly unknown[]): GroupTable[] {
  return processes.map((data) => {
    const loaded = loadProcessConfig(data);
    if (!loaded.ok) {
      throw new Error(
        `test group table: the configuration is rejected (${loaded.rejection.message})`,
      );
    }
    const { verifier } = loaded.config.roles;
    return {
      model: verifier.model,
      promptVersion: promptVersion(verifier.prompt),
      scenarioSet: 'test',
      pairsFingerprint: '000000000000',
      calibratedAt: '2026-11-07T00:00:00.000Z',
      groupCount: 3,
      profiles: [],
      groups: [],
      pairKinds: [],
    };
  });
}

/** The group tables of the configurations `EngineModule` loads by default; `ENGINE_GROUP_TABLES` in every test boot. */
export const TEST_GROUP_TABLES: readonly GroupTable[] = testGroupTablesFor([
  deepResearchProcessV2,
]);
