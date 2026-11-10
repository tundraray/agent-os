import { canonicalJson, sha256Hex } from '../canonical-json.js';
import { createGeneratedDataset, type LogDataset, type LogService, type RecordDraft } from '../dataset.js';
import { BASE_SEGMENT, RECORDS_PER_BLOCK, SCENARIO_VERSION, type GeneratorParams } from '../versions.js';
import { MECHANISMS } from './mechanisms.js';
import { ScenarioParamsSchema, type ScenarioParams } from './scenario-params.js';

/** One scenario of a set: its stable id (`FIXTURE_SCENARIO=<set>/<id>`) and the parameters the generator builds it from. */
export interface Scenario {
  setName: string;
  scenarioId: string;
  params: ScenarioParams;
}

/** Generator parameters of a scenario dataset; the scenario parameters are hashed into the snapshot with the rest. */
interface ScenarioGeneratorParams extends GeneratorParams {
  version: typeof SCENARIO_VERSION;
  scenario: ScenarioParams;
}

const MINUTE_MS = 60_000;
const TRACE_ID_HEX_LENGTH = 32;
/** Event of a distractor record: a deploy of a service near the change, a plausible false cause. */
const DISTRACTOR_EVENT = 'service.deploy';
/** Event of the ordinary record that carries text addressed to the model. */
const INJECTION_EVENT = 'payment.audit';

/** A record the scenario places next to the generated traffic, at an absolute time. */
export interface PlantedRecord {
  kind: 'distractor' | 'injection';
  /** Position of the record in its parameter list (`distractors` or `injections`). */
  index: number;
  atMs: number;
  draft: Omit<RecordDraft, 'offsetMs'>;
}

/**
 * Logs of one scenario with the interface of `v1` and `v2`: the mechanism shapes the payment traces around the moment
 * of change, and the planted records sit at their offsets. The slice is `fx-sc-` plus 8 characters of the parameters
 * fingerprint, so a change of any scenario parameter gives another slice.
 */
export function createScenarioDataset(scenario: Scenario): LogDataset {
  const params = ScenarioParamsSchema.parse(scenario.params);
  const changeMs = Date.parse(params.changeAt);
  const generatorParams: ScenarioGeneratorParams = {
    version: SCENARIO_VERSION,
    seed: params.seed,
    recordsPerBlock: RECORDS_PER_BLOCK,
    segments: [{ ...BASE_SEGMENT }],
    scenario: params,
  };
  const planted = plantedRecords(params);
  return createGeneratedDataset({
    params: generatorParams,
    changeAt: params.changeAt,
    payment: MECHANISMS[params.mechanism].paymentModel(changeMs),
    planted: (block) =>
      planted
        .filter((record) => record.atMs >= block.startMs && record.atMs < block.startMs + block.spanMs)
        .map((record) => ({ ...record.draft, offsetMs: record.atMs - block.startMs })),
  });
}

/** Distractor and injection records of the scenario; their trace ids are fixed by the parameters. */
export function plantedRecords(params: ScenarioParams): PlantedRecord[] {
  const changeMs = Date.parse(params.changeAt);
  const atMs = (offsetMinutes: number): number => changeMs + offsetMinutes * MINUTE_MS;
  const traceIdOf = (kind: PlantedRecord['kind'], index: number): string =>
    sha256Hex(canonicalJson({ seed: params.seed, kind, index })).slice(0, TRACE_ID_HEX_LENGTH);

  const distractors = params.distractors.map(
    (distractor, index): PlantedRecord => ({
      kind: 'distractor',
      index,
      atMs: atMs(distractor.offsetMinutes),
      draft: plantedDraft(traceIdOf('distractor', index), distractor.service, DISTRACTOR_EVENT, `deploy of ${distractor.service} finished`),
    }),
  );
  const injections = params.injections.map(
    (injection, index): PlantedRecord => ({
      kind: 'injection',
      index,
      atMs: atMs(injection.offsetMinutes),
      draft: plantedDraft(traceIdOf('injection', index), 'payment-api', INJECTION_EVENT, injection.text),
    }),
  );
  return [...distractors, ...injections];
}

function plantedDraft(traceId: string, service: LogService, event: string, message: string): PlantedRecord['draft'] {
  return { traceId, spanSeq: 0, service, level: 'info', event, status: 'ok', durationMs: 0, message };
}
