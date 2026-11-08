// agent-runtime / agent-core Integration Test Skeletons - Design Doc: docs/features/agent-runtime/design-agent-core.md (v1.2, approved 2026-11-08)
// PRD: docs/features/agent-runtime/prd.md v1.1 (FR-01..FR-11, FR-21, FR-22; NFR-01..NFR-03 for agents). ADRs: ADR-0001 (runtime owner), ADR-0004 (engine package), ADR-0005 / ADR-0009 (process = data), ADR-0006 (stopping). UXRD: none (part without UI).
// Generated: 2026-11-08 | Part: agent-core | Test type: Integration (in-process runtime + engine + real Postgres, scripted model), CI job `e2e-engine`
// Implementation timing: created alongside the slice each test names (INT-1 the turn loop + registry + tree read; INT-2 sibling runs; INT-3 cancellation of the tree; INT-4 the budget share and its return).
//
// File name and placement. Same package, harness and config as `deep-research-engine.int.e2e-spec.ts` and `agent-quality-engine.int.e2e-spec.ts` (`test/**/*.e2e-spec.ts` of `vitest.config.e2e.ts`; run with
// `pnpm --filter @agent-os/engine test:e2e`, never in the default `vitest run`). Everything below lives in this package (the agent module, the ledger, the tree read); `apps/api` loads only v2 (`ENGINE_PROCESSES`)
// and does not load the probe process, so this part has no api test. The process-kill matrix is the sibling file `agent-runtime-agent-core.e2e-spec.ts` (E2E-1).
//
// Generated as `it.todo` skeletons so the file loads under lint, typecheck and `vitest run`. Implement each todo following its Given/When/Then comments when its slice lands. Do not convert a todo into a passing stub.
//
// Light test process (owner decision): integration and E2E skeletons exist only for the risky UCs of the Test Strategy - the probe-process acceptance (UC-1), concurrency (UC-4 + UC-E5), cancellation (UC-6), budget (UC-E6, UC-E10 for the
// share return) and the restart matrix (UC-E3, UC-E4 -> E2E-1). Every other UC is a unit test named in the plan (list "Proven elsewhere" at the end).
//
// Environment (Design Doc "Test Strategy"):
// - Postgres 16 from infra/docker-compose.yml. Real `createRuntime` and real `createEngine` with the new `AgentRunHandler` (`agent.root`, `agent.run`), the real `ModelGateway` over the real `postgresCallLedger`, the real
//   `ToolRegistry` / `ToolExecutor` / `SessionWindow`. Model boundary only: the scripted language-model double. The probe declares no sources; the harness still connects the counting source
//   as for every other file, and it must stay at zero calls.
// - The process is the PROBE (`agent-probe`, Test Strategy): three definitions as data, living in test/support/test-configs.ts and passed through the harness `processes` option; it is never loaded by `apps/api`. `lead` (root; memory_read, memory_write,
//   call_agent -> helper), `helper` (memory_write, call_agent -> leaf), `leaf` (finish only). `agentLimits.maxDepth` 2. Each definition's prompt carries a unique marker (like `SECOND_CONFIG_MARKER`) so the double recognises the agent by the system prompt.
//   Windows, `runTokens`, `deadlineMs`, `maxTurns` are chosen per test through a config builder (like `versionedConfig`), never by editing the shipped numbers.
// - Isolation (project convention, no truncate): a unique `resourceId` and `launchKey` per test (test/support/new-user.ts); `fileParallelism: false`; `cancelStarted()` in afterEach.
// - "Model evaluates, algorithm decides": the double returns only tool calls by schema; no assertion reads a keyword of model text. Codes the engine writes (`tool_not_in_definition`, `budget_exhausted`, ...) are compared as literals from the Design Doc.
// - Time: runtime deadlines and leases ride the injected harness `clock` / `expireLease`; the engine clock (`engineClock.offsetMs`) moves only `notAfter`. No sleeps for ordering, no latency assertions.
//
// Support to add (existing support files are NOT edited by this skeleton set; the plan's first harness task does it):
// 1. scriptedModel.ts - an `agent` role. The current double answers one structured JSON per role and tells roles apart by the output-schema marker; an agent turn has no such schema. The double must (a) answer with TOOL-CALL content parts
//    (`type: 'tool-call'`, tool name, input) - a new step kind `{ toolCalls: [{ tool, args }] }` next to `{ output }`, plus `{ text }` for the no-tool-call case (DC-2); (b) recognise the agent by the marker in the call's system prompt and keep a
//    script per agent name (`model.scriptAgent('lead', ...steps)`); (c) record per call the agent name, the tool names offered and `toolChoice`, the whole prompt (messages with their provider options, to read the session view, stubs and cache marks);
//    (d) keep `holdUntil` / `hangUntilAborted` / `providerError` for tool-call steps; (e) offer the existing `fallback` program keyed by agent and by the number of tool-result messages in the prompt, for the process that restarts (E2E-1).
//    Scripted `usage` follows the existing `ScriptedUsage` (cache read/write fields).
// 2. test-configs.ts - `agentProbeConfig(options)` builder (data only; same shape the loader validates) and its marker constants.
// 3. engineDb.ts - read-only snapshots of the new tables: `research_agent_runs`, `research_agent_messages`, `research_agent_tool_calls`, `agent_tool_audit`, `research_agent_memory`; `llmCallsOf(investigationId)` for ledger rows with role `agent`.
// 4. engineHarness.ts - `toolAccessPolicy` option of `createEngine` (default: allow), a way to read the tree (`engine.readAgentTree`) and a hook around the `TaskScheduler` handed to `createEngine` that can hold after `propose` returns (INT-4 B3 only).
//
// Budget (this file): Integration 4 (limit 3; up to 5 under the integration-e2e-testing rule only when each extra test names the defect no other test catches). Core: INT-1, INT-2, INT-3. The one extra is INT-4 - unique defect: the share
//   a parent holds is derived from real journal rows (own spend, open reserves, the descendants' spend), so only the real ledger across several tasks of a tree shows a share that is not returned, returned twice or returned while a grandchild still runs.
//   E2E: 1 of 2, in the sibling file.
//
// AC -> proving test (the plan reads this to avoid a second test for an AC already proven; "unit" = a table-driven unit spec named in the plan):
// - AC-01.2: INT-1 (the offered-but-undefined tool is refused by the executor; the double offers every registry tool in one scripted call to prove the code, not the schema, refuses it)
// - AC-02.1, AC-02.2, DC-3, NFR-03, AC-05.4: E2E-1 (K1..K6)
// - AC-03.1, AC-05.1, AC-09.1, AC-10.2: INT-1
// - AC-05.2, DC-5, AC-03.3: INT-2 (AC-03.3 is exercised by the same scenario, see the limit stated in INT-2)
// - AC-08.1, AC-08.2 (cancel half), DC-18: INT-3
// - AC-07.1, DC-8 (refusal half), DC-10, DC-16: INT-4 B1, B2; AC-07.2: INT-1 (sum) and INT-4 (sums per row); DC-9, KD-4 return, AC-05.3 (reason `failed`): INT-4 B3
// - AC-21.1: INT-1 (stable prefix + mark on the last message; the cache-read price of the journal is existing v2 gateway logic and a unit row)
// - NFR-02: INT-1 (every recorded model call went to the definition's model)
// - AC-01.1, AC-13.2, DC-1 (UC-2); DC-2, DC-7, DC-14, DC-17 (UC-E7); DC-6 table, AC-06.1 limits (UC-E1), AC-05.3 reasons (UC-E2); DC-8 share = min(runTokens, remainder); DC-13 and the window steps (UC-7); AC-04.1/AC-04.2 (UC-3);
//   DC-4, AC-03.2 (UC-E9); DC-11, NFR-01 (UC-N1); DC-12, AC-10.1 (UC-11); DC-15, AC-22.1..AC-22.6 (UC-9, UC-10); KD-6 `yield` (UC-E8): unit, see "Proven elsewhere"

