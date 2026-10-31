import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { canonicalJson } from './canonical-json.js';
import { generateGroundTruth } from './ground-truth.js';
import { DATASET_VERSIONS, DatasetVersionSchema } from './versions.js';

/**
 * CLI: writes ground-truth/<version>.json for the versions named in argv (all versions when none are named).
 * Output is canonical JSON, so regeneration of the same version yields the same bytes.
 */
const requested = z.array(DatasetVersionSchema).parse(process.argv.slice(2));
const versions = requested.length > 0 ? requested : DATASET_VERSIONS;
const outputDir = fileURLToPath(new URL('../ground-truth/', import.meta.url));

mkdirSync(outputDir, { recursive: true });
for (const version of versions) {
  const groundTruth = generateGroundTruth(version);
  const file = `${outputDir}${version}.json`;
  writeFileSync(file, `${canonicalJson(groundTruth, 2)}\n`, 'utf8');
  console.log(`${file}: ${groundTruth.snapshot}, ${groundTruth.affectedTraceIds.length} affected traces`);
}
