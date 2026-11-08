import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type FirstErrorRole,
  FIRST_ERROR_STAGES,
} from '../verdict/first-error.js';
import type { Verdict } from '../verdict/verdict.js';
import { METRICS, metricsOfRunKind, type MetricValue } from '../metrics.js';
import type { FailureSignals } from '../signals.js';
import { evaluateLevels, type LevelEvaluation } from '../thresholds.js';
import type {
  Comparison,
  ComparisonVerdict,
  LevelComparison,
  LevelOfRun,
  MetricComparison,
} from '../compare/compare.js';
import type {
  ItemResult,
  RunEntry,
  RunItems,
  RunResult,
} from './run-result.js';

/**
 * The Markdown report of a run (design-self-check.md, «Что видно в отчёте», Contract «Файл порогов»): every run with
 * its verdict and reason code, first-error stage, steps, tokens and cost; the run's metrics; and every admissible
 * level the run measures — with «в пределах» or «за пределом допустимого» when a thresholds file was passed, without
 * an evaluation when it was not. It is built from the result file alone: codes, counts and identifiers, never a
 * prompt, a record or a model answer.
 */

/** The report's name in the run directory. */
export const REPORT_FILE_NAME = 'report.md';

const VERDICT_LABELS: Readonly<Record<Verdict['verdict'], string>> = {
  passed: 'пройден',
  failed: 'не пройден',
  unclear: 'неясно',
};

const EVALUATION_LABELS: Readonly<
  Record<NonNullable<LevelEvaluation>, string>
> = {
  within: 'в пределах',
  beyond: 'за пределом допустимого',
};

/** The four signals in the order of FR-07. */
export const SIGNAL_LABELS = {
  lowJudgeScore: 'низкая оценка судьи',
  discardedClaims: 'много отсеянных утверждений',
  controllerRejections: 'отклонённые решения controller',
  stopReason: 'причина остановки',
} as const satisfies Readonly<Record<keyof FailureSignals, string>>;
const SIGNALS = [
  'lowJudgeScore',
  'discardedClaims',
  'controllerRejections',
  'stopReason',
] as const satisfies readonly (keyof FailureSignals)[];

const FIRST_ERROR_ROLES = [
  'controller',
  'worker',
  'verifier',
  'synthesis',
] as const satisfies readonly FirstErrorRole[];

const NONE = '—';

/** The Markdown text of the report. */
function renderReport(result: RunResult): string {
  return [
    ...header(result),
    ...levels(result),
    ...metrics(result),
    ...runs(result),
  ].join('\n');
}

/** Writes the report next to the result file. */
export async function writeReport(
  runDir: string,
  result: RunResult,
): Promise<string> {
  const path = join(runDir, REPORT_FILE_NAME);
  await writeFile(path, renderReport(result), 'utf8');
  return path;
}

function itemsLine(items: RunItems): string {
  return items.kind === 'set'
    ? `набор \`${items.setName}\` (отпечаток \`${items.setFingerprint}\`)`
    : `исходные расследования: ${items.investigations
        .map(({ investigationId }) => `\`${investigationId}\``)
        .join(', ')}`;
}

function header(result: RunResult): string[] {
  const { items, config, judge } = result;
  return [
    `# Самопроверка: запуск \`${result.runId}\``,
    '',
    `- Вид: \`${result.kind}\`; ${itemsLine(items)}`,
    `- Создан: ${result.createdAt}; код: ${result.codeVersion === null ? NONE : `\`${result.codeVersion}\``}`,
    `- Завершён: ${result.complete ? 'да' : 'нет — есть сценарии «не прогнан»'}`,
    `- Конфигурация: отпечаток \`${config.fingerprint}\`${config.choice === null ? '' : `, взята ${config.choice === 'frozen' ? 'замороженная' : 'поставляемая'}`}`,
    `- Судья: \`${judge.model}\`, версия промпта \`${judge.promptVersion}\``,
    `- Согласие судьи: ${result.judgeAgreement === null ? NONE : `${result.judgeAgreement.correct} из ${result.judgeAgreement.total}`}`,
    '',
    '| Роль | Модель | Версия промпта |',
    '|---|---|---|',
    ...Object.entries(config.roles).map(
      ([role, { model, promptVersion }]) =>
        `| ${role} | \`${model}\` | \`${promptVersion}\` |`,
    ),
    '',
  ];
}

