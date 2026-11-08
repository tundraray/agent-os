import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type Database, researchInvestigations } from '@agent-os/db';
import {
  type AssessBinding,
  type ProcessConfig,
  readRunRecord,
  type RunRecord,
} from '@agent-os/engine';
import {
  loadScenarioSet,
  type ScenarioKey,
  scenarioKey,
} from '@agent-os/mcp-fixture';
import { eq } from 'drizzle-orm';
import {
  type JudgeDeps,
  judgeIdentity,
  judgeRunWithoutKey,
} from '../judge/judge-call.js';
import type { SelfCheckProgram } from '../program.js';
import { writeReport } from '../result/report.js';
import {
  buildRunResult,
  type ItemResult,
  readCodeVersion,
  runConfig,
  type RunEntry,
  runEntry,
  type RunResult,
  writeRunResult,
} from '../result/run-result.js';
import {
  JUDGE_WINDOW_MS,
  judgedRun,
  newRunId,
  parseRoleModel,
  readThresholdsCopy,
  readThresholdsFile,
  THRESHOLDS_COPY_FILE_NAME,
} from '../run/run-command.js';
import {
  scenarioWaiterPorts,
  type StartedRun,
  type WaitedRun,
  waitForScenarioRuns,
} from '../run/run-waiter.js';
import { SELF_CHECK_OWNER } from '../../auth/system-owners.js';
import type { ScenarioAssembly } from '../scenario-assembly.js';
import { type FailureSignals, failureSignals } from '../signals.js';
import { copyOrigin, formatThreadId } from '../thread-ids.js';
import { scenarioVerdict, type Verdict } from '../verdict/verdict.js';
import { type ReplayConfigChoice, replayConfig } from './replay-config.js';
import {
  type FixtureSlice,
  knownFixtureSlices,
  resolveReplaySlice,
} from './replay-slice.js';

/**
 * The `replay` command of the self-check program (design-self-check.md, KD-7, Flow 2, Contract `replay`): repeats of
 * saved investigations, each a new investigation of `system:self-check` with the original's question, on the slice the original saw, with the frozen configuration (or the shipped one by choice). Every refusal
 * — `invalid_arguments`, `thresholds_invalid`, `investigation_not_found`, `replay_slice_unknown`,
 * `process_config_rejected` (schema and catalog), `replay_slice_mismatch` — is given for all originals before the
 * first investigation is started and before the run directory exists. The leftovers of an earlier run are cancelled
 * after the refusals that need no assembly and before the first assembly (DC-18): an assembly's dispatcher would claim
 * a leftover task at once, so the catalog check and the slice check follow the cancel. The original is only read.
 */

/** Repeats per source investigation when the command does not say; the same default as `run`. */
const DEFAULT_RUNS_PER_INVESTIGATION = 3;

const DEFAULT_CHOICE: ReplayConfigChoice = 'frozen';
const CHOICES: readonly ReplayConfigChoice[] = ['frozen', 'shipped'];

export interface ReplayOptions {
  readonly investigationIds: readonly string[];
  /** The owner of the originals: an employee, or `system:self-check` for a scenario run. */
  readonly ownerId: string;
  readonly runsPerInvestigation: number;
  readonly choice: ReplayConfigChoice;
  /** Another catalog model for one role of the chosen configuration; null keeps its models. */
  readonly roleModel: { readonly role: string; readonly model: string } | null;
  /** The thresholds file as given; null without one. */
  readonly thresholdsPath: string | null;
}

/** A refusal of the command, or a usage error of its arguments. */
export interface ReplayRefusal {
  readonly ok: false;
  readonly code:
    | 'invalid_arguments'
    | 'thresholds_invalid'
    | 'process_config_rejected'
    | 'investigation_not_found'
    | 'replay_slice_unknown'
    | 'replay_slice_mismatch';
  readonly reason: string;
}

export type ReplayOutcome =
  | { readonly ok: true; readonly runDir: string; readonly result: RunResult }
  | ReplayRefusal;

const refusal = (
  code: ReplayRefusal['code'],
  reason: string,
): ReplayRefusal => ({ ok: false, code, reason });

