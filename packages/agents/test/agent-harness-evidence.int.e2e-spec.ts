// agent-harness / evidence - agents-package integration skeletons (in-process `createRuntime` + `createAgents` over real Postgres, real MCP fixture process, scripted model)
// Design Doc: docs/features/agent-harness/design-evidence.md (v1.0, Draft), Test Strategy UC-3, UC-4, UC-5, UC-6 (KD-1, KD-2, KD-3, KD-4, KD-5, KD-6, KD-7)
// PRD: docs/features/agent-harness/prd.md FR-08..FR-11 (AC-08.1..AC-08.4, AC-09.1..AC-09.3, AC-10.1, AC-10.2, AC-11.1) and NFR-01, NFR-02, NFR-03
// Generated: 2026-11-21 | Part: evidence | Test type: Integration (no E2E file: see "Budget")
// Implementation timing: written alongside the slice each test names and run once, at the end of the part (project rule "Tests only at the end"):
//   INT-1 with the excerpts step, `start_agent`'s report blocks and the `excerptPass` flag of the built-in `deep-research` record;
//   INT-2 with the failure branches of the excerpts step (no sources, model error);
//   INT-3 with the step-handler selection of the excerpts step (restart is a property of the step as committed, so it follows the step itself);
//   INT-4 with the repository read of the stored results of one task and after INT-1 (it reuses INT-1's record and scripts).
//
// File name follows the repo convention of the `agents` package (`<feature>-<part>.int.e2e-spec.ts` under packages/agents/test, picked up by `vitest.config.e2e.ts`, run with
// `pnpm --filter @agent-os/agents test:e2e`, never in the default `vitest run`; the sibling is agent-harness-core.int.e2e-spec.ts). Every test is `it.todo`: the comments above it
// are its specification; the implementing task replaces `it.todo` by `it` and fills the body (a skeleton that passes on day one proves nothing).
//
// Harness: `createAgentsHarness` of support/agentsHarness.ts (real Postgres, real runtime and agents, scripted `ModelClient` of `@agent-os/agents/testing` as the only model double,
// the real MCP fixture process, `expireLease` and a zombie instance for the restart). The deep-research team is a workflow record of the library double built as `learningWorkflow` /
// `startLearningRun` of self-learning-core.int.e2e-spec.ts build theirs: a coordinator, `deep-research-plan` (no pass), two `deep-research-gather` (pass on) and
// `deep-research-answer` as `finalExecutor`. Isolation: a unique owner `newUser()` per test, its own `createFixtureFiles(...)`, a unique workflow record id; no sleeps, `script.called(n)`
// and `waitForTaskStatus` order the steps. The scripted model tells the pass calls from executor calls by the instructions text it records (`script.calls[i].instructions`).
//
// Support the implementation tasks add (not skeletons, no test of their own):
//   - the scripted model answers a pass call with one tool call (`claims` / `quotes`), the shape KD-4 fixes; the double needs no new capability beyond a per-call matcher on the
//     recorded instructions, which the self-learning extraction rounds already use.
//   - `harness.logs` (exists) is the capture for the journal records; `ledgerRowsOf(owner, taskId)` (exists in self-learning-core) reads the token ledger.
//
// Budget: Integration 4 of 3, E2E 0 of 1-2.
//   The fourth integration test (INT-4) uses the "up to 5" allowance of integration-e2e-testing: its defect (an owner predicate missing from the list read or from the tree read of
//   `start_agent`) is named in its own block and no other test sees it; INT-1 runs both executors under one owner, so a missing owner filter passes there. PRD NFR-02 asks for exactly
//   this two-employee test.
//   E2E: none. The journey this part serves (the owner's reruns of deep research on Haiku, PRD Success Criteria) is a paid manual check, not a CI test; INT-1 already runs the whole path
//   gather -> pass -> answer assignment over the real database.
//
// Proven elsewhere (not in this file; the plan reads this to avoid a second test for an AC already proven). The unit tests are written by the implementation phases,
// one table-driven test per rule, none of them skeletoned here:
// - unit, the quote check (pure-decision, own file next to `check-operations.spec.ts`): source `s1` text with other whitespace -> supported; one changed digit -> `unsupported`, claim stays; id not in the
//   map (another executor's call) -> `unsupported`; `&quot;` / `&lt;` / `&gt;` / `&amp;` entities in the quote -> supported; empty quote -> `unsupported`; two fitting quotes for one claim -> the first
//   counts; a quote for a claim number that does not exist -> not counted; quote over 500 chars -> cut before the check - UC-1, AC-09.1, AC-09.2, AC-09.3, DC-5, DC-6
// - unit, pages and batches (next to `large-result.ts`): pages of one source join back to its text without loss, no batch over 24 000 tokens (bytes / 4), calls over the limit of six leave the rest unread
//   and counted, a source with empty text takes no `sN` - UC-2, DC-3
// - unit, the round of a structured answer (`tool-call-answer`, next to `extract.handler.ts`'s spec): unparsable answer retried once with the error, a second unparsable ends the round, `cutOff` counts
//   as unparsable - KD-4; the existing extraction round (self-learning-core INT-6) proves the extraction side still works after the move, no new test for it
// - unit, which executors get a report block (rows of the tree): completed + `excerptPass` + this coordinator's + creation order, a failed or stopped executor gets none, the plan executor and another
//   coordinator's executors get none, executors of an earlier turn of a continued conversation are included - UC-7, DC-7, DC-8; the shape of one block with `[supported by quote]`, `[no quote]`,
//   `[no excerpts]` - AC-10.2 (rule). INT-1 proves that `start_agent` reads the real tree and lands the blocks in the real assignment once
// - unit, `draft_record` (extend `packages/agents/src/tools/tool-registry.spec.ts`, which already carries `selfLearning` rows): a change that does not mention `excerptPass` keeps it at the executor
//   of the same name, a new executor gets `false` - UC-8, DC-9, KD-7. The schema default (`false` for old content) is a row of the contract schema test
// - unit, the log-field builder of the pass: the shares and the counters for outcomes `done`, `no_sources`, `refused`, `model_error`, `invalid_answer` - DC-10. INT-1 row C proves one real record,
//   INT-2 row B the zero-counter record of a failed pass
// - not automated: AC-10.3 (the answer does not present an unmarked claim as confirmed) is the model's behaviour; the owner checks it by hand on the answers (design Test Strategy)
// - not automated: DC-1 audit entry `access_denied` of a refused pass call - the same helper writes the entry for a refused model step and the model step's own test proves it; the pass only calls it.
//   INT-2 row B proves that a failing pass call ends the task with the report and no excerpts, whichever the reason
// - not automated: DC-2 (a message that arrives after the answer makes the next step a model step) is the branch of the step handler that already picks the model step on a message
// - not automated: the built-in record reaching an existing database (design Open Questions) - an owner decision, not a test
//
// acProof (the same mapping as the JSON of the generation report):
// - AC-08.1: INT-1 row A; AC-08.2: INT-1 row A (plan executor); AC-08.3: INT-2 row A; AC-08.4: INT-2 row B
// - AC-09.1, AC-09.2, AC-09.3: unit; INT-1 row B shows the marks reach the assignment (one supported, one unsupported)
// - AC-10.1: INT-1 row B; AC-10.2: INT-1 row B (+ unit for the block shape); AC-10.3: not automated
// - AC-11.1: INT-1 row C (+ INT-2 row B for the failed pass)
// - NFR-01 (no claim, quote or result text in the journal): INT-1 row C; NFR-02: INT-1 row A (per-executor sources) + INT-4; NFR-03: INT-3

