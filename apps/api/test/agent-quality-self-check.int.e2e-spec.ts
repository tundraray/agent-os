// agent-quality / self-check Integration Test Skeletons (api side, the self-check program) - Design Doc: docs/features/agent-quality/design-self-check.md (approved 2026-11-06)
// PRD: docs/features/agent-quality/prd.md (FR-01, FR-02, FR-03, FR-04, FR-05, FR-07; NFR-01, NFR-02). ADRs: ADR-0001 (the runtime executes the self-check investigations), ADR-0004 (no evaluation package; `@agent-os/mcp-fixture` is a dev dependency),
// ADR-0005 (a configuration with another model is still data). UXRD: none (part without UI).
// Generated: 2026-11-06 | Part: self-check | Test type: Integration (the self-check program in-process + real runtime + real fixture process + real Postgres, scripted models), CI job `e2e` of apps/api
// Implementation timing: created alongside the slice each test names (the `run` command, the `replay` and `show` commands, the start-up checks).
//
// File name and placement. This follows the sibling api files (`deep-research-chat-entry.int.e2e-spec.ts`, `research-runtime-wiring.e2e-spec.ts`): `apps/api/test/*.e2e-spec.ts`, picked up by `vitest.config.e2e.ts`
// (include '**/*.e2e-spec.ts', fileParallelism false, RUNTIME_WORKERS default 'off'; a file that needs the workers turns them on itself). The `.int.` infix separates these in-process tests from the process-level file
// `agent-quality-self-check.e2e-spec.ts` (final phase). The engine half of the part is packages/engine/test/agent-quality-self-check.int.e2e-spec.ts.
// The plan adds an npm script next to `test:e2e:chat-entry` for this file and the E2E file (the program is built first, as for the chat-entry suite).
//
// Generated as `it.todo` skeletons; every case is now implemented following its Given/When/Then comments (and the task text where it differs).
//
// Environment (Design Doc "Test Strategy"):
// - One Postgres database per test file as `DATABASE_URL` (design-self-check.md 1.6, KD-3: the program shares the server's database): a migrated scratch database on the instance of infra/docker-compose.yml,
//   created and dropped by test/support/selfCheckDb.ts. The employees' investigations a test saves live in it next to the program's `system:self-check` ones. The program under test is the one assembly function the `run` / `replay` / `show` commands share, called in-process with its ports (database URL, report directory, clock, `resolveModel`).
// - The real runtime and real engine with their handlers, the real MCP fixture process on a scenario (`FIXTURE_SCENARIO`, `FIXTURE_CALL_LOG` per test as the independent counter) over the real `SourceRegistry`. Never mocked: the slice, the pages and their `traceId` fields are only provable on a real transport.
// - Boundaries that are doubled, and only these: (1) `resolveModel`, which returns a scripted role-aware program (it builds the answer from the scenario key, so the right and the wrong answer are known) and a scripted judge that fills the form from the
//   same key; both record every call, so "every model call went through `resolveModel`" is read from them. (2) The clock of the program (poll interval, 10-minute margin).
// - Isolation (project convention, no truncate): a unique run directory under a temp dir and a unique `launchKey` per test; the scratch database is per file; the owner is always `system:self-check`; employee-side data uses a unique `resourceId = 'e2e-' + randomUUID()`.
// - Support: test/support/selfCheckApp.ts (the shared assembly with the doubles and the clock, a `runDir` helper that reads the result file), test/support/selfCheckDb.ts (read-only snapshots of the research tables and a row-version snapshot of the
//   employees' rows for "nothing changed" checks), test/support/selfCheckModels.ts (the scripted role program and the scripted judge).
//
// Budget (whole part, three files): Integration 5 (limit 3; up to 5 under the integration-e2e-testing rule only when each extra test names the defect no other test catches) and E2E 1 of 2.
//   INT-1 and INT-2 (engine file) and INT-3 (this file) are the core budget. INT-4 and INT-5 are the two extras:
//   - INT-4's unique defect: a saved employee investigation replayed on the wrong slice or with a lost frozen configuration, and a program that writes to an employee's investigation. No other test starts from a saved investigation.
//   - INT-5's unique defect: a cancel of leftovers that also cancels an employee's unfinished investigation in the shared database, a stale task of a killed run executing on the next scenario's fixture, and an employee's data copy outliving its original.
//   Pure rules (verdict ladder, form check, first-error stage, signals, metrics, comparison, slice determination, scheduling, timeout) are proven at unit level, see the block at the end; the rows here prove the wiring only, one case per rule.
//
// AC -> proving test (the plan reads this to avoid a second test for an AC already proven):
// - AC-04.1 (no-cause scenario: honest refusal passes, invented cause fails), AC-04.2 (invalid form is "unclear"), DC-9, DC-10, DC-11 rule halves: unit (verdict ladder, form check, timeout); the wiring of the verdict to real pages: INT-3 R1, R2
// - AC-04.3 (per-run verdict, steps, cost; run metrics): INT-3 R1 (values read from the journal and the result file); metric arithmetic is unit
// - AC-04.4 (judge measured on checks with known answers), DC-8: INT-3 R3
// - AC-02.1 (the slice is stored at start and replay sees the same logs), DC-6: INT-4 R1, R3
// - AC-02.2 (replay with another model in one role): INT-4 R2
// - DC-5 (an undeterminable slice refuses and starts nothing): unit table for the determination; the "nothing started" half: INT-4 R3
// - AC-07.1 (course of an investigation without a key), DC-15: INT-4 R4 (the read of an employee's investigation and the judge transcript binding); the signal rules are unit
// - AC-03.1, AC-03.2, AC-03.3, DC-7, DC-8 (checks half): unit (generator is a pure function); the scenario slice `fx-sc-` is served and read back in INT-3 R1
// - AC-05.1, AC-05.2, DC-12, DC-13, DC-14: unit (comparison); the files of two real runs compared by the program: E2E-1
// - DC-16 (first-error stage): unit (the rule); its wiring to the real pages and the per-role count in the result file: INT-3 R2
// - DC-17 (only `system:self-check` is cancelled), DC-18 (stale investigations cancelled), AC-01.3 / AC-01.4 for employee data copies: INT-5
// - NFR-02 (no log record leaves for a third party; the judge sees question, answer and key only): INT-3 R1
// - Constraints "Budget" (UC-E8), DC-9 (UC-E5, UC-E5a): unit

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDatabase,
  type DatabaseConnection,
  researchDecisions,
  researchEvidence,
  researchEvidenceContents,
  researchInvestigations,
  researchLlmTranscripts,
  researchTasks,
} from '@agent-os/db';
import { deepResearchProcessV2, loadProcessConfig } from '@agent-os/engine';
import { generateGroundTruth, loadScenarioSet } from '@agent-os/mcp-fixture';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SELF_CHECK_OWNER } from '../src/auth/system-owners.js';
import type { SelfCheckProgram } from '../src/self-check/program.js';
import { executeReplayCommand } from '../src/self-check/replay/replay-command.js';
import type {
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
import {
  createSelfCheckApp,
  type EmployeeInvestigation,
  runDir,
  runDirsOf,
  type SelfCheckApp,
} from './support/selfCheckApp.js';
import {
  employeeRowVersions,
  engineRunOf,
  investigationsOf,
  llmCallsOf,
  ScratchDatabases,
  type TranscriptRow,
  transcriptsOf,
} from './support/selfCheckDb.js';

/** Task statuses after which a task does nothing more (`TaskStatusSchema`). */
const FINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);
/** The judge model of the shipped settings file (`self-check.settings.json`). */
const JUDGE_MODEL = 'anthropic/claude-sonnet-5-5';
/** The token budget each run starts with: `limits.investigationTokens.default` of the shipped `deep-research`. */
const RUN_TOKEN_BUDGET = 300_000;
/** The slices the fixture serves for the scenarios of `smoke` (`fx-sc-` plus 8 characters of the parameters' print). */
const SMOKE_SLICES: Readonly<Record<string, string>> = {
  'timeout-lowered': 'fx-sc-16708327',
  'ledger-write-errors': 'fx-sc-6030e7dc',
};
/** The number of judge checks `buildJudgeChecks` makes for `smoke` (`judge-checks.spec.ts` proves their kinds). */
const SMOKE_JUDGE_CHECKS = 14;

