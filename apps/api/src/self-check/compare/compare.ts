import { z } from 'zod';
import {
  type ComparisonMetric,
  type LevelName,
  type MetricDefinition,
  type MetricInput,
  type MetricValue,
  METRICS,
  metricsOfRunKind,
  type RunKind,
  runMetrics,
} from '../metrics.js';
import {
  metricItem,
  RUN_ID_PATTERN,
  type ItemResult,
  type RunItems,
  type RunResult,
} from '../result/run-result.js';
import type { SelfCheckSettings } from '../settings.js';
import {
  evaluateLevels,
  type LevelEvaluation,
  parseThresholds,
  type Thresholds,
} from '../thresholds.js';

/**
 * The comparison of two runs (design-self-check.md, KD-6, «Как сравниваются два запуска», Contract `compare`, DC-12,
 * DC-13, DC-14): a pure calculation over two result files, without a model; the same two files always give the same
 * comparison. Each comparison metric of the run kind gets the difference «plus is better» and an interval from a
 * paired bootstrap over the scenarios (or source investigations) with the resample count and the constant seed of the
 * settings; its verdict comes from its band in the candidate's thresholds. Level metrics are shown for both runs and
 * never become a verdict; only `judgeAgreementMin` and `unclearMax` stop the comparison at «неясно».
 */

/** `better` — «лучше», `worse` — «хуже», `unclear` — «неясно». */
export type ComparisonVerdict = 'better' | 'worse' | 'unclear';

/** Bootstrap of the interval: how many resamples and their constant seed. */
export type Resampling = SelfCheckSettings['resampling'];

/** The interval holds the middle 95% of the resampled differences. */
const INTERVAL_TAIL = 0.025;

/** More resamples than this share without a value (no solved scenario, say) make the metric «неясно». */
const MAX_RESAMPLES_WITHOUT_VALUE = 0.05;

/** Comparison metrics compared in shares of the baseline value rather than in their own units: the cost. */
const RELATIVE_TO_BASELINE: ReadonlySet<string> = new Set([
  'solvedScenarioCost',
]);

/** The levels that stop the comparison at «неясно» when either run is beyond them (DC-14). */
const STOPPING_LEVELS: ReadonlySet<LevelName> = new Set<LevelName>([
  'judgeAgreementMin',
  'unclearMax',
]);

export interface MetricComparison {
  readonly name: string;
  readonly direction: ComparisonMetric['direction'];
  /** The difference is a share of the baseline value («на 12% дешевле» is 0.12). */
  readonly relativeToBaseline: boolean;
  readonly baseline: MetricValue;
  readonly candidate: MetricValue;
  /** Plus is always better; null when either run has no value or the baseline value of a relative metric is 0. */
  readonly difference: MetricValue;
  /** Null when too many resamples gave no value. */
  readonly interval: { readonly lower: number; readonly upper: number } | null;
  readonly resamplesWithoutValue: number;
  /** The band from the candidate's thresholds; null without thresholds. */
  readonly band: number | null;
  /** Null without thresholds or when the comparison stopped on a level. */
  readonly verdict: ComparisonVerdict | null;
}

export interface LevelOfRun {
  readonly value: MetricValue;
  /** Null without thresholds, or when the run did not measure the value. */
  readonly evaluation: LevelEvaluation;
}

export interface LevelComparison {
  readonly metric: string;
  readonly level: LevelName;
  /** From the candidate's thresholds; null without them. */
  readonly limit: number | null;
  readonly baseline: LevelOfRun;
  readonly candidate: LevelOfRun;
}

/** A level that stopped the comparison: the run, the level and the value beyond it. */
interface LevelStop {
  readonly run: 'baseline' | 'candidate';
  readonly metric: string;
  readonly level: LevelName;
  readonly value: number;
  readonly limit: number;
}

