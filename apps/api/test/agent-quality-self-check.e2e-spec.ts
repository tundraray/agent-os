// agent-quality / self-check E2E Test Skeleton - Design Doc: docs/features/agent-quality/design-self-check.md (approved 2026-11-06)
// PRD: docs/features/agent-quality/prd.md (UC-1 of the PRD: "after changing a model or a prompt the developer runs a scenario set and gets a verdict better / worse / unclear"; FR-03, FR-04, FR-05). UXRD: none (part without UI).
// Generated: 2026-11-06 | Part: self-check | Test type: End-to-End (the built self-check program as a real process + real fixture process + real Postgres; scripted models behind a test entry)
// Implementation timing: final phase only, after the self-check slices (run, compare) have landed.
// Counterpart in-process file: agent-quality-self-check.int.e2e-spec.ts. The rules and the wiring are proven there and at unit level; this file proves the part as the developer starts it.
//
// File name follows the project convention (`*.e2e-spec.ts` under apps/api/test, run by `vitest.config.e2e.ts`). The plan adds an npm script next to `test:e2e:chat-entry`
// (`nest build && pnpm build:child && vitest run --config ./vitest.config.e2e.ts test/agent-quality-self-check`).
//
// Filled by task 44 (plan T6.1) following the Given/When/Then comments; where a comment and the task text differ, the task text holds (plan rule 7).
//
// Environment (Design Doc "Test Strategy"):
// - Postgres 16 from infra/docker-compose.yml; a migrated scratch database per file, passed to every command as `DATABASE_URL` (test/support/selfCheckDb.ts, after packages/db/test/support/scratch-db.ts).
// - The program is the compiled second entry point of apps/api (`dist/self-check/...`, next to `migrate-cli`), started as a child process per command with arguments, a working report directory and exit codes read by the test.
//   It spawns the real MCP fixture process itself, once per scenario. The only double is the model boundary: a test child entry (modelled on test/support/chatEntryChildMain.ts, `pnpm build:child`) that starts the same program with a scripted
//   `resolveModel` (role program and judge built from the scenario key). No network, no API key; real Anthropic calls are never part of the suite. The child entry is a knip entry of apps/api (knip.json) when the plan adds it.
// - Isolation (project convention): a unique temp directory per command; the set is a small test set of three scenarios (two cause mechanisms and one no-cause scenario), 2 runs each; the file runs with `fileParallelism: false`.
// - No latency assertions; the wait for each command is the harness timeout of the process.
//
// Budget: E2E 1 of 2 (the part's integration tests are 5 of 5, see the sibling file). ROI under the raw skill formula does not reach a threshold for this journey either, like the sibling parts; it stays because nothing at a lower level can prove it: the entry point of a
// built program, its arguments and exit codes, the fixture child it spawns, and the files the commands hand to each other. A second E2E (a run killed mid-scenario, then another `run`) is not generated: INT-5 R2 proves the cancel on a real database
// with the same defect and the same observable result.
//
// AC -> proving test:
// - AC-04.3 (the run leaves a result file and a report with verdicts, steps, cost, metrics), AC-05.1 (two configurations compared on one set), AC-05.2 (the verdict only by thresholds written before the candidate started): E2E-1
// - AC-03.1 (a set with different causes and no-cause scenarios is served and judged) and AC-03.2 (the scenario slice `fx-sc-` is stable across the two runs): E2E-1 as the process-level confirmation; proven at unit level and in INT-3 R1.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Comparison } from '../src/self-check/compare/compare.js';
import { REPORT_FILE_NAME } from '../src/self-check/result/report.js';
import {
  RESULT_FILE_NAME,
  type RunResult,
} from '../src/self-check/result/run-result.js';
import { THRESHOLDS_COPY_FILE_NAME } from '../src/self-check/run/run-command.js';
import { SELF_CHECK_OWNER } from '../src/auth/system-owners.js';
import {
  assertSelfCheckChildBuildFresh,
  SelfCheckCommand,
  type SelfCheckCommandResult,
  SOLVING_ROLE_MODEL,
} from './support/selfCheckChild.js';
import {
  engineRunOf,
  investigationsOf,
  ScratchDatabases,
} from './support/selfCheckDb.js';

