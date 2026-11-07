import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  configFingerprint,
  deepResearchProcessV2,
  loadProcessConfig,
  type ProcessConfig,
  readTranscripts,
} from '@agent-os/engine';
import {
  buildCalibrationPairs,
  buildJudgeChecks,
  loadScenarioSet,
  type Scenario,
  type ScenarioKey,
  scenarioKey,
  type ScenarioSet,
} from '@agent-os/mcp-fixture';
import type { StoredEvidence } from '@agent-os/runtime';
import { z } from 'zod';
import {
  judgeCheck,
  type JudgeDeps,
  judgeIdentity,
  judgeRunWithKey,
} from '../judge/judge-call.js';
import type { RunKind } from '../metrics.js';
import type { SelfCheckProgram } from '../program.js';
import { writeReport } from '../result/report.js';
import {
  buildRunResult,
  type InjectionMeasure,
  type ItemResult,
  type JudgeAgreement,
  readCodeVersion,
  runConfig,
  type RunEntry,
  runEntry,
  type RunResult,
  writeRunResult,
} from '../result/run-result.js';
import {
  type ScenarioAssembly,
  SELF_CHECK_OWNER,
} from '../scenario-assembly.js';
import { formatThreadId } from '../thread-ids.js';
import { parseThresholds, type Thresholds } from '../thresholds.js';
import { findFirstError, type FirstError } from '../verdict/first-error.js';
import { scenarioVerdict, type Verdict } from '../verdict/verdict.js';
import { measureInjection } from './injection-measure.js';
import { createRunBudget, type RunBudget } from './run-budget.js';
import {
  scenarioWaiterPorts,
  type WaitedRun,
  waitForScenarioRuns,
} from './run-waiter.js';

/**
 * The `run` command of the self-check program (design-self-check.md, Contract `run`, Flow 1): a scenario set run on a
 * configuration, judged, and left as a run directory with the result file and the report. Every refusal —
 * `set_invalid`, `thresholds_invalid`, `process_config_rejected` (`database_not_self_check` comes from the program's
 * start) — is given before the first investigation and before the run directory exists. The leftovers of an earlier
 * run are cancelled after the refusals that need no assembly and before the first assembly (DC-18): an assembly's
 * dispatcher would claim a leftover task at once, so the catalog check of the first assembly follows the cancel. Then
 * the run directory gets the copy of the thresholds file, still before the first investigation (invariant 7, plan
 * Notes 2); the result file is written only at the end, so a run that fails midway leaves the copy and no result file.
 */

/** Runs per scenario when the command does not say (Contract `run`). */
const DEFAULT_RUNS_PER_SCENARIO = 3;

/** The copy of the thresholds file in the run directory; `RunResult.thresholds` is read back from it. */
export const THRESHOLDS_COPY_FILE_NAME = 'thresholds.json';

/** How long a judge call may still start after it is asked for. */
export const JUDGE_WINDOW_MS = 10 * 60_000;

export interface RunOptions {
  readonly setName: string;
  readonly runsPerScenario: number;
  /** Another catalog model for one role of the shipped `deep-research`; null runs the shipped configuration. */
  readonly roleModel: { readonly role: string; readonly model: string } | null;
  /** The thresholds file as given; null without one. */
  readonly thresholdsPath: string | null;
  /** The total token budget of the run; null without a limit. */
  readonly budgetTokens: number | null;
}

/** A refusal of the command, or a usage error of its arguments (`invalid_arguments`, like `unknown_command`). */
export interface RunRefusal {
  readonly ok: false;
  readonly code:
    | 'invalid_arguments'
    | 'set_invalid'
    | 'thresholds_invalid'
    | 'process_config_rejected';
  readonly reason: string;
}

export type RunOutcome =
  | { readonly ok: true; readonly runDir: string; readonly result: RunResult }
  | RunRefusal;

const refusal = (code: RunRefusal['code'], reason: string): RunRefusal => ({
  ok: false,
  code,
  reason,
});

/**
 * `run --set <name> [--runs <n>] [--role-model <role>=<model>] [--thresholds <file>] [--budget <tokens>]`. On success
 * the run directory is printed to stdout by the command line.
 */
export async function executeRunCommand(
  args: readonly string[],
  program: SelfCheckProgram,
): Promise<RunOutcome> {
  const parsed = parseRunArgs(args);
  return parsed.ok ? runScenarioSet(program, parsed.options) : parsed;
}

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

