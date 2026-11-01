// deep-research / engine E2E Test Skeletons - Design Doc: docs/features/deep-research/design-engine.md
// PRD: docs/features/deep-research/prd.md v1.12 (FR-05, FR-06, FR-09, NFR-03). Verification Strategy of the runtime: "Correctness Proof Method", kill matrix (design-runtime.md).
// Generated: 2026-11-01 | Updated: 2026-11-01 for Design Doc v1.9 (KD-9, DC-19, UC-E12; AC-09.2 scoped to a connected source) | Part: engine
// Test type: End-to-End (real fixture process over stdio + built runtime and engine + real Postgres; scripted model), CI job `e2e-engine`
// Implementation timing: after all engine slices land (final phase only). E2E-2 needs the engine child entry and the engine crash points, which the plan adds with the controller slice
// (`engine.start.after-row` is added with the start slice, KD-9).
// Counterpart in-process file: deep-research-engine.int.e2e-spec.ts. The runtime's own kill matrix (research-runtime-runtime.e2e-spec.ts) proves the primitives; this file proves the engine on top of them.
//
// File name follows the project convention (`*.e2e-spec.ts` under packages/<pkg>/test, run by the package's e2e vitest config, which the plan adds with the package scaffold; no config is created here).
//
// Environment (Design Doc "Test Strategy", PRD scenario of the spec, section 15):
// - Postgres 16 from infra/docker-compose.yml. The real MCP fixture process (packages/mcp-fixture) with dataset slice `v1` (120 000 records; its ground truth read through `generateGroundTruth`), `FIXTURE_CALL_LOG` per test as the independent counter.
// - E2E-1 runs the runtime and the engine in the test process over the real `SourceRegistry` + `McpSourceClient`; E2E-2 runs the compiled engine child (`pnpm build && pnpm build:child`, as the runtime and sources packages do)
//   with `RUNTIME_CRASH_AT=<point>[:n]` (ignored when NODE_ENV=production), `RUNTIME_WORKERS=on`, short `RUNTIME_LEASE_MS`, `RUNTIME_REAPER_MS`, `RUNTIME_POLL_MS`.
// - The only double is the model boundary: a deterministic role-aware program behind `resolveModel` (no network, no API key). It builds claims and atoms from the fixture's ground truth, so the answer can be compared to a known truth.
//   Real Anthropic calls are never part of the suite.
// - Isolation (project convention, no truncate): a unique `resourceId = 'e2e-' + randomUUID()` per row; the file runs with `fileParallelism: false`.
// - Support to add with the package scaffold (not created here): test/support/engineChild.ts, engineChildMain.ts (modelled on packages/runtime/test/support/runtimeChild*.ts), test/support/engineDb.ts, fixture harness reuse from packages/sources/test/support/fixtureHarness.ts.
// - No latency assertions: "within the target" for recovery is the harness timeout of the wait for the end state.
//
// Budget: E2E 2 of 2. ROI uses the raw skill formula (Business Value x Frequency + Legal x 10 + Defect Detection) / (Create 10 + Execute 20 + Maintain 8 = 38); like the sibling parts, no E2E test reaches a ">50" threshold with it.
// Both stay because nothing at a lower level can prove them: the first needs a data volume that exceeds a real window across a real transport, the second needs a real process death and a second boot of the engine.
// E2E-2 is the first to drop if the budget has to shrink: its ACs then stay with INT-4 (zombie attempt) plus the runtime kill matrix; K3 is the exception, because the state it produces (the engine row written, no controller task)
// cannot be built in-process without faking a runtime component, so K3 stays as the one row of E2E-2.
// The no-source mode (PRD 1.12) adds no E2E test to this part: its investigation is proven in-process (INT-1 C7, INT-2 L6), and the real process boot without the fixture package is read in the chat-entry L1 scenario (L1-7).

import { researchEvents, researchTaskDependencies } from '@agent-os/db';
import { generateGroundTruth } from '@agent-os/mcp-fixture';
import { parseSourcesSettings } from '@agent-os/sources';
import { asc, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CRASH_EXIT_CODE, endStateOf, type RunRows, runScenario, type ScenarioRun } from './support/engineChild.js';
import { closeEngineDb, engineRowsOf, tasksOf } from './support/engineDb.js';
import { createEngineHarness, type EngineHarness } from './support/engineHarness.js';
import { FIXTURE_ALLOWLIST, type FixtureFiles, fixtureAdapter, fixtureFiles } from './support/fixtureHarness.js';
import { newLaunchKey, newUser } from './support/new-user.js';
import type { RecordedModelCall, ScriptedStep, ScriptedUsage } from './support/scriptedModel.js';