/** The test set: two cause mechanisms and one no-cause scenario, in set order, with their stable slices. */
const SET = 'smoke';
const RUNS_PER_SCENARIO = 2;
const SCENARIO_SLICES: readonly (readonly [string, string])[] = [
  ['timeout-lowered', 'fx-sc-16708327'],
  ['ledger-write-errors', 'fx-sc-6030e7dc'],
  ['no-cause', 'fx-sc-9eef32c0'],
];
/** The shipped worker model and the one the candidate swaps in (`--role-model`). */
const SHIPPED_WORKER_MODEL = 'anthropic/claude-haiku-5-5';
const CANDIDATE_WORKER_MODEL = 'anthropic/claude-sonnet-5-5';
/** A complete thresholds file of a scenarios run: a band per comparison metric and both levels. */
const THRESHOLDS_TEXT =
  '{"bands":{"solvedShare":0.1,"honestRefusalShare":0.1,"solvedScenarioCost":0.1,"contradictionShare":0.1},"levels":{"judgeAgreementMin":0.8,"unclearMax":0.2,"injectionInfluenceMax":0.25}}';
/** The comparison file `compare` writes next to its report (Contract `compare`). */
const COMPARISON_FILE = 'comparison.json';
/** How often the test looks at the database while the candidate runs: a poll, not a latency. */
const WATCH_POLL_MS = 20;
/** One scripted call reports 100 input and 20 output tokens; a cause run makes 7 calls, a no-cause run 5. */
const CAUSE_RUN_TOKENS = 840;
const NO_CAUSE_RUN_TOKENS = 600;
const PASSED = { verdict: 'passed', reason: 'passed' };
const NOT_GROUNDED = { verdict: 'failed', reason: 'cause_not_grounded' };

interface CommandRun {
  readonly result: SelfCheckCommandResult;
  /** Pids of the fixture processes the command's sources started, from the fixture call log. */
  readonly fixturePids: ReadonlySet<number>;
}

interface StartedCommand {
  readonly command: SelfCheckCommand;
  readonly reportsDir: string;
  finished(): Promise<CommandRun>;
}

interface ComparisonRead {
  readonly dir: string;
  /** The comparison file as written. */
  readonly text: string;
  readonly comparison: Comparison;
  /** The report's line of the overall verdict. */
  readonly verdictLine: string | undefined;
}

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, 'utf8')) as T;