/** The comparison file. It holds no time and no random value, so a repeated comparison writes the same bytes. */
export interface Comparison {
  readonly baseline: { readonly runId: string };
  readonly candidate: { readonly runId: string };
  readonly kind: RunKind;
  readonly items: RunItems;
  /** The candidate's thresholds, recorded before its first investigation; null without them. */
  readonly thresholds: Thresholds | null;
  readonly resampling: Resampling;
  /** Null without thresholds. */
  readonly verdict: ComparisonVerdict | null;
  /** The levels that made the overall verdict «неясно» before any metric; empty when none did. */
  readonly stoppedBy: readonly LevelStop[];
  readonly metrics: readonly MetricComparison[];
  readonly levels: readonly LevelComparison[];
}

export type CompareOutcome =
  | { readonly ok: true; readonly comparison: Comparison }
  | {
      readonly ok: false;
      /** `invalid_arguments`: a run directory whose result file carries a run id not of the program's form. */
      readonly code:
        'invalid_arguments' | 'runs_not_comparable' | 'run_incomplete';
      readonly reason: string;
    };

/** The two result files as read from the run directories: null for a directory without one (a failed run). */
interface RunFiles {
  readonly baseline: unknown;
  readonly candidate: unknown;
}

/**
 * Compares two result files; a file that is not a result file of the program throws. A run id not in the form `run`
 * writes (`RUN_ID_PATTERN`) is refused as `invalid_arguments`: the comparison directory is named by the two ids, so
 * nothing read from a file may shape a path. The metric list is the candidate's form's, unless a caller names its own.
 */
export function compareRunFiles(
  files: RunFiles,
  resampling: Resampling,
  metrics?: readonly MetricDefinition[],
): CompareOutcome {
  const baseline =
    files.baseline === null ? null : parseRunFile(files.baseline);
  const candidate =
    files.candidate === null ? null : parseRunFile(files.candidate);
  const badRunId =
    invalidRunId(baseline, 'baseline') ?? invalidRunId(candidate, 'candidate');
  if (badRunId !== null) return badRunId;
  const incomplete =
    incompleteRun(baseline, 'baseline') ??
    incompleteRun(candidate, 'candidate');
  if (incomplete !== null) return incomplete;
  if (baseline === null || candidate === null) {
    throw new Error('a missing result file passed the completeness check');
  }
  const notComparable = notComparableReason(baseline, candidate);
  if (notComparable !== null) {
    return { ok: false, code: 'runs_not_comparable', reason: notComparable };
  }
  return {
    ok: true,
    comparison: compareRuns(
      baseline,
      candidate,
      resampling,
      metrics ?? METRICS,
    ),
  };
}

function invalidRunId(
  run: RunResult | null,
  role: 'baseline' | 'candidate',
): CompareOutcome | null {
  if (run === null || RUN_ID_PATTERN.test(run.runId)) return null;
  return {
    ok: false,
    code: 'invalid_arguments',
    reason: `the ${role} result file names a run id that is not one the program writes`,
  };
}

function incompleteRun(
  run: RunResult | null,
  role: 'baseline' | 'candidate',
): CompareOutcome | null {
  if (run === null) {
    return {
      ok: false,
      code: 'run_incomplete',
      reason: `the ${role} directory has no result file: the run did not finish`,
    };
  }
  if (!run.complete) {
    return {
      ok: false,
      code: 'run_incomplete',
      reason: `the ${role} run ${run.runId} is incomplete: some scenarios were not run`,
    };
  }
  return null;
}

/**
 * One scenario or source investigation of a run, by the key both runs share. A source investigation is told by its id
 * alone: a result file written before design 1.6 also names the database it came from, which the key leaves out.
 */
const itemKey = ({ item }: ItemResult): string =>
  'scenarioId' in item
    ? `scenario:${item.scenarioId}`
    : `investigation:${item.investigationId}`;

const runItemsKey = (items: RunItems): string =>
  items.kind === 'set'
    ? `set ${items.setName} (fingerprint ${items.setFingerprint})`
    : `investigations ${items.investigations
        .map(({ investigationId }) => investigationId)
        .join(', ')}`;

const sortedItemKeys = (run: RunResult): string[] =>
  run.results.map(itemKey).sort();

