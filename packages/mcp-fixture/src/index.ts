import { fileURLToPath } from 'node:url';

/** Absolute path of the fixture process entry (`dist/server.js`), resolved next to this module. */
export const fixtureServerPath: string = fileURLToPath(new URL('./server.js', import.meta.url));

export { argsHash, canonicalJson } from './canonical-json.js';
export { generateGroundTruth, type GroundTruth } from './ground-truth.js';
export { DATASET_VERSIONS, type DatasetVersion } from './versions.js';
