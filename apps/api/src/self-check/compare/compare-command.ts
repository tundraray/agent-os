import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { writeComparisonReport } from '../result/report.js';
import { RESULT_FILE_NAME } from '../result/run-result.js';
import {
  type Comparison,
  type CompareOutcome,
  compareRunFiles,
  type Resampling,
} from './compare.js';

/**
 * The `compare` command (design-self-check.md, Contract `compare`): `compare <baseline run dir> <candidate run dir>`.
 * It reads the two result files and nothing else — no database, no model — and writes the comparison file and its
 * report into a directory of its own under the reports directory. A run directory without a result file is a run that
 * failed midway (invariant 7, plan Notes 2): `run_incomplete`.
 */

/** The comparison file's name in the comparison directory; the report sits next to it. */
const COMPARISON_FILE_NAME = 'comparison.json';

interface CompareContext {
  /** Where the comparison directory is written. */
  readonly reportsDir: string;
  readonly resampling: Resampling;
}

type CompareCommandOutcome =
  | {
      readonly ok: true;
      readonly dir: string;
      readonly comparison: Comparison;
    }
  | Extract<CompareOutcome, { ok: false }>
  | {
      readonly ok: false;
      readonly code: 'invalid_arguments';
      readonly reason: string;
    };

export async function executeCompareCommand(
  args: readonly string[],
  context: CompareContext,
): Promise<CompareCommandOutcome> {
  const dirs = parseCompareArgs(args);
  if (!dirs.ok) return dirs;
  const missing = await missingDirectory([dirs.baseline, dirs.candidate]);
  if (missing !== null) {
    return {
      ok: false,
      code: 'invalid_arguments',
      reason: `no such run directory: ${missing}`,
    };
  }
  const outcome = compareRunFiles(
    {
      baseline: await readResultFile(dirs.baseline),
      candidate: await readResultFile(dirs.candidate),
    },
    context.resampling,
  );
  if (!outcome.ok) return outcome;
  const { comparison } = outcome;
  // Named by the two runs, with no time in it: the same comparison repeated writes the same files in the same place.
  const reportsDir = resolve(context.reportsDir);
  const dir = resolve(
    reportsDir,
    `compare-${comparison.baseline.runId}-vs-${comparison.candidate.runId}`,
  );
  // The run ids come from the result files: whatever they hold, nothing is written outside the reports directory.
  if (!isInside(reportsDir, dir)) {
    return {
      ok: false,
      code: 'invalid_arguments',
      reason: `the run ids of the result files do not name a directory inside ${reportsDir}`,
    };
  }
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, COMPARISON_FILE_NAME),
    `${JSON.stringify(comparison, null, 2)}\n`,
    'utf8',
  );
  await writeComparisonReport(dir, comparison);
  return { ok: true, dir, comparison };
}

function parseCompareArgs(args: readonly string[]):
  | { readonly ok: true; readonly baseline: string; readonly candidate: string }
  | {
      readonly ok: false;
      readonly code: 'invalid_arguments';
      readonly reason: string;
    } {
  const usage = 'usage: compare <baseline run dir> <candidate run dir>';
  let positionals: string[];
  try {
    ({ positionals } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: {},
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: 'invalid_arguments',
      reason: `${message}; ${usage}`,
    };
  }
  const [baseline, candidate] = positionals;
  if (
    positionals.length !== 2 ||
    baseline === undefined ||
    candidate === undefined
  ) {
    return { ok: false, code: 'invalid_arguments', reason: usage };
  }
  return {
    ok: true,
    baseline: resolve(baseline),
    candidate: resolve(candidate),
  };
}

async function missingDirectory(
  dirs: readonly string[],
): Promise<string | null> {
  for (const dir of dirs) {
    const found = await stat(dir).catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (found === null || !found.isDirectory()) return dir;
  }
  return null;
}

/** The result file's data, or null when the directory has none. */
async function readResultFile(dir: string): Promise<unknown> {
  const path = join(dir, RESULT_FILE_NAME);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${path} is not JSON`, { cause: error });
  }
}

/** Whether `path` is strictly below `parent`, both resolved. */
function isInside(parent: string, path: string): boolean {
  const between = relative(parent, path);
  return between !== '' && !between.startsWith('..') && !isAbsolute(between);
}

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
