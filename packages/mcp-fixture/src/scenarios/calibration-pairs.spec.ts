import { buildCalibrationPairs, type CalibrationPair } from './calibration-pairs.js';
import { plantedRecords } from './scenario-dataset.js';
import { loadScenarioSet, type ScenarioSet } from './scenario-sets.js';

function setOf(name: string): ScenarioSet {
  const loaded = loadScenarioSet(name);
  if (!loaded.ok) {
    throw new Error(`set ${name}: ${loaded.detail}`);
  }
  return loaded.set;
}

type PageRecord = CalibrationPair['pages'][number]['records'][number];

function isCountGroup(record: PageRecord): record is Extract<PageRecord, { count: number }> {
  return 'count' in record;
}

// AC-03.3, UC-9: the calibration set the engine part needs.
describe('buildCalibrationPairs over the first set', () => {
  const set = setOf('first');
  let pairs: CalibrationPair[];

  beforeAll(() => {
    pairs = buildCalibrationPairs(set).pairs;
  }, 120_000);

  it('yields pairs of each of the five kinds, with and without text addressed to the model', () => {
    expect(new Set(pairs.map((pair) => pair.pairKind))).toEqual(
      new Set(['supported', 'values_match_meaning_wrong', 'causal', 'contradicted', 'insufficient']),
    );
    expect(new Set(pairs.map((pair) => pair.injected))).toEqual(new Set([true, false]));
  });

  it.each([
    ['supported', 'yes', ['observation', 'quantitative'], [true]],
    ['values_match_meaning_wrong', 'no', ['observation'], [true]],
    ['contradicted', 'no', ['quantitative'], [false]],
    ['insufficient', 'insufficient', ['observation'], [true]],
  ] as const)('gives %s pairs the expected answers', (kind, support, types, valuesMatch) => {
    const ofKind = pairs.filter((pair) => pair.pairKind === kind);
    expect(ofKind.length).toBeGreaterThan(0);
    for (const pair of ofKind) {
      expect(pair.expectedSupport, pair.pairId).toBe(support);
      expect(types).toContain(pair.expectedType);
      expect(valuesMatch).toContain(pair.expectedValuesMatch);
    }
  });

  it('expects a causal claim supported by its trace in a cause scenario and refuted in a no-cause one', () => {
    const mechanismOf = new Map(set.scenarios.map((scenario) => [scenario.scenarioId, scenario.params.mechanism]));
    const causal = pairs.filter((pair) => pair.pairKind === 'causal');
    expect(causal.length).toBe(set.scenarios.length);
    for (const pair of causal) {
      expect(pair.expectedType).toBe('causal');
      expect(pair.expectedSupport, pair.pairId).toBe(mechanismOf.get(pair.scenarioId) === 'no_cause' ? 'no' : 'yes');
    }
  });

  it('keeps 1 to 20 records per pair in pages with the scenario slice and a completeness flag', () => {
    for (const pair of pairs) {
      const records = pair.pages.reduce((sum, page) => sum + page.records.length, 0);
      expect(records, pair.pairId).toBeGreaterThanOrEqual(1);
      expect(records, pair.pairId).toBeLessThanOrEqual(20);
      for (const page of pair.pages) {
        expect(page.snapshot).toMatch(/^fx-sc-[0-9a-f]{8}$/);
        expect(page.complete).toBe(true);
      }
    }
  });

  it('gives every quantitative pair a page of count groups', () => {
    const quantitative = pairs.filter((pair) => pair.expectedType === 'quantitative');
    expect(quantitative.length).toBeGreaterThan(0);
    for (const pair of quantitative) {
      const countPage = pair.pages.find((page) => page.tool === 'aggregate_logs');
      expect(countPage, pair.pairId).toBeDefined();
      expect(countPage?.records.every((record) => isCountGroup(record))).toBe(true);
    }
  });

  it('marks a pair injected exactly when its records hold a trace with text addressed to the model', () => {
    const injectionIds = new Map(
      set.scenarios.map((scenario) => [
        scenario.scenarioId,
        new Set(plantedRecords(scenario.params).flatMap((record) => (record.kind === 'injection' ? [record.draft.traceId] : []))),
      ]),
    );
    for (const pair of pairs) {
      const ids = injectionIds.get(pair.scenarioId) ?? new Set<string>();
      const holdsInjection = pair.pages.some((page) =>
        page.records.some((record) => !isCountGroup(record) && ids.has(record.traceId)),
      );
      expect(holdsInjection, pair.pairId).toBe(pair.injected);
    }
  });
});

describe('calibration pair set fingerprint', () => {
  const smoke = setOf('smoke');

  it('is 12 hex characters, equal on two builds and different when one pair changes', () => {
    const first = buildCalibrationPairs(smoke);
    const second = buildCalibrationPairs(smoke);
    const [changed, ...rest] = smoke.scenarios;
    const reseeded = buildCalibrationPairs({
      ...smoke,
      scenarios: [{ ...changed, params: { ...changed.params, seed: changed.params.seed + 1 } }, ...rest],
    });

    expect(first.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(second.fingerprint).toBe(first.fingerprint);
    const untouched = (pairs: CalibrationPair[]): CalibrationPair[] =>
      pairs.filter((pair) => pair.scenarioId !== changed.scenarioId);
    expect(untouched(reseeded.pairs)).toEqual(untouched(first.pairs));
    expect(reseeded.fingerprint).not.toBe(first.fingerprint);
  }, 120_000);
});
