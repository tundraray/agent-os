import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  type ProcessConfig,
  promptVersion,
  type RunRecord,
} from '@agent-os/engine';
import type { ScenarioKey } from '@agent-os/mcp-fixture';
import type { FormCheckResult } from '../judge/form-check.js';
import type { JudgeIdentity } from '../judge/judge-call.js';
import type { KeyedJudgeForm } from '../judge/judge-forms.js';
import {
  type MetricInput,
  type MetricItem,
  type MetricRun,
  type RunKind,
  type RunMetrics,
  runMetrics,
} from '../metrics.js';
import type { FailureSignals } from '../signals.js';
import type { Thresholds } from '../thresholds.js';
import type { FirstError } from '../verdict/first-error.js';
import type { Verdict } from '../verdict/verdict.js';

/**
 * The run result file (design-self-check.md, Contract Definitions, `RunResult`): what a run measured, as JSON in the
 * run directory. The `engine` part measures the effect of its changes by it, and `compare` reads two of them. Steps,
 * tokens and cost of a run come from its run record — accepted controller decisions and the call journal — never from
 * a count the program keeps itself.
 */

/** The result file's name in the run directory. */
export const RESULT_FILE_NAME = 'result.json';

/**
 * The form of a run id as `newRunId` writes it: the ISO time with `:` and `.` replaced by `-`, then 8 hex characters.
 * A result file whose `runId` has another form is not one the program wrote; `compare` names its directory by it.
 */
export const RUN_ID_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;

type ProcessRole = keyof ProcessConfig['roles'];

/** What the run went over: a scenario set with its fingerprint, or the source investigations of a replays run. */
export type RunItems =
  | {
      readonly kind: 'set';
      readonly setName: string;
      readonly setFingerprint: string;
    }
  | {
      readonly kind: 'investigations';
      readonly investigations: readonly { readonly investigationId: string }[];
    };

/** The configuration of the run: its fingerprint, each role's model and prompt version, and for replays which one. */
export interface RunConfig {
  readonly fingerprint: string;
  readonly roles: Readonly<
    Record<
      ProcessRole,
      { readonly model: string; readonly promptVersion: string }
    >
  >;
  /** A replays run takes the frozen configuration of the original or the shipped one; null for a scenarios run. */
  readonly choice: 'frozen' | 'shipped' | null;
}

/** One run of a scenario or of a source investigation. */
export interface RunEntry {
  readonly investigationId: string;
  readonly status: RunRecord['status'];
  /** Null when the investigation has no answer. */
  readonly answerOutcome: NonNullable<RunRecord['answer']>['outcome'] | null;
  readonly stopReason: NonNullable<RunRecord['answer']>['stopReason'] | null;
  /** The verdict and its reason code; null for a run without a key. */
  readonly verdict: Verdict | null;
  /** The first-error stage of an unsolved cause run; null otherwise. */
  readonly firstError: FirstError | null;
  /** Accepted controller decisions. */
  readonly steps: number;
  /** From the call journal of the investigation. */
  readonly tokens: number;
  readonly costUsd: number;
  /** Claims the answer places in «Установлено». */
  readonly establishedClaims: number;
  /** Established claims the judge named as contradicting the key; null without a form that passed the check. */
  readonly contradictingClaims: number | null;
  /** The failure signals; null for a run judged by a key. */
  readonly signals: FailureSignals | null;
}

/** A scenario or a source investigation with its runs; one left «не прогнан» has `ran: false` and no runs. */
export interface ItemResult {
  readonly item:
    { readonly scenarioId: string } | { readonly investigationId: string };
  /** The kind from the scenario key; null for a source investigation without a key. */
  readonly kind: ScenarioKey['kind'] | null;
  readonly ran: boolean;
  readonly runs: readonly RunEntry[];
  /**
   * A replays run only: the failure signals of the source investigation itself, next to its repeats' signals; null for
   * a source with a key, whose repeats get a verdict instead. A scenarios run leaves the field out.
   */
  readonly sourceSignals?: FailureSignals | null;
  /**
   * A scenarios run only: the measure of text addressed to the model over the scenario's `injected` calibration pairs
   * (design-engine.md, `injectionInfluence`); null for a scenario left «не прогнан». A replays run, and a result file
   * written before the `engine` part, leave the field out: such a run has not measured it (plan Notes 1, decision 8).
   */
  readonly injection?: InjectionMeasure | null;
}

/** The pairs of one scenario checked as they are and without the injected traces' records. */
export interface InjectionMeasure {
  /** Pairs whose two checks both gave an assessment in form. */
  readonly measuredPairs: number;
  /** Measured pairs whose `support` or `claimType` differed between the two checks. */
  readonly influencedPairs: number;
  /** Pairs left out because a check failed or its answer was not in form. */
  readonly unassessedPairs: number;
}

export interface JudgeAgreement {
  readonly correct: number;
  readonly total: number;
}

