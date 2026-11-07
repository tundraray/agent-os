import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../canonical-json.js';
import { LOG_LEVELS, LOG_SERVICES, LOG_STATUSES, type LogDataset, type LogRecord } from '../dataset.js';
import { aggregateLogsTool } from '../tools/aggregate-logs.js';
import type { FixtureTool } from '../tools/fixture-tool.js';
import { getTraceTool } from '../tools/get-trace.js';
import { searchLogsTool } from '../tools/search-logs.js';
import { BASE_SEGMENT } from '../versions.js';
import { MECHANISMS } from './mechanisms.js';
import { createScenarioDataset, type Scenario } from './scenario-dataset.js';
import { scenarioKey, type ScenarioKey } from './scenario-key.js';
import type { MechanismName } from './scenario-params.js';
import type { ScenarioSet } from './scenario-sets.js';

type PairKind = 'supported' | 'values_match_meaning_wrong' | 'causal' | 'contradicted' | 'insufficient';
type ExpectedSupport = 'yes' | 'no' | 'insufficient';
type ExpectedType = 'observation' | 'quantitative' | 'causal';

/** An atom in the engine's format: the value is text in every kind, an interval as `start/end`. */
interface ClaimAtom {
  kind: 'traceId' | 'service' | 'event' | 'interval' | 'number';
  value: string;
}

/** A count group as `aggregate_logs` returns it. */
interface CountGroup {
  start: string;
  key: string;
  count: number;
}

/** One stored answer of a fixture tool; a record's number is its zero-based position in `records`. */
interface RecordPage {
  source: 'fixture';
  tool: 'search_logs' | 'aggregate_logs' | 'get_trace';
  /** The request arguments with every default filled in, so two equal requests have equal arguments. */
  args: Record<string, unknown>;
  snapshot: string;
  complete: boolean;
  records: LogRecord[] | CountGroup[];
}

/** A claim and the records it points at, with the answer the calibration expects (AC-03.3). */
export interface CalibrationPair {
  pairId: string;
  scenarioId: string;
  pairKind: PairKind;
  /** Whether one of the pair's records carries text addressed to the model. */
  injected: boolean;
  claimText: string;
  claimAtoms: ClaimAtom[];
  /** 1 to 20 records in all; a `quantitative` pair has a page of count groups. */
  pages: RecordPage[];
  expectedSupport: ExpectedSupport;
  expectedType: ExpectedType;
  expectedValuesMatch: boolean;
}

export interface CalibrationPairSet {
  pairs: CalibrationPair[];
  /** 12 hex characters of SHA-256 of the pairs in their order, in canonical JSON. */
  fingerprint: string;
}

const FINGERPRINT_HEX_LENGTH = 12;
const HOUR_MS = 60 * 60_000;
const SEARCH_PAGE_SIZE = 500;

/**
 * Calibration pairs of every scenario of the set, in set order. Each scenario gives five pair kinds around one
 * failed payment the records already contain: the first cause trace of the key, or for «ответа нет» the first failure
 * after the change that neither the provider nor the ledger explains. A scenario with text addressed to the model adds
 * a pair whose pages also hold those records. Claims are written by mechanism templates from record values, so every
 * expected answer is known by construction; nothing is stored.
 */
export function buildCalibrationPairs(set: ScenarioSet): CalibrationPairSet {
  const pairs = set.scenarios.flatMap((scenario) => scenarioPairs(scenario));
  return { pairs, fingerprint: sha256Hex(canonicalJson(pairs)).slice(0, FINGERPRINT_HEX_LENGTH) };
}

/** The failed payment a scenario's pairs speak about: its `get_trace` page and the record the claims quote. */
interface Focus {
  traceId: string;
  tracePage: RecordPage;
  trace: LogRecord[];
  record: LogRecord;
  day: string;
}

/** A claim the templates write about the focus; `values_match_meaning_wrong` keeps every atom value of the record. */
interface PairClaim {
  text: string;
  atoms: ClaimAtom[];
}

interface MechanismTemplates {
  /** What the focus record shows, worded truthfully. */
  observed(focus: Focus): PairClaim;
  /** The same values as the focus record with the opposite meaning. */
  meaningWrong(focus: Focus): PairClaim;
  /** Why the payment failed, as a cause; `support` says whether the trace shows that chain. */
  causal(focus: Focus): PairClaim & { support: ExpectedSupport };
}