/**
 * `replay --investigation <id> [--investigation <id> ...] --owner <ownerId> [--runs <n>] [--config frozen|shipped]
 * [--role-model <role>=<model>] [--thresholds <file>]`. On success the run directory is printed to stdout by the
 * command line.
 */
export async function executeReplayCommand(
  args: readonly string[],
  program: SelfCheckProgram,
): Promise<ReplayOutcome> {
  const parsed = parseReplayArgs(args);
  return parsed.ok ? replayInvestigations(program, parsed.options) : parsed;
}

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

function parseReplayArgs(
  args: readonly string[],
): { readonly ok: true; readonly options: ReplayOptions } | ReplayRefusal {
  let values: {
    readonly investigation?: string[];
    readonly [name: string]: string | string[] | undefined;
  };
  try {
    ({ values } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: {
        investigation: { type: 'string', multiple: true },
        owner: { type: 'string' },
        runs: { type: 'string' },
        config: { type: 'string' },
        'role-model': { type: 'string' },
        thresholds: { type: 'string' },
      },
    }));
  } catch (error) {
    return refusal(
      'invalid_arguments',
      error instanceof Error ? error.message : String(error),
    );
  }
  const single = (name: string): string | undefined => {
    const value = values[name];
    return typeof value === 'string' ? value : undefined;
  };
  const investigationIds = values.investigation ?? [];
  const owner = single('owner');
  const runs = single('runs');
  const choice = single('config') ?? DEFAULT_CHOICE;
  const thresholds = single('thresholds');
  const roleModel = parseRoleModel(single('role-model'));
  const usage = usageError({
    investigationIds,
    owner,
    runs,
    choice,
    roleModel,
  });
  if (usage !== null) return refusal('invalid_arguments', usage);
  return {
    ok: true,
    options: {
      investigationIds,
      ownerId: owner ?? '',
      runsPerInvestigation:
        runs === undefined ? DEFAULT_RUNS_PER_INVESTIGATION : Number(runs),
      choice: CHOICES.find((known) => known === choice) ?? DEFAULT_CHOICE,
      roleModel: roleModel === 'invalid' ? null : roleModel,
      thresholdsPath: thresholds === undefined ? null : resolve(thresholds),
    },
  };
}

/** The first usage error of the arguments, or null. */
function usageError(given: {
  readonly investigationIds: readonly string[];
  readonly owner: string | undefined;
  readonly runs: string | undefined;
  readonly choice: string;
  readonly roleModel: ReplayOptions['roleModel'] | 'invalid';
}): string | null {
  if (given.investigationIds.length === 0) {
    return 'no investigation given (--investigation <id>)';
  }
  if (new Set(given.investigationIds).size !== given.investigationIds.length) {
    return 'an investigation is given more than once';
  }
  if (given.owner === undefined || given.owner === '') {
    return 'no owner given (--owner <ownerId>)';
  }
  if (given.runs !== undefined && !POSITIVE_INTEGER.test(given.runs)) {
    return `--runs must be a positive integer, got "${given.runs}"`;
  }
  if (!CHOICES.some((known) => known === given.choice)) {
    return `--config must be one of ${CHOICES.join(', ')}, got "${given.choice}"`;
  }
  if (given.roleModel === 'invalid') {
    return '--role-model must be <role>=<provider/model>';
  }
  return null;
}

/** A source investigation accepted for replay: everything its repeats need, decided before any start. */
interface ReplayItem {
  readonly investigationId: string;
  /** The owner of the original: an employee's original gets no self-check transcript of its own. */
  readonly ownerId: string;
  readonly record: RunRecord;
  readonly slice: FixtureSlice;
  /** What the fixture is started on: `v1`, `v2` or `<set>/<scenario>`. */
  readonly served: string;
  readonly processConfig: ProcessConfig;
  /** The scenario key of an original run on a scenario slice; null for an investigation without a key. */
  readonly key: ScenarioKey | null;
  /** `self-check:copy:<investigationId>` of the original, inherited by a repeat of a repeat. */
  readonly threadId: string;
}

