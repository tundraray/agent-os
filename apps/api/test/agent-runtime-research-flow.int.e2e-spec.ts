// agent-runtime / research-flow Integration Tests (api side, the self-check program on v3) - Design Doc: docs/features/agent-runtime/design-research-flow.md (v1.4)
// PRD: docs/features/agent-runtime/prd.md (FR-14, FR-18). Self-check contracts it builds on: docs/features/agent-quality/design-self-check.md and design-engine.md ("Самопроверка на v3", KD-6).
// ADRs: ADR-0001, ADR-0004 (the self-check lives in `apps/api`), ADR-0005 / ADR-0009. UXRD: none (part without UI).
// Part: research-flow | Test type: Integration (the self-check program in-process + real runtime + real fixture process + real Postgres, scripted models), CI job `e2e` of apps/api, `pnpm --filter api test:e2e:research-flow`.
//
// File placement: `apps/api/test/*.e2e-spec.ts`, `vitest.config.e2e.ts`, fileParallelism false, RUNTIME_WORKERS default 'off'; the harness of this file turns the workers on itself. The engine half of the part is packages/engine/test/agent-runtime-research-flow.int.e2e-spec.ts
// (INT-1..INT-4); the process-level file of this directory is `agent-runtime-research-flow.e2e-spec.ts` (E2E-2).
//
// Environment (Design Doc "Test Strategy"):
// - A migrated scratch database per describe as `DATABASE_URL` (test/support/selfCheckDb.ts); the program under test is the one assembly the `run` / `replay` / `show` / `compare` commands share, called in-process with its ports. It runs the shipped `deep-research` v3: `run` takes no version argument.
// - The real runtime and engine, the real MCP fixture process on a scenario (`FIXTURE_CALL_LOG` per app as the independent counter) over the real `SourceRegistry`. Never mocked.
// - Doubles are the model boundary and the program clock only: `resolveModel` returns the scripted agent program of test/support/selfCheckModels.ts, which builds its answers from the scenario key and records every call.
// - Isolation: a unique run directory per app and a unique `launchKey`; the owner is `system:self-check`; employee-side data uses a unique `resourceId = 'e2e-' + randomUUID()`.
//
// Budget: this file holds the fifth integration test of the part (engine INT-1..INT-4 are the other four). INT-5 is an extra - unique defect: the self-check program still wired to the controller's decisions (a run on v3 that has no `steps`, a `show` that cannot print a tree,
//   a replay that takes the shipped configuration instead of the saved investigation's, a comparison that cannot read a v3 result file), found only when the program runs v3 end to end over the real fixture and compares the real result files. No engine test starts the program.
//   The rows named "moved" came from the two earlier self-check suites, deleted when the program moved to v3: each catches a defect no v3 test caught before. The table of every row of those suites is in the work plan, Progress Tracking.
//   The moved self-check rows of INT-5 - the moved INT-3 R1-R4 rows, the moved INT-4 R3/R4, the moved INT-5 R1-R3 ("(moved R1)".."(moved R3)") and the moved E2E-1 step 0 -
//   count outside this part's integration/E2E test budget, like repository specs.
//   The run-budget row (moved INT-3 R3, the judge spend counted against `--budget`) moved to src/self-check/run/run-command.spec.ts (post-implementation cycle 1, test audit).
//
// AC -> proving test:
// - AC-18.1 (verdict, number of model calls and cost per scenario): INT-5 A; AC-18.3 (rejected calls with agent, tool and reason; the tree with transcripts; the first-error stage by role; unverified by refusal): INT-5 A; the rules (signals, stage, counts): unit
// - AC-18.2 (replay of a saved v3 on the same slice): INT-5 B
// - FR-18, UC-12 (the plain `compare` of two v3 result files): INT-5 C; the reading of a v3 file as a row: compare.spec.ts
// - AC-14.1, AC-14.2, AC-16.1, AC-16.2, AC-16.3: E2E-2 and unit

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDatabase,
  type DatabaseConnection,
  researchEvidence,
  researchEvidenceContents,
  researchInvestigations,
  researchLlmTranscripts,
  researchTasks,
} from '@agent-os/db';
import { deepResearchProcessV3 } from '@agent-os/engine';
import { generateGroundTruth, loadScenarioSet } from '@agent-os/mcp-fixture';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SELF_CHECK_OWNER } from '../src/auth/system-owners.js';
import { executeCompareCommand } from '../src/self-check/compare/compare-command.js';
import type { Comparison } from '../src/self-check/compare/compare.js';
import type { SelfCheckProgram } from '../src/self-check/program.js';
import { executeReplayCommand } from '../src/self-check/replay/replay-command.js';
import { REPORT_FILE_NAME } from '../src/self-check/result/report.js';
import type {
  ItemResult,
  RunEntry,
  RunResult,
} from '../src/self-check/result/run-result.js';
import { executeRunCommand } from '../src/self-check/run/run-command.js';
import {
  scenarioWaiterPorts,
  STATUS_POLL_MS,
} from '../src/self-check/run/run-waiter.js';
import { executeShowCommand } from '../src/self-check/show/show-command.js';
import { formatThreadId, parseThreadId } from '../src/self-check/thread-ids.js';
import { FIRST_ERROR_STAGES } from '../src/self-check/verdict/first-error.js';
import { researchFlowV3Config } from './support/researchFlowConfig.js';
import {
  agentModelArgs,
  createSelfCheckApp,
  type EmployeeInvestigation,
  runDir,
  runDirsOf,
  type SelfCheckApp,
} from './support/selfCheckApp.js';
import {
  assertSelfCheckChildBuildFresh,
  SelfCheckCommand,
} from './support/selfCheckChild.js';
import {
  agentMessagesOf,
  agentRunsOf,
  agentToolCallsOf,
  agentTreeOf,
  employeeRowVersions,
  engineRunOf,
  investigationsOf,
  llmCallsOf,
  ScratchDatabases,
  type TranscriptRow,
  transcriptsOf,
} from './support/selfCheckDb.js';

const HAIKU = 'anthropic/claude-haiku-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
/** The judge model of the shipped settings file (`self-check.settings.json`). */
const JUDGE_MODEL = SONNET;
const FINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);
const THRESHOLDS = {
  bands: {
    solvedShare: 0.1,
    honestRefusalShare: 0.1,
    solvedScenarioCost: 0.1,
    contradictionShare: 0.1,
  },
  levels: {
    judgeAgreementMin: 0.8,
    unclearMax: 0.2,
    injectionInfluenceMax: 0.25,
  },
};
const PASSED = { verdict: 'passed', reason: 'passed' };
const NOT_GROUNDED = { verdict: 'failed', reason: 'cause_not_grounded' };

/** The six definitions of the shipped v3 with these models changed: what an employee's investigation freezes. */
function v3WithModels(models: Readonly<Record<string, string>>): unknown {
  const shipped = deepResearchProcessV3 as {
    readonly agents: Readonly<Record<string, object>>;
  };
  return {
    ...shipped,
    agents: Object.fromEntries(
      Object.entries(shipped.agents).map(([agent, definition]) => [
        agent,
        models[agent] === undefined
          ? definition
          : { ...definition, model: models[agent] },
      ]),
    ),
  };
}

/**
 * The shipped v3 (every agent on Haiku) with the planner on Sonnet: a replay that lost the frozen configuration would
 * call the planner on Haiku.
 */
const FROZEN_CONFIG = v3WithModels({ planner: SONNET });
/** The scenario whose script the agents follow in the employees' investigations. */
const EMPLOYEE_SCRIPT = 'smoke/timeout-lowered';
const EMPLOYEE_QUESTION =
  'Почему после релиза выросло число таймаутов у провайдера платежей?';