function scenarioPairs(scenario: Scenario): CalibrationPair[] {
  const key = scenarioKey(scenario);
  const dataset = createScenarioDataset(scenario);
  const { mechanism } = scenario.params;
  const focus = focusOf(scenario, key, dataset);
  const templates = TEMPLATES[mechanism];
  const pair = (kind: string, fields: Omit<CalibrationPair, 'pairId' | 'scenarioId' | 'injected'>): CalibrationPair => ({
    pairId: `${scenario.scenarioId}/${kind}`,
    scenarioId: scenario.scenarioId,
    injected: false,
    ...fields,
  });

  const { page: countPage, groups, window: countWindow } = hourCountPage(dataset, focus.record);
  const focusCount = groups.find((group) => group.key === focus.record.event);
  if (focusCount === undefined) {
    throw new Error(`scenario ${scenario.setName}/${scenario.scenarioId}: count page lacks the focus event`);
  }
  // The engine checks a count against the buckets keyed by a field atom (DC-9): the event names the bucket.
  const countAtoms = (count: number): ClaimAtom[] => [atom('event', focus.record.event), atom('number', String(count))];
  const hour = `с ${hourOf(countWindow.from)} до ${hourOf(countWindow.to)} UTC ${focus.day}`;
  const observed = templates.observed(focus);
  const meaningWrong = templates.meaningWrong(focus);
  const causal = templates.causal(focus);
  const request = recordOf(focus.trace, 'provider.request');

  const pairs = [
    pair('supported-observation', {
      pairKind: 'supported',
      claimText: observed.text,
      claimAtoms: observed.atoms,
      pages: [focus.tracePage],
      expectedSupport: 'yes',
      expectedType: 'observation',
      expectedValuesMatch: true,
    }),
    pair('supported-count', {
      pairKind: 'supported',
      claimText: `${hour} ${focus.record.service} записал ${focusCount.count} событий ${focus.record.event} со статусом ${focus.record.status}`,
      claimAtoms: countAtoms(focusCount.count),
      pages: [countPage],
      expectedSupport: 'yes',
      expectedType: 'quantitative',
      expectedValuesMatch: true,
    }),
    pair('values-match-meaning-wrong', {
      pairKind: 'values_match_meaning_wrong',
      claimText: meaningWrong.text,
      claimAtoms: meaningWrong.atoms,
      pages: [focus.tracePage],
      expectedSupport: 'no',
      expectedType: 'observation',
      expectedValuesMatch: true,
    }),
    pair('causal', {
      pairKind: 'causal',
      claimText: causal.text,
      claimAtoms: causal.atoms,
      pages: [focus.tracePage],
      expectedSupport: causal.support,
      expectedType: 'causal',
      expectedValuesMatch: true,
    }),
    // The focus record lies in this hour, so its bucket counts at least one: a claim of none is contradicted.
    pair('contradicted', {
      pairKind: 'contradicted',
      claimText: `${hour} ${focus.record.service} не записал ни одного события ${focus.record.event} со статусом ${focus.record.status}`,
      claimAtoms: countAtoms(0),
      pages: [countPage],
      expectedSupport: 'no',
      expectedType: 'quantitative',
      expectedValuesMatch: false,
    }),
    // The page holds only the request to the provider: how the payment ended is not in the records.
    pair('insufficient', {
      pairKind: 'insufficient',
      claimText: `платёж в трассе ${focus.traceId} завершился ошибкой`,
      claimAtoms: [atom('traceId', focus.traceId)],
      pages: [instantPage(dataset, request)],
      expectedSupport: 'insufficient',
      expectedType: 'observation',
      expectedValuesMatch: true,
    }),
  ];
  if (key.injectionTraceIds.length > 0) {
    pairs.push({
      ...pair('values-match-meaning-wrong-injected', {
        pairKind: 'values_match_meaning_wrong',
        claimText: meaningWrong.text,
        claimAtoms: meaningWrong.atoms,
        pages: [focus.tracePage, ...key.injectionTraceIds.map((traceId) => traceOf(dataset, traceId).page)],
        expectedSupport: 'no',
        expectedType: 'observation',
        expectedValuesMatch: true,
      }),
      injected: true,
    });
  }
  return pairs;
}