/** The command over parsed options: all refusals first, then the run directory, the repeats, the files. */
async function replayInvestigations(
  program: SelfCheckProgram,
  options: ReplayOptions,
): Promise<ReplayOutcome> {
  const thresholdsText = await readThresholdsFile(
    options.thresholdsPath,
    'replays',
  );
  if (thresholdsText !== null && !thresholdsText.ok) {
    return refusal('thresholds_invalid', thresholdsText.reason);
  }
  const items = await readItems(program, options);
  if (!Array.isArray(items)) return items;
  // Every refusal that needs no assembly is behind; the leftovers go before the first assembly exists (DC-18).
  await program.cancelLeftovers();
  for (const item of items) {
    const checked = await checkSlice(program, item);
    if (checked !== null) return checked;
  }

  const createdAt = program.clock.now();
  const runId = newRunId(createdAt);
  const runDir = join(program.reportsDir, runId);
  await mkdir(runDir, { recursive: true });
  if (thresholdsText !== null) {
    await writeFile(
      join(runDir, THRESHOLDS_COPY_FILE_NAME),
      thresholdsText.text,
      'utf8',
    );
  }
  program.logger.log('self-check replay started', {
    runId,
    investigations: items.length,
    choice: options.choice,
    runsPerInvestigation: options.runsPerInvestigation,
  });
  const outcomes: ItemOutcome[] = [];
  for (const item of items) {
    outcomes.push(await replayItem({ program, options, runId }, item));
  }
  const firstRecord = outcomes.flatMap(({ records }) => records)[0];
  if (firstRecord === undefined) {
    throw new Error(
      'the replay has no run record to read its configuration from',
    );
  }
  const result = buildRunResult({
    runId,
    kind: 'replays',
    createdAt,
    codeVersion: await readCodeVersion(
      fileURLToPath(new URL('.', import.meta.url)),
    ),
    items: {
      kind: 'investigations',
      investigations: items.map(({ investigationId }) => ({
        investigationId,
      })),
    },
    config: runConfig(firstRecord.config, options.choice),
    judge: judgeIdentity(
      program.settings.judge,
      items.every(({ key }) => key !== null) ? 'withKey' : 'withoutKey',
    ),
    thresholds: await readThresholdsCopy(
      runDir,
      thresholdsText !== null,
      'replays',
    ),
    results: outcomes.map(({ item }) => item),
    judgeAgreement: null,
  });
  await writeRunResult(runDir, result);
  await writeReport(runDir, result);
  program.logger.log('self-check replay written', {
    runId,
    runDir,
    complete: result.complete,
  });
  return { ok: true, runDir, result };
}

/**
 * Every original read by its owner, its slice resolved and its configuration chosen; the first refusal ends the
 * command. The known slices are built once.
 */
async function readItems(
  program: SelfCheckProgram,
  options: ReplayOptions,
): Promise<ReplayItem[] | ReplayRefusal> {
  const { ownerId } = options;
  const db = program.database();
  const known = knownFixtureSlices();
  const items: ReplayItem[] = [];
  for (const investigationId of options.investigationIds) {
    const read = await readOriginal(db, investigationId, ownerId);
    if (read === null) {
      return refusal(
        'investigation_not_found',
        `investigation ${investigationId} of ${ownerId} not found`,
      );
    }
    const resolved = resolveReplaySlice(read.record, known);
    if (!resolved.ok) {
      return refusal(
        'replay_slice_unknown',
        `the slice of ${investigationId} cannot be determined: ${resolved.reason}`,
      );
    }
    const frozen = read.record.config.processConfig;
    if ('agents' in frozen) {
      // DC-29: replay works with the roles form; an agents-form investigation is a defect of the input, not a fallback.
      throw new Error(
        `replay reads the roles form only: investigation ${investigationId} runs on the agents form`,
      );
    }
    const config = replayConfig({
      choice: options.choice,
      frozen,
      roleModel: options.roleModel,
    });
    if (!config.ok) {
      return refusal(
        'process_config_rejected',
        `process configuration rejected at ${config.path.join('.')}: ${config.message}`,
      );
    }
    const { slice } = resolved;
    items.push({
      investigationId,
      ownerId,
      record: read.record,
      slice,
      served:
        slice.kind === 'dataset'
          ? slice.dataset
          : `${slice.setName}/${slice.scenarioId}`,
      processConfig: config.processConfig,
      key: keyOf(slice),
      threadId: formatThreadId({
        kind: 'copy',
        investigationId: copyOrigin({
          investigationId,
          ownerId,
          threadId: read.threadId,
        }),
      }),
    });
  }
  return items;
}