function parseRunArgs(
  args: readonly string[],
): { readonly ok: true; readonly options: RunOptions } | RunRefusal {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: {
        set: { type: 'string' },
        runs: { type: 'string' },
        'role-model': { type: 'string' },
        thresholds: { type: 'string' },
        budget: { type: 'string' },
      },
    }));
  } catch (error) {
    return refusal(
      'invalid_arguments',
      error instanceof Error ? error.message : String(error),
    );
  }
  const { set, runs, budget, thresholds } = values;
  if (set === undefined || set === '') {
    return refusal('set_invalid', 'no scenario set given (--set <name>)');
  }
  if (runs !== undefined && !POSITIVE_INTEGER.test(runs)) {
    return refusal(
      'invalid_arguments',
      `--runs must be a positive integer, got "${runs}"`,
    );
  }
  if (budget !== undefined && !POSITIVE_INTEGER.test(budget)) {
    return refusal(
      'invalid_arguments',
      `--budget must be a positive integer of tokens, got "${budget}"`,
    );
  }
  const roleModel = parseRoleModel(values['role-model']);
  if (roleModel === 'invalid') {
    return refusal(
      'invalid_arguments',
      '--role-model must be <role>=<provider/model>',
    );
  }
  return {
    ok: true,
    options: {
      setName: set,
      runsPerScenario:
        runs === undefined ? DEFAULT_RUNS_PER_SCENARIO : Number(runs),
      roleModel,
      thresholdsPath: thresholds === undefined ? null : resolve(thresholds),
      budgetTokens: budget === undefined ? null : Number(budget),
    },
  };
}

export function parseRoleModel(
  value: string | undefined,
): RunOptions['roleModel'] | 'invalid' {
  if (value === undefined) return null;
  const separator = value.indexOf('=');
  const role = value.slice(0, separator);
  const model = value.slice(separator + 1);
  return separator <= 0 || model === '' ? 'invalid' : { role, model };
}

/** What every step of one run shares. */
interface RunContext {
  readonly program: SelfCheckProgram;
  readonly options: RunOptions;
  readonly runId: string;
  /** `self-check:run:<runId>`: the conversation of every scenario run and the binding of the judge checks. */
  readonly selfCheckRunId: string;
  readonly processConfig: unknown;
  readonly config: ProcessConfig;
  readonly budget: RunBudget;
}

/** The command over parsed options: refusals first, then the run directory, the scenarios, the judge checks, the files. */
async function runScenarioSet(
  program: SelfCheckProgram,
  options: RunOptions,
): Promise<RunOutcome> {
  const loadedSet = loadScenarioSet(options.setName);
  if (!loadedSet.ok) return refusal('set_invalid', loadedSet.detail);
  const { set } = loadedSet;
  const thresholdsText = await readThresholdsFile(options.thresholdsPath);
  if (thresholdsText !== null && !thresholdsText.ok) return thresholdsText;
  const processConfig = configWithRoleModel(options.roleModel);
  const loadedConfig = loadProcessConfig(processConfig);
  if (!loadedConfig.ok) {
    const { path, message } = loadedConfig.rejection;
    return refusal(
      'process_config_rejected',
      `process configuration rejected at ${path.join('.')}: ${message}`,
    );
  }
  const config = loadedConfig.config;
  const [firstScenario] = set.scenarios;
  if (firstScenario === undefined) {
    throw new Error(`scenario set ${set.name} has no scenario`);
  }
  // Every refusal that needs no assembly is behind; the leftovers go before the first assembly exists (DC-18).
  await program.cancelLeftovers();
  // The catalog check of the role models and the judge model is `createEngine`'s, in the first scenario's assembly.
  const firstAssembly = await assembleChecked(
    program,
    firstScenario,
    processConfig,
  );
  if (!('engine' in firstAssembly)) return firstAssembly;
  const budget = createRunBudget(options.budgetTokens);
  const runBudgets = Array.from(
    { length: options.runsPerScenario },
    () => config.limits.investigationTokens.default,
  );

  const createdAt = program.clock.now();
  const runId = newRunId(createdAt);
  const runDir = join(program.reportsDir, runId);
  const context: RunContext = {
    program,
    options,
    runId,
    selfCheckRunId: formatThreadId({ kind: 'run', runId }),
    processConfig,
    config,
    budget,
  };
  try {
    await mkdir(runDir, { recursive: true });
    if (thresholdsText !== null) {
      await writeFile(
        join(runDir, THRESHOLDS_COPY_FILE_NAME),
        thresholdsText.text,
        'utf8',
      );
    }
  } catch (error) {
    await firstAssembly.close();
    throw error;
  }
  program.logger.log('self-check run started', {
    runId,
    set: set.name,
    setFingerprint: set.fingerprint,
    runsPerScenario: options.runsPerScenario,
  });
  // The first scenario runs on the assembly of the catalog check; every scenario, the first included, must be admitted.
  const outcomes: ScenarioOutcome[] = [];
  let assembled: ScenarioAssembly | null = firstAssembly;
  for (const scenario of set.scenarios) {
    outcomes.push(
      await admitAndRunScenario(context, scenario, runBudgets, assembled),
    );
    assembled = null;
  }
  const { judgeAgreement, injection } = await measureOnOwnAssembly(
    context,
    set,
    outcomes,
  );
  const result = buildRunResult({
    runId,
    kind: 'scenarios',
    createdAt,
    codeVersion: await readCodeVersion(
      fileURLToPath(new URL('.', import.meta.url)),
    ),
    items: { kind: 'set', setName: set.name, setFingerprint: set.fingerprint },
    config: runConfig(resultConfig(outcomes, config), null),
    judge: judgeIdentity(program.settings.judge, 'withKey'),
    thresholds: await readThresholdsCopy(runDir, thresholdsText !== null),
    results: outcomes.map(({ item }) => ({
      ...item,
      injection: item.ran ? (injection.get(scenarioIdOf(item)) ?? null) : null,
    })),
    judgeAgreement,
  });
  await writeRunResult(runDir, result);
  await writeReport(runDir, result);
  program.logger.log('self-check run written', {
    runId,
    runDir,
    complete: result.complete,
  });
  return { ok: true, runDir, result };
}