function notComparableReason(
  baseline: RunResult,
  candidate: RunResult,
): string | null {
  if (baseline.kind !== candidate.kind) {
    return `the runs are of different kinds: ${baseline.kind} and ${candidate.kind}`;
  }
  const baselineItems = runItemsKey(baseline.items);
  const candidateItems = runItemsKey(candidate.items);
  if (baselineItems !== candidateItems) {
    return `the runs went over different items: ${baselineItems} and ${candidateItems}`;
  }
  const baselineKeys = sortedItemKeys(baseline);
  const candidateKeys = sortedItemKeys(candidate);
  if (
    new Set(baselineKeys).size !== baselineKeys.length ||
    baselineKeys.join('\n') !== candidateKeys.join('\n')
  ) {
    return 'the runs hold different lists of scenarios or investigations';
  }
  return null;
}

function compareRuns(
  baseline: RunResult,
  candidate: RunResult,
  resampling: Resampling,
  metrics: readonly MetricDefinition[],
): Comparison {
  const { kind } = candidate;
  const thresholds = candidateThresholds(candidate, metrics);
  const pairs = pairedItems(baseline, candidate);
  const baselineInput = metricInput(baseline, pairs.baseline);
  const candidateInput = metricInput(candidate, pairs.candidate);
  const levels = compareLevels(
    kind,
    baselineInput,
    candidateInput,
    thresholds,
    metrics,
  );
  const stoppedBy = levelStops(levels);
  const decides = thresholds !== null && stoppedBy.length === 0;
  const resampled = resampleIndices(pairs.baseline.length, resampling);
  const comparisons = metricsOfRunKind(kind, metrics).flatMap((metric) =>
    metric.kind === 'comparison'
      ? [
          compareMetric(metric, {
            baseline: baselineInput,
            candidate: candidateInput,
            resampled,
            band: thresholds?.bands[metric.name] ?? null,
            decides,
          }),
        ]
      : [],
  );
  return {
    baseline: { runId: baseline.runId },
    candidate: { runId: candidate.runId },
    kind,
    items: candidate.items,
    thresholds,
    resampling: { resamples: resampling.resamples, seed: resampling.seed },
    verdict:
      thresholds === null
        ? null
        : stoppedBy.length > 0
          ? 'unclear'
          : overallVerdict(comparisons),
    stoppedBy,
    metrics: comparisons,
    levels,
  };
}

/** The candidate's thresholds as `run` checked them; a copy that no longer passes the check is a broken file. */
function candidateThresholds(
  candidate: RunResult,
  metrics: readonly MetricDefinition[],
): Thresholds | null {
  if (candidate.thresholds === null) return null;
  const parsed = parseThresholds(candidate.thresholds, candidate.kind, metrics);
  if (!parsed.ok) {
    throw new Error(
      `the candidate run ${candidate.runId} holds thresholds that do not pass the check: ${parsed.reason}`,
    );
  }
  return parsed.thresholds;
}

/** Both runs' items in one order, by key, so the pairing and the resampling do not depend on the order in the files. */
function pairedItems(
  baseline: RunResult,
  candidate: RunResult,
): { readonly baseline: ItemResult[]; readonly candidate: ItemResult[] } {
  const byKey = (run: RunResult) =>
    [...run.results].sort((left, right) =>
      itemKey(left) < itemKey(right)
        ? -1
        : itemKey(left) > itemKey(right)
          ? 1
          : 0,
    );
  return { baseline: byKey(baseline), candidate: byKey(candidate) };
}

function metricInput(
  run: RunResult,
  items: readonly ItemResult[],
): MetricInput {
  return {
    items: items.map(metricItem),
    judgeAgreement: run.judgeAgreement,
  };
}

function compareLevels(
  kind: RunKind,
  baseline: MetricInput,
  candidate: MetricInput,
  thresholds: Thresholds | null,
  metrics: readonly MetricDefinition[],
): LevelComparison[] {
  const baselineValues = runMetrics(kind, baseline, metrics).values;
  const candidateValues = runMetrics(kind, candidate, metrics).values;
  const baselineRows = evaluateLevels(
    kind,
    baselineValues,
    thresholds,
    metrics,
  );
  const candidateRows = evaluateLevels(
    kind,
    candidateValues,
    thresholds,
    metrics,
  );
  return metricsOfRunKind(kind, metrics).flatMap((metric) => {
    if (metric.kind !== 'level') return [];
    const ofRun = (
      values: Readonly<Record<string, MetricValue>>,
      rows: typeof baselineRows,
    ): LevelOfRun => ({
      value: values[metric.name] ?? null,
      evaluation:
        rows?.find((row) => row.metric === metric.name)?.evaluation ?? null,
    });
    return [
      {
        metric: metric.name,
        level: metric.level,
        limit: thresholds?.levels[metric.level] ?? null,
        baseline: ofRun(baselineValues, baselineRows),
        candidate: ofRun(candidateValues, candidateRows),
      },
    ];
  });
}

