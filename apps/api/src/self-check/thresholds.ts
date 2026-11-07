import { z } from 'zod';
import {
  METRICS,
  metricsOfRunKind,
  type LevelName,
  type MetricDefinition,
  type MetricValue,
  type RunKind,
} from './metrics.js';

/**
 * The thresholds file (design-self-check.md, Contract «Файл порогов», DC-13): owner data with a band per comparison
 * metric and the admissible levels. It is either not passed or complete for the run kind: a band for every comparison
 * metric and every level the run of that kind measures, as the metric list declares them. An incomplete file is
 * refused with `thresholds_invalid` before the first investigation.
 */

/** Bands and levels are shares from 0 to 1; the cost band is a share of the baseline. */
const shareValue = z.number().min(0).max(1);

/** Every admissible level is optional here; which ones a run kind needs comes from the metric list. */
const levelsShape = {
  judgeAgreementMin: shareValue.optional(),
  unclearMax: shareValue.optional(),
  injectionInfluenceMax: shareValue.optional(),
} satisfies Record<LevelName, z.ZodOptional<typeof shareValue>>;

const ThresholdsSchema = z.strictObject({
  bands: z.record(z.string(), shareValue),
  levels: z.strictObject(levelsShape),
});

export type Thresholds = z.infer<typeof ThresholdsSchema>;

export type ThresholdsResult =
  | { readonly ok: true; readonly thresholds: Thresholds }
  | {
      readonly ok: false;
      readonly code: 'thresholds_invalid';
      readonly reason: string;
    };

const invalid = (reason: string): ThresholdsResult => ({
  ok: false,
  code: 'thresholds_invalid',
  reason,
});

/** Checks a thresholds file for a run of this kind against the metric list. */
export function parseThresholds(
  data: unknown,
  runKind: RunKind,
  metrics: readonly MetricDefinition[] = METRICS,
): ThresholdsResult {
  const parsed = ThresholdsSchema.safeParse(data);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const path = issue === undefined ? '' : issue.path.map(String).join('.');
    return invalid(
      `thresholds file rejected at ${path || '(root)'}: ${issue?.message ?? 'invalid'}`,
    );
  }
  const thresholds = parsed.data;
  const comparisonNames = new Set(
    metrics.flatMap((metric) =>
      metric.kind === 'comparison' ? [metric.name] : [],
    ),
  );
  const unknownBands = Object.keys(thresholds.bands).filter(
    (name) => !comparisonNames.has(name),
  );
  if (unknownBands.length > 0) {
    return invalid(
      `thresholds file has bands for names that are not comparison metrics: ${unknownBands.join(', ')}`,
    );
  }
  const missing = metricsOfRunKind(runKind, metrics).flatMap((metric) =>
    metric.kind === 'comparison'
      ? thresholds.bands[metric.name] === undefined
        ? [`band ${metric.name}`]
        : []
      : thresholds.levels[metric.level] === undefined
        ? [`level ${metric.level}`]
        : [],
  );
  if (missing.length > 0) {
    return invalid(
      `thresholds file is not complete for a ${runKind} run: missing ${missing.join(', ')}`,
    );
  }
  return { ok: true, thresholds };
}

/** `within` — «в пределах»; `beyond` — «за пределом допустимого»; null when the run did not measure the value. */
export type LevelEvaluation = 'within' | 'beyond' | null;

export interface LevelEvaluationRow {
  readonly metric: string;
  readonly level: LevelName;
  readonly value: MetricValue;
  readonly limit: number;
  readonly evaluation: LevelEvaluation;
}

/**
 * Each level the run kind measures, evaluated against the thresholds file; without a file there is no evaluation.
 * `thresholds` must be a file `parseThresholds` accepted for this run kind.
 */
export function evaluateLevels(
  runKind: RunKind,
  values: Readonly<Record<string, MetricValue>>,
  thresholds: Thresholds | null,
  metrics: readonly MetricDefinition[] = METRICS,
): LevelEvaluationRow[] | null {
  if (thresholds === null) return null;
  return metricsOfRunKind(runKind, metrics).flatMap((metric) => {
    if (metric.kind !== 'level') return [];
    const limit = thresholds.levels[metric.level];
    if (limit === undefined) {
      throw new Error(
        `thresholds have no level ${metric.level}; they were not checked for a ${runKind} run`,
      );
    }
    const value = values[metric.name] ?? null;
    const within =
      value === null
        ? null
        : metric.bound === 'min'
          ? value >= limit
          : value <= limit;
    return [
      {
        metric: metric.name,
        level: metric.level,
        value,
        limit,
        evaluation: within === null ? null : within ? 'within' : 'beyond',
      },
    ];
  });
}
