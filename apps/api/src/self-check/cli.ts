import type { ResolveModel, TokenCounter } from '@agent-os/engine';
import { type Clock, parseRuntimeConfig } from '@agent-os/runtime';
import { withFields } from '../common/log-fields.js';
import { parseTranscriptRetention } from '../engine/transcript-retention.js';
import { runtimeSettingsVariables } from '../research/runtime-settings.js';
import { sourcesSettingsVariables } from '../sources/sources.config.js';
import { executeCalibrateCommand } from './calibrate/calibrate-command.js';
import { executeCompareCommand } from './compare/compare-command.js';
import {
  createSelfCheckProgram,
  type SelfCheckPorts,
  type SelfCheckProgram,
} from './program.js';
import { executeReplayCommand } from './replay/replay-command.js';
import { executeShowCommand } from './show/show-command.js';
import { executeRunCommand } from './run/run-command.js';
import type { SelfCheckLogger } from './scenario-assembly.js';
import { loadSelfCheckSettings } from './settings.js';

/** What an entry hands to `runCli`: the real `main.ts` and the E2E child differ only in the model boundary. */
export interface CliInput {
  /** The arguments after the script: the command name, then its flags. */
  readonly argv: readonly string[];
  /** The process environment: database URLs, Runtime Settings and Sources Settings are read from it here. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where run directories are written. */
  readonly reportsDir: string;
  readonly clock: Clock;
  readonly resolveModel: ResolveModel;
  readonly tokenCounter: TokenCounter;
}

/** How a command ended: success, or a refusal code of its contract (design-self-check.md, Contract Definitions). */
export type CommandOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/** A command that runs on the program assembled over the self-check database (guard and migrations done). */
type ProgramCommand = (
  args: readonly string[],
  program: SelfCheckProgram,
) => Promise<CommandOutcome>;

/**
 * A command that reads and writes files only: no database, no model. It needs neither `SELF_CHECK_DATABASE_URL` nor
 * the guard and the migrations, so it runs without the program.
 */
type FileCommand = (
  args: readonly string[],
  input: CliInput,
) => Promise<CommandOutcome>;

/** The commands that run on the program, by name. */
const COMMANDS: Readonly<Record<string, ProgramCommand>> = {
  /** Prints the run directory on success: the place of the result file and the report. */
  run: async (args, program) => {
    const outcome = await executeRunCommand(args, program);
    if (outcome.ok) console.log(outcome.runDir);
    return outcome;
  },
  /** Prints the run directory of the repeats on success. */
  replay: async (args, program) => {
    const outcome = await executeReplayCommand(args, program);
    if (outcome.ok) console.log(outcome.runDir);
    return outcome;
  },
  /** Prints the course report on success; it is not saved anywhere. */
  show: async (args, program) => {
    const outcome = await executeShowCommand(args, program);
    if (outcome.ok) console.log(outcome.report);
    return outcome;
  },
  /** Prints the calibration report on success; the group table is the file given with `--out`. */
  calibrate: async (args, program) => {
    const outcome = await executeCalibrateCommand(args, program);
    if (outcome.ok) console.log(outcome.report);
    return outcome;
  },
};

/** The commands that run on files only, by name. */
const FILE_COMMANDS: Readonly<Record<string, FileCommand>> = {
  /** Prints the comparison directory on success: the place of the comparison file and its report. */
  compare: async (args, input) => {
    const outcome = await executeCompareCommand(args, {
      reportsDir: input.reportsDir,
      resampling: loadSelfCheckSettings().resampling,
    });
    if (outcome.ok) console.log(outcome.dir);
    return outcome;
  },
};

/** Exit codes of the program: a refusal is told apart from a failure. */
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_REFUSED = 2;

/** Lines of the program's runtime, sources and engine go to stderr; their fields carry identifiers only. */
const consoleLogger: SelfCheckLogger = {
  debug: (message, fields) =>
    console.error(withFields(`[self-check] debug ${message}`, fields)),
  log: (message, fields) =>
    console.error(withFields(`[self-check] ${message}`, fields)),
  warn: (message, fields) =>
    console.error(withFields(`[self-check] warn ${message}`, fields)),
  error: (message, fields) =>
    console.error(withFields(`[self-check] error ${message}`, fields)),
};

function refuse(code: string, reason: string): number {
  console.error(`refused: ${code} — ${reason}`);
  return EXIT_REFUSED;
}

function portsFrom(input: CliInput): SelfCheckPorts {
  const read = (name: string): string | undefined => input.env[name];
  return {
    selfCheckDatabaseUrl: read('SELF_CHECK_DATABASE_URL'),
    mainDatabaseUrl: read('DATABASE_URL'),
    transcriptRetention: parseTranscriptRetention(read),
    reportsDir: input.reportsDir,
    clock: input.clock,
    resolveModel: input.resolveModel,
    tokenCounter: input.tokenCounter,
    logger: consoleLogger,
    runtime: parseRuntimeConfig(runtimeSettingsVariables(read)),
    sourcesVariables: sourcesSettingsVariables(read),
  };
}

async function runCommand(
  command: ProgramCommand,
  args: readonly string[],
  input: CliInput,
): Promise<number> {
  const created = await createSelfCheckProgram(portsFrom(input));
  if (!created.ok) return refuse(created.code, created.reason);
  const { program } = created;
  try {
    const outcome = await command(args, program);
    return outcome.ok ? EXIT_OK : refuse(outcome.code, outcome.reason);
  } finally {
    await program.close();
  }
}

/** How the named command runs, giving the exit code; undefined for a name that is not a command. */
function commandRun(
  name: string,
  args: readonly string[],
  input: CliInput,
): (() => Promise<number>) | undefined {
  if (Object.hasOwn(FILE_COMMANDS, name)) {
    const command = FILE_COMMANDS[name];
    return async () => {
      const outcome = await command(args, input);
      return outcome.ok ? EXIT_OK : refuse(outcome.code, outcome.reason);
    };
  }
  if (Object.hasOwn(COMMANDS, name)) {
    const command = COMMANDS[name];
    return () => runCommand(command, args, input);
  }
  return undefined;
}

/**
 * The command line of the self-check program (design-self-check.md, KD-3): parses the command and runs it, returning
 * the exit code — 0 on success, otherwise non-zero with the refusal code on the console. An unknown or missing command
 * is refused before the environment is read and before any connection; a command that needs the program gets it only
 * after the database guard and the migrations (`createSelfCheckProgram`), and a command on files only (`compare`)
 * opens no connection at all. A thrown error is printed and gives 1.
 */
export async function runCli(input: CliInput): Promise<number> {
  const [name, ...args] = input.argv;
  const run = name === undefined ? undefined : commandRun(name, args, input);
  if (run === undefined) {
    const known = [...Object.keys(COMMANDS), ...Object.keys(FILE_COMMANDS)];
    const given =
      name === undefined ? 'no command given' : `unknown command "${name}"`;
    return refuse('unknown_command', `${given}; commands: ${known.join(', ')}`);
  }
  try {
    return await run();
  } catch (error) {
    // The whole error: a connection failure is an AggregateError with an empty message.
    console.error(error);
    return EXIT_FAILED;
  }
}
