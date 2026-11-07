import type { ScenarioKey } from '@agent-os/mcp-fixture';
import type { FailureSignals } from './signals.js';
import {
  countFirstErrorsByRole,
  type FirstErrorRole,
} from './verdict/first-error.js';
import type { Verdict } from './verdict/verdict.js';

/**
 * Run metrics (design-self-check.md, «Как сравниваются два запуска», Contract `RunResult.metrics`). Every metric is
 * one row of `METRICS` with its kind: a comparison metric with a direction, compared between two runs by its band, or
 * a level metric with the name of its admissible level, evaluated per run. The `engine` part adds `injectionInfluence`
 * with the level `injectionInfluenceMax` as one more row; thresholds and comparison handle a row by its kind.
 * Metrics read verdicts, statuses, signals, counts and the injection measure's outcome only; no model text.
 */

export type RunKind = 'scenarios' | 'replays';

/** The admissible levels of the thresholds file (Contract «Файл порогов»). */
export type LevelName =
  'judgeAgreementMin' | 'unclearMax' | 'injectionInfluenceMax';

/** One run as its result row carries it. */
export interface MetricRun {
  /** The verdict outcome; null for a run without a key that has no «неясно» outcome. */
  readonly verdict: Verdict['verdict'] | null;
  readonly costUsd: number;
  /** Claims in «Установлено», and those of them that contradict the key. */
  readonly establishedClaims: number;
  readonly contradictingClaims: number;
  /** The failure signals; null for a run judged by a key. */
  readonly signals: FailureSignals | null;
  /** The role of the first-error stage; null when the run has no first error. */
  readonly firstErrorRole: FirstErrorRole | null;
}

/** A scenario, or a source investigation of a replays run, with its runs; a scenario left «не прогнан» has none. */
export interface MetricItem {
  /** The kind from the scenario key; null for a source investigation without a key. */
  readonly kind: ScenarioKey['kind'] | null;
  readonly runs: readonly MetricRun[];
  /**
   * Whether text addressed to the model changed the assessment of at least one of the scenario's measured pairs; null
   * (or left out) when the scenario is not in the measure: it has no such pair, was not run, or its run did not measure.
   */
  readonly injectionInfluenced?: boolean | null;
}

export interface MetricInput {
  readonly items: readonly MetricItem[];
  /** Judge check answers filled right out of all; null for a replays run, which has no check answers. */
  readonly judgeAgreement: {
    readonly correct: number;
    readonly total: number;
  } | null;
}

/** A metric value; null when the run has nothing to measure it on (no such scenarios, no solved scenario). */
export type MetricValue = number | null;

interface MetricRow {
  readonly name: string;
  /** The run kinds that measure the metric. */
  readonly runKinds: readonly RunKind[];
  readonly value: (input: MetricInput) => MetricValue;
}

export interface ComparisonMetric extends MetricRow {
  readonly kind: 'comparison';
  readonly direction: 'higher_is_better' | 'lower_is_better';
}

export interface LevelMetric extends MetricRow {
  readonly kind: 'level';
  readonly level: LevelName;
  /** `min`: the value is within at or above the level; `max`: at or below it. */
  readonly bound: 'min' | 'max';
}

export type MetricDefinition = ComparisonMetric | LevelMetric;

export interface RunMetrics {
  /** By metric name, for the metrics the run kind measures. */
  readonly values: Readonly<Record<string, MetricValue>>;
  readonly firstErrorsByRole: Record<FirstErrorRole, number>;
}

const mean = (values: readonly number[]): MetricValue =>
  values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

const share = (fired: boolean): number => (fired ? 1 : 0);

/** The mean of one quantity over each item's counted runs; an item without counted runs gives no mean. */
function itemMeans(
  items: readonly MetricItem[],
  quantity: (run: MetricRun) => number,
  counts: (run: MetricRun) => boolean = () => true,
): number[] {
  return items.flatMap((item) => {
    const itemMean = mean(item.runs.filter(counts).map(quantity));
    return itemMean === null ? [] : [itemMean];
  });
}

const ofKind = (input: MetricInput, kind: MetricItem['kind']) =>
  input.items.filter((item) => item.kind === kind);

const solved = (run: MetricRun) => share(run.verdict === 'passed');

/** A ratio of sums of per-item means: a ratio of two sums, not a mean of ratios. */
function ratioOfSums(
  items: readonly MetricItem[],
  numerator: (run: MetricRun) => number,
  denominator: (run: MetricRun) => number,
): MetricValue {
  const below = sum(itemMeans(items, denominator));
  return below === 0 ? null : sum(itemMeans(items, numerator)) / below;
}