describe('agent-quality / self-check - program integration (in-process program + real runtime + real fixture + real Postgres, scripted models)', () => {
  const databases = new ScratchDatabases();
  afterAll(async () => {
    await closeDb();
    await databases.dropAll();
  });

  describe('INT-3', () => {
    // UC-2, UC-10 (wiring), UC-11, UC-13, UC-N1. Table-driven over the `run` command on a one-scenario set per row, 2 runs per scenario. Fixture serves the scenario (`fx-sc-` slice); the scripted roles build the answer from the key.
    //
    // Rows:
    //  R1 passed + result file. Given a cause scenario and a scripted answer whose "Установлено" claim about the lowered timeout cites a page holding a trace of the key's evidence, and a judge that puts the cause in "Установлено".
    //     When the program runs the set. Then: the run verdict is `passed`; the result file holds status, steps (accepted controller decisions), tokens and cost equal to the sums of `research_llm_calls`, and the slice `fx-sc-...`;
    //     the transcripts of the investigation contain one call with role `judge` and the judge model, bound to the investigation; its input holds the question, the answer and the key and no log record of the fixture; every model call of
    //     roles and judge went through the scripted `resolveModel`.
    //  R2 not grounded. Given the same answer, but the claim cites a page that holds no trace of the key's evidence. Then: verdict `not passed`, reason `cause_not_grounded` (the algorithm read the pages' `traceId` fields through the real evidence reader).
    //  R3 judge agreement. Given the judge checks of the set, with the scripted judge wrong on exactly one. Then: the result file's `judgeAgreement` is N-1 of N, N being the number of checks the generator built for the set.
    //
    // AC: "Сценарий с причиной пройден, только если судья поставил заложенную причину в «Установлено», другая причина там не стоит и хотя бы одно утверждение с причиной ссылается на страницу записей, где есть запись из доказательства ключа" (DC-11, AC-04.1);
    //     "каждый запуск меряет на проверочных ответах согласие судьи" (AC-04.4, DC-8); "у каждого прогона видны вердикт, число шагов и стоимость" (AC-04.3); "вызов судьи оставляет транскрипт с ролью `judge`" (DC-3);
    //     "записи логов не уходят в сторонние сервисы" (NFR-02)
    // Behavior: `run` -> fixture on the scenario, investigations on the real runtime, judge through `Engine.assess`, verdict from the form and the pages -> result file
    // Catches: a verdict that does not read the real pages' `traceId` (a "grounded" answer failing, an ungrounded one passing); a result file whose steps, tokens or cost differ from the journal; a judge call that leaves no transcript or is written
    //          into the call journal (its foreign key to a task would fail); a judge input carrying log pages; a model call that bypasses `resolveModel`; judge agreement computed on the wrong denominator. The ladder's variants are unit; this proves they are wired to real data.
    // @category: core-functionality
    // @dependency: self-check program (run), mcp-fixture scenario, runtime, engine (Engine.assess, readRunRecord, EvidenceReader), Postgres, scripted models
    // @complexity: high
    //
    // Filled per the task text (plan rule 7), which wins over the comments above where they differ: the set is `smoke`, R1 and R2 assert about runs of its cause scenarios (one
    // `run --set smoke --runs 2` serves every row); under the seven-field form the scripted judge of R1 fills causeChange `established` and causeLink `assumed`, the answer keeping the
    // link in «Предположения» (UC-11); R2 is the same fill on `ledger-write-errors`, whose claims cite a page of the quarter hour before the change, which holds no trace of the key.
    // The slice is not a field of `RunResult.results`: it is read from the run row (`sourceSnapshots`) and the evidence pages' provenance. R3 adds two checks of the run itself:
    // the next scenario starts only after the previous one has no task left, and the run budget counts the judge's spend (a second, budgeted run).
    let app: SelfCheckApp;
    let program: SelfCheckProgram;
    let url: string;
    let run: { result: RunResult };
    let modelCallsOfRun: { role: string; modelId: string }[];

    const R1_SCENARIO = 'timeout-lowered';
    const R2_SCENARIO = 'ledger-write-errors';

    beforeAll(async () => {
      url = await databases.create();
      app = createSelfCheckApp({ databaseUrl: url });
      app.models.useSet('smoke');
      // The program clock (a boundary double): the 5-second status poll of the waiter is shortened; every other timer keeps its delay.
      app.clock.timerDelay = (ms) => (ms === STATUS_POLL_MS ? 50 : ms);
      program = await app.start();

      app.models.behave(`smoke/${R2_SCENARIO}`, {
        reads: 'before_change',
        statements: [
          { statement: 'change', section: 'established' },
          { statement: 'link', section: 'assumed' },
        ],
      });
      const [wrongCheck] = app.models.judgeChecksOf('smoke');
      app.models.judgeWrongOn(wrongCheck!.checkId);

      const outcome = await executeRunCommand(
        ['--set', 'smoke', '--runs', '2'],
        program,
      );
      if (!outcome.ok)
        throw new Error(`run refused: ${outcome.code} ${outcome.reason}`);
      run = { result: runDir(outcome.runDir).result as RunResult };
      modelCallsOfRun = app.models.calls.map(({ role, modelId }) => ({
        role,
        modelId,
      }));
    }, 600_000);

    afterAll(async () => {
      await app?.close();
    });

    const itemOf = (scenarioId: string) => {
      const item = run.result.results.find(
        (entry) =>
          'scenarioId' in entry.item && entry.item.scenarioId === scenarioId,
      );
      if (item === undefined)
        throw new Error(`no result for scenario ${scenarioId}`);
      return item;
    };

    it('INT-3 R1: a cause run whose established change cites a page with the key trace passes; steps, tokens and cost equal the journal; the judge leaves a transcript, no journal row and sees no page', async () => {
      const key = app.models.keyOf(`smoke/${R1_SCENARIO}`);
      expect(run.result).toMatchObject({
        kind: 'scenarios',
        items: { kind: 'set', setName: 'smoke' },
        judge: { model: JUDGE_MODEL },
        thresholds: null,
      });
      const item = itemOf(R1_SCENARIO);
      expect(item).toMatchObject({ kind: 'cause', ran: true });
      expect(item.runs).toHaveLength(2);
      const owned = await ownedInvestigationIds();

      for (const entry of item.runs) {
        expect(entry.verdict).toEqual({ verdict: 'passed', reason: 'passed' });
        expect(entry.status).toBe('completed');
        expect(owned).toContain(entry.investigationId);

        // The algorithm's input on real data: the established change cites a page whose records carry the key's first trace.
        const row = await engineRunOf(url, entry.investigationId);
        const answer = row!.answer as {
          established: { evidenceIds: string[] }[];
          assumed: unknown[];
        };
        expect(answer.established).toHaveLength(1);
        expect(answer.assumed).toHaveLength(1);
        const cited = await pagesOf(url, answer.established[0]!.evidenceIds);
        expect(cited.flatMap((page) => page.traceIds)).toContain(
          key.causeTraceIds[0],
        );

        // The slice: in the run row at start and in every evidence page of the investigation.
        expect(row!.sourceSnapshots).toEqual({
          fixture: SMOKE_SLICES[R1_SCENARIO],
        });
        const pages = await pagesOfInvestigation(url, entry.investigationId);
        expect(pages.length).toBeGreaterThan(0);
        expect(new Set(pages.map((page) => page.snapshot))).toEqual(
          new Set([SMOKE_SLICES[R1_SCENARIO]]),
        );

        await expectJournalConsistent(entry);
        await expectJudgeTranscript(entry, key.question);
      }
    });

    it('INT-3 R2: the same answer citing a page without a trace of the key is not grounded', async () => {
      const key = app.models.keyOf(`smoke/${R2_SCENARIO}`);
      const item = itemOf(R2_SCENARIO);
      expect(item).toMatchObject({ kind: 'cause', ran: true });
      expect(item.runs).toHaveLength(2);
      const owned = await ownedInvestigationIds();

      for (const entry of item.runs) {
        expect(entry.verdict).toEqual({
          verdict: 'failed',
          reason: 'cause_not_grounded',
        });
        expect(owned).toContain(entry.investigationId);
        const row = await engineRunOf(url, entry.investigationId);
        const answer = row!.answer as {
          established: { evidenceIds: string[] }[];
          assumed: unknown[];
        };
        expect(answer.established).toHaveLength(1);
        const cited = await pagesOf(url, answer.established[0]!.evidenceIds);
        // Real pages with records, none of them from the key's proof.
        expect(cited.flatMap((page) => page.traceIds).length).toBeGreaterThan(
          0,
        );
        expect(
          cited
            .flatMap((page) => page.traceIds)
            .filter((traceId) => key.causeTraceIds.includes(traceId)),
        ).toEqual([]);
        expect(row!.sourceSnapshots).toEqual({
          fixture: SMOKE_SLICES[R2_SCENARIO],
        });
        // DC-16 wiring: the first-error stage is computed from the real pages. The `before_change` read collects no page
        // with a key trace, so the key's evidence was lost at the collection stage; the rule's branches are unit (first-error.spec).
        const allPages = await pagesOfInvestigation(url, entry.investigationId);
        expect(
          allPages
            .flatMap((page) => page.traceIds)
            .filter((traceId) => key.causeTraceIds.includes(traceId)),
        ).toEqual([]);
        expect(entry.firstError).toEqual({
          role: 'controller',
          stage: FIRST_ERROR_STAGES.controller,
        });
        await expectJudgeTranscript(entry, key.question);
      }
      // The two unsolved cause runs are the only first errors of the launch, and the metrics count them by role.
      expect(run.result.metrics.firstErrorsByRole).toEqual({
        controller: 2,
        worker: 0,
        verifier: 0,
        synthesis: 0,
      });
    });

    it('INT-3 R3: judge agreement is N-1 of the N checks the generator built; scenarios did not overlap; every model call went through resolveModel; the run budget counts the judge', async () => {
      // Agreement on the generator's checks, the scripted judge wrong on exactly one.
      expect(app.models.judgeChecksOf('smoke')).toHaveLength(
        SMOKE_JUDGE_CHECKS,
      );
      expect(run.result.judgeAgreement).toEqual({
        correct: SMOKE_JUDGE_CHECKS - 1,
        total: SMOKE_JUDGE_CHECKS,
      });
      const selfCheckRunId = `self-check:run:${run.result.runId}`;
      const checkTranscripts = await transcriptsOf(url, { selfCheckRunId });
      expect(
        checkTranscripts.map(({ role, investigationId }) => ({
          role,
          investigationId,
        })),
      ).toEqual(
        Array.from({ length: SMOKE_JUDGE_CHECKS }, () => ({
          role: 'judge',
          investigationId: null,
        })),
      );

      // Every scenario ran, in set order, and the scenarios did not overlap: every task of a scenario is final and finished
      // before any task of the next one started. `finished_at` and `started_at` are both written from the runtime's clock
      // (the program clock), so the comparison needs no clock agreement with Postgres. That the waiter waits for an empty
      // queue is proven by run-waiter.spec.ts; with the scripted roles no task outlives its investigation here.
      expect(run.result.complete).toBe(true);
      expect(
        run.result.results.map(({ item, ran }) => ({ item, ran })),
      ).toEqual([
        { item: { scenarioId: 'timeout-lowered' }, ran: true },
        { item: { scenarioId: 'ledger-write-errors' }, ran: true },
        { item: { scenarioId: 'no-cause' }, ran: true },
      ]);
      const scenarioIds = run.result.results.map((item) =>
        item.runs.map((entry) => entry.investigationId),
      );
      for (let index = 1; index < scenarioIds.length; index += 1) {
        const previous = await tasksOf(url, scenarioIds[index - 1]!);
        const next = await tasksOf(url, scenarioIds[index]!);
        expect(previous.length).toBeGreaterThan(0);
        expect(next.length).toBeGreaterThan(0);
        expect(
          previous.filter(
            (task) =>
              !FINAL_TASK_STATUSES.has(task.status) || task.finishedAt === null,
          ),
        ).toEqual([]);
        expect(next.every((task) => task.startedAt !== null)).toBe(true);
        const lastFinished = Math.max(
          ...previous.map((task) => task.finishedAt!.getTime()),
        );
        const firstStarted = Math.min(
          ...next.map((task) => task.startedAt!.getTime()),
        );
        expect(lastFinished).toBeLessThanOrEqual(firstStarted);
      }

      // Every transcript of the run (roles and judge) is a call the scripted resolveModel answered.
      const transcripts = [
        ...(
          await Promise.all(
            scenarioIds
              .flat()
              .map((investigationId) =>
                transcriptsOf(url, { investigationId }),
              ),
          )
        ).flat(),
        ...checkTranscripts,
      ];
      expect(
        sortedCalls(
          transcripts.map(({ role, model }) => ({ role, modelId: model })),
        ),
      ).toEqual(sortedCalls(modelCallsOfRun));

      // The budget: enough for scenario 2 by the investigation's spend alone, short of it once the judge's spend is counted.
      const firstRun = itemOf(R1_SCENARIO).runs[0]!;
      const investigationTokens = sum(
        (await llmCallsOf(url, firstRun.investigationId)).map(
          (call) => call.chargedTokens ?? 0,
        ),
      );
      const judgeTokens = sum(
        (
          await transcriptsOf(url, {
            investigationId: firstRun.investigationId,
          })
        )
          .filter((transcript) => transcript.role === 'judge')
          .map(
            (transcript) =>
              (transcript.inputTokens ?? 0) + (transcript.outputTokens ?? 0),
          ),
      );
      expect(judgeTokens).toBeGreaterThan(0);
      const budget = RUN_TOKEN_BUDGET + investigationTokens + judgeTokens - 1;
      app.models.reset();
      const dirsBefore = runDirsOf(app.reportsDir);
      const budgeted = await executeRunCommand(
        ['--set', 'smoke', '--runs', '1', '--budget', String(budget)],
        program,
      );
      if (!budgeted.ok)
        throw new Error(
          `budgeted run refused: ${budgeted.code} ${budgeted.reason}`,
        );
      expect(runDirsOf(app.reportsDir)).toHaveLength(dirsBefore.length + 1);
      const budgetedResult = runDir(budgeted.runDir).result as RunResult;
      expect(budgetedResult.complete).toBe(false);
      expect(
        budgetedResult.results.map(({ item, ran }) => ({ item, ran })),
      ).toEqual([
        { item: { scenarioId: 'timeout-lowered' }, ran: true },
        { item: { scenarioId: 'ledger-write-errors' }, ran: false },
        { item: { scenarioId: 'no-cause' }, ran: false },
      ]);
      // The scenario that ran spent what the measured run spent, so only the judge's share tipped the remainder.
      expect(budgetedResult.results[0]!.runs[0]!.tokens).toBe(
        investigationTokens,
      );
    }, 600_000);

    // R4 (engine part, T5.4; AC-17.1, DC-14, UC-11): `run` measures `injectionInfluence` on the scenarios with text
    // addressed to the model through the real `Engine.assess` of its assembly, whose `assessModels` must hold the
    // `verifier` model (else every check fails `model_unavailable` and nothing is measured). `smoke` has no such
    // scenario, so the row runs `first` once per scenario. The scripted verifier answers `support: no` on a check that
    // holds an injection record of a swaying scenario, as usual otherwise: half of the injected scenarios sway.
    // Catches: a measure outside `Engine.assess` or without the verifier model; a check input whose records are not a
    // numbered data section, or whose numbers keep a gap after the injection records are dropped.
    it('INT-3 R4: the run measures injectionInfluence through the real Engine.assess with the verifier model in assessModels, and each check input carries the records as a numbered data section', async () => {
      app.models.reset();
      app.models.useSet('first');
      const loaded = loadScenarioSet('first');
      if (!loaded.ok) throw new Error(`set first: ${loaded.detail}`);
      const injected = loaded.set.scenarios
        .map(({ scenarioId }) => scenarioId)
        .filter(
          (scenarioId) =>
            app.models.keyOf(`first/${scenarioId}`).injectionTraceIds.length >
            0,
        );
      expect(injected.length).toBeGreaterThanOrEqual(2);
      const swaying = injected.slice(0, injected.length / 2);
      app.models.injectionSways(
        ...swaying.map((scenarioId) => `first/${scenarioId}`),
      );
      const thresholdsFile = join(
        await mkdtemp(join(tmpdir(), 'self-check-r4-')),
        'thresholds.json',
      );
      await writeFile(
        thresholdsFile,
        JSON.stringify({
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
        }),
        'utf8',
      );

      const outcome = await executeRunCommand(
        ['--set', 'first', '--runs', '1', '--thresholds', thresholdsFile],
        program,
      );

      if (!outcome.ok)
        throw new Error(`run refused: ${outcome.code} ${outcome.reason}`);
      const { result } = runDir(outcome.runDir);
      const firstResult = result as RunResult;
      // Every injected scenario is measured on its one pair; the swaying half changed the assessment.
      expect(
        firstResult.results.map(({ item, injection }) => [
          'scenarioId' in item ? item.scenarioId : null,
          injection,
        ]),
      ).toEqual(
        loaded.set.scenarios.map(({ scenarioId }) => [
          scenarioId,
          {
            measuredPairs: injected.includes(scenarioId) ? 1 : 0,
            influencedPairs: swaying.includes(scenarioId) ? 1 : 0,
            unassessedPairs: 0,
          },
        ]),
      );
      expect(firstResult.metrics.values.injectionInfluence).toBe(0.5);
      const report = readFileSync(
        join(outcome.runDir, 'report.md'),
        'utf8',
      ).split('\n');
      expect(
        report.find((line) => line.startsWith('| injectionInfluence |')),
      ).toMatch(/\| за пределом допустимого \|$/);

      // The checks: two verifier calls per injected scenario, bound to the run, on the verifier model of the configuration.
      const shipped = loadProcessConfig(deepResearchProcessV2);
      if (!shipped.ok) throw new Error('the shipped configuration is refused');
      const { verifier } = shipped.config.roles;
      const checks = (
        await transcriptsOf(url, {
          selfCheckRunId: `self-check:run:${firstResult.runId}`,
        })
      ).filter((transcript) => transcript.role === 'verifier');
      expect(checks).toHaveLength(injected.length * 2);
      const injectionTraceIds = new Set(
        injected.flatMap(
          (scenarioId) =>
            app.models.keyOf(`first/${scenarioId}`).injectionTraceIds,
        ),
      );
      const inputs = checks.map((transcript) => {
        expect(transcript).toMatchObject({
          model: verifier.model,
          outcome: 'answered',
          investigationId: null,
          llmCallId: null,
        });
        return checkInputOf(transcript);
      });
      for (const input of inputs) {
        expect(input.instructions).toBe(verifier.prompt);
        // A numbered data section: the claim with its atom check apart, then one JSON object per record numbered 0..n-1.
        expect(input.claim).toEqual({
          text: expect.any(String),
          atoms: expect.any(Array),
        });
        expect(input.records.map(({ number }) => number)).toEqual(
          input.records.map((_, index) => index),
        );
      }
      // Each pair's claim is checked once as it is, with the injection records, and once without them, on fewer records.
      // The pair is told by its claim text: the atom check beside it numbers the records of each call.
      const holdsInjection = (input: CheckInput) =>
        input.records.some(
          ({ traceId }) =>
            typeof traceId === 'string' && injectionTraceIds.has(traceId),
        );
      const textOf = (input: CheckInput) =>
        (input.claim as { text: string }).text;
      const claims = new Set(inputs.map(textOf));
      expect(claims.size).toBe(injected.length);
      for (const claim of claims) {
        const checksOfPair = inputs.filter((input) => textOf(input) === claim);
        const asIs = checksOfPair.filter(holdsInjection);
        const without = checksOfPair.filter((input) => !holdsInjection(input));
        expect([asIs.length, without.length]).toEqual([1, 1]);
        expect(without[0]!.records.length).toBeLessThan(
          asIs[0]!.records.length,
        );
      }
    }, 600_000);

    // ---- helpers of INT-3 -------------------------------------------------------------------------

    /** Investigations owned by `system:self-check` (KD-3). */
    async function ownedInvestigationIds(): Promise<string[]> {
      return (await investigationsOf(url, SELF_CHECK_OWNER)).map(
        (row) => row.investigationId,
      );
    }

    /** Steps, tokens and cost of a result row against the journal: accepted decisions and the call journal of the investigation. */
    async function expectJournalConsistent(entry: RunEntry): Promise<void> {
      const calls = await llmCallsOf(url, entry.investigationId);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call) => call.status === 'settled')).toBe(true);
      expect(entry.tokens).toBe(
        sum(calls.map((call) => call.chargedTokens ?? 0)),
      );
      expect(entry.costUsd).toBeCloseTo(
        sum(calls.map((call) => Number(call.costUsd ?? 0))),
        8,
      );
      expect(entry.steps).toBe(
        await acceptedDecisionsOf(url, entry.investigationId),
      );
      // No journal row of the judge: the journal holds the five process roles only, one transcript bound to each row.
      expect(new Set(calls.map((call) => call.role))).toEqual(
        new Set(['plan', 'controller', 'worker', 'verifier', 'synthesis']),
      );
      const transcripts = await transcriptsOf(url, {
        investigationId: entry.investigationId,
      });
      expect(
        new Set(
          transcripts
            .filter((transcript) => transcript.llmCallId !== null)
            .map((transcript) => transcript.llmCallId),
        ),
      ).toEqual(new Set(calls.map((call) => call.callId)));
      expect(transcripts.filter((t) => t.llmCallId !== null)).toHaveLength(
        calls.length,
      );
    }

    /** One judge transcript bound to the investigation, outside the journal, whose input is the question, the answer and the key only. */
    async function expectJudgeTranscript(
      entry: RunEntry,
      question: string,
    ): Promise<void> {
      const transcripts = await transcriptsOf(url, {
        investigationId: entry.investigationId,
      });
      const judge = transcripts.filter(
        (transcript) => transcript.role === 'judge',
      );
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
      // The answer goes as claim identifiers and texts: no evidence id, so no page and no log record reaches the judge (NFR-02).
      for (const claims of Object.values(input.answer)) {
        for (const claim of claims)
          expect(Object.keys(claim).sort()).toEqual(['claimId', 'text']);
      }
      const recordTraceIds = (
        await pagesOfInvestigation(url, entry.investigationId)
      ).flatMap((page) => page.traceIds);
      const sent = JSON.stringify(judge[0]!.input);
      expect(
        recordTraceIds.filter((traceId) => sent.includes(traceId)),
      ).toEqual([]);
    }
  });

  describe('INT-4', () => {
    // UC-5, UC-6, UC-E3 (the refusal half), UC-15. Table-driven over a saved employee investigation in the database the program shares, produced by the real engine on fixture `v1` through `Engine.startInvestigation`.
    //
    // Rows:
    //  R1 same slice. Given the finished investigation with the slice recorded in its run row at start (`research_engine_runs`). When `replay` runs it. Then: the replay is a new investigation of the owner `system:self-check`, remembering the original;
    //     its run row and its evidence pages hold the same slice as the original; the original's rows, answer and transcripts are unchanged (row-version snapshot of the employees' rows before and after).
    //  R2 another model in one role. Given the same investigation with the worker on `anthropic/claude-haiku-5-5`. When `replay` runs it with `anthropic/claude-sonnet-5-5` for the worker.
    //     Then: the worker transcripts of the replay name Sonnet; every other role's transcripts name the model of the original's frozen configuration.
    //  R3 refusals start nothing. (a) A legacy investigation: no recorded slice and no evidence pages. (b) A recorded slice that the running fixture does not serve. Then: (a) `replay_slice_unknown`, (b) `replay_slice_mismatch`;
    //     in both there is no new `system:self-check` investigation and the fixture received no tool call.
    //  R4 show. Given a finished employee investigation with three rejected controller decisions and a `step_limit` stop. When `show` opens it. Then: the report marks the signals "rejected decisions" and "stop reason" and lists the model calls in time order
    //     with their transcripts; the judge call without a key leaves its transcript bound to the run id of this `show` which remembers the original, and to no investigation; no employee row changed.
    //
    // AC: "Срез fixture записывается в строку прогона при старте каждого расследования" (AC-02.1); "перед повторным прогоном программа сверяет срез, который отдаёт запущенный fixture, со срезом исходного расследования; при расхождении — отказ" (DC-6);
    //     "повтор с другой моделью в одной роли" (AC-02.2); "Отчёт о ходе расследования показывает четыре сигнала сбоя ... все вызовы модели с их транскриптами" (AC-07.1, DC-15); "программа отказывает с причиной и не запускает ни одного расследования" (DC-5)
    // Behavior: `replay` / `show` -> read the original by owner, start or judge under `system:self-check` -> new investigation or report, original untouched
    // Catches: an investigation started without its slice recorded, so replay is impossible; a replay on other logs than the original saw; a replay whose roles ignore the frozen configuration or whose model swap leaks to other roles; a refusal that has already
    //          started an investigation; a judge transcript bound to the employee's investigation; any write to an employee's rows (invariant 5).
    // @category: integration
    // @dependency: self-check program (replay, show), engine (startInvestigation snapshot write, readTranscripts, readRunRecord, Engine.assess), mcp-fixture, runtime, Postgres, scripted models
    // @complexity: high
    //
    // Filled per the task text (plan rule 7), which wins over the comments above where they differ: R1-R4 here. The employee
    // investigation is made by the harness (`saveEmployeeInvestigation`) with the real engine and runtime over the database on fixture `v1`;
    // the scripted roles follow the script of `smoke/timeout-lowered` (records of the quarter hour before the change, the change stated as
    // established, so all five roles are called). Its frozen configuration is the shipped one with the controller on Haiku, so a replay that
    // lost it would show Sonnet there. R3 also refuses an original of another owner (`investigation_not_found`); the mismatch of (b) is a
    // fixture asked for `v1` that serves `v2` (`serveInstead`). Every row checks the row versions of the employees' rows before and after the command.
    // R4 shows the same original: the task text limits it to the reading of the employee's investigation and the binding of the judge transcript (the signal
    // rules, rejected decisions and `step_limit` included, are proven by `signals.spec.ts`, and the scripted roles make no rejected decision): the
    // report lists the original's journal calls in time order with their transcripts, and the one judge transcript is
    // bound to the show run id and to no investigation.
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
      app.clock.timerDelay = (ms) => (ms === STATUS_POLL_MS ? 50 : ms);
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

    /** `replay` of the investigation by its owner, with the row versions of the employees' rows taken around it. */
    async function replay(
      investigation: EmployeeInvestigation,
      ...flags: string[]
    ) {
      const before = await employeeRowVersions(url);
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
      const after = await employeeRowVersions(url);
      return { outcome, employeesBefore: before, employeesAfter: after };
    }

    /** The one repeat of a replays run of one original, with its run and the result file. */
    function onlyRepeat(
      outcome: Awaited<ReturnType<typeof replay>>['outcome'],
    ) {
      if (!outcome.ok)
        throw new Error(`replay refused: ${outcome.code} ${outcome.reason}`);
      const result = runDir(outcome.runDir).result as RunResult;
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.runs).toHaveLength(1);
      return { result, repeat: result.results[0]!.runs[0]! };
    }

    it("INT-4 R1: the replay of an employee investigation is a new self-check investigation that remembers the original and runs on the slice recorded at its start; the employee's rows are unchanged", async () => {
      // Given: the slice was recorded in the original's run row at start, and its pages were read at that slice.
      expect(
        (await engineRunOf(url, original.investigationId))!.sourceSnapshots,
      ).toEqual({ fixture: V1_SLICE });
      const originalPages = await pagesOfInvestigation(
        url,
        original.investigationId,
      );
      expect(originalPages.length).toBeGreaterThan(0);
      expect(new Set(originalPages.map((page) => page.snapshot))).toEqual(
        new Set([V1_SLICE]),
      );

      const { outcome, employeesBefore, employeesAfter } = await replay(
        original,
        '--runs',
        '1',
      );
      const { result, repeat } = onlyRepeat(outcome);

      expect(result).toMatchObject({
        kind: 'replays',
        items: {
          kind: 'investigations',
          investigations: [{ investigationId: original.investigationId }],
        },
        config: { choice: 'frozen' },
      });
      // A new investigation of the self-check owner, in the copy conversation of the original, with its question.
      expect(repeat.investigationId).not.toBe(original.investigationId);
      const [row] = (await investigationsOf(url, SELF_CHECK_OWNER)).filter(
        (investigation) =>
          investigation.investigationId === repeat.investigationId,
      );
      expect(row).toMatchObject({
        threadId: formatThreadId({
          kind: 'copy',
          investigationId: original.investigationId,
        }),
        query: EMPLOYEE_QUESTION,
      });
      // The repeat saw what the original saw: the same slice in its run row and on every page it read.
      expect(
        (await engineRunOf(url, repeat.investigationId))!.sourceSnapshots,
      ).toEqual({ fixture: V1_SLICE });
      const repeatPages = await pagesOfInvestigation(
        url,
        repeat.investigationId,
      );
      expect(repeatPages.length).toBeGreaterThan(0);
      expect(new Set(repeatPages.map((page) => page.snapshot))).toEqual(
        new Set([V1_SLICE]),
      );
      // The original is untouched (invariant 5).
      expect(employeesBefore.size).toBeGreaterThan(0);
      expect(employeesAfter).toEqual(employeesBefore);
    }, 600_000);

    it('INT-4 R2: a replay with Sonnet for the worker calls the worker on Sonnet and every other role on the model of the frozen configuration', async () => {
      const { outcome, employeesBefore, employeesAfter } = await replay(
        original,
        '--runs',
        '1',
        '--role-model',
        `worker=${SONNET}`,
      );
      const { result, repeat } = onlyRepeat(outcome);

      expect(result.config).toMatchObject({
        choice: 'frozen',
        roles: {
          plan: { model: SONNET },
          controller: { model: HAIKU },
          worker: { model: SONNET },
          verifier: { model: HAIKU },
          synthesis: { model: SONNET },
        },
      });
      // What the roles were called with, read from the repeat's transcripts.
      const transcripts = await transcriptsOf(url, {
        investigationId: repeat.investigationId,
      });
      const modelsByRole = new Map<string, Set<string>>();
      for (const { role, model } of transcripts) {
        modelsByRole.set(
          role,
          (modelsByRole.get(role) ?? new Set()).add(model),
        );
      }
      expect(Object.fromEntries(modelsByRole)).toEqual({
        plan: new Set([SONNET]),
        controller: new Set([HAIKU]),
        worker: new Set([SONNET]),
        verifier: new Set([HAIKU]),
        synthesis: new Set([SONNET]),
        judge: new Set([JUDGE_MODEL]),
      });
      expect(employeesAfter).toEqual(employeesBefore);
    }, 600_000);

    it.each([
      {
        row: 'R3 (a) a legacy investigation: no recorded slice and no evidence page',
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
        row: 'R3 (b) a recorded slice the running fixture does not serve',
        code: 'replay_slice_mismatch',
        given: () => {
          app.serveInstead('v1', 'v2');
          return Promise.resolve(original);
        },
      },
      {
        row: 'R3 an investigation of another owner',
        code: 'investigation_not_found',
        given: () =>
          Promise.resolve({ ...original, resourceId: `e2e-${randomUUID()}` }),
      },
    ])(
      'INT-4 $row: replay refuses with $code and starts nothing',
      async ({ code, given }) => {
        try {
          const investigation = await given();
          const ownedBefore = await ownedInvestigationIds(url);
          const callsBefore = app.readCallLog().length;
          const runDirsBefore = runDirsOf(app.reportsDir);

          const { outcome, employeesBefore, employeesAfter } = await replay(
            investigation,
            '--runs',
            '1',
          );

          expect(outcome).toMatchObject({ ok: false, code });
          // Nothing started: no investigation of `system:self-check`, no tool call on the fixture, no run directory.
          expect(await ownedInvestigationIds(url)).toEqual(ownedBefore);
          expect(app.readCallLog()).toHaveLength(callsBefore);
          expect(runDirsOf(app.reportsDir)).toEqual(runDirsBefore);
          expect(employeesAfter).toEqual(employeesBefore);
        } finally {
          app.serveInstead('v1', null);
        }
      },
      600_000,
    );

    it("INT-4 R4: show reads a saved employee investigation and binds the judge transcript to the show run, not to the employee's investigation", async () => {
      const ownedBefore = await ownedInvestigationIds(url);
      const runDirsBefore = runDirsOf(app.reportsDir);
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
      // The show run remembers the original.
      expect(parseThreadId(outcome.showRunId)).toMatchObject({
        kind: 'show',
        investigationId: original.investigationId,
      });
      // The course of the original: every journal call, by time then by id (the time as the report carries it), each
      // with its transcript.
      const ledger = (await llmCallsOf(url, original.investigationId)).sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.callId.localeCompare(right.callId),
      );
      expect(ledger.length).toBeGreaterThan(0);
      expect(reportedCallIds(outcome.report)).toEqual(
        ledger.map((call) => call.callId),
      );
      expect(
        new Set(
          (
            await transcriptsOf(url, {
              investigationId: original.investigationId,
            })
          ).map((transcript) => transcript.callId),
        ),
      ).toEqual(new Set(ledger.map((call) => call.callId)));
      // The one judge call without a key: its transcript is bound to this show run and to no investigation — not to the
      // employee's, whose rows the program does not write.
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
      // Show starts no investigation, writes no file and writes no employee row.
      expect(await ownedInvestigationIds(url)).toEqual(ownedBefore);
      expect(runDirsOf(app.reportsDir)).toEqual(runDirsBefore);
      expect(employeesAfter).toEqual(employeesBefore);
    }, 600_000);
  });

  describe('INT-5', () => {
    // UC-E7, UC-E9, UC-E10. Table-driven over what the program does before its first investigation and over the lifetime of employee data copies.
    //
    // Rows:
    //  R1 only the program's leftovers (UC-E7). Given an unfinished `system:self-check` investigation left by a dropped run and an employee's investigation `active` with its tasks queued; the runtime workers
    //     are off (`RUNTIME_WORKERS=off`). When the program cancels the leftovers, as `run` does before its first assembly. Then: the `system:self-check` investigation is cancelled; the employee's stays `active` with its tasks queued.
    //  R2 stale investigations. Given a previous program instance that was dropped without closing: its investigations have tasks queued and running. When `run` starts on another set.
    //     Then: before the first new investigation every earlier investigation is cancelled; no task of an earlier run is executed (the earlier run's scripted model records no call after the new start, and the fixture call log shows only the new scenario's calls).
    //  R3 expiring copies. Given a `replay` and a `show` of an employee investigation (a copy and a judge transcript of `system:self-check`) and a finished scenario run; then the employee's conversation is deleted. When the program starts again.
    //     Then: the replay investigation and the `show` judge transcript are gone; the scenario run and its transcripts remain (they are kept without a term).
    //
    // AC: "Программа самопроверки отменяет и удаляет только расследования владельца `system:self-check`; расследования сотрудников она не отменяет" (DC-17, UC-E7);
    //     "Перед первым расследованием команды `run` или `replay` программа отменяет все незаконченные расследования владельца `system:self-check`" (DC-18);
    //     "копии данных сотрудников удаляются при старте программы, если их оригинал удалён или старше срока хранения транскриптов" (AC-01.3, AC-01.4, DC-4)
    // Behavior: program start -> migrations, then expiry of copies; `run` -> cancel of the program's unfinished work before the first assembly -> a clean start for the next scenario, employees untouched
    // Catches: a cancel of leftovers that also cancels an employee's unfinished investigation; a task of a killed run executing on the fixture of the next scenario and corrupting its verdict; an employee's question and answer kept
    //          after the original is deleted. The owner filter and the cancel are observable only on a real database.
    // @category: edge-case
    // @dependency: self-check program (start-up), runtime (cancel), Postgres, mcp-fixture
    // @complexity: medium
    //
    // Filled per the task text (plan rule 7), which wins over the comments above where they differ: R1 calls the program's cancel of leftovers (what `run` does
    // before its first assembly) directly, since a `run` with workers would claim the employee's queued task: the launch condition of KD-3 is not met there. In R2 the earlier instance works on the first
    // scenario of the set `first` and is dropped without closing (`selfCheckApp`: its model calls stop answering, then its clock stops — no claim,
    // heartbeat, relay or reaper pass any more, leases run out); the new `run` goes on `smoke`, so the earlier run's tasks, pages and fixture calls are
    // told apart from the new ones by investigation and slice. R2 also checks on the real database that the waiter's `unfinishedTasks` counts a queued
    // task (left open by task-35). In R3 one program makes four kinds of copy: a replay and a show of an employee original that is then deleted, a show of
    // one whose creation is then moved past the term (31 days back, the default term 30), a show of a kept one, a show of a scenario run
    // (`system:self-check`), next to the scenario run itself; a second program starts on the same database, and the database is compared with before.

    it("INT-5 R1 (UC-E7): the cancel of leftovers cancels the unfinished system:self-check investigation and leaves the employee's active investigation and its queued tasks as they are", async () => {
      const url = await databases.create();
      // `RUNTIME_WORKERS=off`: no runtime of the test claims a task, so the employee's tasks stay queued.
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
        // The leftover of a dropped run: an investigation of the program started on an assembly that never ran it.
        const loaded = loadProcessConfig(deepResearchProcessV2);
        if (!loaded.ok) throw new Error('the shipped configuration is refused');
        const assembly = await program.assembleScenario({
          scenario: 'smoke/timeout-lowered',
          processConfig: deepResearchProcessV2,
        });
        const runId = randomUUID();
        const leftover = await assembly.engine.startInvestigation({
          resourceId: SELF_CHECK_OWNER,
          threadId: formatThreadId({ kind: 'run', runId }),
          query: app.models.keyOf('smoke/timeout-lowered').question,
          processId: loaded.config.processId,
          version: loaded.config.version,
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
        expect(
          await statusOf(employee.resourceId, employee.investigationId),
        ).toBe('active');
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
        // The employee's investigation and every row of it are as they were: still `active`, its tasks still queued.
        expect(
          await statusOf(employee.resourceId, employee.investigationId),
        ).toBe('active');
        expect(await employeeRowVersions(url)).toEqual(employeesBefore);
      } finally {
        await app.close();
      }
    }, 600_000);

    it('INT-5 R2: a run dropped mid-scenario leaves tasks queued and in work; the next run cancels them and drains them before its first investigation, and none of them runs again', async () => {
      const url = await databases.create();
      // The earlier instance: one slot, so its stuck task holds the slot and the rest stays queued; a short lease, so a
      // lease of the dropped instance runs out within seconds; no grace on the shutdown that releases it at the end.
      const earlier = createSelfCheckApp({
        databaseUrl: url,
        runtime: {
          concurrency: 1,
          leaseMs: 2_000,
          heartbeatMs: 500,
          shutdownGraceMs: 0,
        },
      });
      // The next run: its start-up reaps the dropped lease without waiting the default 5 seconds between passes.
      const next = createSelfCheckApp({
        databaseUrl: url,
        runtime: { reaperMs: 100 },
      });
      try {
        // ---- the earlier run on `first`, dropped without closing -------------------------------------------------
        earlier.models.useSet('first');
        const earlierProgram = await earlier.start();
        const loaded = loadProcessConfig(deepResearchProcessV2);
        if (!loaded.ok) throw new Error('the shipped configuration is refused');
        const assembly = await earlierProgram.assembleScenario({
          scenario: EARLIER_SCENARIO,
          processConfig: deepResearchProcessV2,
        });
        const runId = randomUUID();
        const earlierIds: string[] = [];
        for (let index = 0; index < 2; index += 1) {
          const start = await assembly.engine.startInvestigation({
            resourceId: SELF_CHECK_OWNER,
            threadId: formatThreadId({ kind: 'run', runId }),
            query: earlier.models.keyOf(EARLIER_SCENARIO).question,
            processId: loaded.config.processId,
            version: loaded.config.version,
            launchKey: `${runId}/${EARLIER_SCENARIO}/${index}`,
          });
          if (start.outcome === 'rejected')
            throw new Error(`earlier run ${index} refused: ${start.code}`);
          earlierIds.push(start.investigationId);
        }
        // It works on its fixture, then its provider stops answering: the task in the model call stays in work.
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
        // The waiter's count on the real database: queued, waiting and running tasks alike.
        expect(
          await scenarioWaiterPorts(assembly, earlier.clock).unfinishedTasks(
            earlierIds,
          ),
        ).toBe(leftover.length);
        const earlierModelCalls = earlier.models.calls.length;
        const earlierFixtureCalls = earlier.readCallLog().length;
        const earlierSlice = (await engineRunOf(url, earlierIds[0]!))!
          .sourceSnapshots as { fixture: string };

        // ---- the next run on `smoke` --------------------------------------------------------------------------------
        next.models.useSet('smoke');
        next.clock.timerDelay = (ms) => (ms === STATUS_POLL_MS ? 50 : ms);
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
          result.results.map(({ item, ran, runs }) => ({
            item,
            ran,
            verdicts: runs.map((entry) => entry.verdict?.verdict),
          })),
        ).toEqual([
          {
            item: { scenarioId: 'timeout-lowered' },
            ran: true,
            verdicts: ['passed'],
          },
          {
            item: { scenarioId: 'ledger-write-errors' },
            ran: true,
            verdicts: ['passed'],
          },
          { item: { scenarioId: 'no-cause' }, ran: true, verdicts: ['passed'] },
        ]);
        const nextIds = result.results.flatMap((item) =>
          item.runs.map((entry) => entry.investigationId),
        );

        // Every earlier investigation was cancelled; every task it had left ended `cancelled`, and none of its tasks
        // was claimed after the next run started.
        const owned = await investigationsOf(url, SELF_CHECK_OWNER);
        expect(
          owned
            .filter((row) => earlierIds.includes(row.investigationId))
            .map((row) => row.status),
        ).toEqual(['cancelled', 'cancelled']);
        const earlierTasks = await tasksOf(url, earlierIds);
        const leftoverIds = new Set(leftover.map((task) => task.taskId));
        expect(
          earlierTasks
            .filter((task) => leftoverIds.has(task.taskId))
            .map((task) => task.status),
        ).toEqual(leftover.map(() => 'cancelled'));
        expect(
          earlierTasks.filter(
            (task) =>
              task.startedAt !== null &&
              task.startedAt.getTime() >= nextStartedAt.getTime(),
          ),
        ).toEqual([]);

        // They were drained before the first new investigation: the last of them ended before the first task of the
        // next run started (both written from the runtimes' clocks, the system clock here).
        const nextTasks = await tasksOf(url, nextIds);
        expect(nextTasks.length).toBeGreaterThan(0);
        const lastLeftoverEnded = Math.max(
          ...earlierTasks
            .filter((task) => leftoverIds.has(task.taskId))
            .map((task) => task.finishedAt!.getTime()),
        );
        const firstNextStarted = Math.min(
          ...nextTasks.map((task) => task.startedAt!.getTime()),
        );
        expect(lastLeftoverEnded).toBeLessThanOrEqual(firstNextStarted);

        // The dropped instance did nothing more: no model call, no fixture call.
        expect(earlier.models.calls).toHaveLength(earlierModelCalls);
        expect(earlier.readCallLog()).toHaveLength(earlierFixtureCalls);
        // No task of the earlier run read the next run's fixture: its pages all carry the slice of its own scenario,
        // and every tool call the next run's fixtures received is one its own tasks counted.
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

    it('INT-5 R3: at the next start the copies of an employee original that is deleted or past the term are removed; copies of a kept original, of a self-check original and the scenario run stay', async () => {
      const url = await databases.create();
      const before = createSelfCheckApp({ databaseUrl: url });
      const restarted = createSelfCheckApp({ databaseUrl: url });
      try {
        // ---- copies made by one program: of a deleted original, of one past the term, of a kept one, of a scenario run
        before.models.useSet('smoke');
        before.scriptDatasetsAs(EMPLOYEE_SCRIPT);
        before.models.behave(EMPLOYEE_SCRIPT, {
          reads: 'before_change',
          statements: [{ statement: 'change', section: 'established' }],
        });
        before.clock.timerDelay = (ms) => (ms === STATUS_POLL_MS ? 50 : ms);
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

        // ---- the employee deletes one conversation; another original passes the term (30 days by default) --------
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
        // Each copy is there before the start: the repeat with its transcripts, one judge transcript per show.
        expect(investigationsBefore).toContainEqual({
          investigationId: repeatId,
          threadId: formatThreadId({
            kind: 'copy',
            investigationId: deleted.investigationId,
          }),
        });
        for (const showRunId of [
          deletedShow,
          agedShow,
          keptShow,
          selfCheckShow,
        ]) {
          expect(
            transcriptsBefore.filter(
              (transcript) => transcript.selfCheckRunId === showRunId,
            ),
          ).toHaveLength(1);
        }
        expect(
          transcriptsBefore.filter(
            (transcript) => transcript.investigationId === repeatId,
          ).length,
        ).toBeGreaterThan(0);
        const employeesBefore = await employeeRowVersions(url);

        // ---- the program starts again ---------------------------------------------------------------------------
        await restarted.start();
        // The common start runs for every command, `show` included: it starts no runtime worker on the shared database,
        // whose recovery sweeper would reap employees' tasks too (DC-17, DC-18).
        expect(
          restarted.logs.filter(([, message]) =>
            message.startsWith('Runtime workers started'),
          ),
        ).toEqual([]);

        // Gone: the repeat of the deleted original with all its rows, the show judge transcripts of the deleted and the
        // aged original. Everything else stays: the scenario run with its transcripts and judge checks, the show of the
        // kept original, the show of the self-check original.
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
        // The employees' investigations are only read.
        expect(await employeeRowVersions(url)).toEqual(employeesBefore);
      } finally {
        await restarted.close();
        await before.close();
      }
    }, 600_000);
  });
});

const HAIKU = 'anthropic/claude-haiku-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
/** The slice the fixture serves for the dataset `v1`. */
const V1_SLICE = generateGroundTruth('v1').snapshot;
/** The scenario whose script the scripted roles follow in the employee investigations of INT-4. */
const EMPLOYEE_SCRIPT = 'smoke/timeout-lowered';
const EMPLOYEE_QUESTION =
  'Почему после релиза выросло число таймаутов у провайдера платежей?';

/** The configuration as data with these roles on other catalog models. */
function withRoleModels(
  config: unknown,
  models: Readonly<Record<string, string>>,
): unknown {
  const data = config as { roles: Record<string, object> };
  return {
    ...data,
    roles: Object.fromEntries(
      Object.entries(data.roles).map(([role, settings]) => [
        role,
        models[role] === undefined
          ? settings
          : { ...settings, model: models[role] },
      ]),
    ),
  };
}

/**
 * The configuration frozen in the employee investigations of INT-4: the shipped one with the controller on Haiku, so
 * a replay on the shipped configuration instead of the frozen one is seen in the controller's transcripts.
 */
const FROZEN_CONFIG = withRoleModels(deepResearchProcessV2, {
  controller: HAIKU,
});

/** Investigations owned by `system:self-check` (KD-3), oldest first. */
async function ownedInvestigationIds(url: string): Promise<string[]> {
  return (await investigationsOf(url, SELF_CHECK_OWNER)).map(
    (row) => row.investigationId,
  );
}

/** The first scenario of the set `first` (`packages/mcp-fixture/scenario-sets/first.json`): the run INT-5 R2 drops. */
const EARLIER_SCENARIO = 'first/timeout-lowered-01';

/** Polls `condition` every 50 ms; throws naming `what` after `timeoutMs`. */
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

/** The number of tasks per status. */
function countByStatus(
  tasks: readonly { status: string }[],
): Partial<Record<string, number>> {
  const counts: Partial<Record<string, number>> = {};
  for (const { status } of tasks) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

// ---------------------------------------------------------------------------------------------------------------
// Read-only reads of the database that `selfCheckDb.ts` does not offer (tasks, decisions, evidence pages)
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

/** Every task of the investigations, as stored. */
function tasksOf(url: string, investigationIds: readonly string[]) {
  return db(url)
    .select()
    .from(researchTasks)
    .where(inArray(researchTasks.investigationId, [...investigationIds]));
}

/** Accepted controller decisions of the investigation: its steps. */
async function acceptedDecisionsOf(
  url: string,
  investigationId: string,
): Promise<number> {
  const rows = await db(url)
    .select({ decisionId: researchDecisions.decisionId })
    .from(researchDecisions)
    .where(
      and(
        eq(researchDecisions.investigationId, investigationId),
        eq(researchDecisions.status, 'accepted'),
      ),
    );
  return rows.length;
}

interface EvidencePage {
  readonly evidenceId: string;
  /** The slice of the source the page was read at (`provenance.snapshot`). */
  readonly snapshot: string;
  /** The `traceId` fields of the page's records. */
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

/** The evidence pages with these ids. */
function pagesOf(
  url: string,
  evidenceIds: readonly string[],
): Promise<EvidencePage[]> {
  return pagesWhere(
    url,
    inArray(researchEvidence.evidenceId, [...evidenceIds]),
  );
}

/** Every evidence page of the investigation. */
function pagesOfInvestigation(
  url: string,
  investigationId: string,
): Promise<EvidencePage[]> {
  return pagesWhere(url, eq(researchEvidence.investigationId, investigationId));
}

interface JudgeInput {
  readonly question: string;
  readonly answer: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly key: unknown;
}

interface CheckInput {
  readonly instructions: string;
  readonly claim: unknown;
  readonly records: readonly { number: number; traceId: unknown }[];
}

/**
 * The input of a verifier transcript as `buildClaimCheck` lays it out: one user message with the claim JSON in
 * `<claim>`, then `<data>` with one JSON line per page and one per record, each record with its number.
 */
function checkInputOf(transcript: TranscriptRow): CheckInput {
  const { instructions, messages } = transcript.input as {
    instructions: string;
    messages: { role: string; content: string }[];
  };
  expect(messages.map((message) => message.role)).toEqual(['user']);
  const lines = messages[0]!.content.split('\n');
  expect(lines[0]).toBe('<claim>');
  expect(lines[2]).toBe('</claim>');
  expect(lines[3]).toBe('<data>');
  expect(lines.at(-1)).toBe('</data>');
  const data = lines.slice(4, -1).map(
    (line) =>
      JSON.parse(line) as {
        page?: unknown;
        number?: number;
        record?: { traceId?: unknown };
      },
  );
  for (const line of data) {
    expect(Object.keys(line).sort()).toEqual(
      line.page === undefined ? ['number', 'record'] : ['page'],
    );
  }
  return {
    instructions,
    claim: JSON.parse(lines[1]!) as unknown,
    records: data.flatMap((line) =>
      line.number === undefined
        ? []
        : [{ number: line.number, traceId: line.record?.traceId }],
    ),
  };
}

/** The call ids a `show` report lists, in its order (`course-report.ts` writes one `- callId: <id>` line per call). */
function reportedCallIds(report: string): string[] {
  return [...report.matchAll(/^- callId: (\S+)$/gm)].map((match) => match[1]!);
}

/** Every investigation of the database with its conversation, by id. */
function allInvestigations(url: string) {
  return db(url)
    .select({
      investigationId: researchInvestigations.investigationId,
      threadId: researchInvestigations.threadId,
    })
    .from(researchInvestigations)
    .orderBy(researchInvestigations.investigationId);
}

/** Every transcript of the database with what it is bound to. */
function allTranscripts(url: string) {
  return db(url)
    .select({
      callId: researchLlmTranscripts.callId,
      investigationId: researchLlmTranscripts.investigationId,
      selfCheckRunId: researchLlmTranscripts.selfCheckRunId,
    })
    .from(researchLlmTranscripts);
}

/** The judge input of a judge transcript: the JSON of its one user message. */
function judgeInputOf(transcript: TranscriptRow): JudgeInput {
  const { messages } = transcript.input as {
    messages: { role: string; content: string }[];
  };
  expect(messages.map((message) => message.role)).toEqual(['user']);
  return JSON.parse(messages[0]!.content) as JudgeInput;
}

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

/** Calls as a sorted list of `role model`, to compare two records of the same calls. */
const sortedCalls = (
  calls: readonly { role: string; modelId: string }[],
): string[] => calls.map(({ role, modelId }) => `${role} ${modelId}`).sort();

// ---------------------------------------------------------------------------------------------------------------
// Proven at unit level (plan rule 7: the task text replaces the list the skeleton generated). One table-driven spec per rule, cases as rows.
// ---------------------------------------------------------------------------------------------------------------
// - Calibration pairs and judge checks (task 06): packages/mcp-fixture/src/scenarios/calibration-pairs.spec.ts, packages/mcp-fixture/src/scenarios/judge-checks.spec.ts
// - Judge forms and the form check (task 21): apps/api/src/self-check/judge/form-check.spec.ts
// - Verdict ladder (task 22): apps/api/src/self-check/verdict/verdict.spec.ts
// - First-error stage and per-role count (task 23): apps/api/src/self-check/verdict/first-error.spec.ts
// - Failure signals (task 24): apps/api/src/self-check/signals.spec.ts
// - Run metrics and the thresholds file (task 25): apps/api/src/self-check/metrics.spec.ts, apps/api/src/self-check/thresholds.spec.ts
