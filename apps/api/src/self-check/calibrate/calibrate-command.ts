import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { claimAssessmentAgent, deepResearchProcessV3 } from '@agent-os/engine';
import {
  buildCalibrationPairs,
  type DatasetVersion,
  loadScenarioSet,
} from '@agent-os/mcp-fixture';
import type { SelfCheckProgram } from '../program.js';
import {
  currentDeploymentEntries,
  type ScenarioAssembly,
} from '../scenario-assembly.js';
import { newRunId } from '../run/run-command.js';
import { formatThreadId } from '../thread-ids.js';
import {
  calibrateAgent,
  type CalibrationResult,
  type GroupCount,
  renderCalibrationReport,
  writeGroupTable,
} from './calibration.js';

/**
 * The `calibrate` command of the self-check program (design-engine.md, Contract «Программа самопроверки — команда
 * `calibrate`»; design-research-flow.md, Flow 4): the calibration pairs of a scenario set judged by the definition of
 * the form `claim_assessment` of a configuration — the shipped one, or the file given with `--config` — through
 * `Engine.assessAgent`, and the group table written to `--out`. Every refusal — `set_invalid`,
 * `process_config_rejected` — comes before the first call: `createEngine` checks the configuration, so a bad one is
 * refused by the assembly, and one with no such definition after it; `calibration_empty` comes after the calls and
 * writes no table. The engine is assembled without the runtime workers, as for `show`: calibration claims no queued
 * task and cancels no investigation.
 */

export interface CalibrateOptions {
  readonly setName: string;
  /** The configuration file as given; null calibrates the shipped configuration. */
  readonly configPath: string | null;
  readonly groupCount: GroupCount;
  /** Where the table is written, resolved against the working directory. */
  readonly outPath: string;
}

export interface CalibrateRefusal {
  readonly ok: false;
  readonly code:
    | 'invalid_arguments'
    | 'set_invalid'
    | 'process_config_rejected'
    | 'calibration_empty'
    | 'agent_not_detachable'
    | 'model_unavailable';
  readonly reason: string;
}

export type CalibrateOutcome =
  | {
      readonly ok: true;
      readonly outPath: string;
      /** The calibration report to print. */
      readonly report: string;
    }
  | CalibrateRefusal;

const DEFAULT_GROUP_COUNT: GroupCount = 3;
const GROUP_COUNTS: Readonly<Record<string, GroupCount>> = { '3': 3, '4': 4 };

/**
 * What the assembly serves. Calibration calls no source, and the adapter starts the fixture process only on the first
 * call, so any known slice does (as for `show`).
 */
const ASSEMBLY_SERVED: DatasetVersion = 'v1';

const refusal = (
  code: CalibrateRefusal['code'],
  reason: string,
): CalibrateRefusal => ({ ok: false, code, reason });

/** `calibrate --set <name> --out <file> [--config <file>] [--groups 3|4]`. */
export async function executeCalibrateCommand(
  args: readonly string[],
  program: SelfCheckProgram,
): Promise<CalibrateOutcome> {
  const parsed = parseCalibrateArgs(args);
  return parsed.ok ? calibrateSet(program, parsed.options) : parsed;
}

function parseCalibrateArgs(
  args: readonly string[],
):
  { readonly ok: true; readonly options: CalibrateOptions } | CalibrateRefusal {
  let values: { readonly [name: string]: string | undefined };
  try {
    ({ values } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: {
        set: { type: 'string' },
        config: { type: 'string' },
        groups: { type: 'string' },
        out: { type: 'string' },
      },
    }));
  } catch (error) {
    return refusal(
      'invalid_arguments',
      error instanceof Error ? error.message : String(error),
    );
  }
  const { set, config, groups, out } = values;
  if (set === undefined || set === '') {
    return refusal('set_invalid', 'no scenario set given (--set <name>)');
  }
  const groupCount =
    groups === undefined
      ? DEFAULT_GROUP_COUNT
      : Object.hasOwn(GROUP_COUNTS, groups)
        ? GROUP_COUNTS[groups]
        : undefined;
  if (groupCount === undefined) {
    return refusal(
      'invalid_arguments',
      `--groups must be 3 or 4, got "${groups}"`,
    );
  }
  if (out === undefined || out === '') {
    return refusal('invalid_arguments', 'no table file given (--out <file>)');
  }
  return {
    ok: true,
    options: {
      setName: set,
      configPath: config === undefined ? null : resolve(config),
      groupCount,
      outPath: resolve(out),
    },
  };
}

