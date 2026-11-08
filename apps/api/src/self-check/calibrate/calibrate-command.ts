import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  deepResearchProcessV2,
  loadProcessConfig,
  type ProcessConfig,
} from '@agent-os/engine';
import {
  buildCalibrationPairs,
  type DatasetVersion,
  loadScenarioSet,
} from '@agent-os/mcp-fixture';
import type { SelfCheckProgram } from '../program.js';
import type { ScenarioAssembly } from '../scenario-assembly.js';
import { newRunId } from '../run/run-command.js';
import { formatThreadId } from '../thread-ids.js';
import {
  calibrate,
  type GroupCount,
  renderCalibrationReport,
  writeGroupTable,
} from './calibration.js';

/**
 * The `calibrate` command of the self-check program (design-engine.md, Contract «Программа самопроверки — команда
 * `calibrate`», Flow 5): the calibration pairs of a scenario set judged by the `verifier` call of a configuration,
 * and the group table written to `--out`. Every refusal — `set_invalid`, `process_config_rejected`,
 * `calibration_prompt_has_fields` — comes before the first call; `calibration_empty` comes after the calls and writes
 * no table. The engine is assembled without the runtime
 * workers, as for `show`: calibration needs only `Engine.assess`, claims no queued task and cancels no investigation.
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
    | 'calibration_prompt_has_fields'
    | 'calibration_empty';
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
  const { verifier } = processConfig.config.roles;
  // `loadProcessConfig` refuses unpaired braces, so any `{{` left is a field. With one, the call's instructions would
  // differ from the role's rendered prompt, and the table would be bound to another prompt version (Flow 5).
  if (verifier.prompt.includes('{{')) {
    return refusal(
      'calibration_prompt_has_fields',
      'the verifier prompt has template fields; calibration needs it without fields, as the call sends it',
    );
  }
  const pairSet = buildCalibrationPairs(loadedSet.set);
  const runId = newRunId(program.clock.now());
  const selfCheckRunId = formatThreadId({ kind: 'run', runId });
  const assembly = await assembleChecked(program, processConfig.data);
  if (!('engine' in assembly)) return assembly;
  program.logger.log('self-check calibration started', {
    selfCheckRunId,
    set: loadedSet.set.name,
    pairsFingerprint: pairSet.fingerprint,
    pairs: pairSet.pairs.length,
    model: verifier.model,
    groupCount: options.groupCount,
  });
  let calibrated: Awaited<ReturnType<typeof calibrate>>;
  try {
    calibrated = await calibrate({
      pairSet,
      scenarioSet: loadedSet.set.name,
      verifier,
      groupCount: options.groupCount,
      assess: (request) => assembly.engine.assess(request),
      selfCheckRunId,
      clock: program.clock,
    });
  } finally {
    await assembly.close();
  }
  if (!calibrated.ok) return refusal(calibrated.code, calibrated.reason);
  const { report } = calibrated;
  await writeGroupTable(options.outPath, report.table);
  program.logger.log('self-check calibration written', {
    selfCheckRunId,
    outPath: options.outPath,
    promptVersion: report.table.promptVersion,
    profiles: report.table.profiles.length,
  });
  return {
    ok: true,
    outPath: options.outPath,
    report: renderCalibrationReport(report, options.outPath),
  };
}

type ReadConfig =
  | {
      readonly ok: true;
      /** The configuration as data, for the assembly. */
      readonly data: unknown;
      readonly config: ProcessConfig;
    }
  | CalibrateRefusal;

/** The shipped configuration, or the JSON file given; unreadable, not JSON or refused by the schema is a refusal. */
async function readProcessConfig(path: string | null): Promise<ReadConfig> {
  let data: unknown = deepResearchProcessV2;
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
  const loaded = loadProcessConfig(data);
  if (!loaded.ok) {
    const { path: at, message } = loaded.rejection;
    return refusal(
      'process_config_rejected',
      `process configuration rejected at ${at.join('.')}: ${message}`,
    );
  }
  return { ok: true, data, config: loaded.config };
}

/** The assembly without workers; `createEngine`'s catalog refusal of a role or `assess` model is the command's. */
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
