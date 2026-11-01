// deep-research / engine Integration Test Skeletons - Design Doc: docs/features/deep-research/design-engine.md
// PRD: docs/features/deep-research/prd.md v1.12 (FR-01..FR-12, FR-25, FR-26). ADRs: ADR-0001 (runtime owner), ADR-0003 (Drizzle data layer), ADR-0004 (engine package). UXRD: none (part without UI).
// Generated: 2026-11-01 | Updated: 2026-11-01 for the no-source mode (Design Doc v1.9: KD-8, KD-9, DC-16..DC-19, Flow 5, UC-11, UC-12, UC-E11, UC-E12) | Part: engine
// Test type: Integration (in-process runtime + engine + real Postgres, scripted model), CI job `e2e-engine`
// Implementation timing: created alongside the implementation slice that each test names (the controller loop, the token ledger, the claim lifecycle, the attempt guard).
//
// File name and placement. This follows the sibling runtime package (`research-runtime-runtime.int.e2e-spec.ts`), not the DB-free `*.int.spec.ts` of `packages/sources`:
// every engine write goes through `TaskContext.withAttemptGuard` into `research_*` tables of `@agent-os/db` (KD-3), so there is no in-memory form of an engine integration test.
// The pure rules are unit specs under `packages/engine/src/**/*.spec.ts` (default vitest run, CI `check`); see "Proven at unit level" at the end of this file.
// The file is picked up by the `test/**/*.e2e-spec.ts` glob of the package's e2e vitest config (to be added by the plan with the package scaffold; this file adds no config).
// The `.int.` infix separates these in-process tests from the process-level file `deep-research-engine.e2e-spec.ts` (final phase).
//
// Environment (Design Doc "Test Strategy", "Runtime settings"):
// - Postgres 16 from infra/docker-compose.yml, migrations applied once before the suite (the six `research_*` engine tables included). Real `createRuntime` and real `createEngine`
//   with its handlers (`research.controller`, `research.analyze`, `research.verify`, `research.synthesize`) and real `source.fetch`; no mock of Postgres or of a runtime/engine component.
// - Model boundary only: the `resolveModel` port returns a scripted language-model double keyed by role (the real Mastra `Agent`, `ContextBuilder`, `ModelGateway`, `DecisionGate` run over it).
//   The double records every packet it receives (for window and isolation checks) and scripts the structured output and the reported `usage`. `TokenCounter` is a deterministic double
//   with an injectable offset, so a divergence between counted and actual input can be forced (DC-13).
// - Source boundary: a `SourceRegistry` with one in-memory counting adapter allowed to `source.fetch` (the real fixture process is used only in the E2E file). The adapter's call counter
//   is the independent counter for "no source call". `createEngine` receives `connectedSources` = [that adapter's sourceId] by default (mode `sources`, DC-14 in force); the no-source rows (INT-1 C7, INT-2 L6)
//   pass `[]` (mode `model_knowledge`, KD-8) and C7 rebuilds the engine over the same database with the adapter connected. In those rows the model double records the role of every call, so "no controller, worker or verifier call" is read from it
//   and from `research_llm_calls`, and the counting adapter must stay at zero calls.
// - Isolation (project convention, no truncate): a unique `resourceId = 'e2e-' + randomUUID()` and a unique `launchKey` per test. The engine's handler types are fixed, so isolation by
//   `workflowType` is not available: this file runs with `fileParallelism: false`, owns the only runtime with engine handlers in the job, and each test waits for its own terminal status of `controllerTaskId`.
// - Clock, lease and backoff jitter are injected; `notAfter` and the lease are moved with the injected clock and by moving `lease_expires_at` back (as runtime INT-3 does). No sleeps for ordering.
// - Support to add with the package scaffold (not created here): test/support/engineHarness.ts (createDatabase + createRuntime + createEngine with a `connectedSources` option, a `rebuildEngine` over the same database,
//   scripted model, counting source, clock, a `seedShell` helper that calls the real `InvestigationService.create` for INT-1 C8),
//   test/support/engineDb.ts (read-only snapshots of `research_*` rows and a row-version snapshot for "no row changed" checks).
//
// Budget: Integration 4 (limit 3; up to 5 under the integration-e2e-testing rule only when each extra test names the defect no other test catches).
//   INT-1..INT-3 are the core budget. INT-4 is the one extra; its unique defect is stated at its header. Table-driven rows keep the ACs of one rule or one flow in one test.
//   The no-source mode (PRD 1.12) adds rows to these tests, not tests: INT-1 C7 and C8, INT-2 L6, assertions in INT-3 V1 and V2. The count stays 4 of 5 and the extra slot is still INT-4 only.
//
// Proven elsewhere (not in this file; see "Proven at unit level" at the end and the plan's traceability table "AC -> proving test"):
// - process-level: AC-05.1, AC-05.2, AC-05.3 (UC-2, UC-3), NFR-03 / DC-9 on a killed process (UC-E9 first two scenarios), DC-19 second scenario of UC-E12 (the engine row written, the controller task not yet proposed) - deep-research-engine.e2e-spec.ts
// - AC-26.1 (the service starts without the fixture package, `connectedSources` is empty in the composition root): the api composition, not this package - extends apps/api/test/sources-wiring.e2e-spec.ts (named for the plan; that file is not part of
//   this skeleton set); the part-level half (chat accepts messages and launches research without a source check) is apps/api/test/deep-research-chat-entry.int.e2e-spec.ts INT-1 A6
// - AC-26.2, AC-26.3 (exactly one start warning without sources, none with one): unit, loader table (see "Proven at unit level"); the real log of a booted process is read by hand in the L1 scenario of the chat-entry part (L1-7)
// - runtime port TaskContext.withAttemptGuard (design-runtime.md UC-E9 and variants): packages/runtime/test/research-runtime-runtime.int.e2e-spec.ts, INT-3 R8..R10
// - the runtime primitives the engine builds on (admission/dedup, wait/wake, fencing of putEvidence/saveCheckpoint, cancel, deadline): runtime and mcp-source suites, not repeated here

import { randomUUID } from 'node:crypto';
import { deepResearchProcessV1, type InvestigationView, type StartInvestigationResult, type TokenCountRequest } from '@agent-os/engine';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { COUNTING_SOURCE_ID } from './support/countingSource.js';
import { closeEngineDb, engineRowsOf, engineRunsOf, rowVersionsOf, tasksOf } from './support/engineDb.js';
import { createEngineHarness, type EngineHarness, type HandlerPoint, TEST_NOTE_KIND } from './support/engineHarness.js';
import { newLaunchKey, newUser } from './support/new-user.js';
import type { RecordedModelCall, ScriptedUsage } from './support/scriptedModel.js';

/** What a scripted step reports: fixed, or following the packet the double received. */
type StepUsage = ScriptedUsage | ((call: RecordedModelCall) => ScriptedUsage);
import {
  SECOND_CONFIG_MARKER,
  TEST_PROCESSES,
  VERSIONED_PROCESS_ID,
  versionedConfig,
  versionMarker,
} from './support/test-configs.js';

/** A worker packet: the output schema of the `worker` role is the one with `claims`. */
function isWorkerRequest(request: TokenCountRequest): boolean {
  const properties = (request.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  return 'claims' in properties;
}

/** A gate a test opens once; waiting on an open gate goes on at once. */
function latch() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open() };
}

/** Lets callers on in groups of `size`: each waits until `size` callers have arrived. */
function barrier(size: number) {
  let waiting: (() => void)[] = [];
  return {
    arrive(): Promise<void> {
      return new Promise((resolve) => {
        waiting.push(resolve);
        if (waiting.length === size) {
          for (const release of waiting) release();
          waiting = [];
        }
      });
    },
  };
}