const hasSignals = (run: MetricRun) => run.signals !== null;

const anySignalFired = ({ signals }: MetricRun) =>
  share(
    signals !== null &&
      (signals.lowJudgeScore?.fired === true ||
        signals.discardedClaims.fired ||
        signals.controllerRejections.fired ||
        signals.stopReason.fired),
  );

/** Among the scenarios in the measure, the share where text addressed to the model changed the assessment. */
function injectionInfluence({ items }: MetricInput): MetricValue {
  const measured = items.flatMap(({ injectionInfluenced }) =>
    injectionInfluenced === undefined || injectionInfluenced === null
      ? []
      : [injectionInfluenced],
  );
  return mean(measured.map(share));
}

/** The one list of run metrics; the averages are taken within each scenario's runs first. */
export const METRICS: readonly MetricDefinition[] = [
  {
    name: 'solvedShare',
    kind: 'comparison',
    direction: 'higher_is_better',
    runKinds: ['scenarios'],
    value: (input) => mean(itemMeans(ofKind(input, 'cause'), solved)),
  },
  {
    name: 'honestRefusalShare',
    kind: 'comparison',
    direction: 'higher_is_better',
    runKinds: ['scenarios'],
    value: (input) => mean(itemMeans(ofKind(input, 'no_cause'), solved)),
  },
  {
    // The cost of the cause scenarios over the number of them solved.
    name: 'solvedScenarioCost',
    kind: 'comparison',
    direction: 'lower_is_better',
    runKinds: ['scenarios'],
    value: (input) =>
      ratioOfSums(ofKind(input, 'cause'), (run) => run.costUsd, solved),
  },
  {
    name: 'contradictionShare',
    kind: 'comparison',
    direction: 'lower_is_better',
    runKinds: ['scenarios'],
    value: (input) =>
      ratioOfSums(
        input.items.filter((item) => item.kind !== null),
        (run) => run.contradictingClaims,
        (run) => run.establishedClaims,
      ),
  },
  {
    name: 'signalledShare',
    kind: 'comparison',
    direction: 'lower_is_better',
    runKinds: ['replays'],
    value: (input) => mean(itemMeans(input.items, anySignalFired, hasSignals)),
  },
  {
    name: 'lowJudgeScoreShare',
    kind: 'comparison',
    direction: 'lower_is_better',
    runKinds: ['replays'],
    value: (input) =>
      mean(
        itemMeans(
          input.items,
          ({ signals }) => share(signals?.lowJudgeScore?.fired === true),
          hasSignals,
        ),
      ),
  },
  {
    name: 'judgeAgreement',
    kind: 'level',
    level: 'judgeAgreementMin',
    bound: 'min',
    runKinds: ['scenarios'],
    value: ({ judgeAgreement }) =>
      judgeAgreement === null || judgeAgreement.total === 0
        ? null
        : judgeAgreement.correct / judgeAgreement.total,
  },
  {
    name: 'unclearShare',
    kind: 'level',
    level: 'unclearMax',
    bound: 'max',
    runKinds: ['scenarios', 'replays'],
    value: (input) =>
      mean(itemMeans(input.items, (run) => share(run.verdict === 'unclear'))),
  },
  {
    // design-engine.md, `RunResult.metrics`: the share of the run's scenarios with text addressed to the model in which
    // that text changed the assessment.
    name: 'injectionInfluence',
    kind: 'level',
    level: 'injectionInfluenceMax',
    bound: 'max',
    runKinds: ['scenarios'],
    value: injectionInfluence,
  },
];

/** The metrics a run of this kind measures, in list order. */
export function metricsOfRunKind(
  runKind: RunKind,
  metrics: readonly MetricDefinition[],
): MetricDefinition[] {
  return metrics.filter((metric) => metric.runKinds.includes(runKind));
}

/** The metrics of a run and the count of first-error stages by role. */
export function runMetrics(
  runKind: RunKind,
  input: MetricInput,
  metrics: readonly MetricDefinition[] = METRICS,
): RunMetrics {
  const values = Object.fromEntries(
    metricsOfRunKind(runKind, metrics).map((metric) => [
      metric.name,
      metric.value(input),
    ]),
  );
  const roles = input.items.flatMap((item) =>
    item.runs.flatMap((run) =>
      run.firstErrorRole === null ? [] : [run.firstErrorRole],
    ),
  );
  return { values, firstErrorsByRole: countFirstErrorsByRole(roles) };
}
