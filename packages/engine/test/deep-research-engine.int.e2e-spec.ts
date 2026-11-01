// deep-research / engine Integration Test Skeletons - Design Doc: docs/features/deep-research/design-engine.md
// PRD: docs/features/deep-research/prd.md (FR-01..FR-12). ADRs: ADR-0001 (runtime owner), ADR-0003 (Drizzle data layer), ADR-0004 (engine package). UXRD: none (part without UI).
// Generated: 2026-11-01 | Part: engine | Test type: Integration (in-process runtime + engine + real Postgres, scripted model), CI job `e2e-engine`
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
//   is the independent counter for "no source call".
// - Isolation (project convention, no truncate): a unique `resourceId = 'e2e-' + randomUUID()` and a unique `launchKey` per test. The engine's handler types are fixed, so isolation by
//   `workflowType` is not available: this file runs with `fileParallelism: false`, owns the only runtime with engine handlers in the job, and each test waits for its own terminal status of `controllerTaskId`.
// - Clock, lease and backoff jitter are injected; `notAfter` and the lease are moved with the injected clock and by moving `lease_expires_at` back (as runtime INT-3 does). No sleeps for ordering.
// - Support to add with the package scaffold (not created here): test/support/engineHarness.ts (createDatabase + createRuntime + createEngine, scripted model, counting source, clock),
//   test/support/engineDb.ts (read-only snapshots of `research_*` rows and a row-version snapshot for "no row changed" checks).
//
// Budget: Integration 4 (limit 3; up to 5 under the integration-e2e-testing rule only when each extra test names the defect no other test catches).
//   INT-1..INT-3 are the core budget. INT-4 is the one extra; its unique defect is stated at its header. Table-driven rows keep the ACs of one rule or one flow in one test.
//
// Proven elsewhere (not in this file; see "Proven at unit level" at the end and the plan's traceability table "AC -> proving test"):
// - process-level: AC-05.1, AC-05.2, AC-05.3 (UC-2, UC-3), NFR-03 / DC-9 on a killed process (UC-E9 first two scenarios) - deep-research-engine.e2e-spec.ts
// - runtime port TaskContext.withAttemptGuard (design-runtime.md UC-E9 and variants): packages/runtime/test/research-runtime-runtime.int.e2e-spec.ts, INT-3 R8..R10
// - the runtime primitives the engine builds on (admission/dedup, wait/wake, fencing of putEvidence/saveCheckpoint, cancel, deadline): runtime and mcp-source suites, not repeated here

import { describe, it } from 'vitest';

