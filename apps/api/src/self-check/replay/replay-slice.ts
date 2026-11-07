import type { RunRecord } from '@agent-os/engine';
import {
  createScenarioDataset,
  DATASET_VERSIONS,
  type DatasetVersion,
  generateGroundTruth,
  listScenarioSets,
  loadScenarioSet,
} from '@agent-os/mcp-fixture';
import { FIXTURE_SOURCE_ID } from '@agent-os/sources';

/** A fixture slice the program can start the fixture on: a pinned dataset version or a scenario of a known set. */
export type FixtureSlice =
  | {
      readonly kind: 'dataset';
      readonly snapshot: string;
      readonly dataset: DatasetVersion;
    }
  | {
      readonly kind: 'scenario';
      readonly snapshot: string;
      readonly setName: string;
      readonly scenarioId: string;
    };

/** Every slice the program knows, by its snapshot id. */
export type KnownFixtureSlices = ReadonlyMap<string, FixtureSlice>;

/** Where the slice of the original was taken from (KD-7). */
type SliceOrigin = 'run_row' | 'evidence';

/** Why the slice of the original cannot be determined (DC-5). */
type SliceUnknownReason =
  'no_slice' | 'several_slices' | 'not_fixture' | 'not_known';

export type ReplaySliceResult =
  | {
      readonly ok: true;
      readonly slice: FixtureSlice & { readonly from: SliceOrigin };
    }
  | {
      readonly ok: false;
      readonly code: 'replay_slice_unknown';
      readonly reason: SliceUnknownReason;
    };

/** The parts of the original's `RunRecord` the slice is read from. */
export interface ReplaySliceSource {
  readonly sourceSnapshots: RunRecord['sourceSnapshots'];
  readonly evidence: readonly {
    readonly provenance: Pick<
      RunRecord['evidence'][number]['provenance'],
      'sourceId' | 'snapshot'
    >;
  }[];
}

/**
 * The slices of `v1`, `v2` and every scenario of the known sets: by default the sets shipped in `@agent-os/mcp-fixture`
 * (`scenario-sets/`), listed from its files. A known set that does not load is a defect of the program, not of the
 * replayed investigation, so it throws.
 */
export function knownFixtureSlices(
  setNames: readonly string[] = listScenarioSets(),
): KnownFixtureSlices {
  const known = new Map<string, FixtureSlice>();
  for (const dataset of DATASET_VERSIONS) {
    const { snapshot } = generateGroundTruth(dataset);
    known.set(snapshot, { kind: 'dataset', snapshot, dataset });
  }
  for (const setName of setNames) {
    const loaded = loadScenarioSet(setName);
    if (!loaded.ok)
      throw new Error(
        `the known scenario set ${setName} does not load: ${loaded.reason}`,
      );
    for (const scenario of loaded.set.scenarios) {
      const { snapshot } = createScenarioDataset(scenario);
      // The same parameters give the same slice and the same logs, so the first set naming it serves it.
      if (!known.has(snapshot)) {
        known.set(snapshot, {
          kind: 'scenario',
          snapshot,
          setName,
          scenarioId: scenario.scenarioId,
        });
      }
    }
  }
  return known;
}

/**
 * The slice a replay starts the fixture on (KD-7, DC-5): the slices recorded in the run row at start; when none was
 * recorded or read, the slices of the evidence pages' provenance. Exactly one slice, of the fixture source, known to
 * the program — anything else is `replay_slice_unknown`, and nothing may be started.
 */
export function resolveReplaySlice(
  source: ReplaySliceSource,
  known: KnownFixtureSlices,
): ReplaySliceResult {
  const fromRow = Object.entries(source.sourceSnapshots ?? {}).flatMap(
    ([sourceId, snapshot]) =>
      snapshot === null ? [] : [{ sourceId, snapshot }],
  );
  const from: SliceOrigin = fromRow.length > 0 ? 'run_row' : 'evidence';
  const candidates = distinctSlices(
    fromRow.length > 0
      ? fromRow
      : source.evidence.map((page) => page.provenance),
  );
  if (candidates.length === 0) return unknown('no_slice');
  if (candidates.length > 1) return unknown('several_slices');
  const [{ sourceId, snapshot }] = candidates;
  if (sourceId !== FIXTURE_SOURCE_ID) return unknown('not_fixture');
  const slice = known.get(snapshot);
  if (slice === undefined) return unknown('not_known');
  return { ok: true, slice: { ...slice, from } };
}

interface SourceSlice {
  readonly sourceId: string;
  readonly snapshot: string;
}

function distinctSlices(slices: readonly SourceSlice[]): SourceSlice[] {
  const byKey = new Map<string, SourceSlice>();
  for (const slice of slices) {
    byKey.set(JSON.stringify([slice.sourceId, slice.snapshot]), {
      sourceId: slice.sourceId,
      snapshot: slice.snapshot,
    });
  }
  return [...byKey.values()];
}

function unknown(reason: SliceUnknownReason): ReplaySliceResult {
  return { ok: false, code: 'replay_slice_unknown', reason };
}
