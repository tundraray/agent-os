import { z } from 'zod';
import { canonicalJson, sha256Hex } from './canonical-json.js';

export const DatasetVersionSchema = z.enum(['v1', 'v2']);
/** A pinned dataset version selected by `FIXTURE_DATASET`. */
export type DatasetVersion = z.infer<typeof DatasetVersionSchema>;

/** A time window filled evenly with `records` records; `start` inclusive, `end` exclusive. */
interface TimeSegment {
  start: string;
  end: string;
  records: number;
}

/** Generator parameters of one pinned dataset version; their canonical JSON names the snapshot. */
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

/** The week of logs `v1` serves; the tracker's tickets are created inside it too. */
export const LOG_WEEK = { start: '2026-09-14T00:00:00.000Z', end: '2026-09-21T00:00:00.000Z' } as const;

/** The first two days, dense; records 0–119 999 keep their content whatever is appended after them. */
const BASE_SEGMENT: Readonly<TimeSegment> = {
  start: LOG_WEEK.start,
  end: '2026-09-16T00:00:00.000Z',
  records: 120_000,
};
/** The rest of the week at about 4 000 records a day. */
const REST_OF_WEEK: Readonly<TimeSegment> = {
  start: BASE_SEGMENT.end,
  end: LOG_WEEK.end,
  records: 20_000,
};
const HOUR_AFTER_WINDOW: Readonly<TimeSegment> = {
  start: LOG_WEEK.end,
  end: '2026-09-21T01:00:00.000Z',
  records: 2_000,
};
const WEEK_SEGMENTS: readonly Readonly<TimeSegment>[] = [BASE_SEGMENT, REST_OF_WEEK];
const SHARED = {
  seed: 0x20260915,
  recordsPerBlock: 8,
  releaseAt: '2026-09-15T00:00:00.000Z',
  providerTimeoutMs: { beforeRelease: 3_000, afterRelease: 1_500 },
} as const;

export const DATASET_PARAMS: Readonly<Record<DatasetVersion, DatasetParams>> = {
  v1: { version: 'v1', ...SHARED, providerTimeoutMs: { ...SHARED.providerTimeoutMs }, segments: copied(WEEK_SEGMENTS) },
  v2: {
    version: 'v2',
    ...SHARED,
    providerTimeoutMs: { ...SHARED.providerTimeoutMs },
    segments: copied([...WEEK_SEGMENTS, HOUR_AFTER_WINDOW]),
  },
};

function copied(segments: readonly Readonly<TimeSegment>[]): TimeSegment[] {
  return segments.map((segment) => ({ ...segment }));
}

/** Snapshot id: `fx-<version>-<first 8 hex of sha256 of the canonical generator parameters>`. */
export function snapshotOf(params: DatasetParams): string {
  return `fx-${params.version}-${sha256Hex(canonicalJson(params)).slice(0, 8)}`;
}
