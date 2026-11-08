import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Process harness of the self-check E2E-1 (design-self-check.md, Test Strategy): every command of the program runs as
 * its own child process from the compiled test entry `selfCheckChildMain.ts` (`pnpm --filter api build:child` →
 * `dist/test-child/`), over the packages' built `dist`; a build older than its sources is refused before anything is
 * spawned. The harness gives each command its arguments, the database URL (`DATABASE_URL`), the Runtime and
 * Sources Settings and its own reports directory, and reads back only what the developer sees: the exit code, the
 * printed directory, and the files on disk.
 */

const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = join(API_ROOT, '../..');
const CHILD_ENTRY = join(
  API_ROOT,
  'dist/test-child/test/support/selfCheckChildMain.js',
);
/** The shipped entry `pnpm self-check` runs (`nest build`), with the real model boundary. */
const SHIPPED_ENTRY = join(API_ROOT, 'dist/self-check/main.js');

/**
 * The role model with which the scripted roles of the child solve the cause scenarios: `run` with this
 * `--role-model` is the candidate; the shipped configuration grounds its cause on records before the change.
 */
export const SOLVING_ROLE_MODEL = 'worker=anthropic/claude-sonnet-5-5';

/** The variable that names the reports directory of a child command. */
export const REPORTS_DIR_VARIABLE = 'SELF_CHECK_REPORTS_DIR';

/** The variable that names the pair kinds the scripted verifier of `calibrate` errs on (comma-separated). */
export const CALIBRATION_ERRS_ON_VARIABLE = 'SELF_CHECK_CALIBRATION_ERRS_ON';

/** A build the child executes and the sources it is built from. */
interface ChildBuild {
  /** A file every build rewrites. */
  readonly output: string;
  readonly sources: readonly string[];
  readonly command: string;
}

const packageBuild = (dir: string, name: string): ChildBuild => ({
  output: join(REPO_ROOT, 'packages', dir, 'dist/index.js'),
  sources: [join(REPO_ROOT, 'packages', dir, 'src')],
  command: `pnpm --filter @agent-os/${name} build`,
});

/** The packages the program imports by name (the fixture server among them), and the child entry. */
const CHILD_BUILDS: readonly ChildBuild[] = [
  packageBuild('contracts', 'contracts'),
  packageBuild('db', 'db'),
  packageBuild('runtime', 'runtime'),
  packageBuild('engine', 'engine'),
  packageBuild('sources', 'sources'),
  packageBuild('mcp-fixture', 'mcp-fixture'),
  {
    output: SHIPPED_ENTRY,
    sources: [join(API_ROOT, 'src')],
    command: 'pnpm --filter api build',
  },
  {
    output: CHILD_ENTRY,
    sources: [join(API_ROOT, 'src'), join(API_ROOT, 'test/support')],
    command: 'pnpm --filter api build:child',
  },
];

/**
 * Settings of every command: workers on with fast polling (the e2e config turns them off by default), and a short
 * source retry, as the integration file's ports set them.
 */
const COMMAND_SETTINGS: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
  RUNTIME_WORKERS: 'on',
  RUNTIME_CONCURRENCY: '2',
  RUNTIME_POLL_MS: '50',
  DB_POOL_MAX: '4',
  SOURCE_CALL_TIMEOUT_MS: '30000',
  SOURCE_RETRY_BASE_MS: '10',
  SOURCE_RETRY_CAP_MS: '50',
};

/** How long one command may take: a harness guard, not a latency. */
const COMMAND_MS = 240_000;
const OUTPUT_TAIL_LINES = 80;

function newestMtime(dir: string): { file: string; mtimeMs: number } {
  let newest = { file: dir, mtimeMs: 0 };
  for (const entry of readdirSync(dir, { recursive: true })) {
    const file = join(dir, String(entry));
    const { mtimeMs } = statSync(file);
    if (mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
  }
  return newest;
}

/** Throws, naming the build command, when a build the commands execute is missing or older than its sources. */
export function assertSelfCheckChildBuildFresh(): void {
  for (const build of CHILD_BUILDS) {
    let builtMs: number;
    try {
      builtMs = statSync(build.output).mtimeMs;
    } catch {
      throw new Error(
        `Child build ${build.output} is missing; run \`${build.command}\``,
      );
    }
    for (const sources of build.sources) {
      const newest = newestMtime(sources);
      if (newest.mtimeMs > builtMs) {
        throw new Error(
          `Child build ${build.output} is older than ${newest.file}; run \`${build.command}\``,
        );
      }
    }
  }
}

/** One command of the program as the developer starts it. */
export interface SelfCheckCommandInput {
  /** The command name and its flags, e.g. `run --set smoke`. */
  readonly argv: readonly string[];
  /** Where the command writes its run or comparison directory. */
  readonly reportsDir: string;
  /** `DATABASE_URL`, `FIXTURE_CALL_LOG` and any other variable of the command. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * `child` (default): the test entry with the scripted models. `shipped`: `dist/self-check/main.js` itself, which
   * calls the real model, so only for a command refused before any model call.
   */
  readonly entry?: 'child' | 'shipped';
}

/** How a command ended. */
export interface SelfCheckCommandResult {
  /** Null when the process was ended by a signal. */
  readonly exitCode: number | null;
  /** The last line the command printed to stdout: the directory it wrote, on success. */
  readonly printed: string;
  /** Everything the command printed to stdout (the calibration report of `calibrate`). */
  readonly stdout: string;
  readonly stderr: string;
}

/** One command process of the compiled child entry. */
export class SelfCheckCommand {
  private readonly process: ChildProcess;
  private readonly stdout: string[] = [];
  private readonly stderr: string[] = [];
  /** The command's result once the process has ended; rejects after the harness guard. */
  readonly exited: Promise<SelfCheckCommandResult>;

  constructor(input: SelfCheckCommandInput) {
    this.process = spawn(
      process.execPath,
      [
        '--enable-source-maps',
        input.entry === 'shipped' ? SHIPPED_ENTRY : CHILD_ENTRY,
        ...input.argv,
      ],
      {
        cwd: API_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...COMMAND_SETTINGS,
          ...input.env,
          [REPORTS_DIR_VARIABLE]: input.reportsDir,
        },
      },
    );
    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.stdout.push(chunk.toString());
    });
    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.stderr.push(chunk.toString());
    });
    const ended = new Promise<SelfCheckCommandResult>((resolve, reject) => {
      this.process.on('error', reject);
      this.process.on('close', (code) => {
        const stdout = this.stdout.join('');
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        resolve({
          exitCode: code,
          printed: lines.at(-1) ?? '',
          stdout,
          stderr: this.stderr.join(''),
        });
      });
    });
    this.exited = guarded(ended, COMMAND_MS, () => {
      this.process.kill('SIGKILL');
      return this.failure(`did not end within ${COMMAND_MS} ms`);
    });
    // A test that stops waiting (a failed assertion) leaves the rejection unread.
    this.exited.catch(() => undefined);
  }

  get running(): boolean {
    return this.process.exitCode === null && this.process.signalCode === null;
  }

  /** Ends the process without waiting for it (cleanup after a failed test). */
  kill(): void {
    if (this.running) this.process.kill('SIGKILL');
  }

  failure(what: string): Error {
    const tail = this.stderr
      .join('')
      .split('\n')
      .slice(-OUTPUT_TAIL_LINES)
      .join('\n');
    return new Error(`Self-check command ${what}; its last output:\n${tail}`);
  }
}

/** `promise`, or the error of `failure` after `ms`: a guard, not a delay. */
async function guarded<T>(
  promise: Promise<T>,
  ms: number,
  failure: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(failure()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