/** Every level the run kind measures; evaluated only against a thresholds file. */
function levels(result: RunResult): string[] {
  const values = result.metrics.values;
  const evaluated = evaluateLevels(result.kind, values, result.thresholds);
  const rows =
    evaluated === null
      ? metricsOfRunKind(result.kind, METRICS).flatMap((metric) =>
          metric.kind === 'level'
            ? [
                `| ${metric.name} | \`${metric.level}\` | ${formatValue(values[metric.name] ?? null)} | ${NONE} | ${NONE} |`,
              ]
            : [],
        )
      : evaluated.map(
          (row) =>
            `| ${row.metric} | \`${row.level}\` | ${formatValue(row.value)} | ${formatValue(row.limit)} | ${row.evaluation === null ? 'не измерено' : EVALUATION_LABELS[row.evaluation]} |`,
        );
  return [
    '## Допустимые уровни',
    '',
    ...(result.thresholds === null
      ? ['Файл порогов не передан: уровни показаны без оценки.', '']
      : []),
    '| Метрика | Уровень | Значение | Предел | Оценка |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ];
}

function metrics(result: RunResult): string[] {
  const { values, firstErrorsByRole } = result.metrics;
  const comparison = metricsOfRunKind(result.kind, METRICS).filter(
    (metric) => metric.kind === 'comparison',
  );
  return [
    '## Метрики',
    '',
    '| Метрика | Значение |',
    '|---|---|',
    ...comparison.map(
      (metric) =>
        `| ${metric.name} | ${formatValue(values[metric.name] ?? null)} |`,
    ),
    '',
    '### Этапы первой ошибки',
    '',
    '| Этап | Прогонов |',
    '|---|---|',
    ...FIRST_ERROR_ROLES.map(
      (role) => `| ${FIRST_ERROR_STAGES[role]} | ${firstErrorsByRole[role]} |`,
    ),
    '',
  ];
}

function runs(result: RunResult): string[] {
  return ['## Прогоны', '', ...result.results.flatMap(itemSection)];
}

function itemSection(item: ItemResult): string[] {
  const name =
    'scenarioId' in item.item
      ? `Сценарий \`${item.item.scenarioId}\``
      : `Расследование \`${item.item.investigationId}\``;
  const kind = item.kind === null ? '' : ` (\`${item.kind}\`)`;
  if (!item.ran) {
    return [`### ${name}${kind}`, '', 'Не прогнан.', ''];
  }
  return [
    `### ${name}${kind}`,
    '',
    ...(item.sourceSignals === undefined
      ? []
      : [
          `Сигналы сбоя исходного расследования: ${item.sourceSignals === null ? `${NONE} (у исходного есть ключ: повторы получают вердикт)` : firedSignals(item.sourceSignals)}`,
          '',
        ]),
    '| Расследование | Статус | Исход ответа | stopReason | Вердикт | Причина | Этап первой ошибки | Шаги | Токены | Стоимость, USD | Установлено | Противоречат ключу | Сигналы сбоя |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...item.runs.map(runRow),
    '',
  ];
}

function runRow(run: RunEntry): string {
  const cells = [
    `\`${run.investigationId}\``,
    `\`${run.status}\``,
    code(run.answerOutcome),
    code(run.stopReason),
    run.verdict === null ? NONE : VERDICT_LABELS[run.verdict.verdict],
    run.verdict === null ? NONE : `\`${run.verdict.reason}\``,
    run.firstError === null ? NONE : run.firstError.stage,
    String(run.steps),
    String(run.tokens),
    run.costUsd.toFixed(4),
    String(run.establishedClaims),
    run.contradictingClaims === null ? NONE : String(run.contradictingClaims),
    firedSignals(run.signals),
  ];
  return `| ${cells.join(' | ')} |`;
}

function firedSignals(signals: FailureSignals | null): string {
  if (signals === null) return NONE;
  const fired = SIGNALS.filter((name) => signals[name]?.fired === true);
  return fired.length === 0
    ? 'нет'
    : fired.map((name) => SIGNAL_LABELS[name]).join(', ');
}

function code(value: string | null): string {
  return value === null ? NONE : `\`${value}\``;
}

function formatValue(value: MetricValue): string {
  return value === null ? 'не измерено' : String(Number(value.toFixed(4)));
}

const COMPARISON_VERDICT_LABELS: Readonly<Record<ComparisonVerdict, string>> = {
  better: 'лучше',
  worse: 'хуже',
  unclear: 'неясно',
};

const DIRECTION_LABELS: Readonly<
  Record<MetricComparison['direction'], string>
> = {
  higher_is_better: 'больше — лучше',
  lower_is_better: 'меньше — лучше',
};

const RUN_LABELS: Readonly<Record<'baseline' | 'candidate', string>> = {
  baseline: 'базы',
  candidate: 'кандидата',
};

/**
 * Writes the report of a comparison next to its comparison file (design-self-check.md, «Как сравниваются два
 * запуска»): the overall verdict and, when a level stopped it, the reason before any metric; then each comparison
 * metric with both values, the difference «plus is better», the interval and its verdict; then every level with both
 * runs' values. Built from the comparison file alone.
 */
export async function writeComparisonReport(
  dir: string,
  comparison: Comparison,
): Promise<string> {
  const path = join(dir, REPORT_FILE_NAME);
  await writeFile(path, renderComparisonReport(comparison), 'utf8');
  return path;
}

function renderComparisonReport(comparison: Comparison): string {
  return [
    ...comparisonHeader(comparison),
    ...comparisonMetrics(comparison),
    ...comparisonLevels(comparison),
  ].join('\n');
}

function comparisonHeader(comparison: Comparison): string[] {
  const { resampling } = comparison;
  return [
    `# Самопроверка: сравнение \`${comparison.baseline.runId}\` (база) и \`${comparison.candidate.runId}\` (кандидат)`,
    '',
    `- Вид: \`${comparison.kind}\`; ${itemsLine(comparison.items)}`,
    `- Интервал: 95% середины разниц по ${resampling.resamples} перевыборкам сценариев, зерно ${resampling.seed}`,
    `- Общий вердикт: ${
      comparison.verdict === null
        ? `${NONE} — у кандидата нет файла порогов, показаны метрики и интервалы`
        : `«${COMPARISON_VERDICT_LABELS[comparison.verdict]}»`
    }`,
    ...comparison.stoppedBy.map(
      (stop) =>
        `- Причина: у ${RUN_LABELS[stop.run]} ${stop.metric} = ${formatValue(stop.value)}, за пределом \`${stop.level}\` = ${formatValue(stop.limit)}; метрики вердикта не получают`,
    ),
    '',
  ];
}

function comparisonMetrics(comparison: Comparison): string[] {
  return [
    '## Метрики сравнения',
    '',
    'Разница — «плюс лучше»; у метрики в долях от базы разница — доля от значения базы.',
    '',
    '| Метрика | Направление | База | Кандидат | Разница | Интервал | Полоса | Перевыборок без значения | Вердикт |',
    '|---|---|---|---|---|---|---|---|---|',
    ...comparison.metrics.map((metric) => {
      const cells = [
        metric.name,
        `${DIRECTION_LABELS[metric.direction]}${metric.relativeToBaseline ? ', в долях от базы' : ''}`,
        formatValue(metric.baseline),
        formatValue(metric.candidate),
        formatValue(metric.difference),
        metric.interval === null
          ? 'неясно'
          : `от ${formatValue(metric.interval.lower)} до ${formatValue(metric.interval.upper)}`,
        metric.band === null ? NONE : formatValue(metric.band),
        String(metric.resamplesWithoutValue),
        metric.verdict === null
          ? NONE
          : COMPARISON_VERDICT_LABELS[metric.verdict],
      ];
      return `| ${cells.join(' | ')} |`;
    }),
    '',
  ];
}

function comparisonLevels(comparison: Comparison): string[] {
  const ofRun = (run: LevelOfRun) =>
    `${formatValue(run.value)} | ${run.evaluation === null ? NONE : EVALUATION_LABELS[run.evaluation]}`;
  return [
    '## Допустимые уровни',
    '',
    'Уровни не сравниваются: показаны значения обоих запусков.',
    '',
    '| Метрика | Уровень | Предел | База | Оценка базы | Кандидат | Оценка кандидата |',
    '|---|---|---|---|---|---|---|',
    ...comparison.levels.map(
      (row: LevelComparison) =>
        `| ${row.metric} | \`${row.level}\` | ${row.limit === null ? NONE : formatValue(row.limit)} | ${ofRun(row.baseline)} | ${ofRun(row.candidate)} |`,
    ),
    '',
  ];
}
