import { fileURLToPath } from 'node:url';

/** Absolute path of the fixture process entry (`dist/server.js`), resolved next to this module. */
export const fixtureServerPath: string = fileURLToPath(new URL('./server.js', import.meta.url));

export { argsHash, canonicalJson } from './canonical-json.js';
export { generateGroundTruth, type GroundTruth } from './ground-truth.js';
export { DATASET_VERSIONS, type DatasetVersion } from './versions.js';
export {
  buildCalibrationPairs,
  type CalibrationPair,
  type CalibrationPairSet,
} from './scenarios/calibration-pairs.js';
export { buildJudgeChecks, type JudgeCheck } from './scenarios/judge-checks.js';
export { createScenarioDataset, type Scenario } from './scenarios/scenario-dataset.js';
export {
  scenarioKey,
  type BeforeAfter,
  type ScenarioCause,
  type ScenarioDistractor,
  type ScenarioFacts,
  type ScenarioKey,
} from './scenarios/scenario-key.js';
export type { MechanismName, ScenarioParams } from './scenarios/scenario-params.js';
export {
  listScenarioSets,
  loadScenarioSet,
  type LoadScenarioSetOptions,
  type LoadScenarioSetResult,
  type ScenarioSet,
  type ScenarioSetRejection,
} from './scenarios/scenario-sets.js';
export type { LogDataset, LogRecord } from './dataset.js';