describe('deep-research / engine - integration (in-process runtime + engine + real Postgres, scripted model)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  Controller loop: only accepted decisions create tasks, every stop ends in an answer built by code, a deployment without sources runs plan and synthesis only, and a retried start keeps one investigation
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-01.1: "Given на двух расследованиях контроллер выдаёт разные цепочки решений (сразу ответ; сбор → проверка → перестройка плана → сбор → ответ), Then в каждом исполняются ровно выбранные возможности в выбранном порядке и ни одной без решения контроллера."
  // AC-01.2: "Given контроллер выдал решение вне закрытого набора или с невалидной структурой, Then оно не порождает ни одной задачи и ни одного вызова источника, а отказ записан в ходе расследования."
  // AC-01.3: "Given контроллер раз за разом выдаёт недопустимые решения и исчерпал лимит повторов, Then расследование завершается с причиной «контроллер не дал допустимого решения», а пользователь получает ответ по уже проверенному материалу с исходом по правилу принудительной остановки (FR-09)."
  // AC-02.1: "Given найдено противоречие текущей гипотезе и контроллер перестроил план, Then у расследования новая ревизия плана, evidence прежней ревизии доступно новой, а тот же запрос с тем же срезом не вызывает источник повторно."
  // AC-03.2: "Given достигнут лимит шагов контроллера, Then расследование завершается ответом с причиной «лимит шагов» и исходом по правилу принудительной остановки (FR-09)."
  // AC-04.1: "Given для расследования записан внешний сигнал, When контроллер принимает следующее решение, Then сигнал входит в его вход, а запись решения на него ссылается."
  // AC-10.1: "Given настройка назначает большую модель контроллеру, а остальным ролям — модель класса Haiku, Then учёт вызовов показывает, что каждый вызов сделан моделью своей роли."
  // AC-12.1: "Given вторая тестовая конфигурация с другой целью, другим набором возможностей и другими промптами, When по ней запущено расследование, Then оно исполняется без изменения кода движка, а контроллер выбирает только из возможностей этой конфигурации."
  // DC-1 (FR-01): "Решение, чья возможность не включена в конфигурации, отклоняется так же, как решение вне набора."
  // DC-2 (FR-01): "После первого недопустимого решения шага контроллер вызывается повторно не больше maxDecisionRetries раз, всего maxDecisionRetries + 1 вызовов на шаг, и каждый отказ записан с причиной."
  // DC-3 (FR-01): "Когда наступает notAfter, задача анализа, проверки или синтеза проваливается с классом deadline, а контроллер — при пробуждении, перед своим вызовом или после прерванного вызова — останавливает расследование с причиной deadline и ответом кодом."
  // DC-4 (FR-02): "одинаковый запрос с тем же срезом всегда даёт тот же ключ дедупликации."
  // DC-5 (FR-04): "Сигнал незарегистрированного вида или с payload не по схеме своего вида не записывается, и вызывающий получает отказ."
  // DC-8 (FR-06): "Когда обязательная часть входа контроллера не помещается в его окно, модель не вызывается, и расследование останавливается с причиной context_overflow и ответом кодом."
  // DC-15 (FR-12): "Создание движка отклоняет повтор пары processId и version, а разные версии одного процесса загружаются рядом. Старт без версии берёт наибольшую загруженную, и расследование до конца исполняется на версии, с которой стартовало." (here: the recorded-version half; the loader and resolution half is a unit spec, see "Proven at unit level")
  // AC-25.1: "Given в развёртывании не подключён ни один источник данных, When расследование завершено, Then каждое утверждение ответа помечено как взятое из знаний модели без источника, и ни одно не ссылается на evidence."
  // AC-25.2 (engine half): "Given ответ расследования в режиме без источников, Then он ... имеет исход `answered`, и ни одно утверждение не выдано как установленное." (the warning that opens the answer is chat-entry, MC-32)
  // AC-25.4: "Given режим без источников, When расследование завершено, Then учёт вызовов (FR-11) показывает вызовы только постановки и плана и синтеза, а вызовов воркера, проверяющего и источников нет."
  // DC-16 (FR-25): "Режим расследования определяет список подключённых источников в момент старта, и до конца расследования он не меняется, в том числе после рестарта с другим набором источников."
  // DC-17 (FR-25): "В режиме без источников утверждение черновика синтеза со ссылкой на evidence удаляется с причиной `evidence_not_found`, а синтез без единого утверждения даёт исход `inconclusive`." (here: the wiring half; the rule table is a unit test)
  // DC-19 (NFR-03): "Повтор `startInvestigation` с тем же `launchKey` после сбоя на любом шаге старта оставляет у запуска одно расследование со строкой движка и задачей контроллера; оболочку прежнего сбоя он берёт, а не создаёт второе расследование." (here: shell taken and two parallel starts; the kill between the engine row and the controller task is E2E-2 K3)
  // Use cases: UC-1, UC-4, UC-5, UC-9, UC-10 (recorded-version half), UC-11, UC-E1, UC-E4 (deadline scenario), UC-E6 (controller scenario), UC-E12 (first and third scenarios). Flow 1 (first half), Flow 2, Flow 5. KD-8, KD-9, Invariants 8 and 10.
  //
  // Primary failure mode (turns red when): a rejected decision still proposes a task or calls the source; a step is executed twice or without a decision row; a decision's task is
  // not the capability it chose; a stop condition ends the controller task as `failed` without an answer; a replan with the same query calls the source again;
  // an investigation that survives an engine rebuild runs its next steps on the prompts of a newer loaded version instead of its recorded one (the frozen copy in `research_engine_runs` is not what the handlers read);
  // an investigation started without sources calls the controller model, a worker or the source anyway, or its claims reach `established` or keep an evidence reference, or it switches to `sources` when the engine is rebuilt with a source connected
  // (the mode is read from the live `connectedSources` instead of the recorded `sourceMode`); a repeated start with the same `launchKey` after a failed start leaves two investigations in the thread, or leaves an untaken shell next to the new one,
  // or two parallel starts both keep their investigation.
  // Behavior: scripted controller output -> DecisionGate verdict -> research_decisions row (accepted or refused with reason) -> tasks proposed through TaskScheduler (or none) -> runtime wakes the controller
  //   -> after the last step, or at any stop condition, one answer row built from the verified claims with the stop reason;
  //   without sources: the controller task, after the `plan` role, accepts `proposeAnswer` by code, proposes `research.synthesize` and waits -> synthesis claims go to `assumed` -> one answer row
  // @category: core-functionality
  // @dependency: ControllerHandler, ContextBuilder, ModelGateway, DecisionGate, CapabilityRegistry, TaskScheduler (runtime), InvestigationService (runtime), source.fetch, research_decisions, research_signals, research_engine_runs, Postgres
  // @complexity: high
  //
  // Verification items (table of scenarios; each row names the AC it proves and shares the harness):
  // - C1 two decision chains (UC-1, AC-01.1, AC-10.1): investigation A scripted [proposeAnswer], investigation B scripted [requestEvidence, requestVerification, replan, requestEvidence, proposeAnswer] ->
  //   task types per investigation are exactly gather/verify/gather(+their sources)/synthesize in the chosen order, each task row refers to its decision row, no task without a decision;
  //   every `research_llm_calls` row carries the model of its role (controller on the large model, worker/verifier on the small one)
  // - C2 second configuration (UC-9, AC-12.1, DC-1): a test ProcessConfig with another goal, no `verify` and no `analyze`, other prompt text and another `windowTokens`; the scripted controller offers `requestVerification` ->
  //   refused with a reason, zero tasks of that kind; the packets the double received carry this configuration's prompt text and fit its `windowTokens`; the investigation ends in an answer without code changes
  // - C3 replan does not re-collect (UC-4, AC-02.1, DC-4): gather F, then `replan`, then the same request with the same snapshot and another `rationale` text -> two plan revisions, the second `propose` answers `subscribed`,
  //   the counting source adapter saw exactly one call, the evidence of the first revision is readable by the second
  // - C4 signals reach the decision (UC-5, AC-04.1, DC-5): two recorded signals (kind `test.note` and a kind registered only in this test) are in the next DecisionInput the double received and the decision row lists their `signalId`;
  //   `recordSignal` with an unknown kind -> `signal_kind_unknown`, with a payload off its kind's schema -> `signal_payload_invalid`, with another user's `resourceId` -> `investigation_not_found`; `research_signals` has exactly the two rows
  // - C5 forced stops end in a code-built answer (one row per reason; each asserts: reason in the answer, outcome `partial` if a supported claim exists else `inconclusive`, controller task `succeeded` with that `answerId`, the double got no call after the stop): One case per reason; each reason's row is the comment above its case.
  // - C6 recorded version survives an engine rebuild (UC-10, DC-15; unique defect: reading the live configuration list instead of the frozen copy, which only a persisted row and a second `createEngine` over the same database can show):
  //   engine built with versions 1 and 2 of one `processId` (different prompt text); investigation A started without a version, investigation B with version 1, both parked mid-run -> `readInvestigation` shows version 2 for A and 1 for B;
  //   the runtime is stopped and the engine rebuilt over the same database with versions 1, 2 and 3 -> both investigations reach an answer, the packets the double received for each carry the prompt text of its recorded version (A: 2, B: 1),
  //   and a new investigation started without a version records version 3. Which version a start picks and the duplicate-pair rejection are not repeated here: they are the loader spec
  // - C7 no-source mode (UC-11, AC-25.1, AC-25.2 engine half, AC-25.4, DC-16, DC-17 wiring; unique defect: a controller or worker call, a source call or an evidence reference in a deployment without sources, and a mode read from the live
  //   `connectedSources` instead of the recorded row, which only a persisted `sourceMode` and a second `createEngine` over the same database can show): engine built with `connectedSources: []`; the double is scripted with a plan revision
  //   and a synthesis draft of three claims, one of them citing an evidence id -> investigation A: `readInvestigation` shows `sourceMode` `model_knowledge`, outcome `answered`, two claims in `assumed` with empty `evidenceIds` and `verified` false,
  //   the third in `removed` with `evidence_not_found`, `established` empty; the synthesis packet carries the field `sourceMode` = `model_knowledge`; `research_llm_calls` has rows of the roles `plan` and `synthesis` only and the model double
  //   received no call of any other role; the investigation has no task of type `source.fetch`, `research.analyze` or `research.verify`; `research_decisions` holds exactly one accepted decision, `proposeAnswer`, and no refusal; the counting adapter
  //   has zero calls; the controller task is `succeeded` with the `answerId`; the ledger sum equals `research_engine_runs.spent`. Investigation B, started in the same engine and parked before its synthesis, then the engine is rebuilt over the same
  //   database with the adapter connected: B reaches its answer with `sourceMode` `model_knowledge` and still zero source calls, and a new investigation C started in the rebuilt engine records `sourceMode` `sources`
  //   (the claim-by-claim rule table of the gateway, the code-built answers and the configuration without `plan` or `synthesize` are unit tests, see "Proven at unit level")
  // - C8 start retry takes the shell, and a parallel start keeps one investigation (UC-E12 first and third scenarios, DC-19, KD-9; unique defect: `startInvestigation` creating a second investigation when a retry follows a failure between
  //   `InvestigationService.create` and the engine row, and two starts with one `launchKey` both keeping theirs, which only the real unique indexes and the real runtime show). The state a kill between the two writes leaves is exactly what `create`
  //   commits in its own transaction, so it is seeded with the real `InvestigationService.create` (same thread, owner, `query`, `maxTasks`, `maxToolCalls`) and no engine row; a second shell with another `query` is seeded beside it:
  //   (a) `startInvestigation` with launchKey L -> `created`, the returned `investigationId` is the matching shell, `InvestigationService.listForThread` shows the thread with two investigations only (that shell and the unmatched one, which is untouched and not
  //   cancelled), one engine row for L, one controller task, and the investigation reaches an answer; a repeated start with L -> `existing`, `propose` answers `subscribed`, no new row or task
  //   (b) two parallel `startInvestigation` calls with one launchKey and no shell -> both return the same `investigationId`, one engine row and one controller task exist, the investigation the loser created is `cancelled` with no task and no spend
  //   (the kill between the engine row and the controller task cannot be produced without faking a runtime component: it is E2E-2 K3; the shell-matching predicate is a unit test)
  // - Rows never re-check the variants of DecisionGate / config validation / admissible computation: one refused kind per wiring row proves the link, the rule table is a unit test
  describe('INT-1', () => {
    let harness: EngineHarness;

    beforeAll(async () => {
      harness = await createEngineHarness({ processes: TEST_PROCESSES });
    });

    afterAll(async () => {
      await harness?.close();
      await closeEngineDb();
    });

    beforeEach(() => {
      harness.model.reset();
      harness.countingSource.calls.length = 0;
    });

    afterEach(async () => {
      try {
        // A step left in the script means the test scripted a call that never happened.
        expect(harness.model.pending()).toEqual({ plan: 0, controller: 0, worker: 0, verifier: 0, synthesis: 0 });
      } finally {
        // A test that failed midway leaves no active investigation for the next one to run into.
        await harness.cancelStarted();
      }
    });

    const conclude = { output: { kind: 'concludeInconclusive', rationale: 'scripted conclusion' } };

    function created(result: StartInvestigationResult) {
      if (result.outcome === 'rejected') throw new Error(`start refused: ${result.code}`);
      return result;
    }

    async function view(investigationId: string, resourceId: string): Promise<InvestigationView> {
      const read = await harness.engine.readInvestigation({ investigationId, resourceId });
      if (read.outcome !== 'found') throw new Error(`investigation ${investigationId} not found`);
      return read.view;
    }

    /** Waits for the terminal status of the investigation's controller task (rule 9: each test waits for its own). */
    function finished(investigationId: string, resourceId: string): Promise<InvestigationView> {
      return vi.waitFor(
        async () => {
          const current = await view(investigationId, resourceId);
          if (current.status === 'running') throw new Error(`investigation ${investigationId} is still running`);
          return current;
        },
        { timeout: 20_000, interval: 50 },
      );
    }

    /** Contract «Завершение расследования»: the controller task succeeded with the answer's `answerId` and `outcome`. */
    async function expectControllerSucceededWith(investigationId: string, answer: InvestigationView['answer']) {
      const [controller, ...others] = await tasksOf(investigationId);
      expect(others).toEqual([]);
      expect(controller).toMatchObject({
        workflowType: 'research.controller',
        status: 'succeeded',
        outcome: { answerOrDelta: { answerId: answer?.answerId, outcome: answer?.outcome } },
      });
    }

    // C1 also deletes the conversation at the end (unique defect: an engine table whose FK to the investigation does not cascade
    //   blocks `InvestigationService.purgeThread`, which only real rows of all six tables show): after the purge no engine row is left.
    it('INT-1 C1: two scripted decision chains execute exactly the chosen capabilities in the chosen order, each task traces to a decision, and every model call is made by its role\'s model', async () => {
      const SONNET = 'anthropic/claude-sonnet-5-5';
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);
      harness.countingSource.answerWith((call) => [{ service: call.args.service, level: 'error', message: 'refund declined' }]);
      const answerFromDraft = { output: { outcome: 'answered', summary: 'C1 answer', claims: [] } };
      const gather = (service: string, rationale: string) => ({
        output: { kind: 'requestEvidence', rationale, sourceId: 'fixture', toolName: 'search_logs', args: { service }, completeness: 'all' },
      });
      const propose = { output: { kind: 'proposeAnswer', rationale: 'enough to answer' } };
      const run = async (query: string) => {
        const { investigationId } = created(
          await harness.engine.startInvestigation({ resourceId, threadId, query, processId: 'deep-research', launchKey: newLaunchKey() }),
        );
        const done = await finished(investigationId, resourceId);
        expect(done).toMatchObject({ status: 'completed', answer: { outcome: 'inconclusive', stopReason: null } });
        return { investigationId, done, tasks: await tasksOf(investigationId), rows: await engineRowsOf(investigationId) };
      };

      // A: the answer at once.
      harness.model.script('controller', propose);
      harness.model.script('synthesis', answerFromDraft);
      const a = await run('C1 A: why were the refunds declined?');
      const callsA = harness.model.calls.map((call) => [call.role, call.modelId]);
      harness.model.calls.length = 0;
      // B: gather -> verify -> replan -> gather -> answer.
      harness.model.script(
        'controller',
        gather('payments', 'collect the payment errors'),
        { output: { kind: 'requestVerification', rationale: 'check the claim', claimIds: [randomUUID()] } },
        { output: { kind: 'replan', rationale: 'the errors point elsewhere', reason: 'the refunds service declines them' } },
        gather('refunds', 'collect the refund errors'),
        propose,
      );
      harness.model.script('synthesis', answerFromDraft);
      const b = await run('C1 B: why were the refunds declined?');
      const callsB = harness.model.calls.map((call) => [call.role, call.modelId]);

      // Exactly the chosen capabilities in the chosen order, each task named by its decision and none without one.
      for (const { tasks, rows } of [a, b]) {
        const [controller, ...decided] = tasks;
        expect(controller).toMatchObject({ workflowType: 'research.controller', status: 'succeeded' });
        expect(rows.decisions.flatMap((row) => row.proposedTaskIds)).toEqual(decided.map((task) => task.taskId));
      }
      expect(a.tasks.map((task) => [task.workflowType, task.status])).toEqual([
        ['research.controller', 'succeeded'],
        ['research.synthesize', 'succeeded'],
      ]);
      expect(a.rows.decisions.map((row) => [row.step, row.status, row.kind, row.proposedTaskIds])).toEqual([
        [1, 'accepted', 'proposeAnswer', [a.tasks[1]!.taskId]],
      ]);
      const [, fetchPayments, verify, fetchRefunds, synthesize] = b.tasks;
      expect(b.tasks.map((task) => [task.workflowType, task.status])).toEqual([
        ['research.controller', 'succeeded'],
        ['source.fetch', 'succeeded'],
        ['research.verify', 'succeeded'],
        ['source.fetch', 'succeeded'],
        ['research.synthesize', 'succeeded'],
      ]);
      expect(b.rows.decisions.map((row) => [row.step, row.status, row.kind, row.planRevision, row.proposedTaskIds])).toEqual([
        [1, 'accepted', 'requestEvidence', 1, [fetchPayments!.taskId]],
        [2, 'accepted', 'requestVerification', 1, [verify!.taskId]],
        [3, 'accepted', 'replan', 1, []],
        [4, 'accepted', 'requestEvidence', 2, [fetchRefunds!.taskId]],
        [5, 'accepted', 'proposeAnswer', 2, [synthesize!.taskId]],
      ]);
      expect(harness.countingSource.calls.map((call) => call.args)).toEqual([{ service: 'payments' }, { service: 'refunds' }]);
      // AC-10.1: the model double was called with the model of each call's role, and the ledger and the view record it.
      expect(callsA).toEqual([['plan', SONNET], ['controller', SONNET], ['synthesis', SONNET]]);
      expect(callsB).toEqual([
        ['plan', SONNET], ['controller', SONNET], ['controller', SONNET], ['controller', SONNET],
        ['plan', SONNET], ['controller', SONNET], ['controller', SONNET], ['synthesis', SONNET],
      ]);
      expect(a.rows.llmCalls.map((row) => [row.role, row.model, row.status])).toEqual(callsA.map((call) => [...call, 'settled']));
      expect(b.rows.llmCalls.map((row) => [row.role, row.model, row.status])).toEqual(callsB.map((call) => [...call, 'settled']));
      expect(b.done.usage.byRoleAndModel.map((row) => [row.role, row.model, row.calls])).toEqual([
        ['plan', SONNET, 2],
        ['controller', SONNET, 5],
        ['synthesis', SONNET, 1],
      ]);

      // The conversation is deleted: the runtime's purge cascades through the engine tables (a signal row included; neither
      // chain writes a claim).
      const signal = await harness.engine.recordSignal({ investigationId: b.investigationId, resourceId, kind: 'test.note', payload: { note: 'C1' } });
      expect(signal.outcome).toBe('recorded');
      await harness.purgeThread(resourceId, threadId);
      for (const { investigationId } of [a, b]) {
        expect(await engineRowsOf(investigationId)).toEqual({
          run: undefined,
          planRevisions: [],
          decisions: [],
          signals: [],
          claims: [],
          llmCalls: [],
        });
        expect(await tasksOf(investigationId)).toEqual([]);
      }
    }, 30_000);
    it('INT-1 C2: a second configuration without verify and analyze refuses requestVerification, builds packets from its own prompts and windows, and ends in an answer without code changes', async () => {
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);
      harness.model.script(
        'controller',
        { output: { kind: 'requestVerification', rationale: 'check the claim', claimIds: [randomUUID()] } },
        conclude,
      );

      const { investigationId } = created(
        await harness.engine.startInvestigation({
          resourceId,
          threadId,
          query: 'C2: what failed in the checkout incident?',
          processId: 'incident-summary',
          launchKey: newLaunchKey(),
        }),
      );
      const done = await finished(investigationId, resourceId);

      expect(done).toMatchObject({
        status: 'completed',
        processId: 'incident-summary',
        version: 1,
        answer: { outcome: 'inconclusive', stopReason: null, established: [] },
      });
      const { decisions } = await engineRowsOf(investigationId);
      expect(decisions.map((row) => [row.step, row.callIndex, row.status, row.kind, row.rejectionReason])).toEqual([
        [1, 0, 'rejected', 'requestVerification', 'capability_disabled'],
        [1, 1, 'accepted', 'concludeInconclusive', null],
      ]);
      await expectControllerSucceededWith(investigationId, done.answer);
      // The packets carry this configuration's prompts and fit its windows (one counted token per character).
      const calls = harness.model.calls;
      expect(calls.map((call) => call.role)).toEqual(['plan', 'controller', 'controller']);
      for (const call of calls) {
        expect(call.system).toContain(SECOND_CONFIG_MARKER);
      }
      const plan = calls[0]!;
      expect(plan.system.length + plan.user.length).toBeLessThanOrEqual(5_000);
      for (const call of calls.slice(1)) {
        expect(call.system.length + call.user.length).toBeLessThanOrEqual(6_000);
        // The controller chooses only from this configuration's decisions: no verify, no analyze, nothing to wait for.
        expect(call.user).toContain('"admissible":["requestEvidence","replan","proposeAnswer","concludeInconclusive"]');
      }
    });
    it('INT-1 C3: replan with the same request and snapshot but another rationale creates a second plan revision and no second source call (propose answers subscribed)', async () => {
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);
      harness.countingSource.answerWith(() => [{ service: 'payments', level: 'error', message: 'connection reset by peer' }]);
      const gather = { kind: 'requestEvidence', sourceId: 'fixture', toolName: 'search_logs', completeness: 'all' };
      harness.model.script(
        'controller',
        { output: { ...gather, rationale: 'collect the payment errors first', args: { service: 'payments', level: 'error' } } },
        { output: { kind: 'replan', rationale: 'the errors contradict the deploy branch', reason: 'the restart is not a deploy' } },
        // The same request in the new revision: another rationale, the arguments in another key order.
        { output: { ...gather, rationale: 'the new plan needs the same errors', args: { level: 'error', service: 'payments' } } },
        conclude,
      );

      const { investigationId } = created(
        await harness.engine.startInvestigation({
          resourceId,
          threadId,
          query: 'C3: why did the payment service restart?',
          processId: 'deep-research',
          launchKey: newLaunchKey(),
        }),
      );
      const done = await finished(investigationId, resourceId);

      expect(done.answer).toMatchObject({ outcome: 'inconclusive', stopReason: null, established: [] });
      const { decisions, planRevisions } = await engineRowsOf(investigationId);
      expect(planRevisions.map((row) => [row.revision, row.reason])).toEqual([
        [1, null],
        [2, 'the restart is not a deploy'],
      ]);
      const [controller, fetch, ...others] = await tasksOf(investigationId);
      expect(others).toEqual([]);
      expect(controller).toMatchObject({ workflowType: 'research.controller', status: 'succeeded' });
      // One gather task, pinned to the source's snapshot, with the source.fetch budget and the time left until notAfter.
      expect(fetch).toMatchObject({
        workflowType: 'source.fetch',
        status: 'succeeded',
        input: { sourceId: 'fixture', toolName: 'search_logs', args: { level: 'error', service: 'payments' } },
        inputRefs: [{ kind: 'source', ref: 'fixture', snapshot: 'counting-v1' }],
        maxToolCalls: 20,
        maxRetries: 3,
      });
      const notAfter = controller!.deadlineAt!.getTime() - 120_000;
      expect(fetch!.deadlineMs).toBeGreaterThanOrEqual(Math.floor(notAfter - fetch!.createdAt.getTime()) - 1);
      expect(fetch!.deadlineMs).toBeLessThanOrEqual(notAfter - controller!.startedAt!.getTime());
      // The second proposal of the same request was answered `subscribed`: both decisions name the one task.
      expect(decisions.map((row) => [row.step, row.status, row.kind, row.planRevision, row.proposedTaskIds])).toEqual([
        [1, 'accepted', 'requestEvidence', 1, [fetch!.taskId]],
        [2, 'accepted', 'replan', 1, []],
        [3, 'accepted', 'requestEvidence', 2, [fetch!.taskId]],
        [4, 'accepted', 'concludeInconclusive', 2, []],
      ]);
      expect(harness.countingSource.calls).toEqual([
        { toolName: 'search_logs', args: { level: 'error', service: 'payments' }, cursor: null },
      ]);
      // The evidence collected under revision 1 is what revision 2 decides on: its next decision input carries that task.
      expect(fetch!.outputRefs).toHaveLength(1);
      const controllerCalls = harness.model.callsOf('controller');
      expect(controllerCalls).toHaveLength(4);
      expect(controllerCalls[3]!.user).toContain('"revision":2');
      expect(controllerCalls[3]!.user).toContain(fetch!.taskId);
      expect(harness.model.calls.map((call) => call.role)).toEqual([
        'plan', 'controller', 'controller', 'plan', 'controller', 'controller',
      ]);
    });
    it('INT-1 C4: recorded signals appear in the next decision input and are referenced by the decision row; unknown kind, off-schema payload and another owner are refused and write nothing', async () => {
      // A kind registered only in this test: an entry in the options, the controller code is the same (AC-04.2).
      const alertKind = { kind: 'test.alert', payloadSchema: z.object({ severity: z.enum(['low', 'high']) }) };
      await harness.rebuildEngine({ signalKinds: [TEST_NOTE_KIND, alertKind] });
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);
      // The controller is parked in its first call; the signals arrive before the decision taken after the restart.
      harness.model.script('controller', { hangUntilAborted: true });

      const { investigationId } = created(
        await harness.engine.startInvestigation({
          resourceId,
          threadId,
          query: 'C4: did the rollback stop the errors?',
          processId: 'deep-research',
          launchKey: newLaunchKey(),
        }),
      );
      await vi.waitFor(() => expect(harness.model.callsOf('controller')).toHaveLength(1), { timeout: 20_000 });
      expect(harness.model.callsOf('controller')[0]!.user).toContain('"signals":[]');

      const record = (kind: string, payload: unknown, owner = resourceId) =>
        harness.engine.recordSignal({ investigationId, resourceId: owner, kind, payload });
      const note = await record('test.note', { note: 'the deploy was rolled back at 12:05' });
      const alert = await record('test.alert', { severity: 'high' });
      if (note.outcome !== 'recorded' || alert.outcome !== 'recorded') throw new Error('a valid signal was refused');
      // DC-5: refusals are told apart and write no row.
      expect([
        await record('test.unknown', { note: 'x' }),
        await record('test.alert', { severity: 'urgent' }),
        await record('test.note', { note: 'not mine' }, newUser()),
      ]).toEqual([
        { outcome: 'rejected', code: 'signal_kind_unknown' },
        { outcome: 'rejected', code: 'signal_payload_invalid' },
        { outcome: 'rejected', code: 'investigation_not_found' },
      ]);
      expect((await engineRowsOf(investigationId)).signals.map((row) => [row.signalId, row.readByDecisionId])).toEqual([
        [note.signalId, null],
        [alert.signalId, null],
      ]);

      harness.model.script('controller', conclude);
      // No fence: the parked controller resumes on the new workers and takes its step with the signals.
      // Back to the default kinds: test.alert stays registered only for the first half of this test.
      await harness.rebuildEngine({ signalKinds: [TEST_NOTE_KIND] }, { fence: false });
      const done = await finished(investigationId, resourceId);

      expect(done.answer).toMatchObject({ outcome: 'inconclusive', stopReason: null });
      const controllerCalls = harness.model.callsOf('controller');
      expect(controllerCalls).toHaveLength(2);
      const input = controllerCalls[1]!.user;
      expect(input).toContain(
        `{"signalId":"${note.signalId}","kind":"test.note","recordedAt":`,
      );
      expect(input).toContain('"payload":{"note":"the deploy was rolled back at 12:05"}');
      expect(input).toContain(`{"signalId":"${alert.signalId}","kind":"test.alert","recordedAt":`);
      expect(input).toContain('"payload":{"severity":"high"}');
      const { decisions, signals } = await engineRowsOf(investigationId);
      expect(decisions.map((row) => [row.step, row.callIndex, row.status, row.kind])).toEqual([
        [1, 0, 'accepted', 'concludeInconclusive'],
      ]);
      // AC-04.1: the decision row is the one that read both signals; the refused attempts left no row.
      expect(signals.map((row) => [row.signalId, row.kind, row.readByDecisionId])).toEqual([
        [note.signalId, 'test.note', decisions[0]!.decisionId],
        [alert.signalId, 'test.alert', decisions[0]!.decisionId],
      ]);
    });
    // C5 controller_invalid (UC-E1, AC-01.2, AC-01.3, DC-2): decision outside the set, then an invalid structure, then outside the set with `maxDecisionRetries` 2 -> exactly 3 controller calls for the step, 3 refusals recorded with their reasons, zero tasks, zero source calls
    it('INT-1 C5 controller_invalid: invalid decisions of a step create no task and no source call, each refusal is recorded with its reason, and the investigation ends with a code-built answer', async () => {
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);
      const query = 'C5 controller_invalid: why did the payment service restart?';
      harness.model.script(
        'controller',
        { output: { kind: 'deleteEverything', rationale: 'outside the closed set' } },
        { output: { kind: 'concludeInconclusive', rationale: 'x'.repeat(2_001) } },
        { output: { kind: 'summariseLogs', rationale: 'outside the closed set again' } },
      );

      const { investigationId } = created(
        await harness.engine.startInvestigation({
          resourceId,
          threadId,
          query,
          processId: 'deep-research',
          launchKey: newLaunchKey(),
        }),
      );
      const done = await finished(investigationId, resourceId);

      expect(done.answer).toMatchObject({ outcome: 'inconclusive', stopReason: 'controller_invalid', established: [] });
      const { decisions, llmCalls } = await engineRowsOf(investigationId);
      expect(decisions.map((row) => [row.step, row.callIndex, row.status, row.kind, row.rejectionReason])).toEqual([
        [1, 0, 'rejected', null, 'kind_unknown'],
        [1, 1, 'rejected', 'concludeInconclusive', 'invalid_structure'],
        [1, 2, 'rejected', null, 'kind_unknown'],
      ]);
      // Exactly maxDecisionRetries + 1 controller calls, none after the stop, no task and no source call.
      expect(harness.model.calls.map((call) => call.role)).toEqual(['plan', 'controller', 'controller', 'controller']);
      expect(llmCalls.map((row) => row.role)).toEqual(['plan', 'controller', 'controller', 'controller']);
      await expectControllerSucceededWith(investigationId, done.answer);
      expect(harness.countingSource.calls).toEqual([]);
      // Rule 12: the engine log holds no prompt and no model answer.
      const engineLog = JSON.stringify([harness.logs.engine.log, harness.logs.engine.warn, harness.logs.engine.error]);
      expect(engineLog).not.toContain(query);
      expect(engineLog).not.toContain('outside the closed set');
    });
    // C5 step_limit (AC-03.2): `maxSteps` 2 of the test configuration -> third step is not taken, stop reason `step_limit`
    it('INT-1 C5 step_limit: the step after maxSteps is not taken and the investigation ends with a code-built answer with step_limit', async () => {
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);
      harness.model.script(
        'controller',
        { output: { kind: 'replan', rationale: 'first replan', reason: 'the first branch is wrong' } },
        { output: { kind: 'replan', rationale: 'second replan', reason: 'the second branch is wrong' } },
      );

      const { investigationId } = created(
        await harness.engine.startInvestigation({
          resourceId,
          threadId,
          query: 'C5 step_limit: when did the queue back up?',
          processId: 'two-steps',
          launchKey: newLaunchKey(),
        }),
      );
      const done = await finished(investigationId, resourceId);

      expect(done.answer).toMatchObject({ outcome: 'inconclusive', stopReason: 'step_limit', established: [] });
      const { decisions, planRevisions } = await engineRowsOf(investigationId);
      expect(decisions.map((row) => [row.step, row.status, row.kind])).toEqual([
        [1, 'accepted', 'replan'],
        [2, 'accepted', 'replan'],
      ]);
      expect(planRevisions.map((row) => [row.revision, row.reason])).toEqual([
        [1, null],
        [2, 'the first branch is wrong'],
        [3, 'the second branch is wrong'],
      ]);
      // The third step is not taken: two controller calls, no call after the stop.
      expect(harness.model.calls.map((call) => call.role)).toEqual(['plan', 'controller', 'plan', 'controller', 'plan']);
      await expectControllerSucceededWith(investigationId, done.answer);
    });
    // C5 context_overflow (UC-E6 second scenario, DC-8): mandatory part of the controller input larger than its `windowTokens` -> the double is not called, stop reason `context_overflow`
    it('INT-1 C5 context_overflow: a mandatory controller input larger than its window calls no controller model and ends with a code-built answer with context_overflow', async () => {
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);

      const { investigationId } = created(
        await harness.engine.startInvestigation({
          resourceId,
          threadId,
          query: 'C5 context_overflow: which service timed out first?',
          processId: 'narrow-controller',
          launchKey: newLaunchKey(),
        }),
      );
      const done = await finished(investigationId, resourceId);

      expect(done.answer).toMatchObject({ outcome: 'inconclusive', stopReason: 'context_overflow', established: [] });
      // The mandatory part is not cut to fit: the controller model is never called.
      expect(harness.model.calls.map((call) => call.role)).toEqual(['plan']);
      const { decisions, llmCalls } = await engineRowsOf(investigationId);
      expect(decisions).toEqual([]);
      expect(llmCalls.map((row) => row.role)).toEqual(['plan']);
      await expectControllerSucceededWith(investigationId, done.answer);
    });
    // C5 deadline (UC-E4 third scenario, DC-3): analysis task reaches its decision's `notAfter` while running -> the task fails with class `deadline` and the double got no call for it; the controller wakes and answers by code with `deadline`, it does not fail
    it('INT-1 C5 deadline: an analysis task that reaches notAfter fails with deadline without a model call, and the controller answers by code with deadline', async () => {
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);
      harness.countingSource.answerWith(() => [{ service: 'payments', level: 'error', message: 'upstream timeout' }]);
      const subquestion = 'C5 deadline: which payment calls timed out?';
      harness.model.script('controller', {
        output: {
          kind: 'requestAnalysis',
          rationale: 'one sub-question over the payment errors',
          subquestions: [{ text: subquestion, sourceId: 'fixture', toolName: 'search_logs', args: { service: 'payments' }, completeness: 'all' }],
        },
      });
      // The worker is held in the count of its packet; the engine clock moves past notAfter before it goes on.
      const workerHeld = latch();
      let workerCounting = false;
      harness.tokenCounter.intercept = async (request) => {
        if (isWorkerRequest(request)) {
          workerCounting = true;
          await workerHeld.wait;
        }
        return undefined;
      };
      try {
        const { investigationId } = created(
          await harness.engine.startInvestigation({
            resourceId,
            threadId,
            query: 'C5 deadline: why did the payments slow down?',
            processId: 'deep-research',
            launchKey: newLaunchKey(),
          }),
        );
        await vi.waitFor(() => expect(workerCounting).toBe(true), { timeout: 20_000 });
        // Past the controller's deadline, so past notAfter = deadline - deadlineMarginMs of the decision and its tasks.
        harness.engineClock.offsetMs = 3_600_000;
        workerHeld.open();
        const done = await finished(investigationId, resourceId);

        expect(done).toMatchObject({
          status: 'completed',
          answer: { outcome: 'inconclusive', stopReason: 'deadline', established: [] },
        });
        const [controller, fetch, analyze, ...others] = await tasksOf(investigationId);
        expect(others).toEqual([]);
        expect(controller).toMatchObject({
          workflowType: 'research.controller',
          status: 'succeeded',
          outcome: { answerOrDelta: { answerId: done.answer?.answerId, outcome: 'inconclusive' } },
        });
        expect(fetch).toMatchObject({ workflowType: 'source.fetch', status: 'succeeded' });
        expect(analyze).toMatchObject({
          workflowType: 'research.analyze',
          status: 'failed',
          failureReason: { class: 'deadline', code: 'deadline' },
          // Runtime settings: three reservations of the worker call (64 000 + 3 200 + 8 000), 1 tool call, 0 retries.
          maxTokens: 225_600,
          maxToolCalls: 1,
          maxRetries: 0,
        });
        // The analysis task's time is what was left until the decision's notAfter when it was proposed.
        const notAfter = controller!.deadlineAt!.getTime() - 120_000;
        expect(analyze!.deadlineMs).toBeGreaterThanOrEqual(Math.floor(notAfter - analyze!.createdAt.getTime()) - 1);
        expect(analyze!.deadlineMs).toBeLessThanOrEqual(notAfter - controller!.startedAt!.getTime());
        // No worker call and no worker reservation: the model was not called after notAfter.
        expect(harness.model.calls.map((call) => call.role)).toEqual(['plan', 'controller']);
        const { decisions, llmCalls } = await engineRowsOf(investigationId);
        expect(llmCalls.map((row) => row.role)).toEqual(['plan', 'controller']);
        expect(decisions.map((row) => [row.step, row.status, row.kind, row.proposedTaskIds])).toEqual([
          [1, 'accepted', 'requestAnalysis', [fetch!.taskId, analyze!.taskId]],
        ]);
      } finally {
        harness.engineClock.offsetMs = 0;
        harness.tokenCounter.intercept = undefined;
        workerHeld.open();
      }
    });
    it('INT-1 C6: investigations started on versions 2 (no version given) and 1 finish on the prompts of their recorded versions after the engine is rebuilt with versions 1, 2 and 3, and a new start without a version records version 3', async () => {
      await harness.rebuildEngine({ processes: [...TEST_PROCESSES, versionedConfig(1), versionedConfig(2)] });
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);
      const queryA = 'C6 investigation A without a version';
      const queryB = 'C6 investigation B on version 1';
      // Both controllers are parked in their first controller call until the runtime stops.
      harness.model.script('controller', { hangUntilAborted: true }, { hangUntilAborted: true });

      const a = created(
        await harness.engine.startInvestigation({
          resourceId,
          threadId,
          query: queryA,
          processId: VERSIONED_PROCESS_ID,
          launchKey: newLaunchKey(),
        }),
      );
      const b = created(
        await harness.engine.startInvestigation({
          resourceId,
          threadId,
          query: queryB,
          processId: VERSIONED_PROCESS_ID,
          version: 1,
          launchKey: newLaunchKey(),
        }),
      );
      await vi.waitFor(() => expect(harness.model.callsOf('controller')).toHaveLength(2), { timeout: 20_000 });
      expect(await view(a.investigationId, resourceId)).toMatchObject({ status: 'running', version: 2 });
      expect(await view(b.investigationId, resourceId)).toMatchObject({ status: 'running', version: 1 });

      harness.model.calls.length = 0;
      harness.model.script('controller', conclude, conclude, conclude);
      // No fence: the parked controllers must survive the restart and resume on the new workers.
      await harness.rebuildEngine(
        { processes: [...TEST_PROCESSES, versionedConfig(1), versionedConfig(2), versionedConfig(3)] },
        { fence: false },
      );
      const doneA = await finished(a.investigationId, resourceId);
      const doneB = await finished(b.investigationId, resourceId);

      expect(doneA).toMatchObject({ status: 'completed', version: 2, answer: { outcome: 'inconclusive' } });
      expect(doneB).toMatchObject({ status: 'completed', version: 1, answer: { outcome: 'inconclusive' } });
      // After the rebuild each investigation runs on the prompts of its recorded version, not on the newest loaded.
      const markerOf = (query: string) =>
        harness.model.calls
          .filter((call) => call.system.includes(query))
          .map((call) => [call.role, [1, 2, 3].filter((version) => call.system.includes(versionMarker(version)))]);
      expect(markerOf(queryA)).toEqual([['controller', [2]]]);
      expect(markerOf(queryB)).toEqual([['controller', [1]]]);

      const c = created(
        await harness.engine.startInvestigation({
          resourceId,
          threadId,
          query: 'C6 investigation C after the rebuild',
          processId: VERSIONED_PROCESS_ID,
          launchKey: newLaunchKey(),
        }),
      );
      expect(await view(c.investigationId, resourceId)).toMatchObject({ version: 3 });
      expect(await finished(c.investigationId, resourceId)).toMatchObject({ status: 'completed', version: 3 });
    });
    it('INT-1 C7: without connected sources the investigation runs plan then one synthesis with no controller, worker, verifier or source call, delivers its claims as assumed and unverified with evidence references removed, and keeps that mode after the engine is rebuilt with a source connected', async () => {
      const draftClaim = (text: string, evidenceIds: string[] = []) => ({
        claimId: null,
        text,
        atoms: [{ kind: 'service', value: 'payments' }],
        evidenceIds,
      });
      await harness.rebuildEngine({ connectedSources: [] });
      try {
        const resourceId = newUser();
        const threadId = await harness.createThread(resourceId);
        // A: plan, then one synthesis whose third claim cites an evidence id.
        harness.model.script('synthesis', {
          output: {
            outcome: 'answered',
            summary: 'C7 answer from model knowledge',
            claims: [draftClaim('C7 first claim'), draftClaim('C7 second claim'), draftClaim('C7 cited claim', [randomUUID()])],
          },
        });
        const a = created(
          await harness.engine.startInvestigation({
            resourceId,
            threadId,
            query: 'C7 A: why do payments time out?',
            processId: 'deep-research',
            launchKey: newLaunchKey(),
          }),
        );
        const doneA = await finished(a.investigationId, resourceId);

        expect(doneA).toMatchObject({
          status: 'completed',
          sourceMode: 'model_knowledge',
          answer: {
            outcome: 'answered',
            stopReason: null,
            established: [],
            assumed: [
              { text: 'C7 first claim', evidenceIds: [], verified: false },
              { text: 'C7 second claim', evidenceIds: [], verified: false },
            ],
            removed: [{ text: 'C7 cited claim', reason: 'evidence_not_found' }],
          },
        });
        expect(doneA.answer?.assumed).toHaveLength(2);
        expect(doneA.answer?.removed).toHaveLength(1);
        // Invariant 10, AC-25.4: plan and synthesis only, at the double and in the ledger; no source call.
        expect(harness.model.calls.map((call) => call.role)).toEqual(['plan', 'synthesis']);
        expect(harness.model.callsOf('synthesis')[0]!.system).toContain('Source mode: model_knowledge.');
        expect(harness.countingSource.calls).toEqual([]);
        const rowsA = await engineRowsOf(a.investigationId);
        expect(rowsA.llmCalls.map((row) => [row.role, row.status])).toEqual([
          ['plan', 'settled'],
          ['synthesis', 'settled'],
        ]);
        expect(rowsA.llmCalls.reduce((sum, row) => sum + (row.chargedTokens ?? 0), 0)).toBe(rowsA.run!.tokensSpent);
        // KD-8: one decision, proposeAnswer accepted by code, no refusal.
        expect(rowsA.decisions.map((row) => [row.step, row.status, row.decidedBy, row.kind])).toEqual([[1, 'accepted', 'code', 'proposeAnswer']]);
        const [controllerA, synthesisA, ...othersA] = await tasksOf(a.investigationId);
        expect(othersA).toEqual([]);
        expect(synthesisA).toMatchObject({ workflowType: 'research.synthesize', status: 'succeeded' });
        expect(controllerA).toMatchObject({
          workflowType: 'research.controller',
          status: 'succeeded',
          outcome: { answerOrDelta: { answerId: doneA.answer?.answerId, outcome: 'answered' } },
        });

        // B: parked in its plan call, then the engine is rebuilt with the source connected (DC-16).
        harness.model.calls.length = 0;
        const queryB = 'C7 B: why do refunds fail?';
        harness.model.script('plan', { hangUntilAborted: true });
        const b = created(
          await harness.engine.startInvestigation({ resourceId, threadId, query: queryB, processId: 'deep-research', launchKey: newLaunchKey() }),
        );
        await vi.waitFor(() => expect(harness.model.callsOf('plan').some((call) => call.system.includes(queryB))).toBe(true), {
          timeout: 20_000,
        });
        expect(await view(b.investigationId, resourceId)).toMatchObject({ status: 'running', sourceMode: 'model_knowledge' });

        harness.model.calls.length = 0;
        harness.model.script('synthesis', { output: { outcome: 'answered', summary: 'C7 B answer', claims: [draftClaim('C7 B claim')] } });
        // No fence: B survives the restart and resumes on the new workers.
        await harness.rebuildEngine({ connectedSources: [COUNTING_SOURCE_ID] }, { fence: false });
        expect(harness.engine.sourceMode).toBe('sources');
        const doneB = await finished(b.investigationId, resourceId);

        expect(doneB).toMatchObject({
          status: 'completed',
          sourceMode: 'model_knowledge',
          answer: { outcome: 'answered', established: [], assumed: [{ text: 'C7 B claim', evidenceIds: [], verified: false }] },
        });
        expect(harness.model.calls.map((call) => call.role)).toEqual(['plan', 'synthesis']);
        expect(harness.countingSource.calls).toEqual([]);
        expect(new Set((await engineRowsOf(b.investigationId)).llmCalls.map((row) => row.role))).toEqual(new Set(['plan', 'synthesis']));

        // C: a new start in the rebuilt engine records the mode of that engine.
        harness.model.script('controller', conclude);
        const c = created(
          await harness.engine.startInvestigation({
            resourceId,
            threadId,
            query: 'C7 C after the rebuild',
            processId: 'deep-research',
            launchKey: newLaunchKey(),
          }),
        );
        expect(await finished(c.investigationId, resourceId)).toMatchObject({ status: 'completed', sourceMode: 'sources' });
      } finally {
        await harness.rebuildEngine({ connectedSources: [COUNTING_SOURCE_ID] });
      }
    }, 60_000);
    it('INT-1 C8: a start repeated after a failed start takes the shell the failure left instead of creating a second investigation, and two parallel starts with one launchKey keep one investigation', async () => {
      // (a) a retry after a start that failed between `InvestigationService.create` and the engine row
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);
      const query = 'C8: why did the login service fail?';
      const shell = await harness.seedShell({ resourceId, threadId, query });
      const unmatched = await harness.seedShell({ resourceId, threadId, query: 'C8: another question' });
      const unmatchedBefore = await rowVersionsOf(unmatched.investigationId);
      const launchKey = newLaunchKey();
      harness.model.script('controller', conclude);
      const input = { resourceId, threadId, query, processId: 'deep-research', launchKey };

      const first = created(await harness.engine.startInvestigation(input));

      expect(first).toMatchObject({ outcome: 'created', investigationId: shell.investigationId });
      expect(await view(first.investigationId, resourceId)).toMatchObject({ sourceMode: 'sources' });
      const thread = await harness.runtime.investigations.listForThread(resourceId, threadId);
      expect(thread.map((investigation) => [investigation.investigationId, investigation.status])).toEqual([
        [shell.investigationId, 'active'],
        [unmatched.investigationId, 'active'],
      ]);
      expect(await rowVersionsOf(unmatched.investigationId)).toEqual(unmatchedBefore);
      expect((await engineRunsOf(resourceId)).map((run) => [run.investigationId, run.launchKey, run.sourceMode])).toEqual([
        [shell.investigationId, launchKey, 'sources'],
      ]);
      expect(await finished(first.investigationId, resourceId)).toMatchObject({
        status: 'completed',
        answer: { outcome: 'inconclusive', stopReason: null },
      });
      expect((await tasksOf(first.investigationId)).map((task) => task.taskId)).toEqual([first.controllerTaskId]);

      const repeated = created(await harness.engine.startInvestigation(input));

      expect(repeated).toEqual({
        outcome: 'existing',
        investigationId: first.investigationId,
        controllerTaskId: first.controllerTaskId,
      });
      expect(await view(repeated.investigationId, resourceId)).toMatchObject({ sourceMode: 'sources' });
      expect(await engineRunsOf(resourceId)).toHaveLength(1);
      expect((await tasksOf(first.investigationId)).map((task) => task.taskId)).toEqual([first.controllerTaskId]);

      // (b) two parallel starts with one launchKey and no shell
      const otherThread = await harness.createThread(resourceId);
      const parallelKey = newLaunchKey();
      harness.model.script('controller', conclude);
      const parallelInput = { resourceId, threadId: otherThread, query, processId: 'deep-research', launchKey: parallelKey };

      const [left, right] = (
        await Promise.all([harness.engine.startInvestigation(parallelInput), harness.engine.startInvestigation(parallelInput)])
      ).map(created);

      expect(right!.investigationId).toBe(left!.investigationId);
      expect(right!.controllerTaskId).toBe(left!.controllerTaskId);
      const winner = left!.investigationId;
      expect(await view(winner, resourceId)).toMatchObject({ sourceMode: 'sources' });
      expect((await engineRunsOf(resourceId)).filter((run) => run.launchKey === parallelKey)).toHaveLength(1);
      expect(await finished(winner, resourceId)).toMatchObject({ status: 'completed' });
      expect((await tasksOf(winner)).map((task) => task.taskId)).toEqual([left!.controllerTaskId]);
      const parallelThread = await harness.runtime.investigations.listForThread(resourceId, otherThread);
      expect(parallelThread.filter((investigation) => investigation.status === 'active').map((i) => i.investigationId)).toEqual([
        winner,
      ]);
      // The loser may not exist: when the second start already sees the first one's engine row, it returns `existing`
      // without creating an investigation. The race is not forced (no fake runtime component), so the loop may be empty.
      for (const loser of parallelThread.filter((investigation) => investigation.investigationId !== winner)) {
        expect(loser.status).toBe('cancelled');
        expect(await tasksOf(loser.investigationId)).toEqual([]);
        expect((await engineRowsOf(loser.investigationId)).llmCalls).toEqual([]);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  Token ledger: reserve before the call, never exceed the budget, account every call by role and model
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-01.4: "Given расследование отменено, Then после того как отмена вступила в силу, не начинается ни один новый вызов модели и ни один вызов источника."
  // AC-07.1: "Given бюджет расследования меньше требуемого, Then суммарный расход токенов не превышает бюджета, и ни один вызов не начат после того, как остатка перестало хватать."
  // AC-07.2: "Given у задачи исчерпан свой бюджет токенов, Then задача завершается с причиной «бюджет исчерпан», а остальные задачи продолжают работу, пока хватает бюджета расследования."
  // AC-07.3: "Given исчерпан бюджет расследования, Then пользователь получает итоговое сообщение с причиной «бюджет исчерпан», исходом по правилу принудительной остановки (FR-09) и уже проверенными утверждениями с их ссылками на evidence."
  // AC-10.2: "Given все роли переведены на одну модель, Then это делается настройкой, без изменения кода (основа B1)."
  // AC-11.1: "Given завершённое расследование, Then сумма учтённых вызовов совпадает с расходом, списанным с бюджета (FR-07), и разбита по ролям и моделям."
  // DC-12 (FR-10): "Когда модель недоступна и повторы исчерпаны, задача воркера, проверки или синтеза проваливается с кодом model_unavailable, а контроллер останавливает расследование принудительно с этой причиной."
  // DC-13 (FR-11): "Строка журнала хранит и счёт входа до вызова, и фактический вход, так что расхождение счёта провайдера видно по каждому вызову."
  // AC-25.5: "Given режим без источников, When бюджет исчерпан или время расследования истекло раньше, чем синтез завершён, Then расследование завершается с исходом `inconclusive` и причиной остановки."
  // Use cases: UC-8, UC-E2, UC-E5, UC-E10, UC-E11. Flow 1 (failure handling: budget, provider errors, cancel), Flow 2 (first failure bullet), Flow 5 (failure handling). Invariants 1, 2, 4.
  //
  // Primary failure mode (turns red when): a model call starts without a recorded reservation or beyond the remaining investigation budget or the task's `maxTokens`; the charged total differs from the sum of ledger rows;
  // a failed or cancelled call leaves a reservation `reserved`; a provider outage or an exhausted budget fails the controller instead of ending the investigation with an answer; a call starts after cancel;
  // in a deployment without sources a refused reservation, an expired `notAfter` or a cancel during synthesis fails the controller task, or leaves it without an answer (budget, deadline), or gives a cancelled investigation an answer.
  // Behavior: a role asks for a call -> reservation (counted input + margin + maxOutputTokens) is written within the remaining budgets, or refused before the network -> the call -> the reservation is replaced by actual usage and price
  //   (settled), or closed failed/abandoned -> totals per role and model are read back through readInvestigation
  // @category: core-functionality
  // @dependency: ModelGateway, TokenCounter (double), research_llm_calls, research_engine_runs, withAttemptGuard, InvestigationService.cancel, Postgres
  // @complexity: high
  //
  // Verification items (table; every row asserts `sum(research_llm_calls tokens charged) === research_engine_runs.spent` and `spent <= budget`):
  // - L1 task budget (UC-E5 first scenario, AC-07.2): a `research.analyze` task whose `maxTokens` is below the reservation of its call -> task `failed`, code `task_tokens_exhausted`, class `budget_exhausted`, the double got no call for it;
  //   its sibling analysis task succeeds
  // - L2 investigation budget (UC-E5 second scenario, AC-07.1, AC-07.3): the budget covers only the first controller step and one worker call; the next reservation is refused -> no call after the refusal, the controller stops with `budget_exhausted`,
  //   the answer contains the claim that was verified before (established with its evidence ids) and the outcome follows FR-09
  // - L3 accounting by role and model (UC-8, AC-11.1, AC-10.2, DC-13): all five roles pointed at one model by editing the configuration only -> usage grouped by role has all roles, grouped by model has one;
  //   with the token-counter offset set to 7 tokens, each row stores the counted input and the actual input as two different values, and the actual input is within `marginTokens` of the counted one
  // - L4 provider outage (UC-E10, DC-12): the double answers 5xx to every worker call, then to the controller -> exactly 3 calls for the worker task (1 + 2 retries), task `failed` with code `model_unavailable`;
  //   every failed call's reservation is `failed` (settled to what the provider reported in usage); the controller then ends the investigation with an answer by code, stop reason `model_unavailable`
  // - L5 cancel (UC-E2, AC-01.4): a worker call is in flight (held by a latch), a second analysis task is queued -> `InvestigationService.cancel` -> after the cancel commit there is no new reservation row and no new call of the counting source adapter,
  //   the in-flight call is aborted by the signal, its reservation is closed `abandoned` and counted in full, and the sum still equals the charged total
  // - L6 no-source stop before the synthesis ends (UC-E11, AC-25.5; unique defect: the code-built stop answer exists only for the sources path, so the plan-then-synthesis path fails the controller or answers nothing): engine with `connectedSources: []`, three investigations:
  //   (a) the budget covers the `plan` call but is below the synthesis reservation -> the reservation is refused, the double got no synthesis call, the answer has no claims, outcome `inconclusive`, stop reason `budget_exhausted`, the controller task is `succeeded` with that `answerId`
  //   (b) the injected clock moves past `notAfter` after the plan and before the synthesis task is claimed -> the synthesis task fails with class `deadline` without a model call, the controller answers by code: no claims, `inconclusive`, stop reason `deadline`, task `succeeded`
  //   (c) cancel while the synthesis call is held by a latch -> status `cancelled`, `answer` null, no new reservation, the in-flight reservation closed `abandoned` (the abort mechanism itself is L5)
  //   (`model_unavailable` in this mode takes the same code-built answer: a row of the unit table of stop answers, see "Proven at unit level")
  describe('INT-2', () => {
    let harness: EngineHarness;
    const HAIKU = 'anthropic/claude-haiku-5-5';
    /** L3 (AC-10.2): the shipped process with every role on one model, by configuration only. */
    const ONE_MODEL_PROCESS = 'one-model';

    beforeAll(async () => {
      const shipped = deepResearchProcessV1 as { readonly roles: Readonly<Record<string, Readonly<Record<string, unknown>>>> };
      const oneModel = {
        ...shipped,
        processId: ONE_MODEL_PROCESS,
        roles: Object.fromEntries(Object.entries(shipped.roles).map(([role, config]) => [role, { ...config, model: HAIKU }])),
      };
      // Four slots: the analysis tasks of one decision run side by side (L7).
      harness = await createEngineHarness({ processes: [deepResearchProcessV1, oneModel], runtime: { concurrency: 4, dbPoolMax: 10 } });
    });

    afterAll(async () => {
      await harness?.close();
      await closeEngineDb();
    });

    beforeEach(() => {
      harness.model.reset();
      harness.countingSource.calls.length = 0;
    });

    afterEach(async () => {
      try {
        expect(harness.model.pending()).toEqual({ plan: 0, controller: 0, worker: 0, verifier: 0, synthesis: 0 });
      } finally {
        harness.tokenCounter.intercept = undefined;
        await harness.cancelStarted();
      }
    });

    const conclude = { output: { kind: 'concludeInconclusive', rationale: 'scripted conclusion' } };

    async function startDeepResearch(query: string, tokenBudget?: number) {
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);
      const result = await harness.engine.startInvestigation({
        resourceId,
        threadId,
        query,
        processId: 'deep-research',
        launchKey: newLaunchKey(),
        ...(tokenBudget === undefined ? {} : { tokenBudget }),
      });
      if (result.outcome === 'rejected') throw new Error(`start refused: ${result.code}`);
      return { resourceId, investigationId: result.investigationId };
    }

    function finished(investigationId: string, resourceId: string): Promise<InvestigationView> {
      return vi.waitFor(
        async () => {
          const read = await harness.engine.readInvestigation({ investigationId, resourceId });
          if (read.outcome !== 'found') throw new Error(`investigation ${investigationId} not found`);
          if (read.view.status === 'running') throw new Error(`investigation ${investigationId} is still running`);
          return read.view;
        },
        { timeout: 30_000, interval: 50 },
      );
    }

    /** Every row of the ledger is closed, their charge is what the engine row spent, and the spend is within the budget. */
    async function expectLedgerBalanced(investigationId: string) {
      const { run, llmCalls } = await engineRowsOf(investigationId);
      expect(llmCalls.filter((row) => row.status === 'reserved')).toEqual([]);
      expect(run!.tokensReserved).toBe(0);
      expect(llmCalls.reduce((sum, row) => sum + (row.chargedTokens ?? 0), 0)).toBe(run!.tokensSpent);
      expect(run!.tokensSpent).toBeLessThanOrEqual(run!.tokenBudget);
      return llmCalls;
    }

    const analysisOf = (texts: readonly string[]) => ({
      output: {
        kind: 'requestAnalysis',
        rationale: 'split the errors by service',
        subquestions: texts.map((text, index) => ({
          text,
          sourceId: 'fixture',
          toolName: 'search_logs',
          args: { service: `service-${index}` },
          completeness: 'all',
        })),
      },
    });

    it('INT-2 L1: a task whose maxTokens is below its call fails with task_tokens_exhausted without calling the model, and its sibling task continues', async () => {
      harness.countingSource.answerWith((call) => [{ service: call.args.service, level: 'error', message: 'connection reset' }]);
      const overBudget = 'L1 over-budget: what failed in service-0?';
      const sibling = 'L1 sibling: what failed in service-1?';
      harness.model.script('controller', analysisOf([overBudget, sibling]), conclude);
      harness.model.script('worker', {
        output: { claims: [{ text: 'service-1 reset its connections', atoms: [{ kind: 'service', value: 'service-1' }], evidenceIds: [] }] },
      });
      // The call of the first worker is counted above three reservations of the worker role (its task's maxTokens):
      // its packet fits the window, the reservation of the call does not fit the task.
      let overBudgetCounts = 0;
      harness.tokenCounter.intercept = (request) => {
        if (!isWorkerRequest(request) || !request.messages.some((message) => message.content.includes(overBudget))) return undefined;
        overBudgetCounts += 1;
        return overBudgetCounts === 1 ? undefined : 300_000;
      };

      const { resourceId, investigationId } = await startDeepResearch('L1: why did the services reset their connections?');
      const done = await finished(investigationId, resourceId);

      expect(done).toMatchObject({ status: 'completed', answer: { outcome: 'inconclusive', stopReason: null } });
      const [controller, , overTask, , siblingTask, ...others] = await tasksOf(investigationId);
      expect(others).toEqual([]);
      expect(controller).toMatchObject({ workflowType: 'research.controller', status: 'succeeded' });
      expect(overTask).toMatchObject({
        workflowType: 'research.analyze',
        status: 'failed',
        failureReason: { class: 'budget_exhausted', code: 'task_tokens_exhausted' },
      });
      expect(siblingTask).toMatchObject({ workflowType: 'research.analyze', status: 'succeeded' });
      // The refused task called no model: the only worker call is the sibling's, with its own sub-question only.
      const workerCalls = harness.model.callsOf('worker');
      expect(workerCalls).toHaveLength(1);
      expect(workerCalls[0]!.user).toContain(sibling);
      expect(workerCalls[0]!.user).not.toContain(overBudget);
      const llmCalls = await expectLedgerBalanced(investigationId);
      expect(llmCalls.filter((row) => row.taskId === overTask!.taskId)).toEqual([]);
      expect(llmCalls.filter((row) => row.taskId === siblingTask!.taskId).map((row) => [row.role, row.status])).toEqual([
        ['worker', 'settled'],
      ]);
      // The sibling's claim is an unverified revision with the coverage of its gather task.
      const { claims } = await engineRowsOf(investigationId);
      expect(claims.map((row) => [row.taskId, row.claimIndex, row.text, row.status, row.atoms])).toEqual([
        [siblingTask!.taskId, 0, 'service-1 reset its connections', 'unverified', [{ kind: 'service', value: 'service-1' }]],
      ]);
      expect(claims[0]!.coverage).toMatchObject({ completeness: 'complete', returned: 1 });
      // The next decision observes both outcomes: the refusal by its code and the sibling's claim.
      const nextInput = harness.model.callsOf('controller')[1]!.user;
      expect(nextInput).toContain(`"taskId":"${overTask!.taskId}","type":"research.analyze","status":"failed"`);
      expect(nextInput).toContain('"failureCode":"task_tokens_exhausted"');
      expect(nextInput).toContain(`"claimId":"${claims[0]!.claimId}","status":"unverified","text":"service-1 reset its connections"`);
    });
    /**
     * Scripts one analysis of the trace and one verification round of its claim: the controller asks for the round once the
     * worker's claim is written (the test reads its id meanwhile). Returns the claim ids, once known.
     */
    function scriptAnalysisAndRound(usage: Partial<Record<'controller' | 'worker' | 'verifier', StepUsage>> = {}) {
      const usageOf = (role: 'controller' | 'worker' | 'verifier') => (usage[role] === undefined ? {} : { usage: usage[role] });
      const trace = 'e'.repeat(32);
      harness.countingSource.answerWith(() => [{ ts: '2026-10-01T12:05:00.000Z', service: 'payments', level: 'error', traceId: trace }]);
      const claimsWritten = latch();
      const state = { claimIds: [] as string[], claimsWritten };
      harness.model.script(
        'controller',
        {
          output: {
            kind: 'requestAnalysis',
            rationale: 'find the failing trace',
            subquestions: [{ text: 'which trace failed?', sourceId: 'fixture', toolName: 'search_logs', args: { service: 'payments' }, completeness: 'all' }],
          },
          ...usageOf('controller'),
        },
        {
          output: () => ({ kind: 'requestVerification', rationale: 'check the claim', claimIds: state.claimIds }),
          holdUntil: claimsWritten.wait,
          ...usageOf('controller'),
        },
      );
      harness.model.script('worker', {
        output: { claims: [{ text: 'the payment trace failed', atoms: [{ kind: 'traceId', value: trace }], evidenceIds: [] }] },
        ...usageOf('worker'),
      });
      harness.model.script('verifier', {
        output: () => ({ requests: [{ claimIds: state.claimIds, sourceId: 'fixture', toolName: 'get_trace', args: { traceId: trace } }] }),
        ...usageOf('verifier'),
      });
      return state;
    }

    /** Reads the worker's claim ids into `state` and lets the controller ask for their round. */
    async function releaseRound(investigationId: string, state: ReturnType<typeof scriptAnalysisAndRound>) {
      state.claimIds = await vi.waitFor(
        async () => {
          const { claims } = await engineRowsOf(investigationId);
          if (claims.length === 0) throw new Error('the worker claim is not written yet');
          return claims.map((row) => row.claimId);
        },
        { timeout: 20_000, interval: 50 },
      );
      state.claimsWritten.open();
    }

    it('INT-2 L2: an exhausted investigation budget starts no further call, stops with budget_exhausted and answers with the claims verified before, spending no more than the budget', async () => {
      // Every packet counts 1 000 tokens, so each reservation is 1 000 + margin + maxOutputTokens of its role:
      // plan 9 800, controller 10 600, worker 12 200, verifier 6 600. The calls charge 120 (plan, controller),
      // 6 000 (worker) and 4 000 (verifier): 10 360 spent before the third controller call, whose 10 600 no longer fit 20 000.
      harness.tokenCounter.intercept = () => 1_000;
      const round = scriptAnalysisAndRound({ worker: { inputTokens: 1_000, outputTokens: 5_000 }, verifier: { inputTokens: 1_000, outputTokens: 3_000 } });
      try {
        const { resourceId, investigationId } = await startDeepResearch('L2: which payment trace failed?', 20_000);
        await releaseRound(investigationId, round);
        const done = await finished(investigationId, resourceId);

        const tasks = await tasksOf(investigationId);
        const basis = tasks.find((task) => task.workflowType === 'source.fetch' && (task.input as { toolName?: string }).toolName === 'get_trace')!.outputRefs;
        // AC-07.3: the forced stop answers with the claim verified before, with its evidence; FR-09 makes it partial.
        expect(done).toMatchObject({
          status: 'completed',
          answer: {
            outcome: 'partial',
            stopReason: 'budget_exhausted',
            established: [{ claimId: round.claimIds[0], text: 'the payment trace failed', evidenceIds: basis, verified: true }],
          },
        });
        expect(basis).toHaveLength(1);
        expect(tasks.find((task) => task.workflowType === 'research.controller')).toMatchObject({
          status: 'succeeded',
          outcome: { answerOrDelta: { answerId: done.answer?.answerId, outcome: 'partial' } },
        });
        // AC-07.1: the refused call was neither reserved nor made, and the spend stays within the budget.
        expect(harness.model.calls.map((call) => call.role)).toEqual(['plan', 'controller', 'worker', 'controller', 'verifier']);
        const llmCalls = await expectLedgerBalanced(investigationId);
        expect(llmCalls.map((row) => [row.role, row.reservedTokens, row.chargedTokens])).toEqual([
          ['plan', 9_800, 120],
          ['controller', 10_600, 120],
          ['worker', 12_200, 6_000],
          ['controller', 10_600, 120],
          ['verifier', 6_600, 4_000],
        ]);
        expect(done.usage).toMatchObject({ totalTokens: 10_360, tokenBudget: 20_000 });
      } finally {
        round.claimsWritten.open();
      }
    }, 30_000);
    // L3 per the skeleton row; the cache read and write are scripted so their columns are summed too (AC-11.1).
    it('INT-2 L3: after all roles move to one model by configuration, the ledger sum equals the charged total, usage is split by role and model, and each row keeps counted and actual input', async () => {
      // DC-13: the counter counts one token per character plus 7; the double reports the characters of the packet it got.
      harness.tokenCounter.offset = 7;
      const actual = (call: RecordedModelCall): ScriptedUsage => ({
        inputTokens: call.system.length + call.user.length,
        outputTokens: 40,
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
      });
      harness.model.script('plan', { output: { readinessCriteria: ['the trace is named'], branches: [] }, usage: actual });
      const round = scriptAnalysisAndRound({ controller: actual, worker: actual, verifier: actual });
      harness.model.script('controller', { output: { kind: 'proposeAnswer', rationale: 'the claim is verified' }, usage: actual });
      harness.model.script('synthesis', { output: { outcome: 'answered', summary: 'L3 answer', claims: [] }, usage: actual });
      try {
        const resourceId = newUser();
        const threadId = await harness.createThread(resourceId);
        const started = await harness.engine.startInvestigation({
          resourceId,
          threadId,
          query: 'L3: which payment trace failed?',
          processId: ONE_MODEL_PROCESS,
          launchKey: newLaunchKey(),
        });
        if (started.outcome === 'rejected') throw new Error(`start refused: ${started.code}`);
        const { investigationId } = started;
        await releaseRound(investigationId, round);
        const done = await finished(investigationId, resourceId);

        expect(done.status).toBe('completed');
        const llmCalls = await expectLedgerBalanced(investigationId);
        // AC-10.2: the configuration alone moved every role to one model.
        expect(harness.model.calls.map((call) => [call.role, call.modelId])).toEqual(
          ['plan', 'controller', 'worker', 'controller', 'verifier', 'controller', 'synthesis'].map((role) => [role, HAIKU]),
        );
        // DC-13: each row keeps both inputs, 7 apart, so the counter's divergence is visible per call.
        expect(llmCalls.map((row) => [row.role, row.model, row.status, row.countedInputTokens - row.inputTokens!])).toEqual(
          ['plan', 'controller', 'worker', 'controller', 'verifier', 'controller', 'synthesis'].map((role) => [role, HAIKU, 'settled', 7]),
        );
        // AC-11.1: usage by role and model; its total is what the ledger charged.
        const byRole = (role: string) => llmCalls.filter((row) => row.role === role);
        expect(done.usage.byRoleAndModel).toEqual(
          (['plan', 'controller', 'worker', 'verifier', 'synthesis'] as const).map((role) => {
            const rows = byRole(role);
            return {
              role,
              model: HAIKU,
              calls: rows.length,
              inputTokens: rows.reduce((sum, row) => sum + row.inputTokens!, 0),
              outputTokens: 40 * rows.length,
              cacheReadTokens: 30 * rows.length,
              cacheWriteTokens: 10 * rows.length,
              costUsd: expect.closeTo(rows.reduce((sum, row) => sum + Number(row.costUsd), 0), 8),
            };
          }),
        );
        expect(done.usage.byRoleAndModel.map((row) => row.calls)).toEqual([1, 3, 1, 1, 1]);
        const { run } = await engineRowsOf(investigationId);
        expect(done.usage).toMatchObject({ totalTokens: run!.tokensSpent, tokenBudget: 3_000_000 });
        expect(done.usage.totalCostUsd).toBeGreaterThan(0);
      } finally {
        harness.tokenCounter.offset = 0;
        round.claimsWritten.open();
      }
    }, 30_000);
    it('INT-2 L4: a provider outage gives the worker 3 calls then model_unavailable, closes each failed reservation as failed, and ends the investigation with an answer by code', async () => {
      const outage = { providerError: { statusCode: 503 } };
      harness.model.script('controller', analysisOf(['L4: what failed in service-0?']), outage, outage, outage);
      harness.model.script('worker', outage, outage, outage);

      const { resourceId, investigationId } = await startDeepResearch('L4: why is the provider down?');
      const done = await finished(investigationId, resourceId);

      expect(done).toMatchObject({
        status: 'completed',
        answer: { outcome: 'inconclusive', stopReason: 'model_unavailable', established: [] },
      });
      const [controller, , analyze, ...others] = await tasksOf(investigationId);
      expect(others).toEqual([]);
      expect(controller).toMatchObject({
        workflowType: 'research.controller',
        status: 'succeeded',
        outcome: { answerOrDelta: { answerId: done.answer?.answerId, outcome: 'inconclusive' } },
      });
      expect(analyze).toMatchObject({
        workflowType: 'research.analyze',
        status: 'failed',
        failureReason: { class: 'transport_protocol', code: 'model_unavailable' },
      });
      // One call and two retries, one request each: the role agent does not retry on its own (KD-7).
      expect(harness.model.callsOf('worker')).toHaveLength(3);
      expect(harness.model.calls.map((call) => call.role)).toEqual([
        'plan', 'controller', 'worker', 'worker', 'worker', 'controller', 'controller', 'controller',
      ]);
      const llmCalls = await expectLedgerBalanced(investigationId);
      expect(llmCalls.filter((row) => row.taskId === analyze!.taskId).map((row) => [row.role, row.status, row.chargedTokens])).toEqual([
        ['worker', 'failed', 0],
        ['worker', 'failed', 0],
        ['worker', 'failed', 0],
      ]);
      // Two provider retries for the worker and two for the controller wait 1 s and 3 s each on the engine clock.
    }, 30_000);
    // L5 follows UC-E2 of design-engine.md v1.11 (it supersedes the skeleton comment above): the runtime writes `cancelled` at once, so no attempt is
    //   left to close the in-flight reservation under its guard; it stays `reserved`, counted in `tokensReserved`, and the cost is spent + reserved.
    //   The DC-9 close points apply only to investigations that are not cancelled.
    it('INT-2 L5: after cancel no reservation and no source call start, the in-flight reservation stays reserved and the investigation counts it with the charged total', async () => {
      harness.countingSource.answerWith((call) => [{ service: call.args.service, level: 'error', message: 'disk full' }]);
      const queued = 'L5 queued: what failed in service-1?';
      harness.model.script('controller', analysisOf(['L5 in flight: what failed in service-0?', queued]));
      harness.model.script('worker', { hangUntilAborted: true });
      // The queued worker is held in the count `ModelGateway` makes before its reservation (its second count: the first is the
      // packet's), so the check after the count is what must stop it once the cancel is in force.
      const held = latch();
      const release = latch();
      const passed = latch();
      let queuedCounts = 0;
      harness.tokenCounter.intercept = async (request) => {
        if (!isWorkerRequest(request) || !request.messages.some((message) => message.content.includes(queued))) return undefined;
        queuedCounts += 1;
        if (queuedCounts === 2) {
          held.open();
          await release.wait;
          passed.open();
        }
        return undefined;
      };
      try {
        const { resourceId, investigationId } = await startDeepResearch('L5: why did the disks fill up?');
        const inFlight = await vi.waitFor(
          async () => {
            const row = (await engineRowsOf(investigationId)).llmCalls.find((call) => call.role === 'worker');
            if (row === undefined || harness.model.callsOf('worker').length === 0) throw new Error('the worker call is not in flight yet');
            return row;
          },
          { timeout: 10_000, interval: 20 },
        );
        await held.wait;
        const queuedTask = (await tasksOf(investigationId)).find(
          (task) => task.workflowType === 'research.analyze' && JSON.stringify(task.input).includes(queued),
        )!;
        const sourceCallsAtCancel = harness.countingSource.calls.length;
        const rowsAtCancel = (await engineRowsOf(investigationId)).llmCalls;

        await harness.runtime.investigations.cancel(investigationId, resourceId);
        release.open();
        await passed.wait;
        // The runtime settles the cancelled attempts at once; the queued worker's handler ends on its own.
        await vi.waitFor(() => expect(harness.endedRuns).toContainEqual({ taskId: queuedTask.taskId, attempt: queuedTask.attempt }), {
          timeout: 10_000,
          interval: 20,
        });

        expect(await finished(investigationId, resourceId)).toMatchObject({ status: 'cancelled', answer: null });
        // The collections ended before the cancel; every task of the engine ends cancelled (the runtime settles the running ones after the commit).
        await vi.waitFor(
          async () =>
            expect((await tasksOf(investigationId)).map((task) => [task.workflowType, task.status])).toEqual([
              ['research.controller', 'cancelled'],
              ['source.fetch', 'succeeded'],
              ['research.analyze', 'cancelled'],
              ['source.fetch', 'succeeded'],
              ['research.analyze', 'cancelled'],
            ]),
          { timeout: 10_000, interval: 50 },
        );
        // The queued worker passed its count after the cancel and stopped before reserving: no reservation was even tried
        // (a tried one is refused by the runtime's guard, which logs `fenced` for its task), and the ledger is what it was at the cancel.
        expect(harness.logs.runtime.warn.filter(([message]) => message.includes(`taskId=${queuedTask.taskId}`))).toEqual([]);
        const { run, llmCalls } = await engineRowsOf(investigationId);
        expect(llmCalls).toEqual(rowsAtCancel);
        expect(llmCalls.find((row) => row.callId === inFlight.callId)).toMatchObject({ status: 'reserved', chargedTokens: null });
        // UC-E2 (design v1.11): the charged rows sum to `tokensSpent`, the reserved rows to `tokensReserved`; the cost is spent + reserved.
        expect(llmCalls.reduce((sum, row) => sum + (row.chargedTokens ?? 0), 0)).toBe(run!.tokensSpent);
        expect(llmCalls.filter((row) => row.status === 'reserved').reduce((sum, row) => sum + row.reservedTokens, 0)).toBe(run!.tokensReserved);
        expect(run!.tokensReserved).toBe(inFlight.reservedTokens);
        expect(run!.tokensSpent + run!.tokensReserved).toBeLessThanOrEqual(run!.tokenBudget);
        expect(harness.model.callsOf('worker')).toHaveLength(1);
        expect(harness.countingSource.calls).toHaveLength(sourceCallsAtCancel);
      } finally {
        release.open();
      }
    }, 30_000);
    // L5 late close (DC-9 close point 3, design v1.11; unique defect: the answer written by code abandons the reservation of a worker call still
    //   running after a decision with `await: false`, and that call's own close then throws `reservation ... is not open`, failing the task; only the real
    //   ledger and a call coming back after the answer show it). The late close changes nothing in the ledger and logs one warning without prompt text.
    it('INT-2 L5 late close: a worker call that comes back after the answer abandoned its reservation keeps the abandoned charge, logs one warning and succeeds', async () => {
      harness.countingSource.answerWith((call) => [{ service: call.args.service, level: 'error', message: 'pool exhausted' }]);
      const subquestion = 'L5 late: what failed in service-0?';
      const controllerGo = latch();
      const workerGo = latch();
      try {
        harness.model.script(
          'controller',
          { output: { ...analysisOf([subquestion]).output, await: false } },
          { ...conclude, holdUntil: controllerGo.wait },
        );
        harness.model.script('worker', { output: { claims: [] }, holdUntil: workerGo.wait });

        const { resourceId, investigationId } = await startDeepResearch('L5 late: why was the pool exhausted?');
        const workerRow = await vi.waitFor(
          async () => {
            const row = (await engineRowsOf(investigationId)).llmCalls.find((call) => call.role === 'worker');
            if (row === undefined || harness.model.callsOf('worker').length === 0 || harness.model.callsOf('controller').length < 2) {
              throw new Error('the worker call and the second controller call are not both in flight yet');
            }
            return row;
          },
          { timeout: 10_000, interval: 20 },
        );
        controllerGo.open();
        expect(await finished(investigationId, resourceId)).toMatchObject({ status: 'completed', answer: { outcome: 'inconclusive' } });
        workerGo.open();

        const analyze = await vi.waitFor(
          async () => {
            const task = (await tasksOf(investigationId)).find((candidate) => candidate.workflowType === 'research.analyze');
            if (task === undefined || task.status === 'running' || task.status === 'queued') throw new Error('the analysis task is still running');
            return task;
          },
          { timeout: 10_000, interval: 50 },
        );
        expect(analyze).toMatchObject({ status: 'succeeded' });
        const llmCalls = await expectLedgerBalanced(investigationId);
        expect(llmCalls.find((row) => row.callId === workerRow.callId)).toMatchObject({
          status: 'abandoned',
          chargedTokens: workerRow.reservedTokens,
        });
        const warnings = harness.logs.engine.warn.filter(([, fields]) => (fields as { taskId?: string } | undefined)?.taskId === analyze.taskId);
        expect(warnings).toEqual([
          [
            'model call closed after its reservation was abandoned',
            expect.objectContaining({ role: 'worker', outcome: 'settled_after_abandoned' }),
          ],
        ]);
        expect(JSON.stringify(warnings)).not.toContain(subquestion);
      } finally {
        controllerGo.open();
        workerGo.open();
      }
    }, 30_000);
    // L6 (c) follows DC-9 and UC-E2 of design-engine.md v1.12 (as L5 does): after the cancel no attempt is left to close the in-flight
    //   synthesis reservation under its guard, so it stays `reserved` rather than `abandoned`.
    it('INT-2 L6: without sources an exhausted budget or an expired notAfter before the synthesis ends answers by code with no claims, inconclusive and the stop reason, and a cancel during synthesis leaves no answer', async () => {
      const noClaims = { established: [], assumed: [], unknown: [], removed: [] };
      /** The no-source stop answer: no claims, `inconclusive`, the reason; the controller succeeded with it, not failed. */
      async function expectStopAnswer(investigationId: string, done: InvestigationView, stopReason: string) {
        expect(done).toMatchObject({
          status: 'completed',
          sourceMode: 'model_knowledge',
          answer: { outcome: 'inconclusive', stopReason, ...noClaims },
        });
        const [controller, synthesis, ...others] = await tasksOf(investigationId);
        expect(others).toEqual([]);
        expect(controller).toMatchObject({
          workflowType: 'research.controller',
          status: 'succeeded',
          outcome: { answerOrDelta: { answerId: done.answer?.answerId, outcome: 'inconclusive' } },
        });
        return synthesis!;
      }

      await harness.rebuildEngine({ connectedSources: [] });
      const synthesisClaimed = latch();
      const synthesisGo = latch();
      try {
        // (a) the budget covers the plan call (about 9 300 reserved, 120 charged) but not the synthesis reservation (about 11 000).
        const a = await startDeepResearch('L6 a: why did the batch job stop?', 10_000);
        const synthesisA = await expectStopAnswer(a.investigationId, await finished(a.investigationId, a.resourceId), 'budget_exhausted');
        expect(synthesisA).toMatchObject({
          workflowType: 'research.synthesize',
          status: 'failed',
          failureReason: { class: 'budget_exhausted', code: 'investigation_tokens_exhausted' },
        });
        expect(harness.model.calls.map((call) => call.role)).toEqual(['plan']);
        expect((await expectLedgerBalanced(a.investigationId)).map((row) => row.role)).toEqual(['plan']);

        // (b) the engine clock passes notAfter after the plan, while the synthesis task waits to start.
        harness.model.calls.length = 0;
        harness.handlerHold.at = async (point) => {
          if (point.at !== 'run' || point.workflowType !== 'research.synthesize') return;
          synthesisClaimed.open();
          await synthesisGo.wait;
        };
        const b = await startDeepResearch('L6 b: why did the cron drift?');
        await synthesisClaimed.wait;
        harness.engineClock.offsetMs = 3_600_000;
        synthesisGo.open();
        const synthesisB = await expectStopAnswer(b.investigationId, await finished(b.investigationId, b.resourceId), 'deadline');
        expect(synthesisB).toMatchObject({
          workflowType: 'research.synthesize',
          status: 'failed',
          failureReason: { class: 'deadline', code: 'deadline' },
        });
        expect(harness.model.calls.map((call) => call.role)).toEqual(['plan']);
        expect((await expectLedgerBalanced(b.investigationId)).map((row) => row.role)).toEqual(['plan']);
        harness.handlerHold.at = undefined;
        harness.engineClock.offsetMs = 0;

        // (c) a cancel while the synthesis call is in flight.
        harness.model.calls.length = 0;
        harness.model.script('synthesis', { hangUntilAborted: true });
        const c = await startDeepResearch('L6 c: why did the export stall?');
        const inFlight = await vi.waitFor(
          async () => {
            const row = (await engineRowsOf(c.investigationId)).llmCalls.find((call) => call.role === 'synthesis');
            if (row === undefined || harness.model.callsOf('synthesis').length === 0) throw new Error('the synthesis call is not in flight yet');
            return row;
          },
          { timeout: 10_000, interval: 20 },
        );
        const rowsAtCancel = (await engineRowsOf(c.investigationId)).llmCalls;
        await harness.runtime.investigations.cancel(c.investigationId, c.resourceId);
        expect(await finished(c.investigationId, c.resourceId)).toMatchObject({ status: 'cancelled', answer: null });
        const synthesisC = (await tasksOf(c.investigationId)).find((task) => task.workflowType === 'research.synthesize')!;
        await vi.waitFor(() => expect(harness.endedRuns).toContainEqual({ taskId: synthesisC.taskId, attempt: synthesisC.attempt }), {
          timeout: 10_000,
          interval: 20,
        });
        const { run, llmCalls } = await engineRowsOf(c.investigationId);
        expect(run!.answer).toBeNull();
        expect(llmCalls).toEqual(rowsAtCancel);
        expect(llmCalls.find((row) => row.callId === inFlight.callId)).toMatchObject({ status: 'reserved', chargedTokens: null });
        expect(harness.model.calls.map((call) => call.role)).toEqual(['plan', 'synthesis']);
      } finally {
        harness.handlerHold.at = undefined;
        harness.engineClock.offsetMs = 0;
        synthesisClaimed.open();
        synthesisGo.open();
        await harness.rebuildEngine({ connectedSources: [COUNTING_SOURCE_ID] });
      }
    }, 60_000);
    // L7 parallel reservations (Failure Mode «shared-state dependency», invariant 1, AC-07.1; unique defect: the reservations of parallel tasks read the
    //   investigation's remainder without serialization and together exceed the budget, which only concurrent workers over the real ledger can show)
    // Covers (original statements):
    // Invariant 1: "Вызов модели не начинается без записанного резерва, а резерв не выходит за остаток бюджета расследования и maxTokens задачи."
    // AC-07.1: "Given бюджет расследования меньше требуемого, Then суммарный расход токенов не превышает бюджета, и ни один вызов не начат после того, как остатка перестало хватать."
    // Primary failure mode (turns red when): the reservation checks the remainder without locking the `research_engine_runs` row, so three workers reserving at once
    //   all pass the check and the investigation reserves and spends beyond its budget.
    // Verification items: three analysis tasks of one decision reach their reservation together (a barrier in the token counter double), the remainder of the
    //   investigation budget covers exactly two reservations -> exactly two worker reservations are written and settled, the third task fails
    //   `investigation_tokens_exhausted` (class `budget_exhausted`) and its call is not started (two worker calls at the model double), `spent` <= budget and
    //   the ledger sum equals `spent`.
    it('INT-2 L7: three workers reserving at once with a remainder for two get exactly two reservations, the third call does not start, and the spend stays within the budget', async () => {
      harness.countingSource.answerWith((call) => [{ service: call.args.service, level: 'error', message: 'queue full' }]);
      harness.model.script(
        'controller',
        analysisOf(['L7: what failed in service-0?', 'L7: what failed in service-1?', 'L7: what failed in service-2?']),
        conclude,
      );
      harness.model.script('worker', { output: { claims: [] } }, { output: { claims: [] } });
      // Every packet counts 1 000 tokens: plan 9 800, controller 10 600 and worker 12 200 per reservation. After the plan and the first
      // controller call (120 charged each) 29 760 are left: two worker reservations (24 400) fit, a third (36 600) does not.
      // The worker counts pass a barrier of three, so the three reservations follow their counts at once.
      const workers = barrier(3);
      harness.tokenCounter.intercept = async (request) => {
        if (isWorkerRequest(request)) await workers.arrive();
        return 1_000;
      };

      const { resourceId, investigationId } = await startDeepResearch('L7: why did the queues fill up?', 30_000);
      const done = await finished(investigationId, resourceId);

      expect(done).toMatchObject({ status: 'completed', answer: { outcome: 'inconclusive', stopReason: null } });
      const analyses = (await tasksOf(investigationId)).filter((task) => task.workflowType === 'research.analyze');
      expect(analyses).toHaveLength(3);
      const refused = analyses.filter((task) => task.status === 'failed');
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ failureReason: { class: 'budget_exhausted', code: 'investigation_tokens_exhausted' } });
      expect(analyses.filter((task) => task.status === 'succeeded')).toHaveLength(2);
      expect(harness.model.callsOf('worker')).toHaveLength(2);
      const llmCalls = await expectLedgerBalanced(investigationId);
      const workerRows = llmCalls.filter((row) => row.role === 'worker');
      expect(workerRows.map((row) => [row.status, row.reservedTokens])).toEqual([
        ['settled', 12_200],
        ['settled', 12_200],
      ]);
      expect(workerRows.filter((row) => row.taskId === refused[0]!.taskId)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  Claims and the answer: only what the source records support is established, and every claim leads to this investigation's evidence
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-08.1: "Given утверждение называет число или идентификатор, которого нет в цитируемом evidence, Then код помечает его refuted или insufficient, и в ответ оно не попадает как установленное." (here: the failed-collection half, DC-10)
  // AC-08.3: "Given лимит циклов проверки исчерпан без подтверждения, Then утверждение insufficient и никогда не становится supported автоматически."
  // AC-09.1: "Given в развёртывании подключён хотя бы один источник данных, и черновик ответа содержит утверждение без ссылки, со ссылкой на несуществующее evidence или на evidence другого расследования, Then это утверждение удалено из ответа до выдачи, а удаление записано в ходе расследования." (here: the real EvidenceReader half, in mode `sources`; the mode without sources is INT-1 C7)
  // AC-09.2: "Given в развёртывании подключён хотя бы один источник данных, и ответ выдан, Then каждое его утверждение ведёт к evidence со всеми полями provenance."
  // AC-25.3: "Given подключён хотя бы один источник, в том числе недоступный во время расследования, Then в ответе нет ни пометки знаний модели, ни предупреждения режима без источников, а утверждения без допустимой ссылки удаляются (AC-09.1)." (here: the mode of an investigation whose connected source fails; UC-12 second half)
  // AC-09.3: "Given при написании ответа появилось новое существенное утверждение, When циклы проверки (FR-08) ещё остались, Then оно проверяется до выдачи; When циклов не осталось, Then оно выдаётся как предположенное и помечено как непроверенное. Как установленное оно не выдаётся ни в одном случае."
  // DC-10 (FR-08): "refuted ставится только тогда, когда полученная исходная запись противоречит атому; отсутствие атома или провал задачи сбора дают insufficient."
  // Use cases: UC-6 (wiring half), UC-7 (wiring half), UC-12 (second half), UC-E7. Flow 3, Flow 4. Invariants 7, 8, 9.
  //
  // Primary failure mode (turns red when): a claim reaches `established` without all atoms found in this investigation's source records (a worker summary is enough, or a failed collection counts as found);
  // a connected source that fails during the investigation flips the investigation to the no-source mode (its claims lose their references or are marked as model knowledge);
  // evidence of another investigation or an unknown id survives the reference gateway; a status change overwrites the earlier revision instead of appending; the verify loop never ends or ends without a round counted.
  // Behavior: worker claims (unverified) -> verifier picks records -> research.verify proposes source.fetch tasks and waits through the runtime -> code compares atoms to the fetched records -> new revision rows;
  //   synthesis draft -> reference gateway over EvidenceReader -> answer rows (established / assumed / removed); a new claim with rounds left returns needs_verification and the controller verifies and proposes the answer again
  // @category: core-functionality
  // @dependency: research.verify, research.synthesize, CapabilityRegistry, EvidenceReader, source.fetch (counting adapter), research_claims, research_engine_runs, Postgres
  // @complexity: high
  //
  // Verification items (table):
  // - V1 verification round through the runtime (UC-6 wiring, AC-08.1 failed-collection half, DC-10): two claims -> the first has all atoms in the records returned by a fetch task -> new revision `supported` with basis and scope;
  //   the second depends on a fetch task that the adapter fails -> new revision `insufficient` listing the missing atoms, not `refuted`; the earlier `unverified` revisions are byte-identical after the round (row-version snapshot), the verify task `succeeded`;
  //   the same run also pins AC-25.3 (UC-12 second half): the engine is built with the failing adapter connected, so `readInvestigation` shows `sourceMode` `sources` although a collection failed, and the answer carries no model-knowledge mark
  // - V2 gateway over the real reader (UC-7 wiring, AC-09.1, AC-09.2, mode `sources`): a draft with a claim citing evidence of another investigation of the same user, a claim citing an id that does not exist and a claim citing this investigation's evidence of a `supported` claim ->
  //   the first two are in `answer.removed` with their reasons, the third in `established` and `EvidenceReader.get` returns every provenance field for each of its evidence ids; `readInvestigation` by another `resourceId` -> `investigation_not_found`
  // - V3 new claim during synthesis (UC-7 and UC-E7 wiring, AC-09.3, AC-08.3): with verify rounds left -> synthesis returns `needs_verification`, the controller decides `requestVerification` then `proposeAnswer` again and the claim ends in `established` or `insufficient` by the records;
  //   with rounds exhausted (`maxVerifyRounds` reached, `requestVerification` no longer admissible) -> the claim is in `assumed` with `verified` false, never in `established`, and its latest revision is `insufficient` or `unverified`, never `supported`
  // V1 follows design-engine.md v1.12: the failing connected source answers its snapshot and loses every call of one tool, so its fetch task
  //   exists and fails (DC-10); a source whose snapshot cannot be read creates no task (KD-10, DC-20) and is proven by the unit row in
  //   capability-registry.spec.ts. A verified revision keeps its basis in `evidenceIds`, its scope in `coverage` and a verdict per atom in `atoms`.
  describe('INT-3', () => {
    let harness: EngineHarness;
    /** V3 (AC-09.3, AC-08.3): the shipped process without verification rounds, so a new claim cannot be verified. */
    const NO_VERIFY_ROUNDS_PROCESS = 'no-verify-rounds';

    beforeAll(async () => {
      const shipped = deepResearchProcessV1 as { readonly limits: Readonly<Record<string, unknown>> };
      const noVerifyRounds = { ...shipped, processId: NO_VERIFY_ROUNDS_PROCESS, limits: { ...shipped.limits, maxVerifyRounds: 0 } };
      harness = await createEngineHarness({ processes: [deepResearchProcessV1, noVerifyRounds] });
    });

    afterAll(async () => {
      await harness?.close();
      await closeEngineDb();
    });

    beforeEach(() => {
      harness.model.reset();
      harness.countingSource.calls.length = 0;
    });

    afterEach(async () => {
      try {
        expect(harness.model.pending()).toEqual({ plan: 0, controller: 0, worker: 0, verifier: 0, synthesis: 0 });
      } finally {
        harness.countingSource.failCalls(null);
        await harness.cancelStarted();
      }
    });

    it('INT-3 V1: a verification round appends supported and insufficient revisions from fetched source records (a failed collection gives insufficient, not refuted) and leaves the earlier revisions untouched, and a failing connected source keeps the investigation in the sources mode', async () => {
      const trace = 'c'.repeat(32);
      const record = { ts: '2026-10-01T12:05:00.000Z', service: 'payments', level: 'error', event: 'refund', traceId: trace, status: 'error' };
      harness.countingSource.answerWith(() => [record]);
      // The connected source stops answering aggregate_logs; its snapshot still reads, so the fetch task exists and fails.
      harness.countingSource.failCalls((call) => call.toolName === 'aggregate_logs');
      let claimIds: string[] = [];
      const claimsWritten = latch();
      harness.model.script(
        'controller',
        {
          output: {
            kind: 'requestAnalysis',
            rationale: 'find the failing refunds',
            subquestions: [{ text: 'V1: which refunds failed?', sourceId: 'fixture', toolName: 'search_logs', args: { service: 'payments' }, completeness: 'all' }],
          },
        },
        { output: () => ({ kind: 'requestVerification', rationale: 'check both claims', claimIds }), holdUntil: claimsWritten.wait },
        { output: { kind: 'concludeInconclusive', rationale: 'scripted conclusion' } },
      );
      harness.model.script('worker', {
        output: {
          claims: [
            { text: 'the refund trace failed in payments', atoms: [{ kind: 'traceId', value: trace }, { kind: 'service', value: 'payments' }], evidenceIds: [] },
            { text: 'payments logged 42 errors', atoms: [{ kind: 'service', value: 'payments' }, { kind: 'number', value: '42' }], evidenceIds: [] },
          ],
        },
      });
      harness.model.script('verifier', {
        output: () => ({
          requests: [
            { claimIds: [claimIds[0]], sourceId: 'fixture', toolName: 'get_trace', args: { traceId: trace } },
            { claimIds: [claimIds[1]], sourceId: 'fixture', toolName: 'aggregate_logs', args: { service: 'payments', groupBy: 'service' } },
          ],
        }),
      });
      try {
        const resourceId = newUser();
        const threadId = await harness.createThread(resourceId);
        const started = await harness.engine.startInvestigation({
          resourceId,
          threadId,
          query: 'V1: why did the refunds fail?',
          processId: 'deep-research',
          launchKey: newLaunchKey(),
        });
        if (started.outcome === 'rejected') throw new Error(`start refused: ${started.code}`);
        const { investigationId } = started;
        const earlier = await vi.waitFor(
          async () => {
            const { claims } = await engineRowsOf(investigationId);
            if (claims.length < 2) throw new Error('the worker claims are not written yet');
            // One transaction writes both: their order is the worker's output order.
            return claims.sort((left, right) => left.claimIndex - right.claimIndex);
          },
          { timeout: 20_000, interval: 50 },
        );
        claimIds = earlier.map((row) => row.claimId);
        const versionsBefore = await rowVersionsOf(investigationId);
        claimsWritten.open();
        const done = await vi.waitFor(
          async () => {
            const read = await harness.engine.readInvestigation({ investigationId, resourceId });
            if (read.outcome !== 'found' || read.view.status === 'running') throw new Error('the investigation is still running');
            return read.view;
          },
          { timeout: 20_000, interval: 50 },
        );

        const tasks = await tasksOf(investigationId);
        const toolOf = (task: (typeof tasks)[number]) => (task.input as { toolName?: string }).toolName;
        const verify = tasks.find((task) => task.workflowType === 'research.verify')!;
        const traceFetch = tasks.find((task) => task.workflowType === 'source.fetch' && toolOf(task) === 'get_trace')!;
        const aggregateFetch = tasks.find((task) => task.workflowType === 'source.fetch' && toolOf(task) === 'aggregate_logs')!;
        // Runtime settings: three reservations of the verifier call (32 000 + 1 600 + 4 000), 1 tool call, 0 retries.
        expect(verify).toMatchObject({ status: 'succeeded', maxTokens: 112_800, maxToolCalls: 1, maxRetries: 0 });
        expect(traceFetch).toMatchObject({ status: 'succeeded' });
        expect(aggregateFetch).toMatchObject({ status: 'failed', failureReason: { class: 'transport_protocol' } });
        // AC-25.3: the failing connected source does not switch the mode; the answer carries the supported claim with its evidence, no model-knowledge mark.
        expect(done).toMatchObject({ status: 'completed', sourceMode: 'sources', answer: { outcome: 'inconclusive', stopReason: null, assumed: [] } });

        const { claims: rows, decisions, llmCalls } = await engineRowsOf(investigationId);
        // Revisions in the order they were appended: the worker's, then the round's, each by its number in its task.
        const claims = rows.sort((left, right) => Number(left.taskId === verify.taskId) - Number(right.taskId === verify.taskId) || left.claimIndex - right.claimIndex);
        expect(claims.map((row) => [row.claimId, row.taskId, row.status, row.atoms, row.evidenceIds])).toEqual([
          [claimIds[0], earlier[0]!.taskId, 'unverified', [{ kind: 'traceId', value: trace }, { kind: 'service', value: 'payments' }], []],
          [claimIds[1], earlier[1]!.taskId, 'unverified', [{ kind: 'service', value: 'payments' }, { kind: 'number', value: '42' }], []],
          [
            claimIds[0],
            verify.taskId,
            'supported',
            [{ kind: 'traceId', value: trace, verdict: 'found' }, { kind: 'service', value: 'payments', verdict: 'found' }],
            traceFetch.outputRefs,
          ],
          // DC-10: the failed collection gave no record, so its atoms are missing — insufficient, never refuted.
          [
            claimIds[1],
            verify.taskId,
            'insufficient',
            [{ kind: 'service', value: 'payments', verdict: 'missing' }, { kind: 'number', value: '42', verdict: 'missing' }],
            [],
          ],
        ]);
        expect(done.answer!.established).toEqual([
          { claimId: claimIds[0], text: 'the refund trace failed in payments', evidenceIds: traceFetch.outputRefs, verified: true },
        ]);
        expect(claims[2]!.coverage).toMatchObject({ completeness: 'complete', returned: 1 });
        expect(claims[3]!.coverage).toBeNull();
        expect(verify.outcome).toMatchObject({
          answerOrDelta: {
            verdicts: [
              { claimId: claimIds[0], status: 'supported', missingAtoms: [] },
              { claimId: claimIds[1], status: 'insufficient', missingAtoms: [{ kind: 'service', value: 'payments' }, { kind: 'number', value: '42' }] },
            ],
          },
        });
        // Invariant 9: the earlier revisions are the same rows, never rewritten.
        const versionsAfter = await rowVersionsOf(investigationId);
        for (const row of earlier) {
          const key = `research_claims:${row.claimRevisionId}`;
          expect(versionsAfter.get(key)).toBe(versionsBefore.get(key));
        }
        // The round is counted on its accepted decision and its one task.
        expect(decisions.filter((row) => row.status === 'accepted').map((row) => [row.kind, row.proposedTaskIds.length])).toEqual([
          ['requestAnalysis', 2],
          ['requestVerification', 1],
          ['concludeInconclusive', 0],
        ]);
        expect(decisions[1]!.proposedTaskIds).toEqual([verify.taskId]);
        expect(llmCalls.filter((row) => row.taskId === verify.taskId).map((row) => [row.role, row.status])).toEqual([['verifier', 'settled']]);
        expect(harness.model.callsOf('verifier')[0]!.user).toContain(claimIds[1]);
      } finally {
        claimsWritten.open();
      }
    }, 30_000);
    /** Starts an investigation in a new thread of `resourceId` (a new user by default) on `processId`. */
    async function start(query: string, options: { readonly processId?: string; readonly resourceId?: string } = {}) {
      const resourceId = options.resourceId ?? newUser();
      const threadId = await harness.createThread(resourceId);
      const started = await harness.engine.startInvestigation({
        resourceId,
        threadId,
        query,
        processId: options.processId ?? 'deep-research',
        launchKey: newLaunchKey(),
      });
      if (started.outcome === 'rejected') throw new Error(`start refused: ${started.code}`);
      return { investigationId: started.investigationId, resourceId };
    }

    /** Waits for the terminal status of the investigation (rule 9: each test waits for its own). */
    function finished(investigationId: string, resourceId: string): Promise<InvestigationView> {
      return vi.waitFor(
        async () => {
          const read = await harness.engine.readInvestigation({ investigationId, resourceId });
          if (read.outcome !== 'found' || read.view.status === 'running') throw new Error('the investigation is still running');
          return read.view;
        },
        { timeout: 20_000, interval: 50 },
      );
    }

    /** The evidence of the investigation's succeeded `source.fetch` task with `toolName`, once it exists. */
    function fetchedEvidence(investigationId: string, toolName: string): Promise<string[]> {
      return vi.waitFor(
        async () => {
          const fetch = (await tasksOf(investigationId)).find(
            (task) =>
              task.workflowType === 'source.fetch' && (task.input as { toolName?: string }).toolName === toolName && task.status === 'succeeded',
          );
          if (fetch === undefined) throw new Error(`no ${toolName} evidence yet`);
          return fetch.outputRefs;
        },
        { timeout: 20_000, interval: 50 },
      );
    }

    /** The claim ids the investigation's task of `workflowType` wrote, in its output order, once written. */
    function claimsWrittenBy(investigationId: string, workflowType: string): Promise<string[]> {
      return vi.waitFor(
        async () => {
          const task = (await tasksOf(investigationId)).find((candidate) => candidate.workflowType === workflowType);
          const { claims } = await engineRowsOf(investigationId);
          const written = claims.filter((row) => row.taskId === task?.taskId).sort((left, right) => left.claimIndex - right.claimIndex);
          if (written.length === 0) throw new Error(`no claim of ${workflowType} yet`);
          return written.map((row) => row.claimId);
        },
        { timeout: 20_000, interval: 50 },
      );
    }

    const trace = 'd'.repeat(32);
    const traceRecord = { ts: '2026-10-01T12:05:00.000Z', service: 'payments', level: 'error', event: 'refund', traceId: trace, status: 'error' };
    const searchPayments = { kind: 'requestEvidence', sourceId: 'fixture', toolName: 'search_logs', args: { service: 'payments' }, completeness: 'all' };
    const traceAtoms = [{ kind: 'traceId', value: trace }];

    it('INT-3 V2: the reference gateway removes claims citing another investigation\'s or unknown evidence, and each established claim resolves to evidence with all provenance fields; another owner cannot read the investigation', async () => {
      harness.countingSource.answerWith(() => [traceRecord]);
      const claimsWritten = latch();
      const verified = latch();
      let claimIds: string[] = [];
      let basis: string[] = [];
      let foreign: string[] = [];
      const unknownEvidence = randomUUID();
      harness.model.script(
        'controller',
        // The other investigation of the same owner: one collection, then the conclusion.
        { output: { ...searchPayments, rationale: 'collect the refunds' } },
        { output: { kind: 'concludeInconclusive', rationale: 'scripted conclusion' } },
        {
          output: {
            kind: 'requestAnalysis',
            rationale: 'find the failing refund',
            subquestions: [{ text: 'V2: which refund failed?', sourceId: 'fixture', toolName: 'search_logs', args: { service: 'payments' }, completeness: 'all' }],
          },
        },
        { output: () => ({ kind: 'requestVerification', rationale: 'check the claim', claimIds }), holdUntil: claimsWritten.wait },
        { output: { kind: 'proposeAnswer', rationale: 'the claim is verified' }, holdUntil: verified.wait },
      );
      harness.model.script('worker', { output: { claims: [{ text: 'the refund trace failed', atoms: traceAtoms, evidenceIds: [] }] } });
      harness.model.script('verifier', {
        output: () => ({ requests: [{ claimIds, sourceId: 'fixture', toolName: 'get_trace', args: { traceId: trace } }] }),
      });
      harness.model.script('synthesis', {
        output: () => ({
          outcome: 'answered',
          summary: 'the refund failed in payments',
          claims: [
            { claimId: claimIds[0], text: 'the refund trace failed', atoms: traceAtoms, evidenceIds: basis },
            { claimId: null, text: 'cited from another investigation', atoms: traceAtoms, evidenceIds: foreign },
            { claimId: null, text: 'cited from nowhere', atoms: traceAtoms, evidenceIds: [unknownEvidence] },
          ],
        }),
      });
      try {
        const other = await start('V2: the other investigation');
        await finished(other.investigationId, other.resourceId);
        foreign = await fetchedEvidence(other.investigationId, 'search_logs');
        // The same owner: the reader finds the other investigation's evidence, so only the ownership check removes it.
        const { investigationId, resourceId } = await start('V2: why did the refund fail?', { resourceId: other.resourceId });
        claimIds = await claimsWrittenBy(investigationId, 'research.analyze');
        claimsWritten.open();
        basis = await fetchedEvidence(investigationId, 'get_trace');
        verified.open();
        const done = await finished(investigationId, resourceId);

        // The sections in the order of the configuration (ProcessConfig `answer`).
        expect(Object.keys(done.answer!)).toEqual(['answerId', 'outcome', 'stopReason', 'summary', 'established', 'assumed', 'unknown', 'removed']);
        expect(done).toMatchObject({
          status: 'completed',
          sourceMode: 'sources',
          answer: {
            outcome: 'answered',
            stopReason: null,
            summary: 'the refund failed in payments',
            established: [{ claimId: claimIds[0], text: 'the refund trace failed', evidenceIds: basis, verified: true }],
            assumed: [],
            unknown: [],
            removed: [
              { claimId: expect.any(String), text: 'cited from another investigation', reason: 'foreign_evidence' },
              { claimId: expect.any(String), text: 'cited from nowhere', reason: 'evidence_not_found' },
            ],
          },
        });
        // AC-09.2: every established reference is evidence of a task of this investigation with all provenance fields.
        const own = new Set((await tasksOf(investigationId)).map((task) => task.taskId));
        for (const evidenceId of done.answer!.established!.flatMap((claim) => claim.evidenceIds)) {
          const { record } = await harness.runtime.evidence.get(evidenceId, resourceId);
          expect(own.has(record.taskId)).toBe(true);
          expect(record.provenance).toEqual({ sourceId: 'fixture', toolName: 'get_trace', normalizedArgs: { traceId: trace, cursor: null }, snapshot: 'counting-v1' });
        }
        // Runtime settings: three reservations of the synthesis call (48 000 + 2 400 + 8 000); its prompt names the mode.
        const synthesis = (await tasksOf(investigationId)).find((task) => task.workflowType === 'research.synthesize');
        expect(synthesis).toMatchObject({ status: 'succeeded', maxTokens: 175_200, maxToolCalls: 1, maxRetries: 0 });
        expect(harness.model.callsOf('synthesis')[0]!.system).toContain('Source mode: sources.');
        expect(await harness.engine.readInvestigation({ investigationId, resourceId: newUser() })).toEqual({
          outcome: 'rejected',
          code: 'investigation_not_found',
        });
      } finally {
        claimsWritten.open();
        verified.open();
      }
    }, 60_000);

    it('INT-3 V3: a new claim made during synthesis is verified before delivery while rounds remain, and is delivered as assumed and unverified, never established, when they are exhausted', async () => {
      harness.countingSource.answerWith(() => [traceRecord]);
      const collected = latch();
      const newClaimWritten = latch();
      const exhaustedCollected = latch();
      let evidence: string[] = [];
      let newClaimIds: string[] = [];
      let exhaustedEvidence: string[] = [];
      const newClaim = (evidenceIds: string[]) => ({ claimId: null, text: 'the refund trace failed', atoms: traceAtoms, evidenceIds });
      harness.model.script(
        'controller',
        { output: { ...searchPayments, rationale: 'collect the refunds' } },
        { output: { kind: 'proposeAnswer', rationale: 'answer from the records' }, holdUntil: collected.wait },
        { output: () => ({ kind: 'requestVerification', rationale: 'verify the new claim', claimIds: newClaimIds }), holdUntil: newClaimWritten.wait },
        { output: { kind: 'proposeAnswer', rationale: 'the new claim is verified' } },
        // The process without verification rounds.
        { output: { ...searchPayments, rationale: 'collect the refunds' } },
        { output: { kind: 'proposeAnswer', rationale: 'answer from the records' }, holdUntil: exhaustedCollected.wait },
      );
      harness.model.script('verifier', {
        output: () => ({ requests: [{ claimIds: newClaimIds, sourceId: 'fixture', toolName: 'get_trace', args: { traceId: trace } }] }),
      });
      harness.model.script(
        'synthesis',
        { output: () => ({ outcome: 'answered', summary: 'first draft', claims: [newClaim(evidence)] }) },
        { output: () => ({ outcome: 'answered', summary: 'verified', claims: [{ ...newClaim(evidence), claimId: newClaimIds[0] }] }) },
        { output: () => ({ outcome: 'answered', summary: 'unverified', claims: [newClaim(exhaustedEvidence)] }) },
      );
      try {
        // Rounds left: needs_verification, a round, then the answer proposed again.
        const left = await start('V3: why did the refund fail?');
        evidence = await fetchedEvidence(left.investigationId, 'search_logs');
        collected.open();
        newClaimIds = await claimsWrittenBy(left.investigationId, 'research.synthesize');
        newClaimWritten.open();
        const verifiedView = await finished(left.investigationId, left.resourceId);

        const tasks = await tasksOf(left.investigationId);
        const syntheses = tasks.filter((task) => task.workflowType === 'research.synthesize');
        const verify = tasks.find((task) => task.workflowType === 'research.verify')!;
        // Error handling: needs_verification is a sign in the outcome of a succeeded task, not a failure.
        expect(syntheses.map((task) => [task.status, task.outcome])).toMatchObject([
          ['succeeded', { answerOrDelta: { needsVerification: { claimIds: newClaimIds } } }],
          ['succeeded', { answerOrDelta: { answerId: verifiedView.answer!.answerId, outcome: 'answered' } }],
        ]);
        // The controller observed the sign before it asked for the round.
        expect(harness.model.callsOf('controller')[2]!.user).toContain(`"needsVerification":{"claimIds":["${newClaimIds[0]}"]}`);
        const { decisions, claims } = await engineRowsOf(left.investigationId);
        expect(decisions.filter((row) => row.status === 'accepted').map((row) => row.kind)).toEqual([
          'requestEvidence',
          'proposeAnswer',
          'requestVerification',
          'proposeAnswer',
        ]);
        expect(claims.map((row) => [row.claimId, row.taskId, row.status])).toEqual([
          [newClaimIds[0], syntheses[0]!.taskId, 'unverified'],
          [newClaimIds[0], verify.taskId, 'supported'],
        ]);
        expect(verifiedView.answer).toMatchObject({
          outcome: 'answered',
          established: [{ claimId: newClaimIds[0], evidenceIds: evidence, verified: true }],
          assumed: [],
        });

        // Rounds exhausted (`maxVerifyRounds` 0): the new claim is assumed and unverified, and the answer inconclusive (DC-11).
        const exhausted = await start('V3: why did the refund fail, without rounds?', { processId: NO_VERIFY_ROUNDS_PROCESS });
        exhaustedEvidence = await fetchedEvidence(exhausted.investigationId, 'search_logs');
        exhaustedCollected.open();
        const assumedView = await finished(exhausted.investigationId, exhausted.resourceId);
        const [written, ...others] = (await engineRowsOf(exhausted.investigationId)).claims;
        expect(others).toEqual([]);
        expect(written).toMatchObject({ status: 'unverified' });
        expect(assumedView.answer).toMatchObject({
          outcome: 'inconclusive',
          stopReason: null,
          established: [],
          assumed: [{ claimId: written!.claimId, text: 'the refund trace failed', evidenceIds: exhaustedEvidence, verified: false }],
        });
      } finally {
        collected.open();
        newClaimWritten.open();
        exhaustedCollected.open();
      }
    }, 60_000);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4  Zombie attempt: a lost attempt writes nothing, and the next attempt replays the model answer from the checkpoint without a copy   [EXTRA: budget slot 4 of 5]
  // ---------------------------------------------------------------------------------------------------------------
  // Unique defect no other test catches: an engine write path that bypasses `TaskContext.withAttemptGuard` (a decision, a claim revision, an answer or a reservation closure written by an attempt that has already lost the task), or a replayed write
  // that is not idempotent (a second claim revision or a second accepted decision after the next attempt re-reads the checkpoint). The runtime suite proves the guard primitive with its own client table, not that the engine uses it for every write; the E2E
  // kill matrix kills the process, so no live zombie exists there; INT-1..INT-3 never lose an attempt.
  //
  // Covers (original statements):
  // NFR-03 (restart does not lose or duplicate a step), invariant 3 of the Design Doc: "Запись движка, порождённая ответом модели — решение, ревизия утверждения, ответ, закрытие резерва — принимается, только пока задача running и её attempt равен попытке писавшего."
  // UC-E9 third scenario (Design Doc): "в третьем попытка воркера потеряла задачу и пишет утверждения после захвата следующей попыткой" -> "утверждения потерянной попытки не записаны".
  // Use cases: UC-E9 (third scenario). Flow 1 (last failure bullet). Data Model: `research_claims` uniqueness by writing task and claim ordinal; `research_decisions` one accepted decision per step.
  //
  // Primary failure mode (turns red when): after the lease of attempt 1 is taken by attempt 2, attempt 1's late write adds a row to any of the six `research_*` tables, or attempt 2 calls the model again instead of reading the checkpoint,
  // or the replayed write adds a second revision or a second accepted decision.
  // Behavior: attempt 1 gets the model answer and saves it to the checkpoint -> lease moves to attempt 2 -> attempt 1 tries its guarded write -> `fenced`, nothing written -> attempt 2 reads the checkpoint, writes once, and a repeated write adds nothing
  // @category: edge-case
  // @dependency: research.analyze, ControllerHandler, TaskContext.withAttemptGuard (runtime), saveCheckpoint, research_claims, research_decisions, research_llm_calls, injected clock and lease, Postgres
  // @complexity: high
  //
  // Verification items (before/after row-version snapshots of all six tables, not logs):
  // - Z1 worker claims (UC-E9 third scenario): attempt 1 of `research.analyze` has the model answer in the checkpoint, the lease is taken by attempt 2; attempt 1's claim write and reservation closure -> `fenced`, zero rows changed;
  //   attempt 2 makes zero model calls (the double's call count stays 1), writes the claim revisions once; running attempt 2's write a second time leaves the row count unchanged
  // - Z2 controller decision: the same takeover for `research.controller` after the decision was produced and checkpointed -> the late decision write of attempt 1 is `fenced`; attempt 2 ends with exactly one accepted decision for the step
  //   and tasks proposed once (second `propose` answers `subscribed`)
  // The zombie is held right before the write under test (the harness's `handlerHold`: after its checkpoint, or after the guarded write before
  //   it returned, so the hold does not depend on how the write under test is made), its lease is moved back on the harness clock, and the next
  //   attempt is held as it starts: the snapshot is taken with both attempts held, so only the zombie can change a row before it is compared.
  //   The zombie's `run` ending and the runtime fencing its outcome say it is done.
  // - Z1 runs two rows, one per write of the worker after its checkpoint: `close` (the zombie holds an open reservation, which the next attempt
  //   closes `abandoned`, charged in full: DC-9 close point 1) and `claims` (the zombie settled its reservation before it lost the task);
  //   the `claims` row also loses attempt 2 after its write, so attempt 3 replays the same answer and repeats the write.
  // - Z2 holds the controller before its decision write; the decision's tasks are proposed only by attempt 2, which applies the replayed decision.
  describe('INT-4', () => {
    const ANALYZE = 'research.analyze';
    const CONTROLLER = 'research.controller';
    let harness: EngineHarness;

    beforeAll(async () => {
      // A lease is lost only when a test moves it back: no heartbeat beats within a test, the sweeper runs every 50 ms.
      harness = await createEngineHarness({
        runtime: { concurrency: 4, dbPoolMax: 10, leaseMs: 60_000, heartbeatMs: 60_000, reaperMs: 50 },
      });
    });

    afterAll(async () => {
      await harness?.close();
      await closeEngineDb();
    });

    beforeEach(() => {
      harness.model.reset();
      harness.countingSource.calls.length = 0;
    });

    afterEach(async () => {
      try {
        expect(harness.model.pending()).toEqual({ plan: 0, controller: 0, worker: 0, verifier: 0, synthesis: 0 });
      } finally {
        harness.handlerHold.at = undefined;
        await harness.cancelStarted();
      }
    });

    const conclude = { output: { kind: 'concludeInconclusive', rationale: 'scripted conclusion' } };
    const analysisOf = (subquestion: string) => ({
      output: {
        kind: 'requestAnalysis',
        rationale: 'look at the failing service',
        subquestions: [{ text: subquestion, sourceId: 'fixture', toolName: 'search_logs', args: { service: 'service-0' }, completeness: 'all' }],
      },
    });

    async function startDeepResearch(query: string) {
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);
      const result = await harness.engine.startInvestigation({
        resourceId,
        threadId,
        query,
        processId: 'deep-research',
        launchKey: newLaunchKey(),
      });
      if (result.outcome === 'rejected') throw new Error(`start refused: ${result.code}`);
      return { resourceId, investigationId: result.investigationId };
    }

    function finished(investigationId: string, resourceId: string): Promise<InvestigationView> {
      return vi.waitFor(
        async () => {
          const read = await harness.engine.readInvestigation({ investigationId, resourceId });
          if (read.outcome !== 'found') throw new Error(`investigation ${investigationId} not found`);
          if (read.view.status === 'running') throw new Error(`investigation ${investigationId} is still running`);
          return read.view;
        },
        { timeout: 30_000, interval: 50 },
      );
    }

    /**
     * Holds the first handler point `match` accepts until `release`; `reached()` settles with that point once it is held,
     * and fails when no attempt reaches it within 10 s.
     */
    function holdAt(what: string, match: (point: HandlerPoint) => boolean) {
      const release = latch();
      let reach!: (point: HandlerPoint) => void;
      const heldPoint = new Promise<HandlerPoint>((resolve) => {
        reach = resolve;
      });
      let held = false;
      return {
        reached: async (): Promise<HandlerPoint> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${what} was not reached within 10 s`)), 10_000);
          });
          try {
            return await Promise.race([heldPoint, timeout]);
          } finally {
            clearTimeout(timer);
          }
        },
        release: release.open,
        async visit(point: HandlerPoint): Promise<void> {
          if (held || !match(point)) return;
          held = true;
          reach(point);
          await release.wait;
        },
      };
    }
    type Hold = ReturnType<typeof holdAt>;

    const holding = (...holds: Hold[]): void => {
      harness.handlerHold.at = async (point) => {
        for (const hold of holds) await hold.visit(point);
      };
    };

    const startOf = (workflowType: string, attempt: number) => (point: HandlerPoint) =>
      point.at === 'run' && point.workflowType === workflowType && point.attempt === attempt;

    /**
     * The point of an attempt once it saved the model answer of `call` to its checkpoint and then returned from `guarded`
     * guarded writes; with 0, the checkpoint itself.
     */
    function afterCheckpoint(workflowType: string, attempt: number, call: string, guarded: number) {
      let returned: number | undefined;
      return (point: HandlerPoint): boolean => {
        if (point.workflowType !== workflowType || point.attempt !== attempt) return false;
        if (point.at === 'checkpoint' && (point.checkpoint as { call?: unknown }).call === call) {
          returned = 0;
          return guarded === 0;
        }
        if (point.at !== 'guarded' || returned === undefined) return false;
        returned += 1;
        return returned === guarded;
      };
    }

    /** The runtime found the attempt superseded when it came to write its outcome, and wrote nothing. */
    function outcomeFenced(taskId: string, attempt: number): Promise<void> {
      return vi.waitFor(
        () => {
          const logged = harness.logs.runtime.warn.some(
            ([message]) => message.startsWith('fenced outcome') && message.includes(`taskId=${taskId} attempt=${attempt}`),
          );
          if (!logged) throw new Error(`the outcome of ${taskId} attempt ${attempt} is not settled yet`);
        },
        { timeout: 10_000, interval: 20 },
      );
    }

    /**
     * The takeover of a held `zombie` by the next attempt, held as it starts in `successor`: the zombie, let on, ends
     * without changing any row of the investigation. Returns the zombie's task.
     */
    async function zombieWritesNothing(investigationId: string, zombie: Hold, successor: Hold): Promise<string> {
      const { taskId, attempt } = await zombie.reached();
      await harness.expireLease(taskId, attempt);
      await successor.reached();
      const before = await rowVersionsOf(investigationId);

      zombie.release();
      await vi.waitFor(() => expect(harness.endedRuns).toContainEqual({ taskId, attempt }), { timeout: 10_000, interval: 20 });
      await outcomeFenced(taskId, attempt);

      expect(await rowVersionsOf(investigationId)).toEqual(before);
      return taskId;
    }

    it('INT-4 Z1: a worker attempt that lost its lease writes no claim or reservation closure, the next attempt replays the checkpointed answer without a model call, and a repeated write adds no revision', async () => {
      harness.countingSource.answerWith((call) => [{ service: call.args.service, level: 'error', message: 'lock wait timeout' }]);
      const workerAnswer = {
        output: {
          claims: [
            { text: 'service-0 timed out waiting for a lock', atoms: [{ kind: 'service', value: 'service-0' }], evidenceIds: [] },
            { text: 'the lock wait exceeded its timeout', atoms: [{ kind: 'event', value: 'lock wait timeout' }], evidenceIds: [] },
          ],
        },
      };
      // The writes of the worker after its checkpoint: the guarded close of its reservation, then the claims.
      for (const [row, guardedBefore] of [['close', 0], ['claims', 1]] as const) {
        harness.model.reset();
        harness.model.script('controller', analysisOf(`Z1 ${row}: what failed in service-0?`), conclude);
        harness.model.script('worker', workerAnswer);
        const zombie = holdAt(`attempt 1 before its ${row} write`, afterCheckpoint(ANALYZE, 1, 'analyze', guardedBefore));
        const second = holdAt('the start of attempt 2', startOf(ANALYZE, 2));
        // In the `claims` row attempt 2 is held after its write, and attempt 3 takes the task over and writes again.
        const secondWritten = holdAt(
          'the end of attempt 2',
          (point) => row === 'claims' && point.at === 'end' && point.workflowType === ANALYZE && point.attempt === 2,
        );
        holding(zombie, second, secondWritten);
        try {
          const { resourceId, investigationId } = await startDeepResearch(`Z1 ${row}: why do the lock waits time out?`);
          const taskId = await zombieWritesNothing(investigationId, zombie, second);
          second.release();

          let firstWrite: unknown[] = [];
          if (row === 'claims') {
            await secondWritten.reached();
            firstWrite = (await engineRowsOf(investigationId)).claims;
            await harness.expireLease(taskId, 2);
            await vi.waitFor(
              async () =>
                expect((await tasksOf(investigationId)).find((task) => task.taskId === taskId)).toMatchObject({
                  status: 'succeeded',
                  attempt: 3,
                }),
              { timeout: 10_000, interval: 50 },
            );
            secondWritten.release();
            await outcomeFenced(taskId, 2);
          }

          expect(await finished(investigationId, resourceId)).toMatchObject({ status: 'completed', answer: { outcome: 'inconclusive' } });
          // The worker model was called once, by attempt 1: the next attempts took its answer from the checkpoint.
          expect(harness.model.callsOf('worker')).toHaveLength(1);
          expect(harness.model.pending()).toEqual({ plan: 0, controller: 0, worker: 0, verifier: 0, synthesis: 0 });
          const { run, claims: unordered, llmCalls } = await engineRowsOf(investigationId);
          // The revisions of one write share `createdAt`: by their number.
          const claims = [...unordered].sort((left, right) => left.claimIndex - right.claimIndex);
          const task = (await tasksOf(investigationId)).find((candidate) => candidate.taskId === taskId)!;
          expect(task).toMatchObject({ status: 'succeeded', attempt: row === 'claims' ? 3 : 2 });
          // The claims are written once and the task's outcome names them; in `claims` the repeated write of attempt 3 added nothing.
          expect(claims.map((claim) => [claim.taskId, claim.claimIndex, claim.status])).toEqual([
            [taskId, 0, 'unverified'],
            [taskId, 1, 'unverified'],
          ]);
          expect(task.outcome).toMatchObject({ answerOrDelta: { claimIds: claims.map((claim) => claim.claimId) } });
          if (row === 'claims') expect(unordered).toEqual(firstWrite);
          // `close`: attempt 1's fenced close left its reservation open, and attempt 2 closed it `abandoned`, charged in full (DC-9);
          // `claims`: attempt 1 settled it before it lost the task.
          const workerRows = llmCalls.filter((call) => call.taskId === taskId);
          expect(workerRows.map((call) => [call.attempt, call.status])).toEqual([[1, row === 'close' ? 'abandoned' : 'settled']]);
          if (row === 'close') expect(workerRows[0]!.chargedTokens).toBe(workerRows[0]!.reservedTokens);
          expect(llmCalls.filter((call) => call.status === 'reserved')).toEqual([]);
          expect(llmCalls.reduce((sum, call) => sum + (call.chargedTokens ?? 0), 0)).toBe(run!.tokensSpent);
        } finally {
          zombie.release();
          second.release();
          secondWritten.release();
        }
      }
    }, 60_000);

    it('INT-4 Z2: a controller attempt that lost its lease writes no decision, and the next attempt ends with exactly one accepted decision for the step and no duplicated task', async () => {
      harness.countingSource.answerWith((call) => [{ service: call.args.service, level: 'error', message: 'replica lag' }]);
      harness.model.script('controller', analysisOf('Z2: what failed in service-0?'), conclude);
      harness.model.script('worker', { output: { claims: [] } });
      // After the checkpoint of its first decision the controller closes its reservation (a guarded write), then writes the decision.
      const zombie = holdAt('attempt 1 before its decision write', afterCheckpoint(CONTROLLER, 1, 'decision:1:0', 1));
      const second = holdAt('the start of attempt 2', startOf(CONTROLLER, 2));
      holding(zombie, second);
      try {
        const { resourceId, investigationId } = await startDeepResearch('Z2: why do the replicas lag?');
        await zombieWritesNothing(investigationId, zombie, second);
        second.release();

        expect(await finished(investigationId, resourceId)).toMatchObject({ status: 'completed', answer: { outcome: 'inconclusive' } });
        // Two controller calls, one per step: attempt 2 took the decision of step 1 from the checkpoint.
        expect(harness.model.callsOf('controller')).toHaveLength(2);
        const { decisions } = await engineRowsOf(investigationId);
        expect(decisions.map((decision) => [decision.step, decision.callIndex, decision.status, decision.kind])).toEqual([
          [1, 0, 'accepted', 'requestAnalysis'],
          [2, 0, 'accepted', 'concludeInconclusive'],
        ]);
        // The decision's tasks are proposed once: one collection and one analysis, both recorded on the decision.
        const tasks = await tasksOf(investigationId);
        expect(tasks.map((task) => task.workflowType)).toEqual([CONTROLLER, 'source.fetch', ANALYZE]);
        expect(decisions[0]!.proposedTaskIds).toEqual(tasks.slice(1).map((task) => task.taskId));
      } finally {
        zombie.release();
        second.release();
      }
    }, 30_000);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Proven at unit level (named for the plan; generated as specs next to the code, not here). One table-driven spec per rule, cases as rows; fast-check where noted.
// ---------------------------------------------------------------------------------------------------------------
// - DecisionGate + admissible computation (table): decision outside the closed set, capability not enabled (DC-1), invalid structure, `maxFanOut` + 1 sub-questions (DC-6), `replan` at `maxPlanRevisions` leaving only requestVerification /
//   proposeAnswer / concludeInconclusive (AC-02.2, UC-E3), `noveltyWindow` steps without new evidence or revisions leaving only proposeAnswer / concludeInconclusive (AC-03.1, UC-E4 first scenario), a decision creating tasks refused when
//   `notAfter` is within 1 000 ms. AC-02.2, AC-03.1, DC-6.
// - ProcessConfig schema and loader (table, UC-E8, UC-10, UC-12): capability outside the registry, unknown key `script`, unknown field in a prompt template, tool outside the `source.fetch` allowlist (path of the error in the message), duplicate pair `processId` + `version`
//   (the error path names the repeated pair), role model absent from the model catalog; the deep-research configuration shipped as a data file passes the same loader. AC-12.2, AC-12.3, DC-14.
//   Rows added for the mode (UC-12 first half, no database, a recording logger double): `createEngine` with empty `connectedSources` accepts a configuration whose source is outside the allowlist, writes exactly one `warn` that the sources are not connected and
//   the investigations will run on model knowledge, and `Engine.sourceMode` is `model_knowledge`; the same configuration with a non-empty `connectedSources` is rejected by DC-14 with the error path, writes no such warning, and `Engine.sourceMode` is `sources`;
//   a connected source that is unreachable at run time does not change either value. AC-26.2, AC-26.3, AC-25.3 (mode half), DC-18, KD-8.
// - Process version resolution (rows of the same loader table, UC-10): versions 1 and 2 of one `processId` load side by side while a repeated version 1 is rejected; a start without a version resolves to the highest loaded (2, then 3 once 3 is loaded);
//   a start with an explicit version resolves exactly that one; a version or a `processId` that is not loaded answers `process_unknown`. DC-15 (resolution half; the recorded-version half is INT-1 C6).
// - ContextBuilder (table + fast-check property): input tokens of the packed prompt <= `windowTokens` for arbitrary evidence sizes (AC-06.1); mandatory evidence is never truncated and yields `needs_narrowing` with the material size (AC-06.2, DC-7);
//   a worker packet holds only its own sub-question and evidence, not the controller history or other workers' material (AC-05.2 isolation half); `windowTokens` read from the configuration changes the packing (AC-06.3);
//   optional claims go newest first until the window is full.
// - Claim verifier (table, UC-6): an atom (traceId, service, event, interval, number) absent from the records -> `insufficient`; a number equal to the aggregate -> `supported`; an interval contradicted by a fetched record -> `refuted`;
//   a claim backed only by a worker summary is never `supported` before source records arrive. AC-08.1, AC-08.2, DC-10 (comparison half).
// - Reference gateway (table, UC-7): claim without a reference, with an unknown reference, with another investigation's reference -> removed with a reason; a new claim -> `needs_verification` or `assumed`/unverified depending on rounds left; `established` holds only
//   `supported`; outcome `answered` without any `supported` claim is lowered to `inconclusive` (DC-11, mode `sources` only). AC-09.1 (rule), AC-09.3 (rule), DC-11.
//   Rows added for the mode `model_knowledge` (UC-11 rule half): every claim without a reference -> `assumed`, `verified` false, empty `evidenceIds`; a claim with any reference -> `removed` with `evidence_not_found`; at least one remaining claim -> outcome `answered`
//   (DC-11 not applied); a draft with no claim, or all removed -> `inconclusive`; `established` empty in every row. AC-25.1 (rule), AC-25.2 (rule), DC-17.
// - Code-built answers and plan seed of the no-source path (table over the pure builders, UC-11, UC-E11): a stop at `budget_exhausted`, `deadline` or `model_unavailable` before the synthesis ends -> answer with no claims, outcome `inconclusive`, that stop reason;
//   a configuration without the `plan` capability -> the first plan revision is the `goal` and there is no `plan` call; a configuration without `synthesize` -> answer by code, `inconclusive`, no stop reason. AC-25.5 (rule), KD-8.
// - Shell matching predicate (table, UC-E12): an investigation is taken by a retried start only when it has the same thread and owner, the same `query`, the same `maxTasks` and `maxToolCalls`, and no engine row; each differing field leaves it untouched. DC-19 (rule), KD-9.
// - Dedup key builder for gather descriptions (fast-check property): the same tool, arguments and snapshot always give the same key regardless of `rationale` text or argument key order (DC-4 key half).
// - Signal registry (table): kind lookup, payload schema per kind, a kind registered later is accepted without changing the DecisionInput shape (AC-04.2).
// - Cost calculation (table): catalog prices including the Haiku tier above 100 000 input tokens, cache read and write tokens (AC-11.1 price half).
// - Retry policy of ModelGateway (table): 429 / 5xx / network retried twice with a reservation per attempt; `refusal` stop reason and invalid structured output retried once then `invalid_model_output` (Error handling).