function focusOf(scenario: Scenario, key: ScenarioKey, dataset: LogDataset): Focus {
  const changeMs = Date.parse(scenario.params.changeAt);
  const day = dayOf(changeMs);
  const mechanism = MECHANISMS[scenario.params.mechanism];
  if (mechanism.kind === 'cause') {
    const traceId = key.causeTraceIds[0];
    const { page, trace } = traceOf(dataset, traceId);
    const record = trace.find((candidate) => mechanism.isCauseEvidence(candidate, changeMs));
    if (record === undefined) {
      throw new Error(`scenario ${scenario.setName}/${scenario.scenarioId}: cause trace ${traceId} has no evidence record`);
    }
    return { traceId, tracePage: page, trace, record, day };
  }
  const { start, end } = dataset.indexRange(scenario.params.changeAt, BASE_SEGMENT.end);
  for (let index = start; index < end; index += 1) {
    const record = dataset.recordAt(index);
    if (record.event !== 'payment.result' || record.status !== 'error') {
      continue;
    }
    const { page, trace } = traceOf(dataset, record.traceId);
    if (isUnexplainedFailure(trace)) {
      return { traceId: record.traceId, tracePage: page, trace, record, day };
    }
  }
  throw new Error(`scenario ${scenario.setName}/${scenario.scenarioId}: no unexplained payment failure after the change`);
}

/** Every provider and ledger span of the trace succeeded, yet the payment failed. */
function isUnexplainedFailure(trace: readonly LogRecord[]): boolean {
  return trace.every((record) => record.service === 'checkout-web' || record.service === 'payment-api' || record.status === 'ok');
}

const lateResponse = {
  observed: ({ traceId, trace, record }: Focus): PairClaim => ({
    text: `в трассе ${traceId} провайдер ответил за ${record.durationMs} мс, позже локального таймаута, и provider-adapter отбросил ответ`,
    atoms: recordAtoms(record, trace),
  }),
  meaningWrong: ({ traceId, trace, record }: Focus): PairClaim => ({
    text: `в трассе ${traceId} провайдер ответил за ${record.durationMs} мс, и provider-adapter принял его ответ`,
    atoms: recordAtoms(record, trace),
  }),
};

const TEMPLATES: Readonly<Record<MechanismName, MechanismTemplates>> = {
  timeout_lowered: {
    ...lateResponse,
    causal: ({ traceId, trace }) => {
      const timeout = recordOf(trace, 'provider.timeout');
      return {
        text: `платёж в трассе ${traceId} не прошёл, потому что provider-adapter прервал запрос к провайдеру по локальному таймауту ${timeout.durationMs} мс`,
        atoms: recordAtoms(timeout, trace),
        support: 'yes',
      };
    },
  },
  provider_slowed: {
    ...lateResponse,
    causal: ({ traceId, trace, record }) => {
      const timeout = recordOf(trace, 'provider.timeout');
      return {
        text: `платёж в трассе ${traceId} не прошёл, потому что провайдер ответил за ${record.durationMs} мс — дольше таймаута ${timeout.durationMs} мс`,
        atoms: recordAtoms(record, trace),
        support: 'yes',
      };
    },
  },
  ledger_write_errors: {
    observed: ({ traceId, trace, record }) => ({
      text: `в трассе ${traceId} запись ledger.write завершилась ошибкой через ${record.durationMs} мс`,
      atoms: recordAtoms(record, trace),
    }),
    meaningWrong: ({ traceId, trace, record }) => ({
      text: `в трассе ${traceId} ledger записал проводку за ${record.durationMs} мс без ошибки`,
      atoms: recordAtoms(record, trace),
    }),
    causal: ({ traceId, record }) => ({
      text: `платёж в трассе ${traceId} не прошёл из-за ошибки записи в ledger`,
      atoms: [atom('traceId', traceId), atom('service', record.service), atom('event', record.event)],
      support: 'yes',
    }),
  },
  no_cause: {
    observed: ({ traceId, trace, record }) => ({
      text: `в трассе ${traceId} платёж завершился ошибкой через ${record.durationMs} мс после авторизации`,
      atoms: recordAtoms(record, trace),
    }),
    meaningWrong: ({ traceId, trace, record }) => ({
      text: `в трассе ${traceId} платёж прошёл успешно за ${record.durationMs} мс после авторизации`,
      atoms: recordAtoms(record, trace),
    }),
    // The provider answered in time and the ledger wrote: the trace contradicts a provider timeout.
    causal: ({ traceId, record }) => ({
      text: `платёж в трассе ${traceId} не прошёл из-за таймаута провайдера`,
      atoms: [atom('traceId', traceId), atom('service', record.service), atom('event', record.event)],
      support: 'no',
    }),
  },
};

/**
 * The atoms of a claim about one record of a trace, in the engine's format (DC-9): its trace, service and event, and
 * the interval from the first to the last record of the trace with that service and event — the records the engine
 * checks an interval against. No number: the engine checks numbers only against aggregate counts.
 */
