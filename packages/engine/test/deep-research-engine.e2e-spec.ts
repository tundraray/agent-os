// deep-research / engine E2E Test Skeletons - Design Doc: docs/features/deep-research/design-engine.md
// PRD: docs/features/deep-research/prd.md (FR-05, FR-06, FR-09, NFR-03). Verification Strategy of the runtime: "Correctness Proof Method", kill matrix (design-runtime.md).
// Generated: 2026-11-01 | Part: engine | Test type: End-to-End (real fixture process over stdio + built runtime and engine + real Postgres; scripted model), CI job `e2e-engine`
// Implementation timing: after all engine slices land (final phase only). E2E-2 needs the engine child entry and the engine crash points, which the plan adds with the controller slice.
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
// E2E-2 is the first to drop if the budget has to shrink: its ACs then stay with INT-4 (zombie attempt) plus the runtime kill matrix.

import { describe, it } from 'vitest';

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
  // AC-09.2: "Given выданный ответ, Then каждое его утверждение ведёт к evidence со всеми полями provenance." (observed on the real fixture evidence)
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
  // - Outcome: controller task `succeeded` with an `answerId`; `usage` splits cost by role and the sum equals the charged total
  describe('E2E-1', () => {
    it.todo('E2E-1: a question over the 120 000-record slice ends in a sourced answer with no call above its window, parallel isolated workers, partial coverage under the call limit, and provenance on every established claim');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // E2E-2  Restart in the middle of a step: no lost step, no duplicate step, no unaccounted reservation
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: the engine process dies while an investigation is running - once right after the controller recorded its decision and before it proposed the tasks, once during a worker's model call -
  //   the process is started again without the crash point and the investigation still ends in an answer, the user loses and repeats nothing.
  // Verification: process-level recovery of the engine on top of the runtime's recovery, across the model call and the guarded writes.
  // Covers (original statements):
  // NFR-03 (PRD, Reliability): the restart of the process neither loses nor duplicates a step of the investigation.
  // AC-11.1: "Given завершённое расследование, Then сумма учтённых вызовов совпадает с расходом, списанным с бюджета (FR-07), и разбита по ролям и моделям." (after the restart)
  // DC-9 (FR-07): "Незакрытый резерв списывается целиком как abandoned: при следующей попытке задачи, когда контроллер видит задачу в конечном статусе, и при записи ответа."
  // Use cases: UC-E9 (first and second scenarios; the third is INT-4). Flow 1 (failure bullets "Гибель процесса после решения, но до propose" and "во время вызова модели"). KD-2.
  //
  // Primary failure mode (turns red when): the decision of a step is written twice or its tasks are proposed twice after the restart (a duplicated or lost step); an unfinished reservation stays `reserved` forever, or is not charged in full, so the ledger sum
  // differs from the charged total; the model answer already produced is lost and the call repeated and billed twice for the same step.
  // Behavior: kill at crash point -> the runtime reaper requeues the controller or worker task -> new attempt finds the recorded decision (or checkpointed answer) -> proposes/writes the same objects (propose answers `subscribed`) -> investigation completes
  // @category: e2e
  // @dependency: full-system (compiled engine child, runtime, sources, mcp-fixture process, Postgres, crash points)
  // @complexity: high
  //
  // Verification items (table of crash points; the end state of each is compared with an uninterrupted reference run of the same scripted investigation):
  // - K1 after the decision, before `propose` (first scenario): exactly one accepted `research_decisions` row for the step, the proposed tasks exist once (dedup key unique), the restarted controller's `propose` answers `subscribed`, final answer present
  // - K2 during a worker's model call (second scenario): the reservation of the killed call is `abandoned` and counted in full once the next attempt or the answer write closes it; `sum(research_llm_calls) === research_engine_runs.spent`; no `reserved` row remains after the end
  // - Both rows: final statuses of all tasks as in the reference run; claim revisions are not duplicated; the fixture call log has no more `tools/call` lines than the reference run for the same keys
  describe('E2E-2', () => {
    it.todo('E2E-2 K1: a kill after the controller recorded its decision and before propose leaves one decision, one set of tasks and a finished investigation after the restart');
    it.todo('E2E-2 K2: a kill during a worker model call closes the open reservation as abandoned, keeps the ledger sum equal to the charged total, and the investigation still ends in an answer');
  });
});
