import { z } from 'zod';
import { canonicalJson, sha256Hex } from './canonical-json.js';

export const DatasetVersionSchema = z.enum(['v1', 'v2']);
export type DatasetVersion = z.infer<typeof DatasetVersionSchema>;
/** Every dataset version the fixture can serve. */
export const DATASET_VERSIONS: readonly DatasetVersion[] = DatasetVersionSchema.options;

/** A time window filled evenly with `records` records; `start` inclusive, `end` exclusive. */
export interface TimeSegment {
  start: string;
  end: string;
  records: number;
}

/** Generator parameters of one dataset version; their hash names the snapshot. */
export interface DatasetParams {
  version: DatasetVersion;
  seed: number;
  /** Records per block; one block holds one payment trace plus background records. */
  recordsPerBlock: number;
  /** Consecutive windows in index order; a later version only appends segments. */
  segments: TimeSegment[];
  releaseAt: string;
  /** Local `provider-adapter` timeout; the release lowers it while provider latency keeps one distribution. */
  providerTimeoutMs: { beforeRelease: number; afterRelease: number };
}

const BASE_SEGMENT: TimeSegment = {
  start: '2026-09-14T00:00:00.000Z',
  end: '2026-09-16T00:00:00.000Z',
  records: 120_000,
};
const HOUR_AFTER_WINDOW: TimeSegment = {
  start: '2026-09-16T00:00:00.000Z',
  end: '2026-09-16T01:00:00.000Z',
  records: 2_000,
};
const SHARED = {
  seed: 0x20260915,
  recordsPerBlock: 8,
  releaseAt: '2026-09-15T00:00:00.000Z',
  providerTimeoutMs: { beforeRelease: 3_000, afterRelease: 1_500 },
} as const;

export const DATASET_PARAMS: Readonly<Record<DatasetVersion, DatasetParams>> = {
  v1: { version: 'v1', ...SHARED, providerTimeoutMs: { ...SHARED.providerTimeoutMs }, segments: [BASE_SEGMENT] },
  v2: {
    version: 'v2',
    ...SHARED,
    providerTimeoutMs: { ...SHARED.providerTimeoutMs },
    segments: [BASE_SEGMENT, HOUR_AFTER_WINDOW],
  },
};

/** Snapshot id: `fx-<version>-<first 8 hex of sha256 of the canonical generator parameters>`. */
export function snapshotOf(params: DatasetParams): string {
  return `fx-${params.version}-${sha256Hex(canonicalJson(params)).slice(0, 8)}`;
}