function levelStops(levels: readonly LevelComparison[]): LevelStop[] {
  return levels.flatMap((row) => {
    if (!STOPPING_LEVELS.has(row.level) || row.limit === null) return [];
    const limit = row.limit;
    return (['baseline', 'candidate'] as const).flatMap((run) => {
      const { value, evaluation } = row[run];
      return evaluation === 'beyond' && value !== null
        ? [{ run, metric: row.metric, level: row.level, value, limit }]
        : [];
    });
  });
}

interface MetricContext {
  readonly baseline: MetricInput;
  readonly candidate: MetricInput;
  /** Per resample, the indices of the paired items drawn with replacement. */
  readonly resampled: readonly (readonly number[])[];
  readonly band: number | null;
  /** Whether the metric gets a verdict: thresholds were recorded and no level stopped the comparison. */
  readonly decides: boolean;
}

function compareMetric(
  metric: ComparisonMetric,
  context: MetricContext,
): MetricComparison {
  const relative = RELATIVE_TO_BASELINE.has(metric.name);
  const differenceOf = (baseline: MetricInput, candidate: MetricInput) =>
    difference(
      metric,
      relative,
      metric.value(baseline),
      metric.value(candidate),
    );
  const resampledDifferences = context.resampled.map((indices) =>
    differenceOf(
      pick(context.baseline, indices),
      pick(context.candidate, indices),
    ),
  );
  const values = resampledDifferences.filter(
    (value): value is number => value !== null,
  );
  const withoutValue = resampledDifferences.length - values.length;
  const interval =
    values.length === 0 ||
    withoutValue > MAX_RESAMPLES_WITHOUT_VALUE * resampledDifferences.length
      ? null
      : middleInterval(values);
  return {
    name: metric.name,
    direction: metric.direction,
    relativeToBaseline: relative,
    baseline: metric.value(context.baseline),
    candidate: metric.value(context.candidate),
    difference: differenceOf(context.baseline, context.candidate),
    interval,
    resamplesWithoutValue: withoutValue,
    band: context.band,
    verdict:
      context.decides && context.band !== null
        ? intervalVerdict(interval, context.band)
        : null,
  };
}

/** Plus is better: a «lower is better» metric is subtracted the other way; a relative one is divided by the baseline. */
function difference(
  metric: ComparisonMetric,
  relative: boolean,
  baseline: MetricValue,
  candidate: MetricValue,
): MetricValue {
  if (baseline === null || candidate === null) return null;
  const gain =
    metric.direction === 'higher_is_better'
      ? candidate - baseline
      : baseline - candidate;
  if (!relative) return gain;
  return baseline === 0 ? null : gain / baseline;
}

/** Wholly above the band — «лучше»; wholly below minus the band — «хуже»; touching the band — «неясно». */
function intervalVerdict(
  interval: MetricComparison['interval'],
  band: number,
): ComparisonVerdict {
  if (interval === null) return 'unclear';
  if (interval.lower > band) return 'better';
  if (interval.upper < -band) return 'worse';
  return 'unclear';
}

/** «хуже» if any metric is «хуже»; «лучше» if at least one is «лучше» and none «хуже»; otherwise «неясно». */
function overallVerdict(
  comparisons: readonly MetricComparison[],
): ComparisonVerdict {
  const verdicts = comparisons.map((metric) => metric.verdict);
  if (verdicts.includes('worse')) return 'worse';
  if (verdicts.includes('better')) return 'better';
  return 'unclear';
}