/** The fields of the contract, in its order. */
export interface RunResult {
  readonly runId: string;
  readonly kind: RunKind;
  /** ISO 8601. */
  readonly createdAt: string;
  /** The git commit of the program, or null when it cannot be read. */
  readonly codeVersion: string | null;
  readonly items: RunItems;
  readonly config: RunConfig;
  readonly judge: JudgeIdentity;
  /** The copy of the thresholds file made before the first investigation, unchanged; null without a file. */
  readonly thresholds: Thresholds | null;
  /** Whether every scenario or source investigation was run. */
  readonly complete: boolean;
  readonly results: readonly ItemResult[];
  /** Check answers the judge filled right, out of all; null for a replays run, which has none. */
  readonly judgeAgreement: JudgeAgreement | null;
  readonly metrics: RunMetrics;
}

export interface RunEntryInput {
  /** The run record read once after the run ended, or after it was cancelled for the deadline. */
  readonly record: RunRecord;
  readonly verdict: Verdict | null;
  /** The keyed judge form after the form check; null when the run has no answer or no key. */
  readonly judgeForm: FormCheckResult<KeyedJudgeForm> | null;
  readonly firstError: FirstError | null;
  readonly signals: FailureSignals | null;
}

/** A run's row of the result file: statuses, counts and identifiers from the record and the judge form. */
export function runEntry({
  record,
  verdict,
  judgeForm,
  firstError,
  signals,
}: RunEntryInput): RunEntry {
  return {
    investigationId: record.investigationId,
    status: record.status,
    answerOutcome: record.answer?.outcome ?? null,
    stopReason: record.answer?.stopReason ?? null,
    verdict,
    firstError,
    steps: record.decisions.filter((decision) => decision.status === 'accepted')
      .length,
    tokens: record.usage.totalTokens,
    costUsd: record.usage.totalCostUsd,
    establishedClaims: record.answer?.established?.length ?? 0,
    contradictingClaims:
      judgeForm?.valid === true
        ? judgeForm.form.contradictingClaimIds.length
        : null,
    signals,
  };
}

/** The configuration as the result file names it: the fingerprint and, per role, the model and its prompt version. */
export function runConfig(
  config: Pick<RunRecord['config'], 'processConfig' | 'fingerprint'>,
  choice: RunConfig['choice'],
): RunConfig {
  const { processConfig } = config;
  if ('agents' in processConfig) {
    // DC-29: the result file names the roles of the roles form; an agents-form configuration is a defect, not a fallback.
    throw new Error(
      `the result file names the roles form only: ${processConfig.processId} is of the agents form`,
    );
  }
  const roleOf = (role: ProcessRole) => {
    const { model, prompt } = processConfig.roles[role];
    return { model, promptVersion: promptVersion(prompt) };
  };
  return {
    fingerprint: config.fingerprint,
    roles: {
      plan: roleOf('plan'),
      controller: roleOf('controller'),
      worker: roleOf('worker'),
      verifier: roleOf('verifier'),
      synthesis: roleOf('synthesis'),
    },
    choice,
  };
}

export type RunResultInput = Omit<
  RunResult,
  'createdAt' | 'complete' | 'metrics'
> & {
  readonly createdAt: Date;
};

/** The result file of a run: `complete` and `metrics` follow from the results, so they cannot disagree with them. */
export function buildRunResult(input: RunResultInput): RunResult {
  const metricInput: MetricInput = {
    items: input.results.map(metricItem),
    judgeAgreement: input.judgeAgreement,
  };
  return {
    runId: input.runId,
    kind: input.kind,
    createdAt: input.createdAt.toISOString(),
    codeVersion: input.codeVersion,
    items: input.items,
    config: input.config,
    judge: input.judge,
    thresholds: input.thresholds,
    complete: input.results.every((item) => item.ran),
    results: input.results,
    judgeAgreement: input.judgeAgreement,
    metrics: runMetrics(input.kind, metricInput),
  };
}

/** An item's row of the metric input; a scenario without a measured pair is not in the measure of `injectionInfluence`. */
export function metricItem(item: ItemResult): MetricItem {
  const injection = item.injection ?? null;
  return {
    kind: item.kind,
    runs: item.runs.map(metricRun),
    injectionInfluenced:
      injection === null || injection.measuredPairs === 0
        ? null
        : injection.influencedPairs > 0,
  };
}

/** A run whose judge form did not pass has no known contradictions, so its established claims are not counted either. */
function metricRun(entry: RunEntry): MetricRun {
  const judged = entry.contradictingClaims !== null;
  return {
    verdict: entry.verdict?.verdict ?? null,
    costUsd: entry.costUsd,
    establishedClaims: judged ? entry.establishedClaims : 0,
    contradictingClaims: entry.contradictingClaims ?? 0,
    signals: entry.signals,
    firstErrorRole: entry.firstError?.role ?? null,
  };
}

const execFileAsync = promisify(execFile);

/**
 * The commit the program runs from, or null: «коммит git или пусто» — a program run outside a git checkout, or
 * without git installed, still writes its result file.
 */
export async function readCodeVersion(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd,
    });
    const commit = stdout.trim();
    return commit === '' ? null : commit;
  } catch {
    return null;
  }
}

/** Writes the result file into the run directory; the directory exists since the thresholds copy was put there. */
export async function writeRunResult(
  runDir: string,
  result: RunResult,
): Promise<string> {
  const path = join(runDir, RESULT_FILE_NAME);
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return path;
}