describe('deep-research / engine - E2E (real fixture, real Postgres, scripted model)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1  Data larger than any window: question over the 120 000-record slice ends in a sourced answer
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: a user asks a question whose answer lies in a log slice far larger than a model window -> the controller plans and collects pages -> three workers analyse three independent sub-questions in parallel,
  //   one of them "all matches" under a tool-call limit smaller than the page count -> claims are verified against source records -> synthesis delivers an answer whose every statement leads to evidence of this investigation.
  // Verification: end-to-end behaviour from question to sourced answer on real data volume, with the stages chained through the real runtime, source transport and tables.
  // Covers (original statements):
  // AC-05.1: "Given fixture-срез логов, объём которого больше окна модели (сценарий спецификации, раздел 15, research-runtime/prd.md, FR-21), When расследование по нему завершено, Then ни один вызов модели не превысил рабочего окна своей роли (FR-06), а ответ ссылается на evidence из этих данных."
  // AC-05.2: "Given контроллер раздал три независимых подвопроса, Then три воркера стартуют, не дожидаясь друг друга, и вход каждого содержит только его подвопрос и его материал, без истории контроллера и других воркеров."
  // AC-05.3: "Given подвопрос требует всех совпадений, Then воркер не объявляет охват полным, пока у источника остались страницы; при нехватке бюджета охват помечен неполным."
  // AC-09.2: "Given в развёртывании подключён хотя бы один источник данных, и ответ выдан, Then каждое его утверждение ведёт к evidence со всеми полями provenance." (observed on the real fixture evidence; the fixture is connected, so the run is in mode `sources`)
  // Use cases: UC-2, UC-3. Flow 1 (whole), Flow 3.
  //
  // Primary failure mode (turns red when): a stage works alone but breaks when chained on real data - a call's input exceeds its role's window on a real slice (the sum of 120 000 records is over 3.6M tokens, so any unpaged read overflows);
  // the "all matches" worker reports `complete` coverage while pages remain; a worker packet carries the controller history or another worker's evidence; the answer cites evidence that is not this investigation's or lacks provenance fields.
  // Behavior: question -> controller decisions (scripted) -> source.fetch tasks over the real fixture with paging -> three research.analyze tasks -> research.verify with source.fetch -> research.synthesize -> answer
  // @category: e2e
  // @dependency: full-system (runtime, engine, sources, mcp-fixture process, Postgres)
  // @complexity: high
  //
  // Verification items:
  // - Window (AC-05.1): over all rows of `research_llm_calls`, `actual input tokens <= windowTokens` of the row's role (configuration of the run) and the counted input is within `marginTokens` of the actual; the slice read is larger than the largest window
  // - Parallel workers (AC-05.2): the three `research.analyze` tasks have no dependency edge between them and all three have a `TaskStarted` event before the first `TaskSucceeded` among them; the scripted model recorded for each worker packet only that worker's sub-question and its own evidence ids
  // - Partial coverage (AC-05.3): the sub-question marked `all` with `maxToolCalls` below the page count -> its claims carry coverage `partial` and the worker never declares `complete`; the independent fixture call log has the same number of `tools/call` lines as the sum of `toolCallsUsed`
  // - Provenance and truth (AC-09.2): every `established` claim has `evidenceIds` that `EvidenceReader.get` resolves with the investigation's `resourceId`, with every provenance field present, and its atoms match the fixture ground truth for the slice; nothing outside `supported` is in `established`
  // - Outcome: controller task `succeeded` with an `answerId`; `usage` splits cost by role and the sum equals the charged total; `readInvestigation` shows `sourceMode` `sources` (the real fixture is connected: AC-09.2 is in force, no claim is marked as model knowledge)
  describe('E2E-1', () => {
    // The scenario: step 1 `requestAnalysis` of three sub-questions over the real fixture — A every provider timeout of the day after
    // the release (899 records in pages of 5: 180 pages against the 20 calls of a `source.fetch` task), B the first page of the whole
    // slice (500 records, more than the worker window: its worker must not call the model), C one affected trace; step 2
    // `requestVerification` of the claims of A and C; step 3 `proposeAnswer`; the synthesis cites the verified claims with their basis.
    // The double builds the claims from the slice's ground truth, read through `generateGroundTruth`.
    const truth = generateGroundTruth('v1');
    const DAY_AFTER_RELEASE = { from: '2026-09-15T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z' };
    const TIMEOUTS = { ...DAY_AFTER_RELEASE, service: 'provider-adapter', event: 'provider.timeout' };
    const ALL_TIMEOUTS = {
      text: 'E2E-1 A: how often did the provider adapter time out after the release?',
      sourceId: 'fixture',
      toolName: 'search_logs',
      args: { ...TIMEOUTS, pageSize: 5 },
      completeness: 'all',
    };
    const WHOLE_SLICE = {
      text: 'E2E-1 B: what does the whole slice hold?',
      sourceId: 'fixture',
      toolName: 'search_logs',
      args: { from: '2026-09-14T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z', pageSize: 500 },
      completeness: 'sample',
    };
    const ONE_TRACE = {
      text: 'E2E-1 C: what happened to the first affected trace?',
      sourceId: 'fixture',
      toolName: 'get_trace',
      args: { traceId: truth.affectedTraceIds[0] },
      completeness: 'sample',
    };
    const SUBQUESTIONS = [ALL_TIMEOUTS, WHOLE_SLICE, ONE_TRACE];
    const AGGREGATE_TIMEOUTS = { ...TIMEOUTS, groupBy: 'event', bucket: '1h' };
    /** Runtime settings of deep-research: the window of each role; its margin is 5 %. */
    const WINDOWS: Readonly<Record<string, number>> = { plan: 16_000, controller: 32_000, worker: 64_000, verifier: 32_000, synthesis: 48_000 };

    const claimOfA = {
      text: `After the release the provider adapter timed out ${truth.providerTimeouts.afterRelease} times`,
      atoms: [
        { kind: 'event', value: 'provider.timeout' },
        { kind: 'number', value: String(truth.providerTimeouts.afterRelease) },
      ],
      evidenceIds: [],
    };
    const claimOfC = {
      text: `Trace ${truth.affectedTraceIds[0]} got its provider reply late`,
      atoms: [
        { kind: 'traceId', value: truth.affectedTraceIds[0]! },
        { kind: 'service', value: truth.cause.service },
        { kind: 'event', value: 'provider.response' },
      ],
      evidenceIds: [],
    };

    /** The double reports the packet it got as the actual input: one token per character, as the harness counter counts. */
    const actual = (call: RecordedModelCall): ScriptedUsage => ({ inputTokens: call.system.length + call.user.length, outputTokens: 50 });

    /**
     * The worker's program: three workers run at once, so each answer follows the sub-question of the packet, not an order.
     * Any other worker call (B's, were its packet let through) answers without claims, so the window check is what sees it.
     */
    function worker(call: RecordedModelCall): ScriptedStep | undefined {
      if (call.role !== 'worker') return undefined;
      if (call.user.includes(ALL_TIMEOUTS.text)) return { output: { claims: [claimOfA] }, usage: actual };
      if (call.user.includes(ONE_TRACE.text)) return { output: { claims: [claimOfC] }, usage: actual };
      return { output: { claims: [] }, usage: actual };
    }

    let files: FixtureFiles;
    let harness: EngineHarness;

    beforeAll(async () => {
      files = fixtureFiles();
      const settings = parseSourcesSettings(files.env);
      harness = await createEngineHarness({
        // Three analyses, a gather and the controller may run at once.
        runtime: { concurrency: 5, dbPoolMax: 8 },
        source: { settings, allowlist: FIXTURE_ALLOWLIST, adapter: (logger) => fixtureAdapter(settings, logger) },
        model: { fallback: worker },
      });
    });

    afterAll(async () => {
      try {
        await harness?.close();
      } finally {
        files?.remove();
        await closeEngineDb();
      }
    });

    function latch() {
      let open!: () => void;
      const wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { wait, open: () => open() };
    }

    function until<T>(what: string, read: () => Promise<T | undefined>): Promise<T> {
      return vi.waitFor(
        async () => {
          const value = await read();
          if (value === undefined) throw new Error(`waiting for ${what}`);
          return value;
        },
        { timeout: 60_000, interval: 50 },
      );
    }

    it('E2E-1: a question over the 120 000-record slice ends in a sourced answer with no call above its window, parallel isolated workers, partial coverage under the call limit, and provenance on every established claim', async () => {
      // The reference values of the slice, against literals of the fixture's answer key.
      expect([truth.snapshot, truth.affectedTraceIds[0], truth.providerTimeouts.afterRelease]).toEqual(['fx-v1-2157485c', '2fc6e7867ffac751ec4b9011b0fe8942', 899]);
      // AC-05.2: each analysis waits at its start until all three have started; a serialised analysis never lets the others on.
      const allStarted = latch();
      let analysesStarted = 0;
      harness.handlerHold.at = async (point) => {
        if (point.at !== 'run' || point.workflowType !== 'research.analyze') return;
        analysesStarted += 1;
        if (analysesStarted === SUBQUESTIONS.length) allStarted.open();
        await allStarted.wait;
      };
      const analysed = latch();
      const verified = latch();
      const claimIds = { A: '', C: '' };
      const basis: { A: string[]; C: string[] } = { A: [], C: [] };
      harness.model.script('plan', { output: { readinessCriteria: ['the cause of the timeouts is named'], branches: [] }, usage: actual });
      harness.model.script(
        'controller',
        { output: { kind: 'requestAnalysis', rationale: 'split the question', subquestions: SUBQUESTIONS }, usage: actual },
        {
          output: () => ({ kind: 'requestVerification', rationale: 'check the claims', claimIds: [claimIds.A, claimIds.C] }),
          usage: actual,
          holdUntil: analysed.wait,
        },
        { output: { kind: 'proposeAnswer', rationale: 'both claims are verified' }, usage: actual, holdUntil: verified.wait },
      );
      harness.model.script('verifier', {
        output: () => ({
          requests: [
            { claimIds: [claimIds.A], sourceId: 'fixture', toolName: 'aggregate_logs', args: AGGREGATE_TIMEOUTS },
            { claimIds: [claimIds.C], sourceId: 'fixture', toolName: 'get_trace', args: ONE_TRACE.args },
          ],
        }),
        usage: actual,
      });
      harness.model.script('synthesis', {
        output: () => ({
          outcome: 'answered',
          summary: truth.cause.summary,
          claims: [
            { claimId: claimIds.A, text: claimOfA.text, atoms: claimOfA.atoms, evidenceIds: basis.A },
            { claimId: claimIds.C, text: claimOfC.text, atoms: claimOfC.atoms, evidenceIds: basis.C },
          ],
        }),
        usage: actual,
      });
      try {
        const resourceId = newUser();
        const threadId = await harness.createThread(resourceId);
        const started = await harness.engine.startInvestigation({
          resourceId,
          threadId,
          query: 'Why did provider timeouts rise after the release?',
          processId: 'deep-research',
          launchKey: newLaunchKey(),
        });
        if (started.outcome === 'rejected') throw new Error(`start refused: ${started.code}`);
        const { investigationId } = started;
        const subquestionOf = (task: { input: unknown }) => (task.input as { subquestion?: string }).subquestion;
        const analyses = await until('the analyses', async () => {
          const found = (await tasksOf(investigationId)).filter((task) => task.workflowType === 'research.analyze');
          return found.length === SUBQUESTIONS.length && found.every((task) => task.status === 'succeeded') ? found : undefined;
        });
        const analysisOf = (subquestion: { text: string }) => analyses.find((task) => subquestionOf(task) === subquestion.text)!;
        const workerClaims = (await engineRowsOf(investigationId)).claims;
        claimIds.A = workerClaims.find((row) => row.taskId === analysisOf(ALL_TIMEOUTS).taskId)!.claimId;
        claimIds.C = workerClaims.find((row) => row.taskId === analysisOf(ONE_TRACE).taskId)!.claimId;
        analysed.open();
        const verify = await until('the verification round', async () =>
          (await tasksOf(investigationId)).find((task) => task.workflowType === 'research.verify' && task.status === 'succeeded'),
        );
        const revisions = (await engineRowsOf(investigationId)).claims.filter((row) => row.taskId === verify.taskId);
        basis.A = revisions.find((row) => row.claimId === claimIds.A)!.evidenceIds;
        basis.C = revisions.find((row) => row.claimId === claimIds.C)!.evidenceIds;
        verified.open();
        const done = await until('the answer', async () => {
          const read = await harness.engine.readInvestigation({ investigationId, resourceId });
          return read.outcome === 'found' && read.view.status !== 'running' ? read.view : undefined;
        });

        const tasks = await tasksOf(investigationId);
        const { run, claims, llmCalls } = await engineRowsOf(investigationId);
        const [thread] = (await harness.runtime.investigations.listForThread(resourceId, threadId)).filter(
          (investigation) => investigation.investigationId === investigationId,
        );
        const coverageOf = (taskId: string) => thread?.tasks?.find((task) => task.taskId === taskId)?.coverage;
        const gatherOf = (subquestion: { text: string }) => (analysisOf(subquestion).input as { gatherTaskId: string }).gatherTaskId;
        const fetches = tasks.filter((task) => task.workflowType === 'source.fetch');

        // AC-05.1: no call above its role's window (the reference contract: worker 64 000), the counted input within the margin of the actual.
        expect(
          llmCalls.filter((row) => row.inputTokens! > WINDOWS[row.role]! || Math.abs(row.countedInputTokens - row.inputTokens!) > WINDOWS[row.role]! * 0.05),
        ).toEqual([]);
        expect(llmCalls.map((row) => row.role)).toEqual(['plan', 'controller', 'worker', 'worker', 'controller', 'verifier', 'controller', 'synthesis']);
        // The real read B is larger than the largest window: its worker called no model and asked to narrow (DC-7).
        expect(coverageOf(gatherOf(WHOLE_SLICE))).toMatchObject({ completeness: 'partial', totalMatched: 120_000, returned: 500, truncated: true });
        const narrowing = (analysisOf(WHOLE_SLICE).outcome as { answerOrDelta: { needsNarrowing: { materialTokens: number; limitTokens: number } } })
          .answerOrDelta.needsNarrowing;
        expect(narrowing.limitTokens).toBe(60_800);
        expect(narrowing.materialTokens).toBeGreaterThan(64_000);

        // AC-05.2: no edge between the analyses, each depends on its own gather only; all three started before any of them succeeded.
        const analysisIds = analyses.map((task) => task.taskId);
        const edges = await harness.db
          .select()
          .from(researchTaskDependencies)
          .where(inArray(researchTaskDependencies.taskId, analysisIds));
        expect(edges).toHaveLength(SUBQUESTIONS.length);
        expect(Object.fromEntries(edges.map((edge) => [edge.taskId, [edge.dependsOnTaskId, edge.kind]]))).toEqual(
          Object.fromEntries(SUBQUESTIONS.map((subquestion) => [analysisOf(subquestion).taskId, [gatherOf(subquestion), 'depends_on']])),
        );
        const events = await harness.db
          .select({ type: researchEvents.type })
          .from(researchEvents)
          .where(inArray(researchEvents.taskId, analysisIds))
          .orderBy(asc(researchEvents.seq));
        const lifecycle = events.map((event) => event.type).filter((type) => type === 'TaskStarted' || type === 'TaskSucceeded');
        expect(lifecycle.slice(0, 3)).toEqual(['TaskStarted', 'TaskStarted', 'TaskStarted']);
        // Each worker packet holds only its sub-question and the evidence of its own gather: no other sub-question, no controller input.
        const packetOf = (subquestion: { text: string }) => harness.model.callsOf('worker').filter((call) => call.user.includes(subquestion.text));
        expect(packetOf(WHOLE_SLICE)).toEqual([]);
        for (const subquestion of [ALL_TIMEOUTS, ONE_TRACE]) {
          const [packet, ...more] = packetOf(subquestion);
          expect(more).toEqual([]);
          const evidenceIds = [...packet!.user.matchAll(/<evidence id="([^"]+)">/g)].map((match) => match[1]);
          expect(evidenceIds).toEqual(tasks.find((task) => task.taskId === gatherOf(subquestion))!.outputRefs);
          expect(SUBQUESTIONS.filter((other) => packet!.user.includes(other.text))).toEqual([subquestion]);
          expect(packet!.user).not.toContain('<decision_input>');
        }

        // AC-05.3: the "all matches" gather spent its 20 calls with pages left, and its worker carried `partial`, never `complete`.
        const timeoutsGather = tasks.find((task) => task.taskId === gatherOf(ALL_TIMEOUTS))!;
        expect(timeoutsGather).toMatchObject({ status: 'succeeded', maxToolCalls: 20, toolCallsUsed: 20 });
        const partial = { completeness: 'partial', totalMatched: 899, totalRelation: 'eq', returned: 100, truncated: true };
        expect(coverageOf(timeoutsGather.taskId)).toMatchObject(partial);
        expect(coverageOf(analysisOf(ALL_TIMEOUTS).taskId)).toMatchObject(partial);
        expect(claims.find((row) => row.taskId === analysisOf(ALL_TIMEOUTS).taskId)!.coverage).toMatchObject(partial);
        // The independent counter: one fixture `tools/call` line per call the tasks counted — 20 for A, one each for B, C and the
        // two collections of the verification round.
        const counted = fetches.reduce((sum, task) => sum + task.toolCallsUsed, 0);
        expect(counted).toBe(24);
        expect(files.readCallLog()).toHaveLength(counted);

        // AC-09.2: the established claims are the verified ones; each resolves to fixture evidence of this investigation with all provenance fields.
        expect(done).toMatchObject({ status: 'completed', sourceMode: 'sources', answer: { outcome: 'answered', stopReason: null, summary: truth.cause.summary, assumed: [] } });
        expect(done.answer!.established).toEqual([
          { claimId: claimIds.A, text: claimOfA.text, evidenceIds: basis.A, verified: true },
          { claimId: claimIds.C, text: claimOfC.text, evidenceIds: basis.C, verified: true },
        ]);
        expect(revisions).toHaveLength(2);
        expect(Object.fromEntries(revisions.map((row) => [row.claimId, [row.status, row.atoms]]))).toEqual({
          [claimIds.A]: ['supported', claimOfA.atoms.map((atom) => ({ ...atom, verdict: 'found' }))],
          [claimIds.C]: ['supported', claimOfC.atoms.map((atom) => ({ ...atom, verdict: 'found' }))],
        });
        const own = new Set(tasks.map((task) => task.taskId));
        const provenance = async (evidenceIds: readonly string[]) =>
          Promise.all(
            evidenceIds.map(async (evidenceId) => {
              const { record } = await harness.runtime.evidence.get(evidenceId, resourceId);
              expect(own.has(record.taskId)).toBe(true);
              return record.provenance;
            }),
          );
        expect(basis.A.length).toBeGreaterThan(0);
        expect(await provenance(basis.A)).toEqual(
          basis.A.map(() => ({ sourceId: 'fixture', toolName: 'aggregate_logs', normalizedArgs: { ...AGGREGATE_TIMEOUTS, cursor: null }, snapshot: 'fx-v1-2157485c' })),
        );
        expect(basis.C.length).toBeGreaterThan(0);
        expect(await provenance(basis.C)).toEqual(
          basis.C.map(() => ({ sourceId: 'fixture', toolName: 'get_trace', normalizedArgs: { ...ONE_TRACE.args, cursor: null }, snapshot: 'fx-v1-2157485c' })),
        );

        // Outcome: the controller succeeded with the answer; usage by role sums to the charged total, no reservation is open.
        expect(tasks.find((task) => task.workflowType === 'research.controller')).toMatchObject({
          status: 'succeeded',
          outcome: { answerOrDelta: { answerId: done.answer!.answerId, outcome: 'answered' } },
        });
        expect(done.usage.byRoleAndModel.map((row) => [row.role, row.calls])).toEqual([
          ['plan', 1],
          ['controller', 3],
          ['worker', 2],
          ['verifier', 1],
          ['synthesis', 1],
        ]);
        expect(llmCalls.filter((row) => row.status !== 'settled')).toEqual([]);
        expect(llmCalls.reduce((sum, row) => sum + row.chargedTokens!, 0)).toBe(run!.tokensSpent);
        expect(done.usage).toMatchObject({ totalTokens: run!.tokensSpent });
        expect(run!.tokensReserved).toBe(0);
      } finally {
        harness.handlerHold.at = undefined;
        allStarted.open();
        analysed.open();
        verified.open();
        await harness.cancelStarted();
      }
    }, 120_000);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // E2E-2  Restart in the middle of a step or of a start: no lost step, no duplicate step or investigation, no unaccounted reservation
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: the engine process dies while an investigation is running - once right after the controller recorded its decision and before it proposed the tasks, once during a worker's model call,
  //   once at the start, after the investigation's engine row was written and before the controller task was proposed -
  //   the process is started again without the crash point, the start is repeated with the same launch key, and the investigation still ends in an answer, the user loses and repeats nothing.
  // Verification: process-level recovery of the engine on top of the runtime's recovery, across the model call, the guarded writes and the start.
  // Covers (original statements):
  // NFR-03 (PRD, Reliability): the restart of the process neither loses nor duplicates a step of the investigation.
  // AC-11.1: "Given завершённое расследование, Then сумма учтённых вызовов совпадает с расходом, списанным с бюджета (FR-07), и разбита по ролям и моделям." (after the restart)
  // DC-9 (FR-07): "Незакрытый резерв списывается целиком как abandoned: при следующей попытке задачи, когда контроллер видит задачу в конечном статусе, и при записи ответа."
  // DC-19 (NFR-03): "Повтор `startInvestigation` с тем же `launchKey` после сбоя на любом шаге старта оставляет у запуска одно расследование со строкой движка и задачей контроллера; оболочку прежнего сбоя он берёт, а не создаёт второе расследование." (second scenario of UC-E12: process killed after the engine row, before the controller task; the first scenario - a shell after `InvestigationService.create` - and the parallel starts are INT-1 C8)
  // Use cases: UC-E9 (first and second scenarios; the third is INT-4), UC-E12 (second scenario; the first and the third are INT-1 C8). Flow 1 (failure bullets "Гибель процесса после решения, но до propose" and "во время вызова модели"). KD-2, KD-9.
  //
  // Primary failure mode (turns red when): the decision of a step is written twice or its tasks are proposed twice after the restart (a duplicated or lost step); an investigation whose engine row exists but whose controller task was never proposed
  // is left idle after the repeated start, or the repeated start creates a second investigation next to it; an unfinished reservation stays `reserved` forever, or is not charged in full, so the ledger sum
  // differs from the charged total; the model answer already produced is lost and the call repeated and billed twice for the same step.
  // Behavior: kill at crash point -> the runtime reaper requeues the controller or worker task -> new attempt finds the recorded decision (or checkpointed answer) -> proposes/writes the same objects (propose answers `subscribed`) -> investigation completes
  // @category: e2e
  // @dependency: full-system (compiled engine child, runtime, sources, mcp-fixture process, Postgres, crash points)
  // @complexity: high
  //
  // Verification items (table of crash points; the end state of each is compared with an uninterrupted reference run of the same scripted investigation):
  // - K1 after the decision, before `propose` (first scenario): exactly one accepted `research_decisions` row for the step, the proposed tasks exist once (dedup key unique), the restarted controller's `propose` answers `subscribed`, final answer present
  // - K2 during a worker's model call (second scenario): the reservation of the killed call is `abandoned` and counted in full once the next attempt or the answer write closes it; `sum(research_llm_calls) === research_engine_runs.spent`; no `reserved` row remains after the end
  // - K3 at the start, after the engine row and before the controller task (UC-E12 second scenario, DC-19, KD-9): the child is killed at `engine.start.after-row`; after the restart the same `startInvestigation` (same `launchKey`) answers `existing`,
  //   proposes the controller task once, and the investigation reaches the answer; the thread has exactly one investigation of the user and one `research_engine_runs` row for the key; no shell is left next to it
  // - All rows: final statuses of all tasks as in the reference run; claim revisions are not duplicated; the fixture call log has no more `tools/call` lines than the reference run for the same keys
  describe('E2E-2', () => {
    // The scenario of every row, in the compiled child (support/engineChildMain.ts): plan; step 1 `requestAnalysis` of one sub-question over
    // one fixture page (a `source.fetch` and a `research.analyze` task); the worker states one claim; step 2 `proposeAnswer`; the synthesis
    // answers. The model double is a program of the call, not a queue, so a restarted child answers whatever call comes next.
    let reference: ScenarioRun;

    /** The uninterrupted run, as literals: what every killed run must end in. */
    const REFERENCE_END = {
      tasks: [
        ['research.controller', 'succeeded', null],
        ['source.fetch', 'succeeded', null],
        ['research.analyze', 'succeeded', null],
        ['research.synthesize', 'succeeded', null],
      ],
      decisions: [
        [1, 0, 'accepted', 'requestAnalysis', ['source.fetch', 'research.analyze']],
        [2, 0, 'accepted', 'proposeAnswer', ['research.synthesize']],
      ],
      planRevisions: 1,
      claims: [['research.analyze', 0, 'unverified', 'The provider adapter logged errors.']],
      answer: { outcome: 'inconclusive', stopReason: null },
      calls: [
        ['plan', 'settled'],
        ['controller', 'settled'],
        ['worker', 'settled'],
        ['controller', 'settled'],
        ['synthesis', 'settled'],
      ],
    };

    beforeAll(async () => {
      reference = await runScenario();
      expect(reference.firstExitCode).toBe(0);
      expect(endStateOf(reference.end)).toEqual(REFERENCE_END);
      // One fixture call (the one page of the sub-question), and a ledger the runs compare with: closed and spent.
      expect(reference.callLog).toHaveLength(1);
      expect(reference.callLog[0]).toMatch(/^search_logs /);
      expectLedgerClosed(reference.end);
      expect(reference.end.rows.run?.tokensSpent).toBeGreaterThan(0);
    }, 120_000);

    afterAll(async () => {
      await closeEngineDb();
    });

    /** AC-11.1 after the restart: no open reservation is left, and the ledger rows sum to the charged total. */
    function expectLedgerClosed({ rows }: RunRows) {
      expect(rows.llmCalls.filter((call) => call.status === 'reserved')).toEqual([]);
      expect(rows.run?.tokensReserved).toBe(0);
      expect(rows.llmCalls.reduce((sum, call) => sum + (call.chargedTokens ?? 0), 0)).toBe(rows.run?.tokensSpent);
    }

    /** The end equals the reference run's, with one investigation and one engine row for the launch and no extra source call. */
    function expectReferenceEnd(run: ScenarioRun) {
      expect(endStateOf(run.end)).toEqual(endStateOf(reference.end));
      expect([run.end.investigations, run.end.engineRuns]).toEqual([1, 1]);
      expect(run.callLog).toEqual(reference.callLog);
      expectLedgerClosed(run.end);
    }

    /** The reservation of the killed worker call (attempt 1) and the worker call of a later attempt, when there is one. */
    function workerCalls({ rows }: RunRows) {
      const worker = rows.llmCalls.filter((call) => call.role === 'worker');
      return { killed: worker.find((call) => call.attempt === 1), retried: worker.find((call) => call.attempt > 1) };
    }

    it('E2E-2 K1: a kill after the controller recorded its decision and before propose leaves one decision, one set of tasks and a finished investigation after the restart', async () => {
      // The second step-task proposal of the first child is the analysis: the decision is recorded and its gather task proposed.
      const run = await runScenario({ crashAt: 'before-propose:2' });

      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      expect(endStateOf(run.atKill!)).toMatchObject({
        tasks: [
          ['research.controller', 'running', null],
          ['source.fetch', 'queued', null],
        ],
        decisions: [[1, 0, 'accepted', 'requestAnalysis', []]],
      });
      // The restarted controller applies the recorded decision instead of taking the step again: the gather proposal is answered
      // `subscribed` and the analysis is created once; the repeated start subscribes to the live controller task.
      expect([...run.last.proposals].sort(([a], [b]) => a.localeCompare(b))).toEqual([
        ['research.analyze', 'created'],
        ['research.controller', 'subscribed'],
        ['research.synthesize', 'created'],
        ['source.fetch', 'subscribed'],
      ]);
      expect(run.last.started).toBe('existing');
      expectReferenceEnd(run);
    }, 120_000);

    it('E2E-2 K2: a kill during a worker model call closes the open reservation as abandoned, keeps the ledger sum equal to the charged total, and the investigation still ends in an answer', async () => {
      // (a) The runtime recovers the worker task: its next attempt closes the reservation of the killed call before its own call (DC-9,
      // first close point), and the investigation ends as the reference run.
      const recovered = await runScenario({ crashAt: 'worker-call:1' });

      expect(recovered.firstExitCode).toBe(CRASH_EXIT_CODE);
      expect(endStateOf(recovered.atKill!).tasks).toEqual([
        ['research.controller', 'waiting', null],
        ['source.fetch', 'succeeded', null],
        ['research.analyze', 'running', null],
      ]);
      expect(workerCalls(recovered.atKill!).killed).toMatchObject({ status: 'reserved', chargedTokens: null });
      expectReferenceEnd(recovered);
      const { killed, retried } = workerCalls(recovered.end);
      expect(killed).toMatchObject({ status: 'abandoned', chargedTokens: killed?.reservedTokens });
      expect(retried).toMatchObject({ status: 'settled' });
      expect(killed!.closedAt!.getTime()).toBeLessThanOrEqual(retried!.createdAt.getTime());

      // (b) No recovery is left (`RUNTIME_MAX_RECOVERIES=0` in the restarted child): the worker task fails `recovery_exhausted` without
      // another attempt, and the controller, seeing it in a final status, closes its reservation with its next decision (DC-9, second close
      // point) — in the transaction of that decision, before the answer would (third close point).
      const exhausted = await runScenario({ crashAt: 'worker-call:1', restartSettings: { RUNTIME_MAX_RECOVERIES: '0' } });

      expect(exhausted.firstExitCode).toBe(CRASH_EXIT_CODE);
      expect(endStateOf(exhausted.end)).toMatchObject({
        tasks: [
          ['research.controller', 'succeeded', null],
          ['source.fetch', 'succeeded', null],
          ['research.analyze', 'failed', 'recovery_exhausted'],
          ['research.synthesize', 'succeeded', null],
        ],
        decisions: [
          [1, 0, 'accepted', 'requestAnalysis', ['source.fetch', 'research.analyze']],
          [2, 0, 'accepted', 'proposeAnswer', ['research.synthesize']],
        ],
        claims: [],
        answer: { outcome: 'inconclusive', stopReason: null },
      });
      const { killed: abandoned, retried: none } = workerCalls(exhausted.end);
      expect(abandoned).toMatchObject({ status: 'abandoned', chargedTokens: abandoned?.reservedTokens });
      expect(none).toBeUndefined();
      const stepTwo = exhausted.end.rows.decisions.find((decision) => decision.step === 2);
      expect(abandoned!.closedAt).toEqual(stepTwo!.createdAt);
      expectLedgerClosed(exhausted.end);
    }, 240_000);

    it('E2E-2 K3: a kill after the engine row was written and before the controller task was proposed leaves one investigation after the restart, whose repeated start proposes the task once and reaches the answer', async () => {
      const run = await runScenario({ crashAt: 'engine.start.after-row' });

      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      // What the kill left: the investigation and its engine row, no controller task.
      expect(run.atKill).toMatchObject({ investigations: 1, engineRuns: 1, tasks: [], rows: { run: { controllerTaskId: null } } });
      // The repeated start finds the launch, answers `existing` and proposes the controller task once, which creates it.
      expect(run.last.started).toBe('existing');
      expect(run.last.proposals.filter(([workflowType]) => workflowType === 'research.controller')).toEqual([
        ['research.controller', 'created'],
      ]);
      expect(run.end.investigationId).toBe(run.atKill!.investigationId);
      expect(run.end.rows.run?.controllerTaskId).toBe(run.end.tasks[0]?.taskId);
      expectReferenceEnd(run);
    }, 120_000);
  });
});