const pick = (input: MetricInput, indices: readonly number[]): MetricInput => ({
  items: indices.map((index) => {
    const item = input.items[index];
    if (item === undefined) throw new Error(`no item at index ${index}`);
    return item;
  }),
  judgeAgreement: input.judgeAgreement,
});

/** The indices of every resample, drawn once from the constant seed and shared by all metrics. */
function resampleIndices(
  itemCount: number,
  { resamples, seed }: Resampling,
): number[][] {
  const random = mulberry32(seed);
  return Array.from({ length: resamples }, () =>
    Array.from({ length: itemCount }, () => Math.floor(random() * itemCount)),
  );
}

/** The 2.5% and 97.5% quantiles, linearly interpolated between the sorted values. */
function middleInterval(values: readonly number[]): {
  lower: number;
  upper: number;
} {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    lower: quantile(sorted, INTERVAL_TAIL),
    upper: quantile(sorted, 1 - INTERVAL_TAIL),
  };
}

function quantile(sorted: readonly number[], share: number): number {
  const position = (sorted.length - 1) * share;
  const below = Math.floor(position);
  const low = sorted[below];
  const high = sorted[Math.min(below + 1, sorted.length - 1)];
  if (low === undefined || high === undefined) {
    throw new Error('a quantile of no values');
  }
  return low + (position - below) * (high - low);
}

/**
 * mulberry32: a small generator with 32-bit integer math only, so a seed gives the same draws on every platform. The
 * same algorithm generates the fixture datasets in `@agent-os/mcp-fixture`; it is repeated here rather than imported,
 * so the comparison stays a pure function over two files with no dependency on the fixture package.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The fields of a result file that the comparison reads; the rest of the file is carried as `run` wrote it. */
const RunFileSchema = z.looseObject({
  runId: z.string().min(1),
  kind: z.enum(['scenarios', 'replays']),
  items: z.discriminatedUnion('kind', [
    z.looseObject({
      kind: z.literal('set'),
      setName: z.string(),
      setFingerprint: z.string(),
    }),
    z.looseObject({
      kind: z.literal('investigations'),
      // A result file written before design 1.6 also carries `base` (`main` or `self_check`): kept as read, unused.
      investigations: z.array(z.looseObject({ investigationId: z.string() })),
    }),
  ]),
  // The form of the run: an agents-form run names its definitions.
  config: z.looseObject({ definitions: z.record(z.string(), z.unknown()) }),
  thresholds: z.unknown(),
  complete: z.boolean(),
  results: z.array(
    z.looseObject({
      item: z.union([
        z.looseObject({ scenarioId: z.string() }),
        z.looseObject({ investigationId: z.string() }),
      ]),
      kind: z.enum(['cause', 'no_cause']).nullable(),
      ran: z.boolean(),
      runs: z.array(
        z.looseObject({
          verdict: z
            .looseObject({ verdict: z.enum(['passed', 'failed', 'unclear']) })
            .nullable(),
          costUsd: z.number(),
          establishedClaims: z.number().int().nonnegative(),
          contradictingClaims: z.number().int().nonnegative().nullable(),
          signals: z.looseObject({}).nullable(),
          firstError: z.looseObject({ role: z.string() }).nullable(),
        }),
      ),
      // Left out by a replays run and by a result file written before the `engine` part: «не измерено».
      injection: z
        .looseObject({
          measuredPairs: z.number().int().nonnegative(),
          influencedPairs: z.number().int().nonnegative(),
          unassessedPairs: z.number().int().nonnegative(),
        })
        .nullable()
        .optional(),
    }),
  ),
  judgeAgreement: z
    .looseObject({
      correct: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .nullable(),
});

function isRunResultFile(data: unknown): data is RunResult {
  return RunFileSchema.safeParse(data).success;
}

function parseRunFile(data: unknown): RunResult {
  if (isRunResultFile(data)) return data;
  const [issue] = RunFileSchema.safeParse(data).error?.issues ?? [];
  const path = issue === undefined ? '' : issue.path.map(String).join('.');
  throw new Error(
    `not a result file of the self-check program at ${path || '(root)'}: ${issue?.message ?? 'invalid'}`,
  );
}
