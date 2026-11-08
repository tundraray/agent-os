// agent-runtime / research-flow Integration Test Skeletons (engine side) - Design Doc: docs/features/agent-runtime/design-research-flow.md (v1.3, approved 2026-11-08)
// PRD: docs/features/agent-runtime/prd.md v1.1 (FR-12..FR-20). Consumes: docs/features/agent-runtime/design-agent-core.md (v1.6, approved) - its Test Strategy and its skeletons
// `agent-runtime-agent-core.int.e2e-spec.ts` / `agent-runtime-agent-core.e2e-spec.ts` (what they prove is not proven again here). ADRs: ADR-0001, ADR-0004, ADR-0005 / ADR-0009, ADR-0006, ADR-0008, ADR-0010. UXRD: none (part without UI).
// Generated: 2026-11-08 | Part: research-flow | Test type: Integration (in-process runtime + engine + real Postgres, scripted model, the SHIPPED v3 configuration), CI job `e2e-engine`
// Implementation timing: created alongside the slice each test names (INT-1 the v3 tree + the six definitions + the claim/answer code of the forms; INT-2 the shared-row guards under concurrency, stop and close;
//   INT-3 the forced ends of the root; INT-4 after the first real-model runs of v3 have been recorded).
//
// File name and placement. Same package, harness and config as `agent-runtime-agent-core.int.e2e-spec.ts` and `deep-research-engine.int.e2e-spec.ts` (`test/**/*.e2e-spec.ts` of `vitest.config.e2e.ts`; run with
// `pnpm --filter @agent-os/engine test:e2e`, never in the default `vitest run`). The api half of the part (self-check run / replay / show / compare on v3, the switch flag in the server) is `apps/api/test/agent-runtime-research-flow.int.e2e-spec.ts`
// (INT-5) and `apps/api/test/agent-runtime-research-flow.e2e-spec.ts` (E2E-2). The process-kill file of this package is `agent-runtime-research-flow.e2e-spec.ts` (E2E-1).
//
// Generated as `it.todo` skeletons so the file loads under lint, typecheck and `vitest run`. Implement each todo following its Given/When/Then comments when its slice lands. Do not convert a todo into a passing stub.
//
// Light test process (owner decision): integration and E2E skeletons exist only for the risky UCs of the Test Strategy - the v3 tree on six definitions (UC-1, UC-2, UC-4, UC-7), concurrency (UC-E4, UC-E7), stop/close (UC-E6),
// the forced ends of the root (UC-3, UC-E8), the recorded-run regression (UC-R3), restart (UC-E5 -> E2E-1 of this package), self-check on v3 and the switch flag (api files). Every other UC is a unit test named in the plan
// (list "Proven elsewhere" at the end).
//
// Environment (Design Doc "Test Strategy": the scenarios run on the shipped v3 configuration, each agent's model answers by script with tool calls):
// - Postgres 16 from infra/docker-compose.yml. Real `createRuntime` and real `createEngine` with the real `AgentRunHandler` (`agent.root`, `agent.run`) of agent-core, the real research tools (`gather`, `claims_write`, `plan_write`), the real
//   forms `research_close` / `answer_draft` / `claim_assessment` with their prologue / closure / forced-end code, the real answer gateway, the real `ModelGateway` over the real `postgresCallLedger`. Boundary doubles only: the scripted
//   language-model double (per agent) and the counting source (`countingSource.ts`, impersonating the fixture source and tool names, so the shipped config passes its source check unchanged); the counting source is the independent counter of "source called once".
// - The process is the SHIPPED `deep-research` v3 (`deepResearchProcessV3` from `deep-research.v3.json`, started with `version: 3`), not a probe: this part's risk is in the shipped definitions, their allowed calls, windows, shares and forms.
//   Rows that need small numbers (budget, deadline, turns, overflow) use `researchFlowV3Config(overrides)`: the shipped data with only the named numbers changed, the result still validated by the loader.
// - Group table: a test table keyed by the pair of fingerprints the harness reads from the LOADED config (`agentFingerprint` of the verifier, `definitionMemoryFingerprint` of its empty memory), every `supported` claim gets group `low`. It is built from
//   the loaded config, never hard-coded, so an edit of a shipped prompt does not turn a test red (a changed verifier needs a new shipped table; that is the calibration's test, E2E-2).
// - Isolation (project convention, no truncate): a unique `resourceId` and `launchKey` per test (test/support/new-user.ts); `fileParallelism: false`; `cancelStarted()` in afterEach.
// - "Model evaluates, algorithm decides": the double returns only tool calls (and `finish` results) by schema; no assertion reads a keyword of model text. Codes and reasons the engine writes (`pointer_invalid`, `tool_not_in_definition`,
//   `budget_exhausted`, `repeat`, `context_overflow`, ...) are compared as literals from the Design Doc.
// - Time: runtime deadlines and leases ride the injected harness `clock` / `expireLease`; the engine clock (`engineClock.offsetMs`) moves only `notAfter`. No sleeps for ordering, no latency assertions.
//
// Support the plan must add FIRST (existing support files are NOT edited by this skeleton set; the plan's first harness task does it; items 1, 3 and 4 of the agent-core int file's list are assumed done and are only extended here):
// 1. scriptedModel.ts - the `agent` role of agent-core (tool-call steps, per-agent scripts, per-call records, `holdUntil` / `hangUntilAborted` / `providerError` on tool-call steps, the `fallback` program) EXTENDED for six agents of the shipped config:
//    (a) recognise the agent by the SYSTEM BLOCK of its loaded definition: the harness builds the map agent name -> the leading text of `config.agents[name].systemPrompt` from the loaded config object (the shipped prompts carry no marker, a probe marker
//        cannot be added to shipped data; `worker` and `subworker` prompts differ - "как у worker, без указания про подветку" - so the leading text separates them; if a prompt edit makes two leading texts equal the harness fails loudly);
//    (b) a step kind whose tool-call arguments are computed from the prompt: `{ toolCalls: (view) => [...] }`, where `view` is the parsed session so far (tool results by tool name in order - page ids from `gather`, claim numbers from `claims_write`,
//        run ids from `call_agent`, the plan revision), because the ids a controller or worker must send exist only after earlier results; without it the scenarios cannot be scripted;
//    (c) a latch helper (`model.latch(n)`: the first call of each of n agents is held until n have arrived) for INT-2 A and B, and `model.callsOfAgent(name)`;
//    (d) a "refuse form" step for `claim_assessment` (an answer outside the closed form) for the unit/E2E rows named elsewhere.
// 2. test-configs.ts - `researchFlowV3Config(overrides)` (windows stay valid for the loader's smallest-view rule; overrides: `limits.investigationTokens`, per-agent `runTokens` / `deadlineMs` / `maxTurns` / `maxChildren`, `agentLimits.maxDepth`, root
//    `deadlineMs`), and `researchFlowGroupTable(config)` (the table above).
// 3. engineHarness.ts - export `deepResearchProcessV3` use (`processes: [deepResearchProcessV3]`, `groupTables` from item 2); a source answer with a hold on the first call (INT-2 A) if `countingSource.answerWith` has none; a way to start the
//    investigation in `model_knowledge` mode (no connected source: the harness `source` option with an empty source list) for INT-1 B.
// 4. engineDb.ts - read-only snapshots: `research_agent_runs` with parent run, call number, task text, result, status, own and subtree spend; `research_agent_tool_calls` with agent, tool, outcome, reason and the parent run; claim revisions with the
//    author run (worker / verifier closure / root gate); evidence pages with the `repeat` mark; the engine run row with the written answer; `llmCallsOf(investigationId)` by role `agent`.
// 5. A fixture source with enough records: the scenario `answerWith` records are shaped like the real source's count groups and log lines, so the pointer rules and `checkAtoms` see what they see in production (the UC-R1 lesson: a double whose records differ
//    from the real source hides the defect).
//
// Budget (this file): Integration 4 of the part's 5 (the fifth, INT-5, is in the api file; limit 3, up to 5 under the integration-e2e-testing rule only when each extra test names the defect no other test catches). Core: INT-1, INT-2, INT-3. The extra is
//   INT-4 (the recorded-run regression) - unique defect: the scripted calls of every other test are written by the same author who wrote the definitions and so agree with them; only the answers a REAL model gave, played back by place in the tree,
//   show a call, argument shape or order the definitions do not accept (the design names this its guard against "the scenarios' calls differ from the real model's"). E2E: 1 of the part's 2 in the sibling file (E2E-1), the other is in the api.
//   INT-2 groups four rows of one boundary (the research tables written by several runs at the same time, and the guards that take them down); if the plan needs room it demotes B to a real-Postgres repository spec - A and C are not reproducible below this level.
//
// AC -> proving test (the plan reads this to avoid a second test for an AC already proven; "unit" = a table-driven unit spec named in the plan):
// - AC-12.1: INT-1 A (and INT-4); AC-12.2: INT-1 A (the subworker call without a controller turn between); AC-12.3 and AC-07.1 for this part: INT-3 (the wiring: a forced end of the root becomes an answer by code and a `completed` investigation); the precedence of the reasons: unit
// - AC-12.4: INT-1 B
// - AC-15.1: INT-1 A (the tree ends with an answer built by the same gateway; groups, links, summary), INT-4 (the same on a real model's answers), UC-R1 on v3: unit (recorded-runs.spec.ts); AC-15.2: INT-1 A
// - AC-17.1, AC-17.2: INT-1 A (the controller repeats a read and a worker repeats a collection: no rejection for repeat or novelty; the controller's session shows its calls in order)
// - AC-08.1 (this part's write paths), AC-08.2 (the completed-with-answer half agent-core left to this part), DC-2: INT-2 C, INT-2 D
// - DC-11 (the repeat): INT-2 A for the race of two workers, unit for the key; UC-E7 (two checks of one claim): INT-2 B
// - DC-8 (the atomic closure after a restart), DC-2 (the answer written once): E2E-1 of this package
// - AC-13.1, AC-13.2, DC-4 (UC-5), DC-5 (the boot refusal) and AC-14.x, AC-16.x, AC-18.x, AC-19.x, AC-20.1: unit and the api files, see their headers
// - DC-6 (UC-E1), DC-7 and DC-8 (UC-E2), DC-9 (UC-E3), DC-10, DC-12, DC-13, UC-R1 on v3, AC-16.3, AC-20.1 metric: unit, see "Proven elsewhere"