/** The run record and the conversation id of an original of this owner, or null (`investigation_not_found`). */
export async function readOriginal(
  db: Database,
  investigationId: string,
  ownerId: string,
): Promise<{ readonly record: RunRecord; readonly threadId: string } | null> {
  const read = await readRunRecord(db, { investigationId, ownerId });
  if (read.outcome !== 'found') return null;
  const [row] = await db
    .select({ threadId: researchInvestigations.threadId })
    .from(researchInvestigations)
    .where(eq(researchInvestigations.investigationId, investigationId));
  return row === undefined
    ? null
    : { record: read.record, threadId: row.threadId };
}

/** The key of a scenario slice: the original was a run of that scenario, so its repeats are judged by it. */
function keyOf(slice: FixtureSlice): ScenarioKey | null {
  if (slice.kind === 'dataset') return null;
  const loaded = loadScenarioSet(slice.setName);
  const scenario = loaded.ok
    ? loaded.set.scenarios.find(
        ({ scenarioId }) => scenarioId === slice.scenarioId,
      )
    : undefined;
  if (scenario === undefined) {
    throw new Error(
      `the known slice ${slice.snapshot} names ${slice.setName}/${slice.scenarioId}, which no longer loads`,
    );
  }
  return scenarioKey(scenario);
}

