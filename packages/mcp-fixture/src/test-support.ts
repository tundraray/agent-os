import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { argsHash } from './canonical-json';

/**
 * Help for the tests that run the fixture process (`startFixtureProcess`): the fixture files of one test
 * (call log, fault rules, file latches) in a temporary directory, and the readers of the call log — the
 * evidence of what reached an MCP server (the call is in the log before a `wait_for_file` rule holds it).
 */

/** One `tools/call` the fixture received, as its call log stores it. */
export interface FixtureLogEntry {
  readonly seq: number;
  /** The source that received the call (`logs`, `backoffice`, `tracker`). */
  readonly source: string;
  /** `shared` for the shared token, the account name for an OAuth token of the fixture. */
  readonly account: string;
  /** Sequence number of the fixture's OAuth access token (not its value); null for `shared`. */
  readonly tokenId: number | null;
  /** The tool's name on its server (`get_trace`, not `mcp__logs__get_trace`). */
  readonly tool: string;
  readonly argsHash: string;
  /** 1-based occurrence of this (tool, argsHash) call. */
  readonly occurrence: number;
  /** Fault mode applied to the call; null when no rule matched. */
  readonly mode: string | null;
  readonly pid: number;
}

/** Every call of the log, in order; none when no call reached a server yet. */
export function readFixtureLog(callLogPath: string): FixtureLogEntry[] {
  if (!existsSync(callLogPath)) return [];
  return readFileSync(callLogPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FixtureLogEntry);
}

/** What reached the servers for one tool, with these arguments when given. */
export function fixtureCallsOf(
  callLogPath: string,
  filter: {
    readonly tool: string;
    readonly args?: Readonly<Record<string, unknown>>;
  },
): FixtureLogEntry[] {
  const hash = filter.args === undefined ? undefined : argsHash(filter.args);
  return readFixtureLog(callLogPath).filter(
    (entry) =>
      entry.tool === filter.tool &&
      (hash === undefined || entry.argsHash === hash),
  );
}

/** A file the fixture's `wait_for_file` mode waits for: the held call answers once it is released. */
export interface FileLatch {
  readonly path: string;
  release(): void;
}

export function fileLatch(dir: string, name: string): FileLatch {
  const path = join(dir, `latch-${name}`);
  return {
    path,
    release: () => writeFileSync(path, 'released', 'utf8'),
  };
}

/** One rule of `FIXTURE_FAULTS` (`fault-schedule.ts`); the fixture checks the shape. */
export interface FixtureFaultRule {
  readonly tool: string;
  readonly argsHash: string;
  readonly occurrences: 'all' | readonly number[];
  readonly mode: string;
  readonly [parameter: string]: unknown;
}

/**
 * Holds the call of `tool` with `args` on the fixture until `latch` is released: the call is in the log
 * at once, its answer waits (the fixture gives up after 60 s).
 */
export function holdCall(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  latch: FileLatch,
  occurrences: readonly number[] = [1],
): FixtureFaultRule {
  return {
    tool,
    argsHash: argsHash(args),
    occurrences,
    mode: 'wait_for_file',
    path: latch.path,
  };
}

/**
 * The fixture files of one test, in a temporary directory: the call log every fixture process of the test
 * writes (also those of a second instance), the fault rules, and file latches.
 */
export interface FixtureFiles {
  readonly dir: string;
  /** `FIXTURE_CALL_LOG`. */
  readonly callLog: string;
  /** `FIXTURE_FAULTS`: read by the fixture process on every call. */
  readonly faults: string;
  /** Replaces the fault rules from the fixture process's next call. */
  setFaults(rules: readonly FixtureFaultRule[]): void;
  /** A file latch in the test's directory. */
  latch(name: string): FileLatch;
}

/** Fresh fixture files with no fault rules; `label` prefixes the temporary directory's name. */
export function createFixtureFiles(label = 'mcp-fixture'): FixtureFiles {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  const faults = join(dir, 'faults.json');
  const setFaults = (rules: readonly FixtureFaultRule[]) =>
    writeFileSync(faults, JSON.stringify(rules), 'utf8');
  setFaults([]);
  return {
    dir,
    callLog: join(dir, 'calls.jsonl'),
    faults,
    setFaults,
    latch: (name) => fileLatch(dir, name),
  };
}