async function calibrateSet(
  program: SelfCheckProgram,
  options: CalibrateOptions,
): Promise<CalibrateOutcome> {
  const loadedSet = loadScenarioSet(options.setName);
  if (!loadedSet.ok) return refusal('set_invalid', loadedSet.detail);
  const processConfig = await readProcessConfig(options.configPath);
  if (!processConfig.ok) return processConfig;
  const pairSet = buildCalibrationPairs(loadedSet.set);
  const run: SetRun = { program, options, set: loadedSet.set.name, pairSet };
  return calibrateChecker(run, processConfig.data);
}

/** The command's program and options, and the pairs of the set. */
interface SetRun {
  readonly program: SelfCheckProgram;
  readonly options: CalibrateOptions;
  readonly set: string;
  readonly pairSet: ReturnType<typeof buildCalibrationPairs>;
}

const newSelfCheckRunId = (program: SelfCheckProgram): string =>
  formatThreadId({ kind: 'run', runId: newRunId(program.clock.now()) });

async function calibrateChecker(
  run: SetRun,
  data: unknown,
): Promise<CalibrateOutcome> {
  const { program, options, pairSet } = run;
  const selfCheckRunId = newSelfCheckRunId(program);
  const assembly = await assembleChecked(program, data);
  if (!('engine' in assembly)) return assembly;
  let calibrated: CalibrationResult;
  try {
    const agent = claimAssessmentAgent(data);
    if (agent === null) {
      return refusal(
        'invalid_arguments',
        'the configuration has no definition with the result form claim_assessment',
      );
    }
    const deploymentEntries = await currentDeploymentEntries(
      assembly.engine,
      agent,
    );
    logStarted(run, selfCheckRunId, agent.model);
    calibrated = await calibrateAgent({
      pairSet,
      scenarioSet: run.set,
      config: data,
      agent,
      deploymentEntries,
      groupCount: options.groupCount,
      assessAgent: (request) => assembly.engine.assessAgent(request),
      selfCheckRunId,
      clock: program.clock,
    });
  } finally {
    await assembly.close();
  }
  return writtenTable(run, selfCheckRunId, calibrated);
}

function logStarted(run: SetRun, selfCheckRunId: string, model: string): void {
  run.program.logger.log('self-check calibration started', {
    selfCheckRunId,
    set: run.set,
    pairsFingerprint: run.pairSet.fingerprint,
    pairs: run.pairSet.pairs.length,
    model,
    groupCount: run.options.groupCount,
  });
}

async function writtenTable(
  run: SetRun,
  selfCheckRunId: string,
  calibrated: CalibrationResult,
): Promise<CalibrateOutcome> {
  if (!calibrated.ok) return refusal(calibrated.code, calibrated.reason);
  const { report } = calibrated;
  const { outPath } = run.options;
  await writeGroupTable(outPath, report.table);
  run.program.logger.log('self-check calibration written', {
    selfCheckRunId,
    outPath,
    agentFingerprint: report.table.agentFingerprint,
    definitionMemoryFingerprint: report.table.definitionMemoryFingerprint,
    profiles: report.table.profiles.length,
  });
  return {
    ok: true,
    outPath,
    report: renderCalibrationReport(report, outPath),
  };
}

type ReadConfig =
  | {
      readonly ok: true;
      /** The configuration as data; `createEngine` checks it. */
      readonly data: unknown;
    }
  | CalibrateRefusal;

/** The shipped configuration, or the JSON file given; an unreadable file or one that is not JSON is a refusal. */
async function readProcessConfig(path: string | null): Promise<ReadConfig> {
  let data: unknown = deepResearchProcessV3;
  if (path !== null) {
    try {
      data = JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (error) {
      return refusal(
        'process_config_rejected',
        `process configuration ${path} cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { ok: true, data };
}

/** The assembly without workers; `createEngine`'s refusal of the configuration or an `assess` model is the command's. */
async function assembleChecked(
  program: SelfCheckProgram,
  processConfig: unknown,
): Promise<ScenarioAssembly | CalibrateRefusal> {
  try {
    return await program.assembleScenario({
      scenario: ASSEMBLY_SERVED,
      processConfig,
      workers: false,
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