import { describe, it } from 'vitest';

describe('agent-runtime / agent-core - integration (in-process runtime + engine + real Postgres, scripted model, probe process)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  Probe-process acceptance: lead -> helper -> leaf, data only, from a question to a closed investigation (UC-1, UC-N2)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: "AC-01.2: Given инструмента нет в определении агента, When модель агента просит его вызвать, Then инструмент не исполнен, а агент получает отказ с причиной следующим сообщением сессии."
  // AC: "AC-03.1: Given агент записал заметку в память, When другой агент того же расследования читает память, Then он видит заметку и агента, который её оставил."
  // AC: "AC-05.1: Given родитель вызвал дочернего агента, When тот вернул результат, Then в сессии родителя есть задание и результат и нет ни одного сообщения дочерней сессии."
  // AC: "AC-09.1: Given расследование по v3 завершено, When разработчик открывает его ход, Then у каждого запуска агента видны родитель, задание, результат, расход и транскрипты всех его ходов."
  // AC: "AC-10.2: Given агенты дерева вызвали инструменты, Then на каждый вызов приходится ровно одна запись аудита, и в ней видно, какой агент вызвал инструмент."  (Design Doc split: the audit row holds the fact of the call, the tool-call row names the agent)
  // AC: "AC-21.1: Given агент сделал больше одного хода, Then в журнале вызовов ходы после первого стоят меньше, чем стоил бы тот же вход без повтора начала."  (the stable-prefix half only)
  // AC: "AC-07.2: ... сумма по запускам равна расходу расследования."  and  NFR-02: "сессии и заметки памяти уходят только к провайдерам моделей, которыми уже пользуется расследование."
  // Behavior: question -> `agent.root` (lead) turns: write a note and ask a tool outside its definition -> call_agent(helper) -> helper writes a note and calls leaf -> leaf finish -> helper finish -> lead reads memory, finish
  //           -> root task ends -> `engine.lifecycle` closes the investigation `completed` -> the tree read shows three runs
  // Catches: the engine only works for the domain it was written for (a v2-shaped assumption left in the agent module: it imports a process module, needs `config.roles`, or the root is not recognised as the controller task so the investigation is never closed);
  //   a child's messages leak into the parent's session; a tool outside the definition is executed instead of refused; a tool call without exactly one audit row (zero or two) or an audit row that carries arguments; a turn that makes more than one
  //   provider request (the Mastra one-request assumption of KD-1, read as double calls == journal rows); a session view whose beginning changes between turns, which silently disables the cache.
  // @category: core-functionality
  // @dependency: AgentRunHandler, ToolRegistry, ToolExecutor, SessionWindow, ModelGateway, postgresCallLedger, TaskScheduler, InvestigationService, readAgentTree, real Postgres
  // @complexity: high
  //
  // Given (the probe config as data through `processes`, nothing in `src` names it; one user; the double scripted per agent):
  //   lead turn 1: two calls in one turn - `memory_write` (a `finding` note) and `investigation_read` (a registry tool that is NOT in lead's definition); lead turn 2: `call_agent(helper, task)`; lead turn 3 (after the result): `memory_read`; lead turn 4: `finish`.
  //   helper turn 1: `memory_write`; turn 2: `call_agent(leaf, task)`; turn 3: `finish`. leaf turn 1: `finish`. Each `finish` is alone in its turn. The usage of every step is explicit, so the sums are exact.
  // When: the investigation is started through `engine.startInvestigation` and the root run ends.
  // Then (verification items):
  //   - Lifecycle: the investigation is `completed` and closed by the consumer from the `agent.root` task alone (`unrecordControllerTask` before the end proves the `isControllerTask` path, not `controller_task_id`)
  //   - Tree (AC-09.1): `readAgentTree` shows exactly three runs, lead -> helper -> leaf, each with parent run, call number, task text, result, status, own spend and subtree spend, turns linked to ledger rows and to transcripts; the transcript of
  //     every turn has role `agent` and reads back its input from the session
  //   - Isolation (AC-05.1): the session messages of lead hold lead's task, its own answers and results, and helper's task and result only - no message row of helper's or leaf's session is in lead's; helper's result is the one text helper finished with
  //   - Memory (AC-03.1): lead's `memory_read` returns helper's note with author agent `helper` and helper's run id, and lead's own note with author `lead` (design inconsistency: the Test Strategy gives `helper` no `memory_read`, so
  //     "helper sees lead's note" cannot be asserted with these definitions - see "Not observable" below)
  //   - Refusal (AC-01.2): the call outside the definition has state `rejected`, reason `tool_not_in_definition`, no effect (no `investigation_read` side effect); the next message of lead's session is its result with that code; the same turn's `memory_write` was executed
  //   - Audit (AC-10.2): rows of `research_agent_tool_calls` and rows of `agent_tool_audit` match one to one for the whole tree (count equal, every call row references a distinct audit row, including the rejected call); each audit row has the owner user, a time,
  //     the tool, the source (none) and an outcome, and no argument or run reference column holds anything; each call row names the calling agent through its run
  //   - One request per turn (KD-1): `model.calls` of role agent == ledger rows of role `agent` == turns in the sessions; every call's model id equals the definition's model (NFR-02), no other recipient
  //   - Budget sums (AC-07.2): the per-run spend of the tree adds up to the investigation's charged total
  //   - Stable prefix (AC-21.1): for consecutive turns of lead, the prompt messages up to the previous turn's last message are identical (same content, same order), the cache mark is on the system block and on the last message of each view, and
  //     the previous turn's mark is not left behind on an older message
  //   - v2 untouched: no source call (counting source at zero) and no `research.controller` task is created for this process
  describe('INT-1', () => {
    it.todo('INT-1: the probe process lead -> helper -> leaf runs from a question to a completed investigation on data only, with isolated sessions, one audit row per call and a stable session prefix');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  Two sibling agents at once: they run concurrently, the parent wakes once, notes do not collide (UC-4, UC-E5)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: "AC-05.2: Given родитель одним ходом вызвал несколько дочерних агентов, Then они работают одновременно, и родитель получает результат каждого."
  // AC: "AC-03.3: Given два агента пишут в память одновременно, Then сохранены обе заметки."
  // AC (Design Doc): "DC-5: Результаты дочерних агентов одного хода приходят родителю одним пробуждением, когда закончились все, и стоят в его сессии в порядке вызовов."
  // Behavior: lead calls `helper` twice in one turn -> both helper runs are in the model at the same time -> each writes a note and finishes -> lead wakes once -> its session holds both results in call order
  // Catches: siblings serialised (the second child starts only after the first ends); the parent woken twice (a second wake runs a duplicate turn or is rejected as a stale attempt); results written in the order the children finished instead of the order of the
  //   calls; two notes written in the same instant get one number, overwrite each other or lose one.
  // @category: core-functionality
  // @dependency: AgentRunHandler, TaskScheduler (waits_for), ToolExecutor (memory_write), research_agent_memory, real Postgres
  // @complexity: high
  //
  // Given: runtime `concurrency` >= 2 (the harness default is 2; lead is `waiting`, so both slots are free for the children). The double holds the FIRST model call of each helper until both have arrived (a latch released when
  //   `model.callsOfAgent('helper')` has two entries): the first helper cannot answer before the second has begun its work. The second call (`finish`) of the helper that was called FIRST is scripted to answer AFTER the one of the helper called second
  //   (the later-finishing child must still be first in lead's session). Both helpers' tool calls of turn 1 are `memory_write`, released together by the same latch so the two writes reach the engine at the same moment.
  // When: both helpers finish.
  // Then:
  //   - Concurrency (AC-05.2): the two helper runs overlapped - both have a recorded model call before either has a result (read from the double's call order and the run rows); neither waited for the other
  //   - One wake (DC-5): lead's task shows one `wait` and one wake; lead has exactly one turn after the calls, and that turn's session shows two results in the order of the calls (call 1 first), although the children ended in the opposite order
  //   - Notes (AC-03.3): `research_agent_memory` holds both notes, with different sequence numbers and different author runs; neither note is missing and `memory_read` returns both with their authors
  //   - Limit of this row: a database cannot be forced to interleave two transactions from a test without a hook in `src`; releasing both writes from one latch makes the collision likely, not certain. A guaranteed proof of the numbering
  //     under concurrent writers is the unit/repository spec of the memory write (two `Promise.all` writes on the real table, repeated), named for the plan; this test proves the wiring of the same scenario, not the lock.
  describe('INT-2', () => {
    it.todo('INT-2: two helpers called in one turn run at once, wake lead once with results in call order, and both of their simultaneous notes are kept');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  Stop and close take down the whole tree (UC-6)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: "AC-08.1: Given в дереве работают несколько агентов, When сотрудник останавливает расследование, Then после перехода ни один агент дерева не начинает вызов модели или инструмента."
  // AC: "AC-08.2: ... их запуски отменены тем же переходом." (this part: the cancel half - the child runs are cancelled by the same `closeInTx` transition when the root ends in failure while they work; "completed with a ready answer" is `research-flow`)
  // AC (Design Doc): "DC-18: ... когда корень кончился сбоем - например, сроком, пока дочерний ещё в вызове модели; тот же переход `closeInTx`, что при закрытии с ответом, отменяет их."
  // Behavior: (A) stop while lead waits for two helpers - one in a model call, one queued -> `InvestigationService.cancel` -> every agent task `cancelled`, nothing new starts; (B) lead's deadline passes while a helper is in a model call -> lead ends `failed` -> `closeInTx` cancels the helper
  // Catches: a child run left running or queued after the stop (a run that is not a task of the investigation, or one the cancel transition misses); a model call or a tool call that starts after the transition (the reserve check or the `requireActive` guard missing on one path);
  //   after a root failure the investigation closes `failed` but the children keep spending the budget, because the close did not cancel them.
  // @category: core-functionality
  // @dependency: AgentRunHandler, ModelGateway reserve (`stopping`), ToolExecutor (`requireActive`), InvestigationService.cancel / closeInTx, runtime deadline, real Postgres
  // @complexity: high
  //
  // Row A - stop
  //   Given: runtime `concurrency` 1 so exactly one helper runs and the other is `queued`; lead turn 1 = two `call_agent(helper)`; helper #1's model call is `hangUntilAborted`; the second helper's first step is scripted but must never be consumed.
  //   When: the owner's `InvestigationService.cancel` runs (the real service behind `ResearchLaunchService.stopLaunch`); then the test waits for the `endedRuns` of every agent task.
  //   Then (verification items):
  //   - Every agent task of the investigation (`agent.root`, both `agent.run`) is `cancelled`; the helper's in-flight double call was aborted (its signal fired); the queued helper has no attempt and no session row
  //   - After the transition: a snapshot of `research_llm_calls` ids, `research_agent_tool_calls` ids and `model.calls.length` taken right after `cancel` returns equals the one taken after all runs ended - no new reserve, no new model call, no new tool call (AC-08.1)
  //   - The aborted call's ledger row is read as in v2 `INT-2 L5` (the in-flight reservation stays counted with the charged total); this test adds no new rule for it
  //   - The waiting parent is cancelled by the same transition and is not woken by its cancelled children (no wake attempt, no duplicate turn)
  // Row B - close on a root failure
  //   Given: lead's `deadlineMs` is short on the injected runtime clock; lead called one helper and waits; the helper's model call is `hangUntilAborted`.
  //   When: the runtime clock passes lead's deadline (the injected clock and the lease/deadline sweep, not `engineClock.offsetMs`, which moves only `notAfter`).
  //   Then: lead's task is `failed` with class `deadline`; the investigation is `failed`; the helper's task is `cancelled` by the close transition and its model call was aborted; the ledger and tool-call snapshots do not grow after the close.
  describe('INT-3', () => {
    it.todo('INT-3 A: after the owner stops the investigation every run of the tree is cancelled, a queued child never starts, and no reserve, model call or tool call begins after the transition');
    it.todo('INT-3 B: a root that ends in failure while its child is in a model call closes the investigation failed and cancels the child by the same transition');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4  One budget for the tree: refusals by budget and the return of an unspent share (UC-E6, UC-E10; AC-07.2 sums)
  // ---------------------------------------------------------------------------------------------------------------
  // The one extra under the rule (see Budget): its unique defect is stated above. Rows are one rule (the share and the budget are read from the same ledger).
  // AC: "AC-07.1: Given бюджет расследования меньше требуемого, Then ни один агент дерева не начинает вызов модели сверх бюджета, а расследование завершается с причиной «бюджет исчерпан»." (this part: no call over the budget; the reason in the answer is `research-flow`, here the tree read shows `budgetExhausted`)
  // AC (Design Doc): "DC-8: ... Если остаток меньше одного хода дочернего, вызов отклонён с причиной `budget_exhausted`, и запуск не создан."
  // AC (Design Doc): "DC-9: Когда дочерний запуск кончился и в его поддереве не осталось задач в работе, его неистраченная доля возвращается родителю ... Пока в поддереве есть задачи в работе, доля занята целиком, даже если сам дочерний уже провалился."
  // AC (Design Doc): "DC-10: Запуск, которому на следующий ход не хватает доли или бюджета расследования, завершается причиной `budget_exhausted`; вызова модели сверх доли нет."  and  "DC-16: ... чтение дерева показывает признак `budgetExhausted`."
  // AC: "AC-05.3: ... родитель получает отказ с причиной и продолжает работу, а не ждёт бесконечно."  (B3: the reason `failed` of a child ended by the runtime)
  // Behavior: lead calls helper under a tight budget -> the share/reserve check refuses by the ledger's numbers -> no task, no model call over the budget; or helper ends early -> its unspent share returns to lead
  // Catches: B1 - a child run created although the parent's remainder is below one child turn (the share is not checked before the task is proposed); B2 - a reserve granted past the investigation pool or the run's share, so a call starts over the budget;
  //   B3 - a share that stays held after the subtree ended (budget locked for nothing), or one returned while a grandchild still runs (the same tokens spent twice), or a parent's remainder that counts the failed child's reserve twice.
  // @category: core-functionality
  // @dependency: postgresCallLedger / decideReserve (shares), ToolExecutor (call_agent), AgentRunHandler, readAgentTree, real Postgres
  // @complexity: high
  //
  // Budget numbers are chosen in the test from the probe definitions (`windowTokens + maxOutputTokens` = one turn of that agent, `runTokens`), with the counting token counter (1 token per character) and explicit scripted usage; assertions use literals computed from them.
  //
  // Row B1 (UC-E6, first run): investigation budget < one lead turn + one helper turn.
  //   When: lead (root, share = the whole budget) calls `helper`.
  //   Then: the call is `rejected` with `budget_exhausted`; no child task, no child run row; lead gets the refusal in its session, finishes with what it has and the root ends `completed`; the tree read shows `budgetExhausted: true`; the sum of ledger
  //   charged + open reserves <= the investigation budget; no model call was recorded past the budget (DC-8, DC-16, AC-07.1).
  // Row B2 (UC-E6, second run): investigation budget < two turns of lead itself.
  //   When: lead makes its first turn and needs a second.
  //   Then: the reserve of the second turn is refused (`investigation_tokens_exhausted`), no second model call is recorded, the root task is `failed` with class `budget_exhausted`, the investigation is `failed`, the tree read shows `budgetExhausted: true`;
  //   charged + open reserves <= budget (DC-10, DC-16, AC-07.1).
  // Row B3 (UC-E10): the share of a child that ended before its subtree.
  //   Given: lead calls helper (share = min(helper `runTokens`, lead's remainder)); helper calls leaf, then the runtime ends helper `failed` with `recovery_exhausted` (its attempts lose their lease until the recovery limit is spent, the harness `expireLease` on each attempt)
  //   while leaf's model call is held; lead is woken by the failure.
  //   When: lead makes its next turn; later leaf's call is released and leaf finishes.
  //   Then: lead's session holds `child_failed` with reason `failed` (AC-05.3); while leaf is running, lead's held amount (read from the tree read: own spend + the whole share of helper) still includes helper's whole share and lead's next reserve is checked against
  //   that smaller remainder; after leaf ended, lead's held amount is its own spend + the actual spend of helper's subtree and the remainder is back (a later lead call_agent that needs the returned part is accepted); the sum of per-run spend equals the investigation's charged total (AC-07.2).
  //   Needs a hook that holds the engine between `TaskScheduler.propose` returning and the write that records the child's task id (support item 4): the existing `handlerHold` points sit after guarded writes, none lies in that gap.
  describe('INT-4', () => {
    it.todo('INT-4 B1: a call_agent whose share does not fit the parent\'s remainder is rejected with budget_exhausted, creates no run and the tree read shows budgetExhausted');
    it.todo('INT-4 B2: a root without the budget for its next turn starts no further model call, fails with budget_exhausted and spends no more than the budget');
    it.todo('INT-4 B3: a child ended by the runtime before its subtree keeps its whole share held until the subtree ends, then only its actual spend, and the parent gets child_failed(failed)');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Proven elsewhere (named for the plan; no skeleton here, by the light test process)
// ---------------------------------------------------------------------------------------------------------------
// Unit (table-driven, packages/engine/src/**/*.spec.ts), one spec per rule:
// - config loader (UC-2: AC-01.1, AC-13.2, DC-1): one table of broken probe configs (tool outside the registry, unknown callee, `rootAgent` outside `agents`, source outside the process, window below the smallest view, unknown key) plus the shipped v2 config; each row names the agent and the field
// - turn rules (UC-E7: DC-2, DC-14, DC-17): `no_tool_call`, `invalid_result`, `finish_not_alone`, only `finish` on the last turn, `turn_limit`
// - limits and share (UC-E1, DC-6, DC-7, DC-8): `depth_limit`, `children_limit`, `task_limit`; share = min(`runTokens`, remainder); the closed list of `child_failed` reasons from the failure class/code table; `deadline` of a child after the parent's `notAfter`
// - session window (UC-7, DC-13): the four steps in order, a reached step holds, the stub names tool, turn, size and the tool to read again, the stored session is not changed
// - access (UC-11: DC-12, AC-10.1): `ToolAccessPolicy` refusal writes `access_denied` and calls nothing; child sources = parent sources INTERSECT definition sources
// - `yield` (UC-E8, KD-6): `HandlerResultSchema` accepts it, `outcomeOfResult` maps it to `released` and `recovery_count` does not grow (a runtime unit/contract spec); the handler returns it after the slice
// - repository-level, real Postgres (the default `vitest run` has no database, so these run in the e2e job as small DB-backed specs, not as scenarios): AC-04.1/AC-04.2 and DC-4 `foreign_ref` / `not_found` (UC-3, UC-E9), AC-03.2, AC-03.4 and NFR-01 (UC-N1: another owner reads
//   `investigation_not_found`, deleting the conversation removes sessions, calls and memory), AC-22.1..AC-22.6 (UC-9, UC-10: snapshot at start, areas, `no_write_right`, `limit_reached` at 8 KiB, records survive the investigation's deletion), the two-writers numbering of the memory write (INT-2 limit)
// - cache price (UC-8, AC-21.1): the gateway's cache-read pricing is existing v2 logic; INT-1 proves only that the view's start is stable
//
// Not observable as an assertion (reported to the caller):
// - UC-1 "заметку видит helper с агентом-автором lead": with the Test Strategy's probe (`helper` has `memory_write` and `call_agent`, no `memory_read`) the helper has no way to see lead's note. INT-1 asserts the cross-agent read the other way (lead reads helper's note and its author).
//   Giving `helper` `memory_read` in the probe would let the test assert the stated direction too; this is a design/probe-definition choice, not made here.
// - The KD-1 assumption "one Mastra `generate` = one request and returns tool calls unexecuted" is a spike the plan runs first; INT-1 reads its consequence (double calls == journal rows) but cannot tell the spike's two outcomes apart (tool-call mode vs the structured-output fallback)
// - INT-2 AC-03.3: the instant of two simultaneous transactions cannot be forced from a test (see the limit in INT-2)
