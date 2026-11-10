import {
  knownFixtureSlices,
  resolveReplaySlice,
  type KnownFixtureSlices,
  type ReplaySliceSource,
} from './replay-slice.js';

const V1 = 'fx-v1-2157485c';
const V2 = 'fx-v2-5311fe55';
/** `first/timeout-lowered-01`. */
const FIRST_SCENARIO = 'fx-sc-88559311';
/** `smoke/ledger-write-errors`. */
const SMOKE_SCENARIO = 'fx-sc-6030e7dc';

/** A catalog source with its slice, as the run row records it. */
function source(
  sourceId: string,
  snapshot: string | null,
): ReplaySliceSource['catalog'][number] {
  return { sourceId, snapshot };
}

function page(
  sourceId: string,
  snapshot: string,
): ReplaySliceSource['evidence'][number] {
  return { provenance: { sourceId, snapshot } };
}

let known: KnownFixtureSlices;

beforeAll(() => {
  known = knownFixtureSlices();
});

// DC-5, UC-E3, AC-02.1: a replay starts only on a slice the program knows, taken from the run row or else the pages.
describe('replay slice', () => {
  it.each<[string, ReplaySliceSource, unknown]>([
    [
      'the run row slice, which wins over the pages',
      { catalog: [source('fixture', V1)], evidence: [page('fixture', V2)] },
      { kind: 'dataset', snapshot: V1, dataset: 'v1', from: 'run_row' },
    ],
    [
      'a scenario slice from the run row',
      { catalog: [source('fixture', SMOKE_SCENARIO)], evidence: [] },
      {
        kind: 'scenario',
        snapshot: SMOKE_SCENARIO,
        setName: 'smoke',
        scenarioId: 'ledger-write-errors',
        from: 'run_row',
      },
    ],
    [
      'the one slice the fixture and the back office of a scenario both report',
      {
        catalog: [
          source('backoffice', SMOKE_SCENARIO),
          source('fixture', SMOKE_SCENARIO),
        ],
        evidence: [],
      },
      {
        kind: 'scenario',
        snapshot: SMOKE_SCENARIO,
        setName: 'smoke',
        scenarioId: 'ledger-write-errors',
        from: 'run_row',
      },
    ],
    [
      'the pages of an investigation without a catalog',
      {
        catalog: [],
        evidence: [page('fixture', V2), page('fixture', V2)],
      },
      { kind: 'dataset', snapshot: V2, dataset: 'v2', from: 'evidence' },
    ],
    [
      'the pages when the slice was not read at start',
      {
        catalog: [source('fixture', null)],
        evidence: [page('fixture', FIRST_SCENARIO)],
      },
      {
        kind: 'scenario',
        snapshot: FIRST_SCENARIO,
        setName: 'first',
        scenarioId: 'timeout-lowered-01',
        from: 'evidence',
      },
    ],
  ])('takes %s', (_, source, expected) => {
    const result = resolveReplaySlice(source, known);
    expect(result).toEqual({ ok: true, slice: expected });
  });

  it.each<[string, ReplaySliceSource, string]>([
    [
      'an empty catalog in the row and no pages',
      { catalog: [], evidence: [] },
      'no_slice',
    ],
    [
      'a catalog source without its slice and no pages',
      { catalog: [source('fixture', null)], evidence: [] },
      'no_slice',
    ],
    [
      'pages on several slices',
      {
        catalog: [],
        evidence: [page('fixture', V1), page('fixture', V2)],
      },
      'several_slices',
    ],
    [
      'several catalog sources with slices in the row',
      {
        catalog: [source('fixture', V1), source('other', 'other-slice')],
        evidence: [],
      },
      'several_slices',
    ],
    [
      'a row slice of another source',
      {
        catalog: [source('fixture', null), source('other', V1)],
        evidence: [],
      },
      'not_fixture',
    ],
    [
      'pages of another source',
      { catalog: [], evidence: [page('other', V1)] },
      'not_fixture',
    ],
    [
      'a fixture slice found neither in v1, v2 nor the known sets',
      {
        catalog: [source('fixture', 'fx-sc-00000000')],
        evidence: [],
      },
      'not_known',
    ],
  ])('refuses %s with replay_slice_unknown', (_, source, reason) => {
    expect(resolveReplaySlice(source, known)).toEqual({
      ok: false,
      code: 'replay_slice_unknown',
      reason,
    });
  });
});