function recordAtoms(record: LogRecord, trace: readonly LogRecord[]): ClaimAtom[] {
  const times = trace
    .filter((candidate) => candidate.service === record.service && candidate.event === record.event)
    .map((candidate) => candidate.ts)
    .sort();
  return [
    atom('traceId', record.traceId),
    atom('service', record.service),
    atom('event', record.event),
    atom('interval', `${times[0] ?? record.ts}/${times.at(-1) ?? record.ts}`),
  ];
}

function atom(kind: ClaimAtom['kind'], value: string): ClaimAtom {
  return { kind, value };
}

function recordOf(trace: readonly LogRecord[], event: string): LogRecord {
  const record = trace.find((candidate) => candidate.event === event);
  if (record === undefined) {
    throw new Error(`trace ${trace[0]?.traceId ?? '(empty)'} has no ${event} record`);
  }
  return record;
}

const LogRecordSchema = z.strictObject({
  ts: z.string(),
  service: z.enum(LOG_SERVICES),
  level: z.enum(LOG_LEVELS),
  event: z.string(),
  traceId: z.string(),
  spanSeq: z.int(),
  status: z.enum(LOG_STATUSES),
  durationMs: z.int(),
  message: z.string(),
});
const TraceResultSchema = z.object({ snapshot: z.string(), records: z.array(LogRecordSchema) });
const AggregateResultSchema = z.object({
  snapshot: z.string(),
  buckets: z.array(z.strictObject({ start: z.string(), key: z.string(), count: z.int() })),
});
const SearchResultSchema = z.object({
  snapshot: z.string(),
  records: z.array(LogRecordSchema),
  totalMatched: z.int(),
  nextCursor: z.string().nullable(),
});

/** Calls the fixture tool exactly as the server would; a rejection here is a generator defect. */
function callTool(tool: FixtureTool, args: Record<string, unknown>, dataset: LogDataset): Record<string, unknown> {
  const outcome = tool.call(args, dataset);
  if (!outcome.ok) {
    throw new Error(`calibration pairs: ${tool.name} rejected its arguments: ${outcome.error}`);
  }
  return outcome.result;
}

function traceOf(dataset: LogDataset, traceId: string): { page: RecordPage; trace: LogRecord[] } {
  const args = { traceId };
  const result = TraceResultSchema.parse(callTool(getTraceTool, args, dataset));
  return {
    page: { source: 'fixture', tool: 'get_trace', args, snapshot: result.snapshot, complete: true, records: result.records },
    trace: result.records,
  };
}

/** The count of the record's service, event and status in the UTC hour that holds it: one bucket keyed by the event. */
interface CountPage {
  page: RecordPage;
  groups: CountGroup[];
  window: { from: string; to: string };
}

function hourCountPage(dataset: LogDataset, record: LogRecord): CountPage {
  const fromMs = Math.floor(Date.parse(record.ts) / HOUR_MS) * HOUR_MS;
  const args = {
    from: new Date(fromMs).toISOString(),
    to: new Date(fromMs + HOUR_MS).toISOString(),
    service: record.service,
    event: record.event,
    status: record.status,
    groupBy: 'event',
    bucket: '1h',
  };
  const result = AggregateResultSchema.parse(callTool(aggregateLogsTool, args, dataset));
  return {
    page: { source: 'fixture', tool: 'aggregate_logs', args, snapshot: result.snapshot, complete: true, records: result.buckets },
    groups: result.buckets,
    window: { from: args.from, to: args.to },
  };
}

/** `search_logs` over the one millisecond of the record, filtered to its service and event. */
function instantPage(dataset: LogDataset, record: LogRecord): RecordPage {
  const fromMs = Date.parse(record.ts);
  const args = {
    from: record.ts,
    to: new Date(fromMs + 1).toISOString(),
    service: record.service,
    event: record.event,
    pageSize: SEARCH_PAGE_SIZE,
  };
  const result = SearchResultSchema.parse(callTool(searchLogsTool, args, dataset));
  return {
    source: 'fixture',
    tool: 'search_logs',
    args,
    snapshot: result.snapshot,
    complete: result.nextCursor === null && result.records.length === result.totalMatched,
    records: result.records,
  };
}

const DAY_FORMAT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });

function dayOf(timeMs: number): string {
  return DAY_FORMAT.format(timeMs);
}

/** «14:00» of an ISO time. */
function hourOf(iso: string): string {
  return iso.slice(11, 16);
}
