import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestChild, within } from '@agent-os/runtime/testing';
import { type ChildTypes, CHILD_TYPES_ENV } from './runtimeChildHandlers';

/**
 * Child-process harness of E2E-1 and of the on-demand measurements. A child is plain Node running
 * `runtimeChildMain.ts` and the packages from source through the `tsx` loader. The
 * harness never talks to the runtime inside a child: it starts it, waits for it to die at its crash
 * point or stops it, and reads the rows it left. A restart is a fresh child without
 * `RUNTIME_CRASH_AT`.
 */

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHILD_ENTRY = join(PACKAGE_ROOT, 'test/support/runtimeChildMain.ts');

/** Exit code of a crash point (the code of a process killed by SIGKILL). */
const CRASH_EXIT_CODE = 137;

/** Runtime settings at their design defaults (design-runtime.md, Runtime settings). */
export const DEFAULT_SETTINGS: Readonly<Record<string, string>> = {
  RUNTIME_CONCURRENCY: '16',
  RUNTIME_POLL_MS: '500',
  RUNTIME_NOTIFY: 'on',
  RUNTIME_REAPER_MS: '5000',
  RUNTIME_MAX_RECOVERIES: '3',
  DB_POOL_MAX: '10',
};

/** How long a dying child may take to reach its crash point. */
const CRASH_MS = 60_000;

export interface ChildOptions {
  /** Task types the child registers; it claims only these. */
  types: ChildTypes;
  /** `RUNTIME_CRASH_AT` (`<point>[:n]`); unset for a child that must not crash. */
  crashAt?: string;
  /** Runtime settings; those of the kill matrix (`TestChild`) by default. */
  settings?: Readonly<Record<string, string>>;
}

/** One child process running a runtime with workers on. */
export class RuntimeChild extends TestChild {
  constructor(options: ChildOptions) {
    super({
      name: 'Runtime child',
      entry: CHILD_ENTRY,
      cwd: PACKAGE_ROOT,
      execArgv: ['--import', import.meta.resolve('tsx')],
      env: {
        ...options.settings,
        RUNTIME_CRASH_AT: options.crashAt ?? '',
        [CHILD_TYPES_ENV]: JSON.stringify(options.types),
      },
    });
  }

  /** Waits for the exit of a crash point and fails on any other exit code. */
  async crashed(): Promise<void> {
    const code = await within(this.exited, CRASH_MS, () =>
      this.failure(`did not reach its crash point within ${CRASH_MS} ms`),
    );
    if (code !== CRASH_EXIT_CODE) {
      throw this.failure(`exited with ${String(code)} instead of the crash code ${CRASH_EXIT_CODE}`);
    }
  }
}

/** Children of one test; {@link killAll} ends whatever is left of them. */
export class Children {
  private readonly started: RuntimeChild[] = [];

  /** Starts a child; a child without `crashAt` is awaited until its workers run. */
  async start(options: ChildOptions): Promise<RuntimeChild> {
    const child = new RuntimeChild(options);
    this.started.push(child);
    if (options.crashAt === undefined) await child.ready();
    return child;
  }

  /** Kills every child still alive: cleanup after a passed or failed test. */
  async killAll(): Promise<void> {
    await Promise.all(this.started.map((child) => child.kill()));
  }
}