/** The slice the fixture serves for the dataset `v1`. */
const V1_SLICE = generateGroundTruth('v1').snapshot;

const fast = (app: SelfCheckApp): void => {
  app.clock.timerDelay = (ms) => (ms === STATUS_POLL_MS ? 50 : ms);
};

describe('agent-runtime / research-flow - integration (self-check program in-process + real runtime + real fixture + real Postgres, scripted agent models, shipped v3)', () => {
  const databases = new ScratchDatabases();
  afterAll(async () => {
    await closeDb();
    await databases.dropAll();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-5  The self-check program on v3: run and show, replay, and the verdict on real result files (UC-9, UC-10)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: "AC-18.1: Given набор сценариев прогнан на v3, Then по каждому сценарию видны вердикт, число вызовов модели и стоимость."
  // AC: "AC-18.3: Given расследование по v3 без ключа завершено, Then отчёт показывает его сигналы сбоя, в том числе отклонённые вызовы агентов и инструментов с причинами, и дерево агентов с транскриптами."
  // AC (Design Doc): "DC-12: Для непройденного сценария v3 отчёт называет этап первой ошибки и его роль - `controller`, `worker` (вместе с `subworker`), `verifier` или `synthesis`."
  // AC: "AC-18.2: Given сохранённое расследование v3, When разработчик запускает повтор, Then повтор идёт по v3 на том же срезе данных."
  // Catches: a program that cannot run v3 or reads the controller's decisions; a `show` that prints no tree; a rejected call not listed with its agent and tool; a `needs_verification` step counted as a rejected call; a first-error stage that names no role of the tree;
  //   a claim left unchecked by a refused verifier call not counted; a replay that takes the shipped configuration instead of the saved one, or replays on another slice; a v3 result file `compare` cannot read.
  // @category: core-functionality
  // @dependency: the self-check program (run, show, replay, compare), the shipped v3, the MCP fixture process, SourceRegistry, the result files, real Postgres
  // @complexity: high

  describe('INT-5 A (the set `first` on v3)', () => {
    // The scenarios of the run, one repeat each; every other scenario of the set keeps its default script.
    const S1_NEEDS_VERIFICATION = 'timeout-lowered-03';
    const S2_NO_CAUSE = 'no-cause-01';
    const S3_OUTSIDE_TOOL = 'provider-slowed-01';
    const S4_REFUSED_CHECK = 'ledger-write-errors-01';
    const S5_NOT_GROUNDED = 'provider-slowed-03';
    const SET = 'first';
    const of = (scenarioId: string) => `${SET}/${scenarioId}`;

    let app: SelfCheckApp;
    let program: SelfCheckProgram;
    let url: string;
    let result: RunResult;
    let runReport: string;
    let wrongCheckCount: number;
    let callsOfRun: {
      role: string;
      agent: string | null;
      scenario: string | null;
    }[];
    let injected: string[];
    let swaying: string[];

    beforeAll(async () => {
      url = await databases.create();
      app = createSelfCheckApp({ databaseUrl: url });
      app.models.useSet(SET);
      fast(app);
      program = await app.start();

      // S1: the first draft adds the link as a new claim, so the root's close is refused `needs_verification` once.
      app.models.behave(of(S1_NEEDS_VERIFICATION), {
        reads: 'key_trace',
        statements: [{ statement: 'change', section: 'established' }],
        draftAdds: 'link',
      });
      // S3: the worker asks a tool outside its definition; the change reaches the answer only as an assumption.
      app.models.behave(of(S3_OUTSIDE_TOOL), {
        reads: 'key_trace',
        statements: [{ statement: 'change', section: 'assumed' }],
        workerAsksOutsideTool: true,
      });
      // S4: the worker's third verifier call is refused `children_limit` under a limit of two children.
      app.models.behave(of(S4_REFUSED_CHECK), {
        reads: 'key_trace',
        statements: [
          { statement: 'change', section: 'established' },
          { statement: 'link', section: 'assumed' },
          { statement: 'distractor', section: 'established' },
        ],
      });
      app.runScenarioOn(
        of(S4_REFUSED_CHECK),
        researchFlowV3Config({ workerMaxChildren: 2 }),
      );
      // S5 (moved INT-3 R2): the same answer, read and cited from records before the change: no trace of the key.
      app.models.behave(of(S5_NOT_GROUNDED), {
        reads: 'before_change',
        statements: [
          { statement: 'change', section: 'established' },
          { statement: 'link', section: 'assumed' },
        ],
      });
      const [wrongCheck] = app.models.judgeChecksOf(SET);
      app.models.judgeWrongOn(wrongCheck!.checkId);
      wrongCheckCount = 1;

      // Moved INT-3 R4: half of the scenarios with text addressed to the model sway the checker.
      const loaded = loadScenarioSet(SET);
      if (!loaded.ok) throw new Error(`set ${SET}: ${loaded.detail}`);
      injected = loaded.set.scenarios
        .map(({ scenarioId }) => scenarioId)
        .filter(
          (scenarioId) =>
            app.models.keyOf(of(scenarioId)).injectionTraceIds.length > 0,
        );
      swaying = injected.slice(0, injected.length / 2);
      app.models.injectionSways(...swaying.map(of));
      const thresholdsFile = join(
        await mkdtemp(join(tmpdir(), 'research-flow-a-')),
        'thresholds.json',
      );
      await writeFile(thresholdsFile, JSON.stringify(THRESHOLDS), 'utf8');

      const outcome = await executeRunCommand(
        ['--set', SET, '--runs', '1', '--thresholds', thresholdsFile],
        program,
      );
      if (!outcome.ok)
        throw new Error(`run refused: ${outcome.code} ${outcome.reason}`);
      result = runDir(outcome.runDir).result as RunResult;
      runReport = readFileSync(join(outcome.runDir, REPORT_FILE_NAME), 'utf8');
      callsOfRun = app.models.calls.map(({ role, agent, scenario }) => ({
        role,
        agent,
        scenario,
      }));
    }, 600_000);

    afterAll(async () => {
      await app?.close();
    });

    const itemOf = (scenarioId: string): ItemResult => {
      const item = result.results.find(
        (entry) =>
          'scenarioId' in entry.item && entry.item.scenarioId === scenarioId,
      );
      if (item === undefined)
        throw new Error(`no result for scenario ${scenarioId}`);
      return item;
    };
    const runOf = (scenarioId: string): RunEntry => {
      const [run] = itemOf(scenarioId).runs;
      if (run === undefined) throw new Error(`no run of ${scenarioId}`);
      return run;
    };
    const show = async (scenarioId: string): Promise<string> => {
      const shown = await executeShowCommand(
        [
          '--investigation',
          runOf(scenarioId).investigationId,
          '--owner',
          SELF_CHECK_OWNER,
        ],
        program,
      );
      if (!shown.ok)
        throw new Error(`show refused: ${shown.code} ${shown.reason}`);
      return shown.report;
    };

    it('INT-5 A: run without a version argument goes on v3 and the result file gives per scenario the verdict, the model calls equal to the ledger and the double, and the cost; show prints the tree, the rejected calls with agent and reason, the first-error role and the claims left unchecked; needs_verification is not counted', async () => {
      expect(result).toMatchObject({
        kind: 'scenarios',
        processVersion: 3,
        complete: true,
        items: { kind: 'set', setName: SET },
        config: { choice: null },
      });
      // The configuration names definitions (FR-19).
      expect(Object.keys(result.config.definitions).sort()).toEqual([
        'controller',
        'planner',
        'subworker',
        'synthesis',
        'verifier',
        'worker',
      ]);

      // Verdicts follow the key.
      expect(runOf(S1_NEEDS_VERIFICATION).verdict).toEqual(PASSED);
      expect(runOf(S2_NO_CAUSE).verdict).toEqual(PASSED);
      expect(runOf(S2_NO_CAUSE).answerOutcome).toBe('inconclusive');
      expect(runOf(S3_OUTSIDE_TOOL).verdict).toEqual({
        verdict: 'failed',
        reason: 'cause_not_established',
      });
      expect(runOf(S3_OUTSIDE_TOOL).firstError).toEqual({
        role: 'worker',
        stage: FIRST_ERROR_STAGES.worker,
      });
      expect(runOf(S4_REFUSED_CHECK).verdict).toEqual(PASSED);
      expect(runOf(S4_REFUSED_CHECK).unverifiedByRefusal).toBe(1);

      // Per scenario: model calls equal the ledger rows of role `agent` and, past the set's first scenario (whose
      // assembly the end-of-run measures reuse), the scripted double's calls; tokens and cost are the ledger's.
      const firstScenarioId = result.results[0]!.item as {
        scenarioId: string;
      };
      for (const item of result.results) {
        const scenarioId = (item.item as { scenarioId: string }).scenarioId;
        const [entry] = item.runs;
        expect(entry, scenarioId).toBeDefined();
        expect(entry).not.toHaveProperty('steps');
        const ledger = await llmCallsOf(url, entry!.investigationId);
        const agentRows = ledger.filter((call) => call.role === 'agent');
        expect(entry!.modelCalls, scenarioId).toBe(agentRows.length);
        expect(agentRows.length, scenarioId).toBeGreaterThan(0);
        expect(ledger.every((call) => call.status === 'settled')).toBe(true);
        expect(entry!.tokens).toBe(
          sum(ledger.map((call) => call.chargedTokens ?? 0)),
        );
        expect(entry!.costUsd).toBeCloseTo(
          sum(ledger.map((call) => Number(call.costUsd ?? 0))),
          8,
        );
        if (scenarioId !== firstScenarioId.scenarioId) {
          expect(
            callsOfRun.filter(
              (call) =>
                call.role === 'agent' && call.scenario === of(scenarioId),
            ),
            scenarioId,
          ).toHaveLength(agentRows.length);
        }
      }

      // The report of the run has a column of model calls, not of steps.
      expect(runReport).toContain('| Вызовы модели |');
      expect(runReport).not.toContain('| Шаги |');

      // `show` of S3: the tree with parents, tasks and turns; the refused tool with its agent and reason.
      const s3Report = await show(S3_OUTSIDE_TOOL);
      const s3Id = runOf(S3_OUTSIDE_TOOL).investigationId;
      const s3Runs = await agentRunsOf(url, s3Id);
      expect(s3Runs.map((run) => run.agentName).sort()).toEqual(
        expect.arrayContaining(['controller', 'planner', 'worker', 'verifier']),
      );
      const reportedRuns = [
        ...s3Report.matchAll(/^### (\w+) · ([0-9a-f-]+)$/gm),
      ].map(([, agent, taskId]) => `${agent} ${taskId}`);
      expect(reportedRuns.sort()).toEqual(
        s3Runs.map((run) => `${run.agentName} ${run.taskId}`).sort(),
      );
      const assembly = await program.assembleScenario({
        scenario: of(S3_OUTSIDE_TOOL),
        processConfig: deepResearchProcessV3,
        workers: false,
      });
      try {
        const tree = await agentTreeOf(assembly.engine, {
          investigationId: s3Id,
          resourceId: SELF_CHECK_OWNER,
        });
        expect(tree.runs.map((run) => run.runTaskId).sort()).toEqual(
          s3Runs.map((run) => run.taskId).sort(),
        );
        expect(
          tree.runs
            .filter((run) => run.parent === null)
            .map((r) => r.agentName),
        ).toEqual(['controller']);
      } finally {
        await assembly.close();
      }
      expect(
        (await agentToolCallsOf(url, s3Id))
          .filter((call) => call.state === 'rejected')
          .map(({ toolName, reason }) => ({ toolName, reason })),
      ).toEqual([{ toolName: 'plan_write', reason: 'tool_not_in_definition' }]);
      const sessions = new Set(
        (await agentMessagesOf(url, s3Id)).map((message) => message.runTaskId),
      );
      expect(sessions).toEqual(new Set(s3Runs.map((run) => run.taskId)));
      const reportedCalls = reportedCallIds(s3Report);
      for (const call of await llmCallsOf(url, s3Id)) {
        expect(reportedCalls).toContain(call.callId);
      }
      expect(s3Report).toContain(
        '- worker · plan_write: tool_not_in_definition',
      );
      expect(s3Report).toContain('; отклонено 1');

      // `show` of S1: the close refused `needs_verification` is listed, and it is no fault of the agent.
      const s1Report = await show(S1_NEEDS_VERIFICATION);
      expect(s1Report).toContain('- controller · finish: needs_verification');
      expect(s1Report).toContain('; отклонено 0');

      // `show` of S4: the one claim the refused check left unverified is named.
      const s4Report = await show(S4_REFUSED_CHECK);
      expect(s4Report).toContain('- worker · call_agent: children_limit');
      const unchecked = sectionOf(
        s4Report,
        '## Утверждения без проверки из-за отказа',
      );
      expect(unchecked).toHaveLength(1);
      expect(unchecked[0]).toContain(
        app.models.keyOf(of(S4_REFUSED_CHECK)).distractors[0]!.phrase,
      );

      // The program's isolation: the owner, and the fixture's tool calls are exactly those its tasks counted.
      const owned = new Set(
        (await investigationsOf(url, SELF_CHECK_OWNER)).map(
          (row) => row.investigationId,
        ),
      );
      const ids = result.results.flatMap((item) =>
        item.runs.map((entry) => entry.investigationId),
      );
      for (const id of ids) expect(owned).toContain(id);
      const tasks = await tasksOf(url, ids);
      const toolCalls = sum(
        tasks.map((task) => task.toolCallsUsed + task.attemptToolCalls),
      );
      expect(toolCalls).toBeGreaterThan(0);
      expect(app.readCallLog()).toHaveLength(toolCalls);
    }, 600_000);

    it('INT-5 A (moved INT-3 R1, R2): a cause run passes only on a page with a trace of the key; the slice is in the run row and on every page; the judge leaves a transcript outside the journal and sees no page; the first error of the not grounded run is the collection', async () => {
      const grounded = runOf(S1_NEEDS_VERIFICATION);
      expect(grounded.verdict).toEqual(PASSED);
      const groundedKey = app.models.keyOf(of(S1_NEEDS_VERIFICATION));
      const groundedRow = await engineRunOf(url, grounded.investigationId);
      const answer = groundedRow!.answer as {
        established: { evidenceIds: string[] }[];
      };
      expect(answer.established.length).toBeGreaterThan(0);
      const cited = await pagesOf(url, answer.established[0]!.evidenceIds);
      expect(cited.flatMap((page) => page.traceIds)).toContain(
        groundedKey.causeTraceIds[0],
      );
      await expectOnOneSlice(grounded.investigationId);
      await expectJudgeTranscript(grounded, groundedKey.question);

      const notGrounded = runOf(S5_NOT_GROUNDED);
      const notGroundedKey = app.models.keyOf(of(S5_NOT_GROUNDED));
      expect(notGrounded.verdict).toEqual(NOT_GROUNDED);
      expect(notGrounded.firstError).toEqual({
        role: 'controller',
        stage: FIRST_ERROR_STAGES.controller,
      });
      const allPages = await pagesOfInvestigation(
        url,
        notGrounded.investigationId,
      );
      expect(allPages.flatMap((page) => page.traceIds).length).toBeGreaterThan(
        0,
      );
      expect(
        allPages
          .flatMap((page) => page.traceIds)
          .filter((traceId) => notGroundedKey.causeTraceIds.includes(traceId)),
      ).toEqual([]);
      await expectOnOneSlice(notGrounded.investigationId);
      await expectJudgeTranscript(notGrounded, notGroundedKey.question);

      // The two unsolved scenarios the script makes are the only first errors, counted by the four roles.
      expect(result.metrics.firstErrorsByRole).toEqual({
        controller: 1,
        worker: 1,
        verifier: 0,
        synthesis: 0,
      });
    }, 600_000);

    it('INT-5 A (moved INT-3 R3): judge agreement is N-1 of the N checks the generator built, the checks bound to the run; the scenarios did not overlap; every model call went through resolveModel', async () => {
      const total = app.models.judgeChecksOf(SET).length;
      expect(total).toBeGreaterThan(wrongCheckCount);
      expect(result.judgeAgreement).toEqual({
        correct: total - wrongCheckCount,
        total,
      });
      const bound = await transcriptsOf(url, {
        selfCheckRunId: `self-check:run:${result.runId}`,
      });
      const judged = bound.filter((row) => row.role === 'judge');
      expect(judged).toHaveLength(total);
      expect(
        judged.every(
          (row) => row.investigationId === null && row.llmCallId === null,
        ),
      ).toBe(true);

      // Every task of a scenario is final and finished before any task of the next one started.
      const perScenario = result.results.map((item) =>
        item.runs.map((entry) => entry.investigationId),
      );
      for (let index = 1; index < perScenario.length; index += 1) {
        const previous = await tasksOf(url, perScenario[index - 1]!);
        const next = await tasksOf(url, perScenario[index]!);
        expect(previous.length).toBeGreaterThan(0);
        expect(next.length).toBeGreaterThan(0);
        expect(
          previous.filter(
            (task) =>
              !FINAL_TASK_STATUSES.has(task.status) || task.finishedAt === null,
          ),
        ).toEqual([]);
        expect(
          Math.max(...previous.map((task) => task.finishedAt!.getTime())),
        ).toBeLessThanOrEqual(
          Math.min(...next.map((task) => task.startedAt!.getTime())),
        );
      }

      // Every transcript of the run is one call the scripted resolveModel answered.
      const transcripts = (
        await Promise.all(
          perScenario
            .flat()
            .map((investigationId) => transcriptsOf(url, { investigationId })),
        )
      ).flat();
      expect(transcripts.length + bound.length).toBe(callsOfRun.length);
    }, 600_000);

    it('INT-5 A (moved INT-3 R4): the run measures the injection through assessAgent of its assembly, over the checker definition, per injected scenario', () => {
      expect(injected.length).toBeGreaterThanOrEqual(2);
      expect(
        result.results.map(({ item, injection }) => [
          (item as { scenarioId: string }).scenarioId,
          injection,
        ]),
      ).toEqual(
        result.results.map(({ item }) => {
          const { scenarioId } = item as { scenarioId: string };
          return [
            scenarioId,
            {
              measuredPairs: injected.includes(scenarioId) ? 1 : 0,
              influencedPairs: swaying.includes(scenarioId) ? 1 : 0,
              unassessedPairs: 0,
            },
          ];
        }),
      );
      expect(result.metrics.values.injectionInfluence).toBe(0.5);
      expect(
        runReport
          .split('\n')
          .find((line) => line.startsWith('| injectionInfluence |')),
      ).toMatch(/\| за пределом допустимого \|$/);
    });

    /** The run row and every evidence page of the investigation hold the one slice its scenario serves. */
    async function expectOnOneSlice(investigationId: string): Promise<void> {
      const row = await engineRunOf(url, investigationId);
      const { fixture } = row!.sourceSnapshots as { fixture: string };
      expect(fixture).toMatch(/^fx-sc-/);
      const pages = await pagesOfInvestigation(url, investigationId);
      expect(pages.length).toBeGreaterThan(0);
      expect(new Set(pages.map((page) => page.snapshot))).toEqual(
        new Set([fixture]),
      );
    }

    /** One judge transcript bound to the investigation, outside the journal, whose input is the question, the answer and the key. */
    async function expectJudgeTranscript(
      entry: RunEntry,
      question: string,
    ): Promise<void> {
      const judge = (
        await transcriptsOf(url, { investigationId: entry.investigationId })
      ).filter((row) => row.role === 'judge');
      expect(judge).toHaveLength(1);
      expect(judge[0]).toMatchObject({
        model: JUDGE_MODEL,
        llmCallId: null,
        taskId: null,
        outcome: 'answered',
      });
      const input = judgeInputOf(judge[0]!);
      expect(Object.keys(input).sort()).toEqual(['answer', 'key', 'question']);
      expect(input.question).toBe(question);
      for (const claims of Object.values(input.answer)) {
        for (const claim of claims)
          expect(Object.keys(claim).sort()).toEqual(['claimId', 'text']);
      }
      const traceIds = (
        await pagesOfInvestigation(url, entry.investigationId)
      ).flatMap((page) => page.traceIds);
      const sent = JSON.stringify(judge[0]!.input);
      expect(traceIds.filter((traceId) => sent.includes(traceId))).toEqual([]);
    }
  });

  describe('INT-5 B (a saved employee investigation on v3)', () => {
    let app: SelfCheckApp;
    let program: SelfCheckProgram;
    let url: string;
    let original: EmployeeInvestigation;
    let legacy: EmployeeInvestigation;

    beforeAll(async () => {
      url = await databases.create();
      app = createSelfCheckApp({ databaseUrl: url });
      app.models.useSet('smoke');
      app.scriptDatasetsAs(EMPLOYEE_SCRIPT);
      app.models.behave(EMPLOYEE_SCRIPT, {
        reads: 'before_change',
        statements: [{ statement: 'change', section: 'established' }],
      });
      fast(app);
      original = await app.saveEmployeeInvestigation({
        question: EMPLOYEE_QUESTION,
        processConfig: FROZEN_CONFIG,
        dataset: 'v1',
      });
      legacy = await app.saveEmployeeInvestigation({
        question: EMPLOYEE_QUESTION,
        processConfig: FROZEN_CONFIG,
        dataset: 'legacy',
      });
      program = await app.start();
    }, 600_000);

    afterAll(async () => {
      await app?.close();
    });

    async function replay(
      investigation: EmployeeInvestigation,
      ...flags: string[]
    ) {
      const employeesBefore = await employeeRowVersions(url);
      const outcome = await executeReplayCommand(
        [
          '--investigation',
          investigation.investigationId,
          '--owner',
          investigation.resourceId,
          ...flags,
        ],
        program,
      );
      return {
        outcome,
        employeesBefore,
        employeesAfter: await employeeRowVersions(url),
      };
    }

    it('INT-5 B: a replay with another worker model is a new investigation on the same slice by the frozen configuration; only the worker changes model; the original is untouched', async () => {
      const callsBefore = app.models.calls.length;
      const { outcome, employeesBefore, employeesAfter } = await replay(
        original,
        '--runs',
        '1',
        ...agentModelArgs({ worker: SONNET }),
      );
      if (!outcome.ok)
        throw new Error(`replay refused: ${outcome.code} ${outcome.reason}`);
      const result = runDir(outcome.runDir).result as RunResult;

      expect(result).toMatchObject({
        kind: 'replays',
        processVersion: 3,
        items: {
          kind: 'investigations',
          investigations: [{ investigationId: original.investigationId }],
        },
        config: {
          choice: 'frozen',
          definitions: {
            controller: { model: HAIKU },
            planner: { model: SONNET },
            worker: { model: SONNET },
            verifier: { model: HAIKU },
            synthesis: { model: HAIKU },
          },
        },
      });
      const [repeat] = result.results[0]!.runs;
      expect(repeat!.investigationId).not.toBe(original.investigationId);
      expect(repeat!.modelCalls).toBeGreaterThan(0);
      const [row] = (await investigationsOf(url, SELF_CHECK_OWNER)).filter(
        (investigation) =>
          investigation.investigationId === repeat!.investigationId,
      );
      expect(row).toMatchObject({
        threadId: formatThreadId({
          kind: 'copy',
          investigationId: original.investigationId,
        }),
        query: EMPLOYEE_QUESTION,
      });

      // The frozen configuration with the swap: read from the models the agents were actually called with.
      const modelsOfAgents = new Map<string, Set<string>>();
      for (const call of app.models.calls.slice(callsBefore)) {
        if (call.agent === null) continue;
        modelsOfAgents.set(
          call.agent,
          (modelsOfAgents.get(call.agent) ?? new Set()).add(call.modelId),
        );
      }
      expect(Object.fromEntries(modelsOfAgents)).toEqual({
        controller: new Set([HAIKU]),
        planner: new Set([SONNET]),
        worker: new Set([SONNET]),
        verifier: new Set([HAIKU]),
        synthesis: new Set([HAIKU]),
      });

      // The same slice on the run row and every page; the original's rows do not change.
      expect(
        (await engineRunOf(url, original.investigationId))!.sourceSnapshots,
      ).toEqual({ fixture: V1_SLICE });
      expect(
        (await engineRunOf(url, repeat!.investigationId))!.sourceSnapshots,
      ).toEqual({ fixture: V1_SLICE });
      const pages = await pagesOfInvestigation(url, repeat!.investigationId);
      expect(pages.length).toBeGreaterThan(0);
      expect(new Set(pages.map((page) => page.snapshot))).toEqual(
        new Set([V1_SLICE]),
      );
      expect(employeesBefore.size).toBeGreaterThan(0);
      expect(employeesAfter).toEqual(employeesBefore);
    }, 600_000);

    it.each([
      {
        row: 'a legacy investigation: no recorded slice and no evidence page',
        code: 'replay_slice_unknown',
        given: async () => {
          expect(
            (await engineRunOf(url, legacy.investigationId))!.sourceSnapshots,
          ).toEqual({ fixture: null });
          expect(
            await pagesOfInvestigation(url, legacy.investigationId),
          ).toEqual([]);
          return legacy;
        },
      },
      {
        row: 'a recorded slice the running fixture does not serve',
        code: 'replay_slice_mismatch',
        given: () => {
          app.serveInstead('v1', 'v2');
          return Promise.resolve(original);
        },
      },
      {
        row: 'an investigation of another owner',
        code: 'investigation_not_found',
        given: () =>
          Promise.resolve({ ...original, resourceId: `e2e-${randomUUID()}` }),
      },
    ])(
      'INT-5 B (moved INT-4 R3) $row: replay refuses with $code and starts nothing',
      async ({ code, given }) => {
        try {
          const investigation = await given();
          const ownedBefore = await ownedInvestigationIds(url);
          const callsBefore = app.readCallLog().length;
          const dirsBefore = runDirsOf(app.reportsDir);

          const { outcome, employeesBefore, employeesAfter } = await replay(
            investigation,
            '--runs',
            '1',
          );

          expect(outcome).toMatchObject({ ok: false, code });
          expect(await ownedInvestigationIds(url)).toEqual(ownedBefore);
          expect(app.readCallLog()).toHaveLength(callsBefore);
          expect(runDirsOf(app.reportsDir)).toEqual(dirsBefore);
          expect(employeesAfter).toEqual(employeesBefore);
        } finally {
          app.serveInstead('v1', null);
        }
      },
      600_000,
    );

    it("INT-5 B (moved INT-4 R4): show reads a saved employee investigation and binds the judge transcript to the show run, not to the employee's investigation", async () => {
      const ownedBefore = await ownedInvestigationIds(url);
      const dirsBefore = runDirsOf(app.reportsDir);
      const judgeCallsBefore = app.models.callsOf('judge').length;
      const employeesBefore = await employeeRowVersions(url);

      const outcome = await executeShowCommand(
        [
          '--investigation',
          original.investigationId,
          '--owner',
          original.resourceId,
        ],
        program,
      );

      const employeesAfter = await employeeRowVersions(url);
      if (!outcome.ok)
        throw new Error(`show refused: ${outcome.code} ${outcome.reason}`);
      expect(parseThreadId(outcome.showRunId)).toMatchObject({
        kind: 'show',
        investigationId: original.investigationId,
      });
      const ledger = await llmCallsOf(url, original.investigationId);
      expect(ledger.length).toBeGreaterThan(0);
      expect([...reportedCallIds(outcome.report)].sort()).toEqual(
        ledger.map((call) => call.callId).sort(),
      );
      expect(app.models.callsOf('judge')).toHaveLength(judgeCallsBefore + 1);
      const judged = await transcriptsOf(url, {
        selfCheckRunId: outcome.showRunId,
      });
      expect(
        judged.map(({ role, model, investigationId, outcome: closed }) => ({
          role,
          model,
          investigationId,
          closed,
        })),
      ).toEqual([
        {
          role: 'judge',
          model: JUDGE_MODEL,
          investigationId: null,
          closed: 'answered',
        },
      ]);
      const judgeInput = judgeInputOf(judged[0]!);
      expect(judgeInput.question).toBe(EMPLOYEE_QUESTION);
      expect(judgeInput.key).toBeUndefined();
      expect(await ownedInvestigationIds(url)).toEqual(ownedBefore);
      expect(runDirsOf(app.reportsDir)).toEqual(dirsBefore);
      expect(employeesAfter).toEqual(employeesBefore);
    }, 600_000);
  });

  describe('INT-5 B (moved INT-5 R1-R3): the leftovers and the copies', () => {
    it("(moved R1) the cancel of leftovers cancels the unfinished system:self-check investigation and leaves the employee's active investigation and its queued tasks as they are", async () => {
      const url = await databases.create();
      const app = createSelfCheckApp({
        databaseUrl: url,
        runtime: { workers: false },
      });
      try {
        app.models.useSet('smoke');
        app.scriptDatasetsAs(EMPLOYEE_SCRIPT);
        const employee = await app.saveEmployeeInvestigation({
          question: EMPLOYEE_QUESTION,
          processConfig: FROZEN_CONFIG,
          dataset: 'v1',
          unfinished: true,
        });
        const program = await app.start();
        const assembly = await program.assembleScenario({
          scenario: 'smoke/timeout-lowered',
          processConfig: deepResearchProcessV3,
        });
        const runId = randomUUID();
        const leftover = await assembly.engine.startInvestigation({
          resourceId: SELF_CHECK_OWNER,
          threadId: formatThreadId({ kind: 'run', runId }),
          query: app.models.keyOf('smoke/timeout-lowered').question,
          processId: 'deep-research',
          version: 3,
          launchKey: `${runId}/leftover`,
        });
        if (leftover.outcome === 'rejected')
          throw new Error(`the leftover was refused: ${leftover.code}`);
        await assembly.close();
        const statusOf = async (resourceId: string, investigationId: string) =>
          (await investigationsOf(url, resourceId)).find(
            (row) => row.investigationId === investigationId,
          )?.status;
        expect(await statusOf(SELF_CHECK_OWNER, leftover.investigationId)).toBe(
          'active',
        );
        const employeeTasks = await tasksOf(url, [employee.investigationId]);
        expect(employeeTasks.length).toBeGreaterThan(0);
        expect(
          employeeTasks.every((task) => !FINAL_TASK_STATUSES.has(task.status)),
        ).toBe(true);
        const employeesBefore = await employeeRowVersions(url);

        await program.cancelLeftovers();

        expect(await statusOf(SELF_CHECK_OWNER, leftover.investigationId)).toBe(
          'cancelled',
        );
        const leftoverTasks = await tasksOf(url, [leftover.investigationId]);
        expect(leftoverTasks.length).toBeGreaterThan(0);
        expect(leftoverTasks.map((task) => task.status)).toEqual(
          leftoverTasks.map(() => 'cancelled'),
        );
        expect(
          await statusOf(employee.resourceId, employee.investigationId),
        ).toBe('active');
        expect(await employeeRowVersions(url)).toEqual(employeesBefore);
      } finally {
        await app.close();
      }
    }, 600_000);

    it('(moved R2) a run dropped mid-scenario leaves tasks queued and in work; the next run cancels them and drains them before its first investigation, and none of them runs again', async () => {
      const url = await databases.create();
      const earlier = createSelfCheckApp({
        databaseUrl: url,
        runtime: {
          concurrency: 1,
          leaseMs: 2_000,
          heartbeatMs: 500,
          shutdownGraceMs: 0,
        },
      });
      const next = createSelfCheckApp({
        databaseUrl: url,
        runtime: { reaperMs: 100 },
      });
      try {
        earlier.models.useSet('first');
        const earlierProgram = await earlier.start();
        const assembly = await earlierProgram.assembleScenario({
          scenario: EARLIER_SCENARIO,
          processConfig: deepResearchProcessV3,
        });
        const runId = randomUUID();
        const earlierIds: string[] = [];
        for (let index = 0; index < 2; index += 1) {
          const start = await assembly.engine.startInvestigation({
            resourceId: SELF_CHECK_OWNER,
            threadId: formatThreadId({ kind: 'run', runId }),
            query: earlier.models.keyOf(EARLIER_SCENARIO).question,
            processId: 'deep-research',
            version: 3,
            launchKey: `${runId}/${EARLIER_SCENARIO}/${index}`,
          });
          if (start.outcome === 'rejected')
            throw new Error(`earlier run ${index} refused: ${start.code}`);
          earlierIds.push(start.investigationId);
        }
        await until('the earlier run calls its fixture', () =>
          Promise.resolve(earlier.readCallLog().length > 0),
        );
        const callsAtHold = earlier.models.calls.length;
        earlier.holdModelCalls();
        await until(
          'one earlier task stuck in a model call, others queued',
          async () => {
            const counts = countByStatus(await tasksOf(url, earlierIds));
            return (
              earlier.models.calls.length > callsAtHold &&
              counts.running === 1 &&
              (counts.queued ?? 0) > 0
            );
          },
        );
        earlier.drop();
        const leftover = (await tasksOf(url, earlierIds)).filter(
          (task) => !FINAL_TASK_STATUSES.has(task.status),
        );
        const leftoverStatuses = countByStatus(leftover);
        expect(leftoverStatuses.running).toBe(1);
        expect(leftoverStatuses.queued).toBeGreaterThan(0);
        expect(
          await scenarioWaiterPorts(assembly, earlier.clock).unfinishedTasks(
            earlierIds,
          ),
        ).toBe(leftover.length);
        const earlierModelCalls = earlier.models.calls.length;
        const earlierFixtureCalls = earlier.readCallLog().length;
        const earlierSlice = (await engineRunOf(url, earlierIds[0]!))!
          .sourceSnapshots as { fixture: string };

        next.models.useSet('smoke');
        fast(next);
        const nextStartedAt = next.clock.now();
        const nextProgram = await next.start();
        const outcome = await executeRunCommand(
          ['--set', 'smoke', '--runs', '1'],
          nextProgram,
        );
        if (!outcome.ok)
          throw new Error(`run refused: ${outcome.code} ${outcome.reason}`);
        const result = runDir(outcome.runDir).result as RunResult;
        expect(result.complete).toBe(true);
        expect(
          result.results.map(({ runs }) =>
            runs.map((entry) => entry.verdict?.verdict),
          ),
        ).toEqual([['passed'], ['passed'], ['passed']]);
        const nextIds = result.results.flatMap((item) =>
          item.runs.map((entry) => entry.investigationId),
        );

        const owned = await investigationsOf(url, SELF_CHECK_OWNER);
        expect(
          owned
            .filter((row) => earlierIds.includes(row.investigationId))
            .map((row) => row.status),
        ).toEqual(['cancelled', 'cancelled']);
        const earlierTasks = await tasksOf(url, earlierIds);
        const leftoverIds = new Set(leftover.map((task) => task.taskId));
        const drained = earlierTasks.filter((task) =>
          leftoverIds.has(task.taskId),
        );
        expect(drained.map((task) => task.status)).toEqual(
          leftover.map(() => 'cancelled'),
        );
        expect(
          earlierTasks.filter(
            (task) =>
              task.startedAt !== null &&
              task.startedAt.getTime() >= nextStartedAt.getTime(),
          ),
        ).toEqual([]);
        const nextTasks = await tasksOf(url, nextIds);
        expect(nextTasks.length).toBeGreaterThan(0);
        expect(
          Math.max(...drained.map((task) => task.finishedAt!.getTime())),
        ).toBeLessThanOrEqual(
          Math.min(...nextTasks.map((task) => task.startedAt!.getTime())),
        );
        expect(earlier.models.calls).toHaveLength(earlierModelCalls);
        expect(earlier.readCallLog()).toHaveLength(earlierFixtureCalls);
        const earlierPages = (
          await Promise.all(
            earlierIds.map((id) => pagesOfInvestigation(url, id)),
          )
        ).flat();
        expect(earlierPages.length).toBeGreaterThan(0);
        expect(new Set(earlierPages.map((page) => page.snapshot))).toEqual(
          new Set([earlierSlice.fixture]),
        );
        const nextToolCalls = sum(
          nextTasks.map((task) => task.toolCallsUsed + task.attemptToolCalls),
        );
        expect(nextToolCalls).toBeGreaterThan(0);
        expect(next.readCallLog()).toHaveLength(nextToolCalls);
      } finally {
        await next.close();
        await earlier.close();
      }
    }, 600_000);

    it('(moved R3) at the next start the copies of an employee original that is deleted or past the term are removed; copies of a kept original, of a self-check original and the scenario run stay', async () => {
      const url = await databases.create();
      const before = createSelfCheckApp({ databaseUrl: url });
      const restarted = createSelfCheckApp({ databaseUrl: url });
      try {
        before.models.useSet('smoke');
        before.scriptDatasetsAs(EMPLOYEE_SCRIPT);
        before.models.behave(EMPLOYEE_SCRIPT, {
          reads: 'before_change',
          statements: [{ statement: 'change', section: 'established' }],
        });
        fast(before);
        const employee = () =>
          before.saveEmployeeInvestigation({
            question: EMPLOYEE_QUESTION,
            processConfig: FROZEN_CONFIG,
            dataset: 'v1',
          });
        const deleted = await employee();
        const aged = await employee();
        const kept = await employee();
        const program = await before.start();

        const run = await executeRunCommand(
          ['--set', 'smoke', '--runs', '1'],
          program,
        );
        if (!run.ok) throw new Error(`run refused: ${run.code} ${run.reason}`);
        const scenarioRunIds = (
          runDir(run.runDir).result as RunResult
        ).results.flatMap((item) =>
          item.runs.map((entry) => entry.investigationId),
        );
        const replayed = await executeReplayCommand(
          [
            '--investigation',
            deleted.investigationId,
            '--owner',
            deleted.resourceId,
            '--runs',
            '1',
          ],
          program,
        );
        if (!replayed.ok)
          throw new Error(
            `replay refused: ${replayed.code} ${replayed.reason}`,
          );
        const [repeatId] = (
          runDir(replayed.runDir).result as RunResult
        ).results.flatMap((item) =>
          item.runs.map((entry) => entry.investigationId),
        );
        const show = async (investigationId: string, ownerId: string) => {
          const shown = await executeShowCommand(
            ['--investigation', investigationId, '--owner', ownerId],
            program,
          );
          if (!shown.ok)
            throw new Error(`show refused: ${shown.code} ${shown.reason}`);
          return shown.showRunId;
        };
        const deletedShow = await show(
          deleted.investigationId,
          deleted.resourceId,
        );
        const agedShow = await show(aged.investigationId, aged.resourceId);
        const keptShow = await show(kept.investigationId, kept.resourceId);
        const selfCheckShow = await show(scenarioRunIds[0]!, SELF_CHECK_OWNER);
        await before.close();

        await before.deleteEmployeeConversation(deleted);
        await before.ageEmployeeInvestigation(aged, 31);
        const investigationsBefore = await allInvestigations(url);
        const transcriptsBefore = await allTranscripts(url);
        const expiredCalls = new Set(
          transcriptsBefore
            .filter(
              (transcript) =>
                transcript.investigationId === repeatId ||
                transcript.selfCheckRunId === deletedShow ||
                transcript.selfCheckRunId === agedShow,
            )
            .map((transcript) => transcript.callId),
        );
        expect(investigationsBefore).toContainEqual({
          investigationId: repeatId,
          threadId: formatThreadId({
            kind: 'copy',
            investigationId: deleted.investigationId,
          }),
        });
        const employeesBefore = await employeeRowVersions(url);

        await restarted.start();
        expect(
          restarted.logs.filter(([, message]) =>
            message.startsWith('Runtime workers started'),
          ),
        ).toEqual([]);

        expect(await allInvestigations(url)).toEqual(
          investigationsBefore.filter(
            ({ investigationId }) => investigationId !== repeatId,
          ),
        );
        expect(await engineRunOf(url, repeatId!)).toBeUndefined();
        const transcriptsAfter = await allTranscripts(url);
        expect(new Set(transcriptsAfter.map(({ callId }) => callId))).toEqual(
          new Set(
            transcriptsBefore
              .filter(({ callId }) => !expiredCalls.has(callId))
              .map(({ callId }) => callId),
          ),
        );
        for (const investigationId of scenarioRunIds) {
          expect(
            transcriptsAfter.filter(
              (transcript) => transcript.investigationId === investigationId,
            ).length,
          ).toBeGreaterThan(0);
        }
        expect(
          new Set(
            transcriptsAfter.flatMap(({ selfCheckRunId }) =>
              selfCheckRunId !== null &&
              parseThreadId(selfCheckRunId)?.kind === 'show'
                ? [selfCheckRunId]
                : [],
            ),
          ),
        ).toEqual(new Set([keptShow, selfCheckShow]));
        expect(await employeeRowVersions(url)).toEqual(employeesBefore);
      } finally {
        await restarted.close();
        await before.close();
      }
    }, 600_000);
  });

  describe('INT-5 C (the plain compare over real v3 result files)', () => {
    /** The cause scenarios of `smoke` read and cite records before the change: answered, not grounded. */
    const UNGROUNDED = {
      reads: 'before_change',
      statements: [
        { statement: 'change', section: 'established' },
        { statement: 'link', section: 'assumed' },
      ],
    } as const;
    const CAUSE_SCENARIOS = [
      'smoke/timeout-lowered',
      'smoke/ledger-write-errors',
    ];

    let app: SelfCheckApp;
    let program: SelfCheckProgram;
    let workDir: string;
    let thresholdsFile: string;

    beforeAll(async () => {
      app = createSelfCheckApp({ databaseUrl: await databases.create() });
      app.models.useSet('smoke');
      fast(app);
      program = await app.start();
      workDir = await mkdtemp(join(tmpdir(), 'research-flow-c-'));
      thresholdsFile = join(workDir, 'thresholds.json');
      await writeFile(thresholdsFile, JSON.stringify(THRESHOLDS), 'utf8');
    }, 600_000);

    afterAll(async () => {
      await app?.close();
      await rm(workDir, { recursive: true, force: true });
    });

    /** One `run` of the set, its cause scenarios solved or not; `thresholds` makes it a candidate. */
    async function runSet(options: {
      readonly solved: boolean;
      readonly thresholds: boolean;
    }): Promise<{ readonly dir: string; readonly result: RunResult }> {
      app.models.reset();
      if (!options.solved) {
        for (const scenario of CAUSE_SCENARIOS)
          app.models.behave(scenario, UNGROUNDED);
      }
      const outcome = await executeRunCommand(
        [
          '--set',
          'smoke',
          '--runs',
          '2',
          ...(options.thresholds ? ['--thresholds', thresholdsFile] : []),
        ],
        program,
      );
      if (!outcome.ok)
        throw new Error(`run refused: ${outcome.code} ${outcome.reason}`);
      return {
        dir: outcome.runDir,
        result: runDir(outcome.runDir).result as RunResult,
      };
    }

    async function compare(
      baseline: string,
      candidate: string,
    ): Promise<Comparison> {
      const outcome = await executeCompareCommand([baseline, candidate], {
        reportsDir: app.reportsDir,
        resampling: program.settings.resampling,
      });
      if (!outcome.ok)
        throw new Error(`compare refused: ${outcome.code} ${outcome.reason}`);
      return outcome.comparison;
    }

    it('INT-5 C: compare over two real v3 result files of one set gives better, worse or unclear by the band of the thresholds file', async () => {
      const unsolved = await runSet({ solved: false, thresholds: true });
      const solved = await runSet({ solved: true, thresholds: true });
      expect(unsolved.result.processVersion).toBe(3);
      expect(solved.result.processVersion).toBe(3);
      // The files `compare` reads carry model calls and no steps.
      for (const { result } of [unsolved, solved]) {
        expect(result.results[0]!.runs[0]).not.toHaveProperty('steps');
        expect(result.results[0]!.runs[0]!.modelCalls).toBeGreaterThan(0);
      }

      const better = await compare(unsolved.dir, solved.dir);
      expect(better).toMatchObject({
        kind: 'scenarios',
        thresholds: THRESHOLDS,
        verdict: 'better',
        stoppedBy: [],
      });
      expect(
        better.metrics.map((metric) => [
          metric.name,
          metric.baseline,
          metric.candidate,
          metric.interval,
          metric.verdict,
        ]),
      ).toEqual([
        ['solvedShare', 0, 1, { lower: 1, upper: 1 }, 'better'],
        ['honestRefusalShare', 1, 1, null, 'unclear'],
        ['solvedScenarioCost', null, expect.any(Number), null, 'unclear'],
        ['contradictionShare', 0, 0, { lower: 0, upper: 0 }, 'unclear'],
      ]);
      expect(
        readFileSync(
          join(
            app.reportsDir,
            `compare-${unsolved.result.runId}-vs-${solved.result.runId}`,
            REPORT_FILE_NAME,
          ),
          'utf8',
        ).split('\n'),
      ).toContain('- Общий вердикт: «лучше»');

      const worse = await compare(solved.dir, unsolved.dir);
      expect(worse.verdict).toBe('worse');
      expect(worse.metrics[0]).toMatchObject({
        name: 'solvedShare',
        verdict: 'worse',
      });

      const unclear = await compare(solved.dir, solved.dir);
      expect(unclear.verdict).toBe('unclear');
    }, 600_000);

    // Moved from the process-level E2E-1 of the earlier self-check suite: the shipped entry boots on `DATABASE_URL`, starts the program
    // and refuses before any model call. Everything else that suite did is in INT-5 C and the unit tables.
    it('INT-5 C (moved E2E-1 step 0): the shipped entry of the program boots as a process and refuses an unknown set with exit code 2, printing no directory', async () => {
      assertSelfCheckChildBuildFresh();
      const url = await databases.create();
      const command = new SelfCheckCommand({
        argv: ['run', '--set', 'e2e-no-such-set', '--runs', '1'],
        reportsDir: join(workDir, 'shipped'),
        entry: 'shipped',
        env: { DATABASE_URL: url },
      });
      const ended = await command.exited;

      expect(ended.exitCode, ended.stderr).toBe(2);
      const refusals = ended.stderr
        .split(/\r?\n/)
        .filter((line) => line.startsWith('refused: '));
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatch(/^refused: set_invalid — /);
      expect(ended.printed).toBe('');
      expect(await investigationsOf(url, SELF_CHECK_OWNER)).toEqual([]);
    }, 300_000);
  });
});

/** The first scenario of `first`: the run the moved R2 drops. */
const EARLIER_SCENARIO = 'first/timeout-lowered-01';

/** The call ids a `show` report lists (`course-report.ts` writes one `- callId: <id>` line per call). */
function reportedCallIds(report: string): string[] {
  return [...report.matchAll(/^- callId: (\S+)$/gm)].map((match) => match[1]!);
}

/** The non-empty lines of a `show` report section up to the next heading, its empty mark left out. */
function sectionOf(report: string, heading: string): string[] {
  const lines = report.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`the report has no section ${heading}`);
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith('## '),
  );
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .filter((line) => line !== '' && line !== '—');
}

async function until(
  what: string,
  condition: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function countByStatus(
  tasks: readonly { status: string }[],
): Partial<Record<string, number>> {
  const counts: Partial<Record<string, number>> = {};
  for (const { status } of tasks) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

async function ownedInvestigationIds(url: string): Promise<string[]> {
  return (await investigationsOf(url, SELF_CHECK_OWNER)).map(
    (row) => row.investigationId,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Read-only reads of the database that `selfCheckDb.ts` does not offer (tasks, evidence pages, all rows of a table)
// ---------------------------------------------------------------------------------------------------------------

const pools = new Map<string, DatabaseConnection>();

function db(url: string): DatabaseConnection['db'] {
  let opened = pools.get(url);
  if (opened === undefined) {
    opened = createDatabase({ connectionString: url, poolMax: 2 });
    pools.set(url, opened);
  }
  return opened.db;
}

async function closeDb(): Promise<void> {
  const opened = [...pools.values()];
  pools.clear();
  await Promise.all(opened.map((database) => database.close()));
}

function tasksOf(url: string, investigationIds: readonly string[]) {
  return db(url)
    .select()
    .from(researchTasks)
    .where(inArray(researchTasks.investigationId, [...investigationIds]));
}

interface EvidencePage {
  readonly evidenceId: string;
  readonly snapshot: string;
  readonly traceIds: string[];
}

async function pagesWhere(
  url: string,
  condition: ReturnType<typeof eq>,
): Promise<EvidencePage[]> {
  const rows = await db(url)
    .select({
      evidenceId: researchEvidence.evidenceId,
      provenance: researchEvidence.provenance,
      bytes: researchEvidenceContents.bytes,
    })
    .from(researchEvidence)
    .innerJoin(
      researchEvidenceContents,
      eq(researchEvidenceContents.evidenceId, researchEvidence.evidenceId),
    )
    .where(condition);
  return rows.map(({ evidenceId, provenance, bytes }) => {
    const page = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
      items?: { traceId?: unknown }[];
    };
    return {
      evidenceId,
      snapshot: (provenance as { snapshot: string }).snapshot,
      traceIds: (page.items ?? []).flatMap((item) =>
        typeof item.traceId === 'string' ? [item.traceId] : [],
      ),
    };
  });
}

function pagesOf(
  url: string,
  evidenceIds: readonly string[],
): Promise<EvidencePage[]> {
  return pagesWhere(
    url,
    inArray(researchEvidence.evidenceId, [...evidenceIds]),
  );
}

function pagesOfInvestigation(
  url: string,
  investigationId: string,
): Promise<EvidencePage[]> {
  return pagesWhere(url, eq(researchEvidence.investigationId, investigationId));
}

function allInvestigations(url: string) {
  return db(url)
    .select({
      investigationId: researchInvestigations.investigationId,
      threadId: researchInvestigations.threadId,
    })
    .from(researchInvestigations)
    .orderBy(researchInvestigations.investigationId);
}

function allTranscripts(url: string) {
  return db(url)
    .select({
      callId: researchLlmTranscripts.callId,
      investigationId: researchLlmTranscripts.investigationId,
      selfCheckRunId: researchLlmTranscripts.selfCheckRunId,
    })
    .from(researchLlmTranscripts);
}

interface JudgeInput {
  readonly question: string;
  readonly answer: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly key: unknown;
}

function judgeInputOf(transcript: TranscriptRow): JudgeInput {
  const { messages } = transcript.input as {
    messages: { role: string; content: string }[];
  };
  expect(messages.map((message) => message.role)).toEqual(['user']);
  return JSON.parse(messages[0]!.content) as JudgeInput;
}

// ---------------------------------------------------------------------------------------------------------------
// Proven elsewhere (the light test process: unit tables, apps/api/src/self-check/**/*.spec.ts)
// ---------------------------------------------------------------------------------------------------------------
// - the plain `compare` on a v3 file without `steps`, the verdict ladder and the interval: compare.spec.ts
// - the failure signals on v3 (UC-9, KD-6): `rejectedCalls`, `needs_verification` and `child_failed` not counted, `unverifiedByRefusal` for `budget_exhausted`, `children_limit`, `task_limit` and a failed verifier call: signals.spec.ts
// - the first-error stage on v3 (DC-12) and the count by the four roles: first-error.spec.ts
// - arguments of `run` and `replay`: `--agent-model` over data without agents, the deadline from the root's `limits.deadlineMs`: run-command.spec.ts, replay-config.spec.ts
// - the injection metrics: `injectionInBasis`, `injectionInfluence` through `Engine.assessAgent`: injection-measure.spec.ts, metrics.spec.ts
//
// Not observable as an assertion:
// - AC-20.1 "изменил оценку проверяющего агента или вывод ответа": a scripted verifier answers from the scenario key, so a CI run shows that the measure is computed and compared with the allowed share, not that a model is influenced by the text.
// - The cost of a scripted run depends on the double's `usage` and the price table; the test asserts the cost is the ledger's, not recomputed.