type ThresholdsText = { readonly ok: true; readonly text: string } | RunRefusal;

/** The thresholds file's text when it parses and is complete for a run of this kind (`thresholds_invalid` otherwise). */
export async function readThresholdsFile(
  path: string | null,
  runKind: RunKind = 'scenarios',
): Promise<ThresholdsText | null> {
  if (path === null) return null;
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return refusal(
      'thresholds_invalid',
      `thresholds file ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const data = parseJson(text);
  if (data === undefined) {
    return refusal('thresholds_invalid', `thresholds file ${path} is not JSON`);
  }
  const parsed = parseThresholds(data, runKind);
  return parsed.ok ? { ok: true, text } : parsed;
}

/** The copy in the run directory, read back unchanged; it was checked before it was written. */
export async function readThresholdsCopy(
  runDir: string,
  copied: boolean,
  runKind: RunKind = 'scenarios',
): Promise<Thresholds | null> {
  if (!copied) return null;
  const text = await readFile(join(runDir, THRESHOLDS_COPY_FILE_NAME), 'utf8');
  const parsed = parseThresholds(parseJson(text), runKind);
  if (!parsed.ok) {
    throw new Error(
      `the thresholds copy in ${runDir} no longer passes its check: ${parsed.reason}`,
    );
  }
  return parsed.thresholds;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The shipped `deep-research` as data, with another model in one role when asked. It stays data: the schema and the
 * catalog check of `createEngine` refuse it with the path to the field (ADR-0005), an unknown role included.
 */
function configWithRoleModel(roleModel: RunOptions['roleModel']): unknown {
  if (roleModel === null) return deepResearchProcessV2;
  const shipped = loadProcessConfig(deepResearchProcessV2);
  if (!shipped.ok) {
    throw new Error(
      `the shipped deep-research configuration is rejected at ${shipped.rejection.path.join('.')}`,
    );
  }
  const roles: Readonly<Record<string, object>> = shipped.config.roles;
  const role = Object.hasOwn(roles, roleModel.role)
    ? roles[roleModel.role]
    : {};
  return {
    ...shipped.config,
    roles: { ...roles, [roleModel.role]: { ...role, model: roleModel.model } },
  };
}

/** A scenario's assembly, or `process_config_rejected` with the path `createEngine` names. */
async function assembleChecked(
  program: SelfCheckProgram,
  scenario: Scenario,
  processConfig: unknown,
): Promise<ScenarioAssembly | RunRefusal> {
  try {
    return await program.assembleScenario({
      scenario: `${scenario.setName}/${scenario.scenarioId}`,
      processConfig,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'process_config_rejected'
    ) {
      return refusal('process_config_rejected', error.message);
    }
    throw error;
  }
}

/**
 * A scenario is «не прогнан» when the budget's remainder does not cover all its runs (UC-E8) — the first one too, so a
 * budget below one scenario still leaves an incomplete run with its result file. An assembly made already (the first
 * scenario's, for the catalog check) is used, or closed unused.
 */
async function admitAndRunScenario(
  context: RunContext,
  scenario: Scenario,
  runBudgets: readonly number[],
  assembled: ScenarioAssembly | null,
): Promise<ScenarioOutcome> {
  const key = scenarioKey(scenario);
  if (context.budget.admitScenario(runBudgets) === 'not_run') {
    await assembled?.close();
    context.program.logger.log('scenario not run: run budget', {
      runId: context.runId,
      scenarioId: scenario.scenarioId,
      spentTokens: context.budget.spentTokens(),
    });
    return {
      item: {
        item: { scenarioId: scenario.scenarioId },
        kind: key.kind,
        ran: false,
        runs: [],
      },
      records: [],
    };
  }
  const assembly =
    assembled ??
    (await assembleChecked(context.program, scenario, context.processConfig));
  if (!('engine' in assembly)) {
    throw new Error(
      `the configuration accepted for the first scenario was refused later: ${assembly.reason}`,
    );
  }
  return runScenario(context, scenario, assembly);
}

interface ScenarioOutcome {
  readonly item: ItemResult;
  /** The run records of the scenario, for the result's configuration. */
  readonly records: readonly WaitedRun['record'][];
}

/**
 * One scenario on its own assembly: all runs started at once for `system:self-check`, waited for until the queue is
 * empty, each judged and given its verdict; then the assembly is closed, so the next scenario starts on a new fixture.
 */
async function runScenario(
  context: RunContext,
  scenario: Scenario,
  assembly: ScenarioAssembly,
): Promise<ScenarioOutcome> {
  const { program, budget, config } = context;
  const key = scenarioKey(scenario);
  try {
    const started = [];
    for (let index = 0; index < context.options.runsPerScenario; index += 1) {
      const startedAt = program.clock.now();
      const start = await assembly.engine.startInvestigation({
        resourceId: SELF_CHECK_OWNER,
        threadId: context.selfCheckRunId,
        query: key.question,
        processId: config.processId,
        version: config.version,
        launchKey: `${context.runId}/${scenario.scenarioId}/${index}`,
      });
      if (start.outcome === 'rejected') {
        throw new Error(
          `run ${index} of scenario ${scenario.scenarioId} was refused: ${start.code}`,
        );
      }
      started.push({ investigationId: start.investigationId, startedAt });
    }
    const waited = await waitForScenarioRuns(
      scenarioWaiterPorts(assembly, program.clock),
      {
        runs: started,
        controllerDeadlineMs:
          config.limits.taskBudgets['research.controller'].deadlineMs,
      },
    );
    const judge: JudgeDeps = {
      engine: assembly.engine,
      judge: program.settings.judge,
    };
    const runs: RunEntry[] = [];
    for (const run of waited) {
      budget.chargeInvestigation(run.usage);
      runs.push(await judgedRun(judge, key, run, program.clock.now()));
      program.logger.log('scenario run judged', {
        runId: context.runId,
        scenarioId: scenario.scenarioId,
        investigationId: run.investigationId,
        outcome: run.outcome,
      });
    }
    await chargeJudgeCalls(assembly, budget, waited);
    return {
      item: {
        item: { scenarioId: scenario.scenarioId },
        kind: key.kind,
        ran: true,
        runs,
      },
      records: waited.map((run) => run.record),
    };
  } finally {
    await assembly.close();
  }
}

/** A run's row: `timeout` and a run without an answer get their verdict before the judge (DC-9). */
export async function judgedRun(
  deps: JudgeDeps,
  key: ScenarioKey,
  run: WaitedRun,
  now: Date,
): Promise<RunEntry> {
  const { record } = run;
  if (run.outcome === 'timeout') {
    const verdict: Verdict = { verdict: 'unclear', reason: 'timeout' };
    return runEntry({
      record,
      verdict,
      judgeForm: null,
      firstError: null,
      signals: null,
    });
  }
  if (record.answer === null) {
    const verdict = scenarioVerdict({ answer: null });
    return runEntry({
      record,
      verdict,
      judgeForm: null,
      firstError: null,
      signals: null,
    });
  }
  const judged = await judgeRunWithKey(deps, {
    key,
    answer: record.answer,
    investigationId: record.investigationId,
    notAfter: new Date(now.getTime() + JUDGE_WINDOW_MS),
  });
  const pageTraceIds = new Map(
    [...run.pages].map(
      ([evidenceId, page]) => [evidenceId, traceIdsOf(page)] as const,
    ),
  );
  const verdict = scenarioVerdict({
    answer: record.answer,
    form: judged.checked,
    key,
    pageTraceIds,
  });
  return runEntry({
    record,
    verdict,
    judgeForm: judged.checked,
    firstError: firstErrorOf(key, run, verdict, pageTraceIds),
    signals: null,
  });
}

/** The first-error stage of an unsolved cause scenario; none for a «ответа нет» scenario or a verdict that is not «не пройден». */
function firstErrorOf(
  key: ScenarioKey,
  run: Extract<WaitedRun, { outcome: 'finished' }>,
  verdict: Verdict,
  pageTraceIds: ReadonlyMap<string, readonly string[]>,
): FirstError | null {
  if (
    key.kind !== 'cause' ||
    verdict.verdict !== 'failed' ||
    verdict.reason === 'cause_invented'
  ) {
    return null;
  }
  const { record } = run;
  return findFirstError({
    keyTraceIds: key.causeTraceIds,
    pages: [...pageTraceIds].map(([evidenceId, traceIds]) => ({
      evidenceId,
      traceIds,
    })),
    claims: record.claims.map(({ claimId, status, evidenceIds }) => ({
      claimId,
      status,
      evidenceIds,
    })),
    establishedClaimIds: (record.answer?.established ?? []).map(
      ({ claimId }) => claimId,
    ),
    verdict: verdict.reason,
  });
}

/** An evidence page of `source.fetch`: its records are `items`. */
const EvidencePageSchema = z.object({ items: z.array(z.unknown()) });
/** A log record carries its trace in the `traceId` field; a count group carries none. */
const TracedRecordSchema = z.object({ traceId: z.string() });
const decoder = new TextDecoder();

/** The `traceId` fields of a page's records: identifiers, not text. */
function traceIdsOf(page: StoredEvidence): string[] {
  const { items } = EvidencePageSchema.parse(
    JSON.parse(decoder.decode(page.bytes)),
  );
  return items.flatMap((item) => {
    const traced = TracedRecordSchema.safeParse(item);
    return traced.success ? [traced.data.traceId] : [];
  });
}

/** The judge's spend on the scenario's runs, by the transcripts bound to each investigation. */
async function chargeJudgeCalls(
  assembly: ScenarioAssembly,
  budget: RunBudget,
  waited: readonly WaitedRun[],
): Promise<void> {
  for (const { investigationId } of waited) {
    const read = await readTranscripts(assembly.database.db, {
      investigationId,
      ownerId: SELF_CHECK_OWNER,
      retention: 'no_term',
    });
    if (read.outcome !== 'found') {
      throw new Error(
        `transcripts of self-check run ${investigationId} not found`,
      );
    }
    budget.chargeAssessCalls(read.transcripts);
  }
}

/** What the run measures at the end on an assembly of its own: judge agreement and the injection measure. */
interface SetMeasures {
  readonly judgeAgreement: JudgeAgreement;
  /** By scenario id, for every scenario that ran. */
  readonly injection: ReadonlyMap<string, InjectionMeasure>;
}

const scenarioIdOf = ({ item }: ItemResult): string =>
  'scenarioId' in item ? item.scenarioId : item.investigationId;

/**
 * Judge agreement on the set's check answers (DC-8, AC-04.4) and the measure of text addressed to the model over the
 * scenarios that ran (AC-17.1), each call bound to the run id. They run at the end on an assembly of its own, whose
 * `assessModels` hold the judge and the `verifier` model; their spend is charged after, and may pass the limit
 * (Constraints, «Бюджет»).
 */
async function measureOnOwnAssembly(
  context: RunContext,
  set: ScenarioSet,
  outcomes: readonly ScenarioOutcome[],
): Promise<SetMeasures> {
  const { program, budget, selfCheckRunId } = context;
  const [firstScenario] = set.scenarios;
  if (firstScenario === undefined)
    throw new Error(`scenario set ${set.name} has no scenario`);
  const assembly = await assembleChecked(
    program,
    firstScenario,
    context.processConfig,
  );
  if (!('engine' in assembly)) {
    throw new Error(
      `the configuration accepted for the first scenario was refused later: ${assembly.reason}`,
    );
  }
  try {
    const judgeAgreement = await measureJudge(context, set, assembly);
    const ran = new Set(
      outcomes.flatMap(({ item }) => (item.ran ? [scenarioIdOf(item)] : [])),
    );
    const injection = await measureInjectionOfSet(context, set, ran, assembly);
    const read = await readTranscripts(assembly.database.db, {
      selfCheckRunId,
      retention: 'no_term',
    });
    if (read.outcome !== 'found')
      throw new Error(`transcripts of ${selfCheckRunId} not found`);
    budget.chargeAssessCalls(read.transcripts);
    return { judgeAgreement, injection };
  } finally {
    await assembly.close();
  }
}

/** Judge agreement: the set's check answers filled right out of all. */
async function measureJudge(
  context: RunContext,
  set: ScenarioSet,
  assembly: ScenarioAssembly,
): Promise<JudgeAgreement> {
  const { program, selfCheckRunId } = context;
  const keys = new Map(
    set.scenarios.map((scenario) => [
      scenario.scenarioId,
      scenarioKey(scenario),
    ]),
  );
  const checks = buildJudgeChecks(set);
  const deps: JudgeDeps = {
    engine: assembly.engine,
    judge: program.settings.judge,
  };
  let correct = 0;
  for (const check of checks) {
    const key = keys.get(check.scenarioId);
    if (key === undefined)
      throw new Error(
        `judge check ${check.checkId} names no scenario of the set`,
      );
    const notAfter = new Date(program.clock.now().getTime() + JUDGE_WINDOW_MS);
    const checked = await judgeCheck(deps, {
      check,
      key,
      selfCheckRunId,
      notAfter,
    });
    if (checked.agreed) correct += 1;
  }
  program.logger.log('judge agreement measured', {
    runId: context.runId,
    correct,
    total: checks.length,
  });
  return { correct, total: checks.length };
}

/**
 * The injection measure of each scenario that ran (design-engine.md, `injectionInfluence`): its `injected`
 * calibration pairs, as `calibrate` builds them, checked by the run's `verifier` through `Engine.assess`. A scenario
 * without text addressed to the model has no such pair and measures nothing.
 */
async function measureInjectionOfSet(
  context: RunContext,
  set: ScenarioSet,
  ran: ReadonlySet<string>,
  assembly: ScenarioAssembly,
): Promise<Map<string, InjectionMeasure>> {
  const { program, config, selfCheckRunId } = context;
  const measures = new Map<string, InjectionMeasure>();
  for (const scenario of set.scenarios) {
    if (!ran.has(scenario.scenarioId)) continue;
    const key = scenarioKey(scenario);
    const pairs =
      key.injectionTraceIds.length === 0
        ? []
        : buildCalibrationPairs({ ...set, scenarios: [scenario] }).pairs;
    const measure = await measureInjection({
      pairs,
      injectionTraceIds: key.injectionTraceIds,
      verifier: config.roles.verifier,
      assess: (request) => assembly.engine.assess(request),
      selfCheckRunId,
      clock: program.clock,
    });
    measures.set(scenario.scenarioId, measure);
    if (pairs.length > 0) {
      program.logger.log('injection influence measured', {
        runId: context.runId,
        scenarioId: scenario.scenarioId,
        ...measure,
      });
    }
  }
  return measures;
}

/**
 * All runs share the configuration, so the first run record names it; when the budget admitted no scenario, there is
 * no record and the loaded configuration is named the way a record would name it.
 */
function resultConfig(
  results: readonly ScenarioOutcome[],
  config: ProcessConfig,
): Pick<WaitedRun['record']['config'], 'processConfig' | 'fingerprint'> {
  const record = results.flatMap(({ records }) => records)[0];
  return record === undefined
    ? { processConfig: config, fingerprint: configFingerprint(config) }
    : record.config;
}

/** A sortable run id without `:`, so it fits `self-check:run:<runId>` and a directory name (`RUN_ID_PATTERN`). */
export function newRunId(createdAt: Date): string {
  const stamp = createdAt.toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}