import { describe, it } from 'vitest';

describe('agent-harness / evidence - the answer agent gets each gather report with excerpts checked against its own stored results', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: the main path - gather executors run the pass, the code marks the quotes, `start_agent` puts the reports into the answer agent's assignment
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-08.1 "Given исполнитель сбора закончил работу отчётом и у него есть сохранённые результаты, when проход выписок выполнен, then для каждого утверждения отчёта есть выписка с цитатой и id вызова или с пометкой, что цитаты нет."
  //   AC-08.2 "Given у исполнителя проход не включён, например у исполнителя плана, when исполнитель закончил работу, then прохода нет и всё идёт как сегодня."
  //   AC-10.1 "Given два исполнителя сбора закончили работу и их проходы выполнены, when стартует агент ответа, then его задание содержит оба отчёта и выписки обоих с пометками, хотя координатор их в задание не писал."
  //   AC-10.2 "Given у утверждения пометка «без цитаты», when стартует агент ответа, then это утверждение есть в его задании вместе с пометкой."
  //   AC-11.1 "Given проход выписок выполнен, then журнал содержит одну запись с числом утверждений, обеими долями и стоимостью прохода, с id запуска и исполнителя."
  //   NFR-01 "Записи журнала этой фичи не содержат значений аргументов, текстов утверждений и цитат, секретов и токенов - только имена, числа, исходы и id."
  //   NFR-02 "Проход выписок читает только сохранённые результаты вызовов своего исполнителя, сделанных по правам запускающего" (the per-executor half; the two-employee half is INT-4).
  //   Design: UC-3; KD-1, KD-2, KD-3, KD-5, KD-6, KD-7; Flow 1, Flow 2.
  // Behavior: one `deep-research` record of the library double - a coordinator, `deep-research-plan` (no pass), two `deep-research-gather` G1 and G2 (pass on, each calls `logs` `get_trace`
  //   once on its own trace and ends with a text report), `deep-research-answer` as `finalExecutor`; the result of G1's call holds SECRET_MARK in a field the masking does not know (it must not
  //   reach the journal) ->
  //   the coordinator starts plan, then G1 and G2, then, after both reported, `start_agent` for the answer agent with a brief that carries no report text;
  //   each gather's pass runs between its last text and its end: one call for the claims (the scripted answer lists two claims for G1, one for G2), one call for the quotes (G1: claim 1 a line
  //   copied from its own result, claim 2 a line that is in no result; G2: claim 1 a line from its own result);
  //   the answer agent's first model call is the observation point.
  // Rows (one scripted run, literal expected values):
  //   A. the executors (AC-08.1, AC-08.2, NFR-02): the plan executor's task result is `{ report }` with no `excerpts` and no pass call was made for it (the recorded calls whose instructions are the
  //      pass's: exactly two claims calls, one per gather, and no more than one quotes call each); the claims call of G1 sees G1's report and nothing of G2's, the quotes call of G1 holds only G1's result text
  //      as `s1` and none of G2's, and the reverse for G2; the task result of G1 holds `excerpts` with two entries in the order of the claims, G2's one entry; no pass call is recorded in either
  //      executor's history (`agents.get(...)` history has no entry from the pass).
  //   B. the assignment (AC-10.1, AC-10.2): the answer agent's task input, its `agent_sessions.prompt` and the first model input hold the same text: the coordinator's brief first, then one report block per gather in
  //      the order they were started; the block of G1 holds its report and its two claims, the first with `[supported by quote]`, the quote and `logs/get_trace`, the second with `[no quote]` and the claim
  //      text (the claim was not dropped); the block of G2 holds its report and its claim `[supported by quote]`; the plan executor has no block; the coordinator's brief and its own history hold no report text
  //      and no excerpts (`child_finished` carries the report only).
  //   C. the journal (AC-11.1, NFR-01): over `harness.logs` filtered by the run id, exactly two `excerpt pass finished` records, one per gather, with `agentId` of that gather, `parentId` the coordinator's
  //      task, `outcome: 'done'`, G1 `claims` 2, `supported` 1, `unquoted` 1, `supportedShare` 0.5 and `unsupportedShare` 0.5, G2 `claims` 1, `supported` 1, `supportedShare` 1, both with `modelCalls`
  //      and `costUsd` read from the ledger of the gather's task (`ledgerRowsOf`, two or more rows of the pass's calls billed to the owner), an `answer reports added` record with 2 blocks, 2 with excerpts, 0 without;
  //      no record of the run holds SECRET_MARK, a claim text, a quote text or a report text anywhere in its JSON.
  // Catches: (1) the pass wired to the wrong executors - run for the plan executor (the flag read from the workflow instead of the executor), or for an executor whose snapshot does not carry
  //   `excerptPass` (the field lost between the library record and the snapshot, KD-7), or never run at all; (2) the pass reading the stored results of the wrong task (the sibling gather's results
  //   in G1's quotes call) - a quote can then be supported by a call the executor never made; (3) the excerpts committed after `child_finished`, or not at all, so the answer agent starts without them
  //   (KD-1: only the order inside the executor's closing transaction guarantees it); (4) `start_agent` not appending the blocks, or appending them only for one executor, or the coordinator still
  //   copying the reports itself and the code adding a second copy; (5) the check dropping a claim whose quote was not found instead of marking it, or the mark lost between the task result and the
  //   assignment text; (6) a journal record carrying a claim, quote or result text. The pure quote check, the paging and the block shape are unit tables that start from the values they are given
  //   and see none of these.
  // @category: core-functionality
  // @dependency: excerpts step, step handler selection, model step ("continue" instead of "finish" for an executor with a pass), tool-call-answer round, quote check, pages and batches, stored results read, runtime task result and `child_finished` commit, `start_agent` (report blocks, `tasks.listTree`), `excerptPass` of the executor snapshot, journal, token ledger, Postgres, MCP fixture (logs), ScriptedModel
  // @complexity: high
  it.todo('INT-1: two gather executors with the pass end with report and checked excerpts, the plan executor with none, and the answer agent starts with both reports and their marks in its assignment, the journal holding names and numbers only');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: a gather with nothing to quote, and a pass that fails, both end with their report and no excerpts; the run goes on
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-08.3 "Given исполнитель сбора делал вызовы только через `run_code`, when он закончил работу, then прохода нет, а агент ответа получает его отчёт с отметкой, что выписок нет."
  //   AC-08.4 "Given проход выписок кончился ошибкой модели, when начинается агент ответа, then он получает отчёт этого исполнителя с отметкой, что выписок нет, а запуск не падает."
  //   AC-11.1 (the record of a failed pass). Design: UC-4; KD-4; Flow 3.
  // Behavior: the same record as INT-1 with two gathers: G1 calls tools only through `run_code` (its calls are not stored as results), G2 calls `logs` `get_trace` once; the scripted model answers G2's claims
  //   call with a provider error that outlasts the retries of `ModelClient` (as `ownerModelRefusals` / the error scripts of self-learning INT-6 do), so G2's pass ends before any quotes call ->
  //   both gathers end with their text report, the coordinator starts the answer agent after both reports.
  // Rows (one scripted run, literal expected values):
  //   A. G1 (no sources, AC-08.3): no pass call is recorded for G1 (no claims call with its report); its task result is `{ report, excerpts: null }`; its `child_finished` reached the coordinator once.
  //   B. G2 (model error, AC-08.4): the task ends `completed` (not `failed`, no `handler_error`) with `{ report, excerpts: null }`; exactly one pass call was made for G2 (the claims call, no quotes call);
  //      the coordinator received G2's `child_finished` once; the journal holds one `excerpt pass finished` record for G2 with `outcome: 'model_error'`, `claims` 0, `supported` 0, `pagesRead` 0 and a `reason`
  //      (warn level), and one for G1 with `outcome: 'no_sources'` and zero counters.
  //   C. the assignment: the answer agent starts, its assignment holds the reports of G1 and G2 each with the single line `[no excerpts]` and no claim lines; the run ends with the answer agent's text
  //      (`runs.get` status completed): the run did not fail.
  // Catches: (1) a failing pass call that throws out of the step, so the executor's task fails, no `child_finished` is written and the coordinator waits for a report that never comes - the whole run
  //   hangs on one flaky call; (2) the pass called for an executor without stored results (an empty claims call billed for nothing, or a call that fails on an empty source list); (3) a block with no marker at all
  //   (the answer agent cannot tell "no excerpts" from "all claims confirmed"), or a block missing for the executor whose pass failed; (4) the record absent for the failed pass, so the owner's
  //   success measure (PRD: 70% supported over ten runs) is computed over successful passes only. A unit test of the step's branches starts from a given failure; only this test sees the task still
  //   complete and the coordinator still hear it.
  // @category: edge-case
  // @dependency: excerpts step (no-sources and failure branches), step handler selection, `run_code` calls (not stored), ModelClient provider error, runtime task result and `child_finished` commit, `start_agent` (report blocks), journal, Postgres, ScriptedModel
  // @complexity: medium
  it.todo('INT-2: a gather that used only run_code and a gather whose pass call fails both end completed with their report and no excerpts, the answer agent gets "[no excerpts]" for each, and the run completes');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: a restart in the middle of the pass - one report, excerpts once, both attempts billed
  // ---------------------------------------------------------------------------------------------------------------
  // AC: NFR-03 "Рестарт процесса посреди прохода выписок не теряет проход и не дублирует его: агент ответа получает выписки каждого отчёта ровно один раз." Design: UC-5; KD-1, KD-2; Flow 4, DC-4.
  // Behavior: a run as in INT-1 with one gather G; instance A runs G's excerpts step: the claims call is answered and the quotes call is held by a latch (as the held model calls of agent-platform-agents INT-3) ->
  //   the lease of G's task is expired (`expireLease`), instance B (the restarted server) picks the step up and runs it again from the start; the held call of instance A is released afterwards (the zombie
  //   tries to commit) -> G ends, the coordinator starts the answer agent.
  // Rows (one test, literal expected values):
  //   A. G's task is `completed` once, its result holds `report` and `excerpts` from the second attempt's answers only; the coordinator's history holds exactly one `child_report` for G; the runtime
  //      rejected the zombie's commit (no second `child_finished`, no second event of the end of G; read through the coordinator's inbox rows and the task's events, as agent-platform-agents INT-3 row E does).
  //   B. the answer agent's assignment holds the block of G once, with the excerpts of the second attempt.
  //   C. the token ledger of G's task, read by owner and task, holds the rows of both attempts' pass calls (the claims call of A, the claims call and the quotes call of B - three or more rows, none
  //      dropped, none from a call that was not made); the pass wrote nothing else in the first attempt (no excerpts in the task result between the attempts, no history entry from the pass).
  // Catches: the excerpts written in a commit of their own before the step's end (a restart then leaves excerpts of a task that is not yet finished, and the second attempt writes them again - twice in the
  //   result, or twice in the block); the zombie's stale commit accepted (two `child_finished`, the coordinator sees the report twice and starts the answer agent early); a step that has already written its
  //   ledger rows being "protected" by dropping them on retry, so the cost of the first attempt vanishes. The commit-ownership rule belongs to the runtime and is proven there; this test proves the excerpts
  //   step is built on it - the one place the evidence part adds to the closing commit.
  // @category: edge-case
  // @dependency: excerpts step, step handler, runtime lease and stale-commit rule, `expireLease`, zombie instance, token ledger, `start_agent` (report blocks), Postgres, ScriptedModel (held call)
  // @complexity: high
  it.todo('INT-3: when the server is restarted in the middle of the pass the gather ends once with one report, its excerpts appear once in the answer agent assignment, and both attempts are in the token ledger');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4: two employees - the stored results of one task are read by its owner only, and one employee's excerpts never reach another's answer agent
  // ---------------------------------------------------------------------------------------------------------------
  // AC: NFR-02 "Проход выписок читает только сохранённые результаты вызовов своего исполнителя, сделанных по правам запускающего, а агент ответа получает выписки только из своего запуска. Проверка — тест с двумя сотрудниками: выписки одного не попадают в задание агента ответа другого."
  //   Design: UC-6; KD-5, KD-6; Security Considerations. Criteria: AC-09.3 (the map `s1`...`sN` holds only the executor's own calls).
  // Behavior: two employees U1 and U2 run the same `deep-research` record side by side (a unique coordinator each, one gather each with the pass on, a result carrying a mark unique to the employee),
  //   the quotes of each gather cite its own result; U1's gather makes three calls, the second returns an empty text -> both answer agents start; then the repository read of the stored results
  //   of U1's gather is called directly with U1's owner id and again with U2's owner id for the same task id.
  // Rows (one test, literal expected values):
  //   A. the assignments: the answer agent of U1 holds U1's report block with U1's quote and no text of U2's report, claims or quote; the answer agent of U2 the reverse.
  //   B. the read as U1: exactly the rows of U1's gather task with a non-empty text, in call order, each with its call id and tool name (two rows, the empty one skipped); none of U1's other tasks, none of U2's.
  //   C. the read as U2 for U1's task id: an empty list, and no error text that names the task's existence.
  // Catches: the list scoped by task but not by owner (an employee who obtains another's task id reads that task's results, and quotes from another employee's tool output reach a report), or by
  //   owner but not by task (sibling gathers of one run flow into one pass and a quote is "supported" by a call the executor never made); `start_agent` reading the tree without the owner of the
  //   coordinator's task (another employee's blocks in the assignment). INT-1 runs both executors under one owner, so it passes with any owner predicate missing; only real rows of two owners show it.
  //   The pure parts (numbering, empty-text skip) are inputs to the unit tables and are not repeated here.
  // @category: core-functionality
  // @dependency: stored results repository (list of a task by owner), `tasks.listTree(rootId, ownerId)`, `start_agent` (report blocks), excerpts step, real tool call path, Postgres, MCP fixture (logs), ScriptedModel
  // @complexity: medium
  it.todo('INT-4: an employee\'s gather pass reads only the stored results of its own task as its owner, and one employee\'s reports and quotes never appear in another employee\'s answer agent assignment');
});