describe('deep-research / engine - integration (in-process runtime + engine + real Postgres, scripted model)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  Controller loop: only accepted decisions create tasks, and every stop ends in an answer built by code
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
  // Use cases: UC-1, UC-4, UC-5, UC-9, UC-10 (recorded-version half), UC-E1, UC-E4 (deadline scenario), UC-E6 (controller scenario). Flow 1 (first half), Flow 2.
  //
  // Primary failure mode (turns red when): a rejected decision still proposes a task or calls the source; a step is executed twice or without a decision row; a decision's task is
  // not the capability it chose; a stop condition ends the controller task as `failed` without an answer; a replan with the same query calls the source again;
  // an investigation that survives an engine rebuild runs its next steps on the prompts of a newer loaded version instead of its recorded one (the frozen copy in `research_engine_runs` is not what the handlers read).
  // Behavior: scripted controller output -> DecisionGate verdict -> research_decisions row (accepted or refused with reason) -> tasks proposed through TaskScheduler (or none) -> runtime wakes the controller
  //   -> after the last step, or at any stop condition, one answer row built from the verified claims with the stop reason
  // @category: core-functionality
  // @dependency: ControllerHandler, ContextBuilder, ModelGateway, DecisionGate, CapabilityRegistry, TaskScheduler (runtime), source.fetch, research_decisions, research_signals, research_engine_runs, Postgres
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
  // - C5 forced stops end in a code-built answer (one row per reason; each asserts: reason in the answer, outcome `partial` if a supported claim exists else `inconclusive`, controller task `succeeded` with that `answerId`, the double got no call after the stop):
  //     controller_invalid (UC-E1, AC-01.2, AC-01.3, DC-2): decision outside the set, then an invalid structure, then outside the set with `maxDecisionRetries` 2 -> exactly 3 controller calls for the step, 3 refusals recorded with their reasons, zero tasks, zero source calls
  //     step_limit (AC-03.2): `maxSteps` 2 of the test configuration -> third step is not taken, stop reason `step_limit`
  //     deadline (UC-E4 third scenario, DC-3): analysis task claimed after its decision's `notAfter` -> the task fails with class `deadline` and the double got no call for it; the controller wakes and answers by code with `deadline`, it does not fail
  //     context_overflow (UC-E6 second scenario, DC-8): mandatory part of the controller input larger than its `windowTokens` -> the double is not called, stop reason `context_overflow`
  // - C6 recorded version survives an engine rebuild (UC-10, DC-15; unique defect: reading the live configuration list instead of the frozen copy, which only a persisted row and a second `createEngine` over the same database can show):
  //   engine built with versions 1 and 2 of one `processId` (different prompt text); investigation A started without a version, investigation B with version 1, both parked mid-run -> `readInvestigation` shows version 2 for A and 1 for B;
  //   the runtime is stopped and the engine rebuilt over the same database with versions 1, 2 and 3 -> both investigations reach an answer, the packets the double received for each carry the prompt text of its recorded version (A: 2, B: 1),
  //   and a new investigation started without a version records version 3. Which version a start picks and the duplicate-pair rejection are not repeated here: they are the loader spec
  // - Rows never re-check the variants of DecisionGate / config validation / admissible computation: one refused kind per wiring row proves the link, the rule table is a unit test
  describe('INT-1', () => {
    it.todo('INT-1 C1: two scripted decision chains execute exactly the chosen capabilities in the chosen order, each task traces to a decision, and every model call is made by its role\'s model');
    it.todo('INT-1 C2: a second configuration without verify and analyze refuses requestVerification, builds packets from its own prompts and windows, and ends in an answer without code changes');
    it.todo('INT-1 C3: replan with the same request and snapshot but another rationale creates a second plan revision and no second source call (propose answers subscribed)');
    it.todo('INT-1 C4: recorded signals appear in the next decision input and are referenced by the decision row; unknown kind, off-schema payload and another owner are refused and write nothing');
    it.todo('INT-1 C5: controller_invalid, step_limit, deadline and context_overflow each end the investigation with a code-built answer carrying the reason; invalid decisions create no task and no source call');
    it.todo('INT-1 C6: investigations started on versions 2 (no version given) and 1 finish on the prompts of their recorded versions after the engine is rebuilt with versions 1, 2 and 3, and a new start without a version records version 3');
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
  // Use cases: UC-8, UC-E2, UC-E5, UC-E10. Flow 1 (failure handling: budget, provider errors, cancel), Flow 2 (first failure bullet). Invariants 1, 2, 4.
  //
  // Primary failure mode (turns red when): a model call starts without a recorded reservation or beyond the remaining investigation budget or the task's `maxTokens`; the charged total differs from the sum of ledger rows;
  // a failed or cancelled call leaves a reservation `reserved`; a provider outage or an exhausted budget fails the controller instead of ending the investigation with an answer; a call starts after cancel.
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
  describe('INT-2', () => {
    it.todo('INT-2 L1: a task whose maxTokens is below its call fails with task_tokens_exhausted without calling the model, and its sibling task continues');
    it.todo('INT-2 L2: an exhausted investigation budget starts no further call, stops with budget_exhausted and answers with the claims verified before, spending no more than the budget');
    it.todo('INT-2 L3: after all roles move to one model by configuration, the ledger sum equals the charged total, usage is split by role and model, and each row keeps counted and actual input');
    it.todo('INT-2 L4: a provider outage gives the worker 3 calls then model_unavailable, closes each failed reservation as failed, and ends the investigation with an answer by code');
    it.todo('INT-2 L5: after cancel no reservation and no source call start, the in-flight reservation is closed abandoned and the ledger sum still equals the charged total');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  Claims and the answer: only what the source records support is established, and every claim leads to this investigation's evidence
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-08.1: "Given утверждение называет число или идентификатор, которого нет в цитируемом evidence, Then код помечает его refuted или insufficient, и в ответ оно не попадает как установленное." (here: the failed-collection half, DC-10)
  // AC-08.3: "Given лимит циклов проверки исчерпан без подтверждения, Then утверждение insufficient и никогда не становится supported автоматически."
  // AC-09.1: "Given черновик ответа содержит утверждение без ссылки, со ссылкой на несуществующее evidence или на evidence другого расследования, Then это утверждение удалено из ответа до выдачи, а удаление записано в ходе расследования." (here: the real EvidenceReader half)
  // AC-09.2: "Given выданный ответ, Then каждое его утверждение ведёт к evidence со всеми полями provenance."
  // AC-09.3: "Given при написании ответа появилось новое существенное утверждение, When циклы проверки (FR-08) ещё остались, Then оно проверяется до выдачи; When циклов не осталось, Then оно выдаётся как предположенное и помечено как непроверенное. Как установленное оно не выдаётся ни в одном случае."
  // DC-10 (FR-08): "refuted ставится только тогда, когда полученная исходная запись противоречит атому; отсутствие атома или провал задачи сбора дают insufficient."
  // Use cases: UC-6 (wiring half), UC-7 (wiring half), UC-E7. Flow 3, Flow 4. Invariants 7, 8, 9.
  //
  // Primary failure mode (turns red when): a claim reaches `established` without all atoms found in this investigation's source records (a worker summary is enough, or a failed collection counts as found);
  // evidence of another investigation or an unknown id survives the reference gateway; a status change overwrites the earlier revision instead of appending; the verify loop never ends or ends without a round counted.
  // Behavior: worker claims (unverified) -> verifier picks records -> research.verify proposes source.fetch tasks and waits through the runtime -> code compares atoms to the fetched records -> new revision rows;
  //   synthesis draft -> reference gateway over EvidenceReader -> answer rows (established / assumed / removed); a new claim with rounds left returns needs_verification and the controller verifies and proposes the answer again
  // @category: core-functionality
  // @dependency: research.verify, research.synthesize, CapabilityRegistry, EvidenceReader, source.fetch (counting adapter), research_claims, research_engine_runs, Postgres
  // @complexity: high
  //
  // Verification items (table):
  // - V1 verification round through the runtime (UC-6 wiring, AC-08.1 failed-collection half, DC-10): two claims -> the first has all atoms in the records returned by a fetch task -> new revision `supported` with basis and scope;
  //   the second depends on a fetch task that the adapter fails -> new revision `insufficient` listing the missing atoms, not `refuted`; the earlier `unverified` revisions are byte-identical after the round (row-version snapshot), the verify task `succeeded`
  // - V2 gateway over the real reader (UC-7 wiring, AC-09.1, AC-09.2): a draft with a claim citing evidence of another investigation of the same user, a claim citing an id that does not exist and a claim citing this investigation's evidence of a `supported` claim ->
  //   the first two are in `answer.removed` with their reasons, the third in `established` and `EvidenceReader.get` returns every provenance field for each of its evidence ids; `readInvestigation` by another `resourceId` -> `investigation_not_found`
  // - V3 new claim during synthesis (UC-7 and UC-E7 wiring, AC-09.3, AC-08.3): with verify rounds left -> synthesis returns `needs_verification`, the controller decides `requestVerification` then `proposeAnswer` again and the claim ends in `established` or `insufficient` by the records;
  //   with rounds exhausted (`maxVerifyRounds` reached, `requestVerification` no longer admissible) -> the claim is in `assumed` with `verified` false, never in `established`, and its latest revision is `insufficient` or `unverified`, never `supported`
  describe('INT-3', () => {
    it.todo('INT-3 V1: a verification round appends supported and insufficient revisions from fetched source records (a failed collection gives insufficient, not refuted) and leaves the earlier revisions untouched');
    it.todo('INT-3 V2: the reference gateway removes claims citing another investigation\'s or unknown evidence, and each established claim resolves to evidence with all provenance fields; another owner cannot read the investigation');
    it.todo('INT-3 V3: a new claim made during synthesis is verified before delivery while rounds remain, and is delivered as assumed and unverified, never established, when they are exhausted');
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
  describe('INT-4', () => {
    it.todo('INT-4 Z1: a worker attempt that lost its lease writes no claim or reservation closure, the next attempt replays the checkpointed answer without a model call, and a repeated write adds no revision');
    it.todo('INT-4 Z2: a controller attempt that lost its lease writes no decision, and the next attempt ends with exactly one accepted decision for the step and no duplicated task');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Proven at unit level (named for the plan; generated as specs next to the code, not here). One table-driven spec per rule, cases as rows; fast-check where noted.
// ---------------------------------------------------------------------------------------------------------------
// - DecisionGate + admissible computation (table): decision outside the closed set, capability not enabled (DC-1), invalid structure, `maxFanOut` + 1 sub-questions (DC-6), `replan` at `maxPlanRevisions` leaving only requestVerification /
//   proposeAnswer / concludeInconclusive (AC-02.2, UC-E3), `noveltyWindow` steps without new evidence or revisions leaving only proposeAnswer / concludeInconclusive (AC-03.1, UC-E4 first scenario), a decision creating tasks refused when
//   `notAfter` is within 1 000 ms. AC-02.2, AC-03.1, DC-6.
// - ProcessConfig schema and loader (table, UC-E8, UC-10): capability outside the registry, unknown key `script`, unknown field in a prompt template, tool outside the `source.fetch` allowlist (path of the error in the message), duplicate pair `processId` + `version`
//   (the error path names the repeated pair), role model absent from the model catalog; the deep-research configuration shipped as a data file passes the same loader. AC-12.2, AC-12.3, DC-14.
// - Process version resolution (rows of the same loader table, UC-10): versions 1 and 2 of one `processId` load side by side while a repeated version 1 is rejected; a start without a version resolves to the highest loaded (2, then 3 once 3 is loaded);
//   a start with an explicit version resolves exactly that one; a version or a `processId` that is not loaded answers `process_unknown`. DC-15 (resolution half; the recorded-version half is INT-1 C6).
// - ContextBuilder (table + fast-check property): input tokens of the packed prompt <= `windowTokens` for arbitrary evidence sizes (AC-06.1); mandatory evidence is never truncated and yields `needs_narrowing` with the material size (AC-06.2, DC-7);
//   a worker packet holds only its own sub-question and evidence, not the controller history or other workers' material (AC-05.2 isolation half); `windowTokens` read from the configuration changes the packing (AC-06.3);
//   optional claims go newest first until the window is full.
// - Claim verifier (table, UC-6): an atom (traceId, service, event, interval, number) absent from the records -> `insufficient`; a number equal to the aggregate -> `supported`; an interval contradicted by a fetched record -> `refuted`;
//   a claim backed only by a worker summary is never `supported` before source records arrive. AC-08.1, AC-08.2, DC-10 (comparison half).
// - Reference gateway (table, UC-7): claim without a reference, with an unknown reference, with another investigation's reference -> removed with a reason; a new claim -> `needs_verification` or `assumed`/unverified depending on rounds left; `established` holds only
//   `supported`; outcome `answered` without any `supported` claim is lowered to `inconclusive` (DC-11). AC-09.1 (rule), AC-09.3 (rule), DC-11.
// - Dedup key builder for gather descriptions (fast-check property): the same tool, arguments and snapshot always give the same key regardless of `rationale` text or argument key order (DC-4 key half).
// - Signal registry (table): kind lookup, payload schema per kind, a kind registered later is accepted without changing the DecisionInput shape (AC-04.2).
// - Cost calculation (table): catalog prices including the Haiku tier above 100 000 input tokens, cache read and write tokens (AC-11.1 price half).
// - Retry policy of ModelGateway (table): 429 / 5xx / network retried twice with a reservation per attempt; `refusal` stop reason and invalid structured output retried once then `invalid_model_output` (Error handling).
