import type { RuntimeConfig } from './runtime-config.js';

/**
 * Test crash points of `RUNTIME_CRASH_AT` (design-runtime.md, Runtime settings). The kill
 * matrix stops the process at one of them to prove recovery.
 */
export const CRASH_POINTS = [
  /** After the claim transaction of a step. */
  'step.after-claim',
  /** After a `guard` transaction of the handler. */
  'step.after-guard',
  /** Before the commit transaction of a step. */
  'step.before-commit',
  /** Inside the commit transaction, after the handler's writes, before delivery marks. */
  'step.inside-commit',
  /** After the commit, before the outbox delivers its events. */
  'step.after-commit',
  /** Inside the message transaction, after the insert, before the wake-up. */
  'inbox.before-wake',
  /** After the sweeper's requeue transaction. */
  'sweeper.after-requeue',
] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

/** Exit code of a crash: the code of a process killed by SIGKILL. */
const CRASH_EXIT_CODE = 137;

const CRASH_AT_FORMAT = /^([a-z.-]+)(?::(\d+))?$/;

interface CrashTarget {
  point: CrashPoint;
  /** 1-based pass of the point on which the process exits. */
  pass: number;
}

export interface CrashPointsOptions {
  /** Raw `RUNTIME_CRASH_AT`: `<point>[:n]`, unset by default. */
  crashAt: string | undefined;
  nodeEnv: string | undefined;
  /** Ends the process; injected so that a spec does not end its own. */
  exit: (code: number) => void;
}

const isCrashPoint = (value: string): value is CrashPoint =>
  (CRASH_POINTS as readonly string[]).includes(value);

/** The only parser of `RUNTIME_CRASH_AT`; an invalid value throws, naming it. */
function parseCrashAt(raw: string): CrashTarget {
  const invalid = (reason: string) =>
    new Error(`Invalid RUNTIME_CRASH_AT "${raw}": ${reason}`);
  const match = CRASH_AT_FORMAT.exec(raw);
  if (!match) throw invalid('expected <point>[:n]');
  const [, point, pass] = match;
  if (!isCrashPoint(point)) {
    throw invalid(`unknown point, expected one of ${CRASH_POINTS.join(', ')}`);
  }
  const passNumber = pass === undefined ? 1 : Number(pass);
  if (passNumber < 1) throw invalid('the pass number starts at 1');
  return { point, pass: passNumber };
}

/**
 * Exits the process with code 137 on the configured pass of the configured crash point.
 * Never fires under `NODE_ENV=production`: there the variable is not even parsed.
 */
export class CrashPoints {
  private readonly target: CrashTarget | undefined;
  private passes = 0;

  constructor(private readonly options: CrashPointsOptions) {
    const { crashAt, nodeEnv } = options;
    this.target =
      nodeEnv !== 'production' && crashAt !== undefined
        ? parseCrashAt(crashAt)
        : undefined;
  }

  /** Crash points of the running process (`RUNTIME_CRASH_AT` and `NODE_ENV` of the settings). */
  static fromConfig(config: RuntimeConfig): CrashPoints {
    return new CrashPoints({
      crashAt: config.crashAt,
      nodeEnv: config.nodeEnv,
      exit: (code) => process.exit(code),
    });
  }

  /** Marks one pass of `point`; exits when it is the configured pass of the configured point. */
  hit(point: CrashPoint): void {
    if (this.target?.point !== point) return;
    this.passes += 1;
    if (this.passes === this.target.pass) this.options.exit(CRASH_EXIT_CODE);
  }
}