/** The assembly on the item's slice, or `process_config_rejected` with the path `createEngine` names (catalog check). */
async function assembleOnSlice(
  program: SelfCheckProgram,
  item: ReplayItem,
): Promise<ScenarioAssembly | ReplayRefusal> {
  try {
    return await program.assembleScenario({
      scenario: item.served,
      processConfig: item.processConfig,
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
 * Before any start (DC-6): the configuration passes the catalog check of `createEngine`, and the fixture started on
 * the item's slice serves exactly the original's slice. The assembly is closed again; nothing was started on it.
 */
async function checkSlice(
  program: SelfCheckProgram,
  item: ReplayItem,
): Promise<ReplayRefusal | null> {
  const assembly = await assembleOnSlice(program, item);
  if (!('engine' in assembly)) return assembly;
  try {
    const served = await assembly.currentFixtureSnapshot();
    return served === item.slice.snapshot
      ? null
      : refusal(
          'replay_slice_mismatch',
          `the fixture started on ${item.served} serves ${served}; ${item.investigationId} saw ${item.slice.snapshot}`,
        );
  } finally {
    await assembly.close();
  }
}

interface ReplayContext {
  readonly program: SelfCheckProgram;
  readonly options: ReplayOptions;
  readonly runId: string;
}

interface ItemOutcome {
  readonly item: ItemResult;
  /** The run records of the repeats, for the result's configuration. */
  readonly records: readonly RunRecord[];
}

/**
 * The repeats of one original on an assembly of their own: all started at once in the copy's conversation, waited for
 * until the queue is empty, then judged — by the key as in `run`, or without a key into failure signals next to the
 * original's own signals. The assembly is closed, so the next original starts on a new fixture.
 */
async function replayItem(
  context: ReplayContext,
  item: ReplayItem,
): Promise<ItemOutcome> {
  const { program, runId } = context;
  const assembly = await assembleOnSlice(program, item);
  if (!('engine' in assembly)) {
    throw new Error(
      `the configuration accepted for ${item.investigationId} was refused later: ${assembly.reason}`,
    );
  }
  try {
    const served = await assembly.currentFixtureSnapshot();
    if (served !== item.slice.snapshot) {
      throw new Error(
        `the fixture on ${item.served} served ${item.slice.snapshot} at the check and ${served} now`,
      );
    }
    const waited = await waitForScenarioRuns(
      scenarioWaiterPorts(assembly, program.clock),
      {
        runs: await startRepeats(context, assembly, item),
        controllerDeadlineMs:
          item.processConfig.limits.taskBudgets['research.controller']
            .deadlineMs,
      },
    );
    const deps: JudgeDeps = {
      engine: assembly.engine,
      judge: program.settings.judge,
    };
    const runs: RunEntry[] = [];
    for (const run of waited) {
      const now = program.clock.now();
      runs.push(
        item.key === null
          ? await unkeyedRun(deps, program, run, now)
          : await judgedRun(deps, item.key, run, now),
      );
      program.logger.log('replay run judged', {
        runId,
        investigationId: item.investigationId,
        repeatId: run.investigationId,
        outcome: run.outcome,
      });
    }
    return {
      item: {
        item: { investigationId: item.investigationId },
        kind: item.key?.kind ?? null,
        ran: true,
        runs,
        sourceSignals:
          item.key === null
            ? await originalSignals(deps, program, item, waited)
            : null,
      },
      records: waited.map((run) => run.record),
    };
  } finally {
    await assembly.close();
  }
}

/** All repeats of the original started at once for `system:self-check` in the copy's conversation. */
async function startRepeats(
  { program, options, runId }: ReplayContext,
  assembly: ScenarioAssembly,
  item: ReplayItem,
): Promise<StartedRun[]> {
  const started: StartedRun[] = [];
  for (let index = 0; index < options.runsPerInvestigation; index += 1) {
    const startedAt = program.clock.now();
    const start = await assembly.engine.startInvestigation({
      resourceId: SELF_CHECK_OWNER,
      threadId: item.threadId,
      query: item.record.query,
      processId: item.processConfig.processId,
      version: item.processConfig.version,
      launchKey: `${runId}/${item.investigationId}/${index}`,
    });
    if (start.outcome === 'rejected') {
      throw new Error(
        `repeat ${index} of ${item.investigationId} was refused: ${start.code}`,
      );
    }
    started.push({ investigationId: start.investigationId, startedAt });
  }
  return started;
}

const TIMEOUT: Verdict = { verdict: 'unclear', reason: 'timeout' };
const NO_ANSWER: Verdict = scenarioVerdict({ answer: null });

/**
 * A repeat of an original without a key: its failure signals, the judge without a key bound to the repeat itself.
 * `timeout` and a run without an answer are «неясно» before the judge (DC-9); a run with an answer has no verdict.
 */
async function unkeyedRun(
  deps: JudgeDeps,
  program: SelfCheckProgram,
  run: WaitedRun,
  now: Date,
): Promise<RunEntry> {
  const { record } = run;
  const verdict =
    run.outcome === 'timeout'
      ? TIMEOUT
      : record.answer === null
        ? NO_ANSWER
        : null;
  return runEntry({
    record,
    verdict,
    judgeForm: null,
    firstError: null,
    signals: await signalsOf(deps, program, record, {
      binding: { investigationId: record.investigationId },
      notAfter: new Date(now.getTime() + JUDGE_WINDOW_MS),
    }),
  });
}

/**
 * The original's own signals, to stand next to its repeats'. An original of `system:self-check` binds its judge
 * transcript to itself; an employee's original gets no transcript of the program, so the transcript is bound to its
 * first repeat — a copy that remembers the original and goes with it (DC-4).
 */
async function originalSignals(
  deps: JudgeDeps,
  program: SelfCheckProgram,
  item: ReplayItem,
  waited: readonly WaitedRun[],
): Promise<FailureSignals> {
  const [firstRepeat] = waited;
  if (firstRepeat === undefined) {
    throw new Error(`no repeat of ${item.investigationId} was waited for`);
  }
  return signalsOf(deps, program, item.record, {
    binding: {
      investigationId:
        item.ownerId === SELF_CHECK_OWNER
          ? item.investigationId
          : firstRepeat.investigationId,
    },
    notAfter: new Date(program.clock.now().getTime() + JUDGE_WINDOW_MS),
  });
}

/** The four failure signals of a record; the judge without a key is called only when it has an answer. */
async function signalsOf(
  deps: JudgeDeps,
  program: SelfCheckProgram,
  record: RunRecord,
  call: { readonly binding: AssessBinding; readonly notAfter: Date },
): Promise<FailureSignals> {
  const judge =
    record.answer === null
      ? null
      : (
          await judgeRunWithoutKey(deps, {
            question: record.query,
            answer: record.answer,
            binding: call.binding,
            notAfter: call.notAfter,
          })
        ).checked;
  return failureSignals({
    run: record,
    judge,
    thresholds: program.settings.signals,
  });
}