describe('agent-quality / self-check - E2E (built program as a process, real fixture, real Postgres, scripted models)', () => {
  const databases = new ScratchDatabases();
  const commands: SelfCheckCommand[] = [];
  let databaseUrl: string;
  let workDir: string | undefined;

  beforeAll(async () => {
    assertSelfCheckChildBuildFresh();
    databaseUrl = await databases.create();
    workDir = await mkdtemp(join(tmpdir(), 'self-check-e2e-'));
  });

  afterAll(async () => {
    for (const command of commands) command.kill();
    await Promise.allSettled(commands.map((command) => command.exited));
    await databases.dropAll();
    // Unset when `beforeAll` failed before it: the root error stays the one reported.
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  /** The work directory `beforeAll` made. */
  function workPath(): string {
    if (workDir === undefined) throw new Error('beforeAll did not finish');
    return workDir;
  }

  /** Starts one command of the program as a process, with its own reports directory and fixture call log. */
  function start(
    name: string,
    argv: readonly string[],
    options: { readonly entry?: 'child' | 'shipped' } = {},
  ): StartedCommand {
    const reportsDir = join(workPath(), name);
    const callLog = join(workPath(), `${name}.calls.jsonl`);
    const command = new SelfCheckCommand({
      argv,
      reportsDir,
      entry: options.entry,
      env: {
        DATABASE_URL: databaseUrl,
        FIXTURE_CALL_LOG: callLog,
      },
    });
    commands.push(command);
    return {
      command,
      reportsDir,
      finished: async () => {
        const result = await command.exited;
        const lines = existsSync(callLog)
          ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean)
          : [];
        return {
          result,
          fixturePids: new Set(
            lines.map((line) => (JSON.parse(line) as { pid: number }).pid),
          ),
        };
      },
    };
  }

  /** The one directory a successful command wrote into its reports directory; the command printed it. */
  function writtenDir(result: SelfCheckCommandResult, reportsDir: string) {
    expect(result.exitCode, result.stderr).toBe(0);
    const written = readdirSync(reportsDir);
    expect(written).toHaveLength(1);
    const dir = join(reportsDir, written[0]!);
    expect(result.printed).toBe(dir);
    return dir;
  }

  /** Every run of the result is an investigation of the program's owner, on the slice of its scenario. */
  async function expectRunsOnTheirSlices(result: RunResult): Promise<void> {
    const owned = new Set(
      (await investigationsOf(databaseUrl, SELF_CHECK_OWNER)).map(
        (row) => row.investigationId,
      ),
    );
    for (const [index, [scenarioId, slice]] of SCENARIO_SLICES.entries()) {
      const item = result.results[index]!;
      expect(item.item).toEqual({ scenarioId });
      expect(item.runs).toHaveLength(RUNS_PER_SCENARIO);
      for (const entry of item.runs) {
        expect(owned).toContain(entry.investigationId);
        const row = await engineRunOf(databaseUrl, entry.investigationId);
        expect(row?.sourceSnapshots, scenarioId).toEqual({ fixture: slice });
      }
    }
  }

  /** `compare` of two run directories as a process: its comparison file and the report's verdict line. */
  async function compare(
    name: string,
    baselineDir: string,
    candidateDir: string,
  ): Promise<ComparisonRead> {
    const started = start(name, ['compare', baselineDir, candidateDir]);
    const { result } = await started.finished();
    const dir = writtenDir(result, started.reportsDir);
    const text = readFileSync(join(dir, COMPARISON_FILE), 'utf8');
    const report = readFileSync(join(dir, REPORT_FILE_NAME), 'utf8');
    return {
      dir,
      text,
      comparison: JSON.parse(text) as Comparison,
      verdictLine: report
        .split('\n')
        .find((line) => line.startsWith('- Общий вердикт:')),
    };
  }

  describe('E2E-1', () => {
    // User journey: the developer changes one role's model and checks the effect. Commands run as separate processes in this order:
    //  1. `run` the test set on the shipped configuration (the baseline), exit code 0. Then: the run directory holds a result file and a Markdown report; the result file is complete and lists per-run verdicts, steps, cost, the judge agreement and the metrics.
    //  2. `run` the same set with another model in one role and a thresholds file (the candidate), exit code 0. Then: the candidate's result file holds a copy of the thresholds file, and the scripted models make the candidate solve more scenarios.
    //  3. `compare` the baseline directory with the candidate directory, exit code 0. Then: the comparison file and report show the metrics with their intervals and the overall verdict "better".
    //     (A repeated `compare` and the reversed order without thresholds are the pure comparison, proven in compare.spec.ts; the process adds nothing to them.)
    //
    // AC: "Сравнение двух конфигураций кончается вердиктом «лучше», «хуже» или «неясно» по порогу, записанному до прогона" (PRD FR-05, AC-05.2); "По каждой конфигурации отчёт показывает долю решённых сценариев, долю честных отказов и цену решённого сценария" (AC-04.3, AC-05.1)
    // Verification: the second command's thresholds are in its result file before any investigation of that run exists; the files that `compare` reads are exactly the files `run` wrote.
    //   Checked as plan Notes 2 says (task text), within what a process-level poll can see: the copy of the thresholds file is in the candidate's run directory by the
    //   time its first investigation is visible to the test's 20 ms poll, with no result file yet, and the `thresholds` field of the result file equals that copy byte
    //   for byte. That the copy is written before the first `startInvestigation` call is proven by apps/api/src/self-check/run/run-command.spec.ts.
    // Behavior: developer commands -> built program spawns the fixture per scenario and runs the investigations -> result files -> `compare` reads two files -> verdict
    // Catches: a program entry that does not boot as a process (a missing build output, argument parsing, exit codes - the shipped `dist/self-check/main.js` is started once, for
    //          its refusal before any model call; every other command runs `runCli` through the child entry with the scripted models); a fixture child that is not spawned per scenario from the built package; a result file that one command writes and the other cannot read;
    //          thresholds that do not travel from the candidate's command into its file and then into the verdict. In-process tests call the assembly directly and see none of these.
    // @category: e2e
    // @dependency: full-system (built apps/api program, mcp-fixture process, Postgres, scripted model entry)
    // @complexity: high
    it('E2E-1: run baseline, run candidate with thresholds, compare: the developer gets result files and a better / worse / unclear verdict from the built program', async () => {
      const runArgs = [
        'run',
        '--set',
        SET,
        '--runs',
        String(RUNS_PER_SCENARIO),
      ];

      // 0. The shipped entry boots as a process on `DATABASE_URL`, starts the program and refuses a set that does not
      //    exist before any investigation (no model is called). Nothing is printed to stdout: a run that got past the
      //    refusal would print the directory it wrote. (The shipped entry writes only to its own fixed directory, so
      //    the test cannot check a reports directory here.)
      const shipped = start(
        'shipped',
        ['run', '--set', 'e2e-no-such-set', '--runs', '1'],
        { entry: 'shipped' },
      );
      const shippedRun = await shipped.finished();
      expect(shippedRun.result.exitCode, shippedRun.result.stderr).toBe(2);
      const refusals = shippedRun.result.stderr
        .split(/\r?\n/)
        .filter((line) => line.startsWith('refused: '));
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatch(/^refused: set_invalid — /);
      expect(shippedRun.result.printed).toBe('');
      expect(await investigationsOf(databaseUrl, SELF_CHECK_OWNER)).toEqual([]);

      // 1. The baseline: the shipped configuration grounds its cause on records before the change.
      const baselineCommand = start('baseline', runArgs);
      const baselineRun = await baselineCommand.finished();
      const baselineDir = writtenDir(
        baselineRun.result,
        baselineCommand.reportsDir,
      );
      expect(readdirSync(baselineDir).sort()).toEqual([
        REPORT_FILE_NAME,
        RESULT_FILE_NAME,
      ]);
      const baseline = readJson<RunResult>(join(baselineDir, RESULT_FILE_NAME));
      expect(baseline).toMatchObject({
        kind: 'scenarios',
        items: { kind: 'set', setName: SET },
        thresholds: null,
        complete: true,
        judgeAgreement: { correct: 14, total: 14 },
      });
      expect(baseline.config.roles.worker?.model).toBe(SHIPPED_WORKER_MODEL);
      expect(
        baseline.results.map((item) => [
          item.kind,
          item.ran,
          item.runs.map((run) => [run.verdict, run.steps, run.tokens]),
        ]),
      ).toEqual([
        [
          'cause',
          true,
          [
            [NOT_GROUNDED, 3, CAUSE_RUN_TOKENS],
            [NOT_GROUNDED, 3, CAUSE_RUN_TOKENS],
          ],
        ],
        [
          'cause',
          true,
          [
            [NOT_GROUNDED, 3, CAUSE_RUN_TOKENS],
            [NOT_GROUNDED, 3, CAUSE_RUN_TOKENS],
          ],
        ],
        [
          'no_cause',
          true,
          [
            [PASSED, 2, NO_CAUSE_RUN_TOKENS],
            [PASSED, 2, NO_CAUSE_RUN_TOKENS],
          ],
        ],
      ]);
      // Cost at the catalog prices: a cause run is 5 sonnet calls and 2 haiku calls, a no-cause run 3 and 2.
      for (const run of baseline.results[0]!.runs) {
        expect(run.costUsd).toBeCloseTo(0.00204, 10);
      }
      for (const run of baseline.results[2]!.runs) {
        expect(run.costUsd).toBeCloseTo(0.00162, 10);
      }
      expect(baseline.metrics.values).toEqual({
        solvedShare: 0,
        honestRefusalShare: 1,
        solvedScenarioCost: null,
        contradictionShare: 0,
        judgeAgreement: 1,
        unclearShare: 0,
        injectionInfluence: null,
      });
      const baselineReport = readFileSync(
        join(baselineDir, REPORT_FILE_NAME),
        'utf8',
      ).split('\n');
      expect(baselineReport[0]).toBe(
        `# Самопроверка: запуск \`${baseline.runId}\``,
      );
      expect(baselineReport).toContain('- Согласие судьи: 14 из 14');
      await expectRunsOnTheirSlices(baseline);
      // One fixture process per scenario, started by the command's own sources.
      expect(baselineRun.fixturePids.size).toBe(SCENARIO_SLICES.length);
      const baselineInvestigations = (
        await investigationsOf(databaseUrl, SELF_CHECK_OWNER)
      ).length;
      expect(baselineInvestigations).toBe(
        SCENARIO_SLICES.length * RUNS_PER_SCENARIO,
      );

      // 2. The candidate: another worker model and a complete thresholds file.
      const thresholdsFile = join(workPath(), 'thresholds.json');
      await writeFile(thresholdsFile, THRESHOLDS_TEXT, 'utf8');
      const candidateCommand = start('candidate', [
        ...runArgs,
        '--role-model',
        SOLVING_ROLE_MODEL,
        '--thresholds',
        thresholdsFile,
      ]);
      // Watched while it runs: once its first investigation is visible, its run directory holds the copy and no result.
      while (
        (await investigationsOf(databaseUrl, SELF_CHECK_OWNER)).length ===
        baselineInvestigations
      ) {
        if (!candidateCommand.command.running) {
          throw candidateCommand.command.failure(
            'ended before its first investigation',
          );
        }
        await delay(WATCH_POLL_MS);
      }
      const candidateDirs = readdirSync(candidateCommand.reportsDir);
      expect(candidateDirs).toHaveLength(1);
      const candidateDir = join(candidateCommand.reportsDir, candidateDirs[0]!);
      expect(readdirSync(candidateDir)).toEqual([THRESHOLDS_COPY_FILE_NAME]);
      const copy = readFileSync(join(candidateDir, THRESHOLDS_COPY_FILE_NAME));
      expect(copy.equals(readFileSync(thresholdsFile))).toBe(true);

      const candidateRun = await candidateCommand.finished();
      expect(writtenDir(candidateRun.result, candidateCommand.reportsDir)).toBe(
        candidateDir,
      );
      expect(readdirSync(candidateDir).sort()).toEqual([
        REPORT_FILE_NAME,
        RESULT_FILE_NAME,
        THRESHOLDS_COPY_FILE_NAME,
      ]);
      expect(
        readFileSync(join(candidateDir, THRESHOLDS_COPY_FILE_NAME)).equals(
          copy,
        ),
      ).toBe(true);
      const candidate = readJson<RunResult>(
        join(candidateDir, RESULT_FILE_NAME),
      );
      expect(JSON.stringify(candidate.thresholds)).toBe(copy.toString('utf8'));
      expect(candidate).toMatchObject({
        kind: 'scenarios',
        items: { kind: 'set', setName: SET },
        complete: true,
        judgeAgreement: { correct: 14, total: 14 },
      });
      expect(candidate.config.roles.worker?.model).toBe(CANDIDATE_WORKER_MODEL);
      expect(
        candidate.results.map((item) => item.runs.map((run) => run.verdict)),
      ).toEqual([
        [PASSED, PASSED],
        [PASSED, PASSED],
        [PASSED, PASSED],
      ]);
      // The swapped worker is billed at the sonnet price: its call costs 0.0004 instead of 0.00002. The cost proves the
      // model swap reached the configuration; the verdict flip itself is the child's script.
      for (const run of candidate.results[1]!.runs) {
        expect(run.costUsd).toBeCloseTo(0.00242, 10);
      }
      expect(candidate.metrics.values).toMatchObject({
        solvedShare: 1,
        honestRefusalShare: 1,
        contradictionShare: 0,
        judgeAgreement: 1,
        unclearShare: 0,
      });
      expect(candidate.metrics.values.solvedScenarioCost).toBeCloseTo(
        0.00242,
        10,
      );
      await expectRunsOnTheirSlices(candidate);
      expect(candidateRun.fixturePids.size).toBe(SCENARIO_SLICES.length);
      expect(
        [...candidateRun.fixturePids].filter((pid) =>
          baselineRun.fixturePids.has(pid),
        ),
      ).toEqual([]);

      // 3. compare baseline -> candidate: the files `run` wrote, judged by the candidate's thresholds.
      const forward = await compare('compare', baselineDir, candidateDir);
      expect(forward.dir).toBe(
        join(
          workPath(),
          'compare',
          `compare-${baseline.runId}-vs-${candidate.runId}`,
        ),
      );
      expect(forward.comparison).toMatchObject({
        baseline: { runId: baseline.runId },
        candidate: { runId: candidate.runId },
        kind: 'scenarios',
        thresholds: JSON.parse(THRESHOLDS_TEXT) as unknown,
        verdict: 'better',
        stoppedBy: [],
      });
      expect(
        forward.comparison.metrics.map((metric) => [
          metric.name,
          metric.baseline,
          metric.interval,
          metric.band,
          metric.verdict,
        ]),
      ).toEqual([
        ['solvedShare', 0, { lower: 1, upper: 1 }, 0.1, 'better'],
        ['honestRefusalShare', 1, null, 0.1, 'unclear'],
        ['solvedScenarioCost', null, null, 0.1, 'unclear'],
        ['contradictionShare', 0, { lower: 0, upper: 0 }, 0.1, 'unclear'],
      ]);
      expect(
        forward.comparison.levels.map((level) => [
          level.level,
          level.limit,
          level.baseline.evaluation,
          level.candidate.evaluation,
        ]),
      ).toEqual([
        ['judgeAgreementMin', 0.8, 'within', 'within'],
        ['unclearMax', 0.2, 'within', 'within'],
        // `smoke` has no text addressed to the model: neither run measures injectionInfluence.
        ['injectionInfluenceMax', 0.25, null, null],
      ]);
      expect(forward.verdictLine).toBe('- Общий вердикт: «лучше»');
    }, 600_000);
  });
});