import { describe, it } from 'vitest';

describe('agent-runtime / research-flow - integration (in-process runtime + engine + real Postgres, scripted model, shipped v3)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  The v3 tree on its six definitions: a question to an answer, and the same without sources (UC-1, UC-2, UC-7, UC-4)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: "AC-12.1: Given расследование по v3 завершено, Then в его дереве есть запуски агентов плана, controller, worker, проверяющего и synthesis."
  // AC: "AC-12.2: Given определение worker-агента разрешает вызов другого агента, When worker вызывает его посреди своего задания, Then вызов исполнен, и шага controller между ними нет."
  // AC: "AC-15.1: Given расследование по v3, Then выполняются критерии FR-09, FR-11, FR-12, FR-13, FR-14 и FR-16 PRD agent-quality."  (the assembly half: answer sections, groups, links, summary)
  // AC: "AC-15.2: Given агент записал в память или вернул в результате вывод, которого нет среди проверенных утверждений, Then в «Установлено» и в сводке ответа этого вывода нет."
  // AC: "AC-17.1: Given controller-агент в расследовании по v3 сделал несколько ходов, When разработчик открывает его сессию, Then в ней по порядку видны все его прежние вызовы и их результаты, и ни один его вызов код не отклонил за отсутствие новизны."
  // AC: "AC-17.2: Given расследование по v3, Then ни один вызов controller-агента не отклонён кодом за повтор или за отсутствие новизны."
  // AC: "AC-12.4: Given в развёртывании не подключён ни один источник данных, When расследование идёт по v3, Then выполняются критерии FR-25 и FR-27 PRD deep-research: ответ на знаниях модели с пометкой у каждого утверждения и предупреждением в беседе."
  // AC (Design Doc): "DC-3: В режиме без источников корень - определение `modelKnowledgeRoot`, и журнал вызовов показывает только его ходы."
  // Behavior: A - question -> controller calls planner -> two workers on two branches (worker A calls subworker mid-task) -> every claim written by `claims_write` is handed to a `verifier` run -> controller calls synthesis -> `finish(research_close, answer)`
  //   -> the root's closure passes the gates, the answer gateway builds the answer, ONE guarded write stores answer + message + root result -> `engine.lifecycle` closes the investigation `completed`;
  //   B - no connected source -> the root is `synthesis` alone -> `finish(answer_draft)` -> the root's closure screens the draft in `model_knowledge` mode and writes the answer.
  // Catches: A - a v2-shaped assumption left in the v3 path (the root not recognised as the controller task so the investigation never closes; the answer written after the root's result instead of with it); a subworker call that still passes through a controller turn;
  //   a verification revision written by anything but the verifier's closure, or a status taken from the model's text instead of the assessment's fields; a conclusion kept in memory or in a child's result promoted into "Установлено";
  //   a repeated collection or a repeated read refused for "no novelty" (the v2 patch carried over); a controller session that loses an earlier call. B - the mode ignored (a controller and a planner called for a question with no sources), a claim not marked
  //   as model knowledge, a missing warning, an outcome other than `answered`.
  // @category: core-functionality
  // @dependency: AgentRunHandler, the six definitions of deep-research v3, gather / claims_write / plan_write, forms research_close / answer_draft / claim_assessment, answer gateway, engine.lifecycle, TaskScheduler, readAgentTree, real Postgres
  // @complexity: high
  //
  // Row A (UC-1, UC-2, UC-7; the two workers' scripts are written so the other asserted facts are exact)
  //   Given (the shipped v3, `version: 3`, one user, the counting source answering the scenario's records; every scripted step has explicit `usage`):
  //     controller: turn 1 `memory_read` + `investigation_read` (and again in turn 2 - a deliberate repeat), turn 3 `call_agent(planner)`, turn 4 two `call_agent(worker)` with one branch each; after both results, `call_agent(synthesis)` (every
  //       claim was already handed to a verifier by the workers, so the controller checks nothing itself); then `finish(research_close, { answer: <the synthesis run> })`.
  //     planner: `investigation_read`, `plan_write`, `finish`. worker A: `gather`, `claims_write` (2 claims), `call_agent(verifier)` for the first, `call_agent(subworker)` with a sub-branch, `call_agent(verifier)` for the second, `memory_write` of a
  //       CONCLUSION that is not among its claims, `finish` whose result text repeats that conclusion. worker B: the SAME `gather` as worker A (same source, tool, args, slice), then `claims_write` (1 claim), `call_agent(verifier)`, `finish`.
  //       subworker: `gather`, `claims_write` (1 claim), `call_agent(verifier)`, `finish`. verifier (one script per run, taken by the claim number in the task): `finish` with an assessment that supports one claim and does not support another.
  //       synthesis: `finish(answer_draft)` over the supported claims, summary ids from them.
  //   When: the investigation is started through `engine.startInvestigation` and the root run ends.
  //   Then (verification items):
  //   - Tree (AC-12.1): `readAgentTree` shows runs of `controller` (root), `planner`, two `worker`, one `subworker`, one `verifier` per written claim and `synthesis`; every run has parent run, call number, task text, result, own and subtree spend;
  //     the transcripts of its turns have role `agent`
  //   - No controller between (AC-12.2): between the moment worker A's `call_agent(subworker)` is recorded and the subworker's result in worker A's session, the controller's turn count did not change (the controller is waiting; the call went from worker to subworker
  //     by `call_agent`, not through the controller)
  //   - Verification (KD-2): every claim a worker or the subworker wrote has two revisions - the author's `unverified` and a verification revision whose task is a `verifier` run; its status follows the assessment's fields (the supported claim `supported`, the other not),
  //     its group is the test table's `low`; no revision of any claim was written by another path
  //   - The result of a verifier handed to the worker is the claim number, status and group only - no packet and no model text in the worker's session (KD-2)
  //   - Answer (AC-15.1): the answer sections are those of the config; "Установлено" holds exactly the claims whose last revision is a verification revision with status `supported`, with links from their basis; the summary is built from them
  //   - Memory is data (AC-15.2): the conclusion worker A put in memory and in its result text is in neither "Установлено" nor the summary
  //   - Controller session (AC-17.1): the messages of the controller's session hold its calls and their results in the order of the turns, the repeated `investigation_read` included
  //   - No patch (AC-17.2): no tool call of any run of the tree is `rejected` for repeat or novelty; worker B's `gather` is NOT rejected (its result carries the mark `repeat`, DC-11 - the race of the same call is INT-2 A, here only the sequence is read)
  //   - Single write (KD-3): the engine run row holds the answer and the message, and the root's result in the same record (read as one row version / one `ts`); the investigation is `completed` and its reserves are closed
  //   - v2 untouched: no `research.controller`, `research.analyze`, `research.verify` or `research.synthesize` task exists for this investigation
  // Row B (UC-4)
  //   Given: no connected source (mode `model_knowledge`); `synthesis` scripted with `finish(answer_draft)` with claims and an outcome other than `answered` in the draft (the code, not the model, sets the outcome); no other agent has a script (a call to it would be an unscripted step and fail the test).
  //   When: the investigation is started and finishes.
  //   Then: `completed`; the tree holds one run, `synthesis`, as the root (no controller, planner, worker or verifier run); every claim of the answer is in "Предположения" with the model-knowledge mark, the warning opens the answer, the outcome is `answered`;
  //     the ledger rows of role `agent` belong to `synthesis` only (DC-3); the counting source got no call.
  describe('INT-1', () => {
    it.todo('INT-1 A: the shipped v3 tree - planner, two workers (one with a subworker), a verifier per claim, synthesis, research_close - ends with an answer of verified claims only, written with the root\'s result, without a controller turn inside a worker\'s call');
    it.todo('INT-1 B: with no source connected the root is synthesis alone, and its draft becomes an answer of model-knowledge assumptions with the warning and the outcome answered');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  Several runs at once on the shared research rows, stop and close (UC-E4, UC-E7, UC-E6)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: "AC-17.2 / DC-11: Повтор запроса отдаёт сохранённую страницу без нового вызова источника и без отказа; результат вызова говорит, что страница прежняя, и называет число её записей."  (the race half)
  // AC: "AC-15.1 (UC-E7): worker и controller одновременно вызывают проверяющего на одно утверждение; у утверждения две ревизии проверки, ответ берёт последнюю; ворота закрытия пройдены."
  // AC: "AC-08.1: Given в дереве работают несколько агентов, When сотрудник останавливает расследование, Then после перехода ни один агент дерева не начинает вызов модели или инструмента."  (the research write paths)
  // AC: "AC-08.2: ... закрытие расследования с готовым ответом, пока дочерние запуски работают ... их запуски отменены тем же переходом."  (the completed-with-answer half; the failure half is agent-core INT-3 B)
  // AC (Design Doc): "DC-2: Корень, который закрыл расследование ответом, пока запуски его поддерева ещё работают, кончается успехом, а расследование становится `completed` и тем же переходом отменяет эти запуски."
  // Behavior: A - two workers send the same `gather` in the same moment -> the source is called once -> both get the same page; B - worker and controller call `verifier` on one claim at once -> two revisions; C - the owner stops while three verifiers run -> nothing is written afterwards;
  //   D - the root closes with an answer while a subworker (whose parent worker already failed) still works -> `completed`, the subworker `cancelled` by the same transition.
  // Catches: A - the second `gather` of the same request starting a second source call (the repeat lookup reads only saved pages and misses the call still in flight), or waiting forever on the first, or being refused; B - two closures numbering their revision the same
  //   (a unique violation fails one verifier run and leaves its claim unchecked), or the second one overwriting the first, or the gate reading the earlier of two; C - a verifier closure, an answer write or a `claims_write` that lands after the stop (the guarded write
  //   without `requireActive` on one research path), or a model call that starts after the transition; D - a root that ends `succeeded` while its subtree keeps spending and writing, or an answer written but the subtree not cancelled.
  // @category: core-functionality
  // @dependency: gather (source.fetch task and its dedupe), claim_assessment closure, research_close closure, TaskScheduler, InvestigationService.cancel / closeInTx, engine.lifecycle, counting source, real Postgres
  // @complexity: high
  //
  // Row A (UC-E4): Given: runtime `concurrency` >= 2; two workers whose first step is the same `gather` (support item 1c: both held until both have arrived; the counting source holds its first call). When: both are released. Then: `countingSource.calls` has ONE call for that request;
  //   both workers' results carry the same page number, the number of its records and the mark `repeat` on the later one (or on the one that waited); neither is `rejected`; exactly one `source.fetch` task and one stored page exist for the request (DC-11, AC-17.2).
  // Row B (UC-E7): Given: a claim written by a worker; the worker and the controller (a second wave) call `verifier` with that claim number in the same turn-moment (latch), the two assessments differ (one supported, one not). When: both end.
  //   Then: the claim has two verification revisions with different revision numbers, written by two different verifier runs; the answer takes the LAST one (by revision number); the closing gate 2 passes (each call ended); neither verifier run failed.
  // Row C (UC-E6, first run): Given: three `verifier` runs, each in a held model call (concurrency high enough that all three are in the model at the same time). When: the owner's `InvestigationService.cancel` runs and the runs end.
  //   Then: the investigation is `cancelled`; every agent task of the tree is `cancelled` or ended before the transition; after the transition: no new verification revision, no new claim revision, no new answer or message, no new ledger row, no new model call
  //   (snapshots of row ids taken right after `cancel` returns and after all runs ended are equal); the aborted calls' reserves are read as in agent-core INT-3 A (nothing new asserted for them).
  // Row D (UC-E6, second run): Given: root has called worker W and, via W, a subworker S; W's run has already failed (its model unavailable) while S is in a held model call; the root's own flow still reaches `finish(research_close)` with a ready draft and gates passed.
  //   When: the root's `finish` is processed. Then: the root's task is `succeeded`; the investigation is `completed`; S is `cancelled` by the same `closeInTx` transition and its model call was aborted; the answer is written once; nothing is added to the ledger, the claims or the tool-call
  //   rows after the close (equal snapshots before/after S ended).
  describe('INT-2', () => {
    it.todo('INT-2 A: two workers sending the same collection at once call the source once and both get the same stored page, marked as a repeat, without a refusal');
    it.todo('INT-2 B: a worker and the controller checking one claim at the same time leave two verification revisions with different numbers, and the answer takes the later one');
    it.todo('INT-2 C: a stop while three verifiers run leaves no verification revision, claim, answer, ledger row or model call after the transition');
    it.todo('INT-2 D: a root that closes with an answer while a subworker still works is succeeded, the investigation completed, and the subworker cancelled by the same transition');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  The forced ends of the root: an answer by code, and the right reason (UC-3, UC-E8)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: "AC-12.3: Given расследование по v3 остановлено принудительно, Then причина остановки - одна из тех, что сотрудник видит и в v2."
  // AC: "AC-07.1 (agent-core, answered here): Given бюджет расследования меньше требуемого, Then ни один агент дерева не начинает вызов модели сверх бюджета, а расследование завершается с причиной «бюджет исчерпан»."
  // AC (Design Doc): "DC-1: Принудительный конец корня даёт ответ кодом и причину остановки по правилу старшинства; расследование закрывается `completed`."
  // AC (Design Doc): "ворота 3: Если запуск агента ответа кончился прологом с признаком `overflow` - пакет длиннее предела, - закрытие не отказывает: оно собирает ответ кодом с причиной `context_overflow`, и корень кончается успехом." (UC-E8)
  // Behavior: the root cannot make its next turn (reserve refused / turn limit after a budget refusal in the tree / the chain of deadlines) or the synthesis packet overflows -> the forced end / the overflow end of the form -> `buildCodeAnswer` from the verified claims
  //   -> ONE guarded write -> the root ends `succeeded` -> the investigation is `completed`, the answer carries the reason.
  // Catches: a root failed by the budget (investigation `failed`, no answer) instead of an answer by code; a model call started past the budget; the reason read from the wrong source (the `budgetExhausted` flag of the tree not read, so a root that ran out of turns after its branches were
  //   cut by the budget says `step_limit`); a root woken too late to write: the chain worker -> subworker -> verifier ending at the SAME instant as the root (each level must end `RUNTIME_LEASE_MS` before its parent) so the answer is lost to the task deadline;
  //   a synthesis packet that overflows and the root dies on `draft_invalid` instead of answering `context_overflow`.
  // @category: core-functionality
  // @dependency: forced-end code of research_close, AgentRunHandler (notAfter / reserve), gate 3, buildCodeAnswer, collect (budgetExhausted flag, tool-call rows), runtime clock, real Postgres
  // @complexity: high
  //
  // Table-driven. The mapping code -> reason and the precedence are a unit table (named in "Proven elsewhere"); these rows prove the wiring from a REAL end to a written answer. The small numbers come from `researchFlowV3Config(overrides)`.
  // Common Then: the root's task is `succeeded`, the investigation `completed`, the answer exists once, its outcome is `partial` when at least one claim is `supported` and `inconclusive` otherwise, there is no summary, the reason is the literal of the row;
  //   `charged + open reserves <= the investigation budget`; no model call was recorded after the refusal point (compare `model.calls` before/after).
  // Row A (UC-3 run 1 - budget): Given: `limits.investigationTokens` below what the scripted tree needs (the second worker's share is refused `budget_exhausted` by the code); the controller still has turns. When: the controller asks for the next turn and its reserve is refused.
  //   Then: reason `budget_exhausted`; claims already `supported` appear in the answer, the unchecked ones as assumptions "не проверено".
  // Row B (UC-3 run 5 - the chain of deadlines): Given: a controller waiting on worker -> subworker -> verifier, the verifier's model call held; the injected runtime clock moves to the root's `notAfter`. When: the lease/deadline sweep runs.
  //   Then: `notAfter` of the verifier, the subworker and the worker are each not later than the parent's minus `RUNTIME_LEASE_MS` (read from the run rows, literals computed from the config); they end `not_after` before the root; the root wakes, starts no turn and writes the answer
  //   with reason `deadline` before its own task deadline; no model call after the wake. Limit: the promise holds with a free dispatcher slot (design-agent-core "Risks"); this row keeps a slot free and does not claim the busy-slot case.
  // Row C (UC-3 run 6 - precedence by the tree flag): Given: a worker call refused `budget_exhausted` earlier in the tree, then the root's `maxTurns` exhausted. When: the root cannot make a turn. Then: reason `budget_exhausted`, not `step_limit` (the flag is read from the tool-call rows).
  // Row D (UC-E8): Given: so many verified claims that the synthesis packet exceeds 32 000 bytes (the prologue's `overflow`). When: the controller calls `synthesis` and then closes with `answer`. Then: the synthesis run ended without a model call (no ledger row, no transcript);
  //   the closing does not refuse `draft_invalid`; the answer is by code with reason `context_overflow`; the investigation is `completed`.
  describe('INT-3', () => {
    it.todo('INT-3 A: a root whose next turn the budget refuses answers by code from the verified claims with the reason budget_exhausted and starts no model call past the budget');
    it.todo('INT-3 B: when the root\'s deadline arrives while the chain worker - subworker - verifier works, each level ends before its parent and the root writes an answer with the reason deadline before its task deadline');
    it.todo('INT-3 C: a root that runs out of turns after a branch was refused by the budget says budget_exhausted, not step_limit');
    it.todo('INT-3 D: a synthesis packet over the limit makes no model call and the root answers by code with the reason context_overflow instead of refusing the draft');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4  The recorded v3 tree on a real model's answers (UC-R3)
  // ---------------------------------------------------------------------------------------------------------------
  // The one extra under the rule (see Budget): its unique defect is stated above.
  // AC: "AC-12.1 / AC-15.1: ответы модели каждого агента из первых расследований v3 на настоящих моделях по учебному fixture-источнику, выгруженные из их сессий; модель отвечает записанными ответами; ответ находится по месту запуска в дереве - родительскому запуску и номеру вызова - и номеру хода, а не по порядку времени;
  //     дерево кончается тем же ответом - те же утверждения по разделам и те же статусы - и без отказов кода, которых не было в записи."
  // Behavior: the recorded answers of each agent (tool calls and `finish` results, exactly as the real models produced them) are played back by place in the tree -> the same tree runs on the real definitions, tools and forms -> the same answer.
  // Catches: a definition, a schema or an argument rule that rejects what a real Haiku-class model sends, while every scripted test passes (a `claims_write` pointer shape, a `gather` argument, a tool name, the number of calls per turn, a `finish` form), a playback that matches by time
  //   and so hides a divergence in the tree, an answer that differs from the recorded one in claim statuses or sections.
  // @category: integration
  // @dependency: the shipped v3 config, all research tools and forms, the recorded fixture, the playback double, real Postgres
  // @complexity: high
  //
  // Given (the support the plan makes, see below): `packages/engine/test/fixtures/recorded-v3-runs-<date>.json` - the sessions of the first real-model v3 investigations over the training fixture source (`@agent-os/mcp-fixture`, the scenarios of the first self-check runs),
  //   as `{ agent, parentPlace, callNumber, turn, assistantToolCalls | text, finishResult }` records plus the expected answer (sections, claim texts, statuses). A schema spec of the fixture file keeps a bad recording red below this test (like `recorded-runs.spec.ts` for UC-R1).
  //   The source for the playback is the counting source answering with the recorded pages (records as the fixture source returned them), because the pages' ids and contents must match the recorded pointers.
  // When: each agent's model double answers with the recorded answers, found by (the run's place in the tree = parent run place + call number, and the turn number), never by order of arrival; the investigation runs to its end.
  // Then:
  //   - The tree has the same shape as the recorded one (same agents at the same places, same number of turns per run)
  //   - No tool call is `rejected` that was not rejected in the recording (the recording's rejections, if any, repeat at the same places); no run failed that did not fail
  //   - The answer has the same claims in the same sections with the same statuses and groups as the recorded one (the test group table is replaced by the recorded table for the recorded fingerprint pair, or the group is excluded from the comparison; the choice is the plan's, see "Not observable")
  //   - The investigation is `completed`
  // Not runnable until: v3 exists and has been run on real models once against the fixture source (the plan schedules the recording as a task of its own; it is outside CI and needs an API key).
  describe('INT-4', () => {
    it.todo('INT-4: the recorded answers of the first real-model v3 runs, played back by place in the tree, end in the same answer without a rejection the recording did not have');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Proven elsewhere (named for the plan; no skeleton here, by the light test process)
// ---------------------------------------------------------------------------------------------------------------
// Unit (table-driven, packages/engine/src/**/*.spec.ts), one spec per rule:
// - config loader and engine start (UC-5: AC-13.1, AC-13.2, DC-4; DC-5): one table of broken v3 variants (unknown key; `research_close` on a non-root; `answer_draft` on a definition that is not `modelKnowledgeRoot`; two `claim_assessment` definitions; none; a tool on the verifier)
//   with the agent, form and constraint in the error; the shipped v3 and v2 load; `createEngine` with a default version not loaded -> `process_version_not_loaded` (process, version); a default version without a group table for the verifier's pair -> `calibration_missing` with both fingerprints
//   (the server-start half is E2E-2 S1); `createProcessSet.resolve` without a version takes the default (KD-5); `investigationTokenLimits` reads the default version's limits (800 000 / 10 000 000 for v3, 300 000 for v2)
// - `claims_write` against real Postgres, small DB-backed specs (UC-E1, DC-6): a pointer to a page of another investigation, a record number outside the page, more than 20 records -> `pointer_invalid` with the ordinal numbers of the bad claims and NO revision written (all-or-nothing); a good call writes `unverified` revisions and returns numbers in call order
// - `gather` (DC-11): the key of a repeat (source, tool, arguments, slice) and the `repeat` mark; refusals `access_denied`, `invalid_arguments`; `source_unavailable` on a failed task. The race of two callers is INT-2 A
// - the `claim_assessment` prologue and closure (UC-E2: DC-7, DC-8; UC-R1 on v3; AC-16.3; DC-10): packet longer than 24 000 bytes -> `end` with `needs_narrowing` -> revision `insufficient`, no model call; a non-form answer twice -> `invalid_result` then `insufficient`/`invalid_assessment`;
//   a task that is not a claim number of this investigation -> `not_a_claim` -> `prologue_refused`; the forced end `turn_limit` -> `insufficient`/`invalid_assessment`, the other codes -> `none`; the six recorded claims of UC-R1 give the statuses `checkAtoms` + `decideClaim` give in v2
//   (extend `recorded-runs.spec.ts` with the v3 prologue/closure path); the pair packet of `calibrate` equals the prologue packet built from the same records; with no table for the pair the supported claim gets the lowest group (the self-check run) and under `Engine.assessAgent` it gets none
// - the `research_close` gates (UC-E3: DC-9), for `answer` and for `inconclusive`: `plan_missing`, `unverified_claims` with numbers (every ended call of any outcome satisfies gate 2, including `budget_exhausted`, `children_limit`, `task_limit`, `child_failed`), `needs_verification` once and then no new draft claims written,
//   `draft_invalid` (run missing / not succeeded / wrong form / ended before a `needs_verification`); the `answer_draft` prologue overflow flag; a table over the collected input, no database
// - the order of reasons (AC-12.3): codes `run_tokens_exhausted` / `investigation_tokens_exhausted` / `model_unavailable` / `not_after` / `turn_limit` x the `budgetExhausted` flag x close `inconclusive` x overflow -> `budget_exhausted`, `model_unavailable`, `deadline`, `step_limit`, `context_overflow`, none; outcome `partial` / `inconclusive`
// - the self-check rules on v3 (AC-18.3, DC-12): see the api file header
// - fingerprints (AC-16.1): `agentFingerprint` and `definitionMemoryFingerprint` change with model, effort, prompt, tools, form version, ceiling, and with a write or a delete in the verifier's `deployment` memory (the registry-wide check is agent-core's)
//
// Not observable as an assertion (reported to the caller):
// - UC-1 "в дереве есть запуски агентов всех пяти стадий" is observable by agent name, but "worker сам решает, кого и когда вызвать" is not: the double decides in the script, so the test proves that the definitions ALLOW and the code EXECUTES the calls the design describes, not that a real model chooses them.
//   That is INT-4 on recorded answers and the comparison with v2 on real models (the main risk of the design); no CI test reads it.
// - UC-3 "корень пишет ответ раньше срока своей задачи" holds with a free dispatcher slot; with all slots busy the root may not wake in time (design risk). INT-3 B keeps a slot free and asserts the ordering of `notAfter` values and of the ends, not a latency.
// - INT-2 A and B ask for two things at the same instant; a database cannot be forced to interleave two transactions from a test without a hook in `src`. Latches make the collision likely, not certain; the guaranteed proof of the revision numbering and of the
//   repeat lookup under two writers is a repository-level spec on the real table (two `Promise.all` calls, repeated), which the plan names next to the DB-backed `claims_write` spec.
// - INT-4: the group of a claim depends on the table for the recorded fingerprint pair, and a prompt edit changes the pair; whether the comparison uses the recorded table or leaves the group out is a plan decision, the design says only "те же утверждения по разделам и те же статусы".
// - INT-4: the fixture does not exist yet and cannot be made before v3 runs on real models; it records one provider's answers on one date and has to be re-recorded when a definition's tools change.
