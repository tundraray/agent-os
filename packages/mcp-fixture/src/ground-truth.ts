import { createLogDataset } from './dataset.js';
import { DATASET_PARAMS, type DatasetVersion } from './versions.js';

/**
 * Scenario answer key next to the data: why provider timeouts rose at the release, which explanation is wrong,
 * and the traces that time out only because of the new, lower local timeout.
 */
export interface GroundTruth {
  datasetVersion: DatasetVersion;
  snapshot: string;
  releaseAt: string;
  cause: {
    service: 'provider-adapter';
    summary: string;
    localTimeoutMsBeforeRelease: number;
    localTimeoutMsAfterRelease: number;
  };
  rejectedAlternative: {
    hypothesis: string;
    reason: string;
  };
  /** `provider.timeout` records whose request was sent before / at-or-after the release. */
  providerTimeouts: { beforeRelease: number; afterRelease: number };
  /** Traces after the release whose provider latency lies between the two timeouts, in time order. */
  affectedTraceIds: string[];
}

/** Derives the ground truth from the dataset itself, so the file can be checked against regeneration. */
export function generateGroundTruth(version: DatasetVersion): GroundTruth {
  const params = DATASET_PARAMS[version];
  const { beforeRelease, afterRelease } = params.providerTimeoutMs;
  const dataset = createLogDataset(version);
  const releaseMs = Date.parse(dataset.releaseAt);
  const providerTimeouts = { beforeRelease: 0, afterRelease: 0 };
  const affectedTraceIds: string[] = [];

  for (let index = 0; index < dataset.recordCount; index += 1) {
    const record = dataset.recordAt(index);
    if (record.service !== 'provider-adapter') {
      continue;
    }
    const requestMs = Date.parse(record.ts) - record.durationMs;
    const afterReleaseRequest = requestMs >= releaseMs;
    if (record.event === 'provider.timeout') {
      providerTimeouts[afterReleaseRequest ? 'afterRelease' : 'beforeRelease'] += 1;
    }
    if (
      record.event === 'provider.response' &&
      record.status === 'late' &&
      afterReleaseRequest &&
      record.durationMs <= beforeRelease
    ) {
      affectedTraceIds.push(record.traceId);
    }
  }

  return {
    datasetVersion: version,
    snapshot: dataset.snapshot,
    releaseAt: dataset.releaseAt,
    cause: {
      service: 'provider-adapter',
      summary: `the release lowered the provider-adapter local timeout from ${beforeRelease} ms to ${afterRelease} ms, so provider replies slower than ${afterRelease} ms now time out and arrive late`,
      localTimeoutMsBeforeRelease: beforeRelease,
      localTimeoutMsAfterRelease: afterRelease,
    },
    rejectedAlternative: {
      hypothesis: 'the payment provider became slower after the release',
      reason: 'provider latency follows one distribution before and after the release; only the local timeout changed',
    },
    providerTimeouts,
    affectedTraceIds,
  };
}
