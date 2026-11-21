// deep-agents / agent-types - agents-package integration skeleton (in-process `createRuntime` + `createAgents` over real Postgres, real MCP fixture process, scripted model)
// Design Doc: docs/features/deep-agents/design-agent-types.md (v1.2, Draft), Test Strategy UC-7, UC-8 (wiring half), KD-5, DC-4, Invariants 1 and 2
// PRD: docs/features/deep-agents/prd.md FR-04, FR-09 (AC-04.1, AC-04.2, AC-09.1, AC-09.2)
// Generated: 2026-11-22 | Part: agent-types | Test type: Integration (no E2E file in this package)
// Implementation timing: written alongside the plan slice (`agent_run_tasks`, `task_list`, the plan block of the model and compaction steps, the open-items input of `endOfTurn`) and run once, at the end of the part.
//
// File name follows the repo convention of the `agents` package (`<feature>-<part>.int.e2e-spec.ts` under packages/agents/test, run with `pnpm --filter @agent-os/agents test:e2e`). The test is `it.todo`:
// the comments above it are its specification; the implementing task replaces `it.todo` by `it`, adds the imports and fills the body.
//
// Harness: `createAgentsHarness` of support/agentsHarness.ts (real Postgres, real runtime and agents, scripted `ModelClient` as the only model double), the library double extended with a `deep_agent`
// record kind (a team of two subagents and a final subagent). "The restarted server" is a second harness over the same database (`createAgentsHarness` again, as agent-platform-agents INT-3 C does);
// a lost step is `expireLease` as in INT-3 E. A unique owner `newUser()` per test; no sleeps, `script.called(n)` and `waitForTaskStatus` order the steps.
//   Support the implementation tasks add (not skeletons): `LibraryDoubleRecord` gets the `deep_agent` kind; a reader `planRowsOf(db, sessionId)` over `app.agent_run_tasks`;
//   a model-input reader for the LAST line of the system prompt of a recorded call (`script.calls[n].system`).
//
// Budget: Integration 1 here (INT-3). With INT-1 and INT-2 (apps/api) and INT-4 (db) the part uses 4 of 3, through the "up to 5" allowance; INT-3 names its defects below. E2E 0 in this package.
//
// Proven elsewhere (the plan reads this to avoid a second test for an AC already proven):
// - unit, packages/agents/src/step/turn-rules.spec.ts (extend the `endOfTurn` table): deep agent with no children in work x {open item `waiting`, open item `running`, all `done` or `cancelled`, no plan}, and the
//   order of branches (open items before the final-subagent rule; root, plain agent and subagent unchanged) - UC-8, AC-09.1 (rule), AC-09.2
// - unit, `task_list` rule table (next to the tool): `add` numbers from 1 and never reuses a number; `set` of an unknown number, a move out of `done` or `cancelled`, `failed` from an agent, an empty call and a
//   plan over the code limit -> `invalid_arguments` with its text - KD-5, Invariant 2
// - unit, `gateStart` table (extend): deep agent x {name in the team, name outside it, id of a `deep_agent` record, `maxRuns` reached}, and agent x {id of a `deep_agent` record} -> `not_allowed` / `run_limit`
//   - UC-5, AC-02.1, AC-03.2, DC-2, DC-3. The wiring (a refused start creates no task, session or ledger row) is proven by the rewritten INT-1 D below, not again here.
// - rewritten existing, packages/agents/test/agent-platform-agents.int.e2e-spec.ts INT-1 D (final subagent's report becomes the session's report, an answer before it gets a notice, a start outside the team is
//   refused without creating a task) and packages/workflows/test/agent-platform-workflows.int.e2e-spec.ts INT-2 A, INT-3 B (the research run end to end: plan, two gather agents, early answer notice, report as the
//   run's answer) - they move here onto `deep_agent` as the one proof of UC-6 / AC-02.2 / AC-05.1 / AC-05.2 / AC-07.1 / AC-03.2. Nothing of them is restated in this file.
// - rewritten existing, agent-platform-workflows INT-1 (the brief: nothing starts before the decision, an edited question reaches the run, one run per request, a decline starts nothing) moves with
//   `start_workflow` into `agents` as the `start_deep_agent` test - AC-03.1.
// - existing, agent-platform-agents INT-4 (every agents operation called as another owner answers as for a missing agent): the new `tasks` read of `GET /api/agents/:agentId/tasks` is ONE MORE ROW of its table
//   (owner sees the three items; another employee and an unknown id answer `AGENT_NOT_FOUND`) - UC-7 second half, AC-04.1 isolation. Not a new test; the plan adds the row to that file.
// - rewritten existing, self-learning-core INT-1..INT-12 on `deep_agent` (the learning run row is written at start, the extraction task after the end) - UC-9, AC-08.1; the flag reaching `learningRunOf` is the
//   rewritten INT-1 there.
//
// acProof of this file: AC-04.2: INT-3 rows A and B; AC-04.1 (model side): INT-3 row B; AC-09.1 (wiring), AC-09.2: INT-3 row C; DC-4: INT-3 row B

import { describe, it } from 'vitest';

describe('deep-agents / agent-types - the plan belongs to the run: written with the step, read at every step, never lost or doubled', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: the plan survives a lost step, a restart and compaction, and the model is stopped by it when it answers with open items
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-04.1 "Given глубокий агент добавил три пункта и первый перевёл в «в работе», when сотрудник открывает экран агента, then видит три пункта и их статусы." (the read side: the rows and the model's block)
  //   AC-04.2 "Given у запуска есть план, when сервер перезапустился или сотрудник продолжил работу сообщением, then план тот же, с теми же статусами."
  //   AC-09.1 "Given в плане пункт «в работе», when глубокий агент отвечает текстом, then ответ не принят, а агент видит уведомление с этим пунктом."
  //   AC-09.2 "Given все пункты плана «готова» или «отменена», when глубокий агент отвечает текстом, then ответ принят."
  //   DC-4 "Модель видит план целиком в начале каждого шага, в том числе после сжатия истории."
  //   Invariants 1, 2: "Пункт плана пишется и меняется в транзакции шага своего запуска, вместе с `tool_result` вызова, который его изменил." / "Номер пункта не меняется и не повторяется в запуске."
  //   Design: UC-7, UC-8 (wiring); KD-5; Flow 2 (the open-items branch).
  // Behavior: a deep agent session calls `task_list` (add three items, set the first `running`) -> the rows are written in the step's transaction with the `tool_result` -> the step is lost after the commit and
  //   replayed, the server restarts, the employee writes a message, the history is compacted -> every model call and the compaction call see the same plan as a block at the end of the system prompt -> a text
  //   answer with an open item gets a `notice` naming it, and with all items closed ends the run.
  // Catches: (1) the plan kept only in the history or in memory - lost by compaction (the summary replaces the history) or by a restart; (2) a replayed step writing the three items twice (items 4-6), or the
  //   numbers restarting at 1 after the restart (the write not in the step's transaction, or not idempotent with the `tool_result`); (3) the plan block missing from the COMPACTION call or from the first step after
  //   it - the model then re-plans from the summary; (4) the open items not read from the table before `endOfTurn` (the rule is unit-correct, the step feeds it an empty list) so the early answer of the
  //   deep agent is accepted with work open.
  // @category: core-functionality
  // @dependency: createRuntime, createAgents (`task_list`, step handler, compaction step, endOfTurn input), library double with a `deep_agent` record, scripted model double, Postgres (agent_run_tasks)
  // @complexity: high
  //
  // Verification items (one scripted deep agent run, started directly as `deep_agent` record of the owner; the model's literal texts and numbers are written in the test):
  // - Row A "lost step and restart" (AC-04.2, Invariants 1-2): step 1 answers `task_list { add: ['собрать логи', 'сверить с заказами', 'написать вывод'], set: [] }`, step 2 `task_list { set: [[1, 'running']] }`.
  //   The lease of the task is expired right after step 1 commits (`expireLease`) so the step is replayed: the rows are exactly three (numbers 1-3, statuses waiting, `running` after step 2), the `tool_result` of the
  //   call appears once in the history. Then the first harness is closed and a second one over the same database starts: `planRowsOf` still shows the same three rows, and a message from the owner makes
  //   step 3 run; its model input shows the plan block with the same numbers and statuses; a further `add` gets number 4 (not 1).
  // - Row B "block at every step and after compaction" (AC-04.1, DC-4): with `AGENT_COMPACT_AT_TOKENS` low, the answer of step 2 reports usage over it so the next step is a compaction. Then: the recorded model call of
  //   step 1 (before any item exists) carries no items, calls of steps 2 and 3 end their system prompt with the block listing `1 running`, `2 waiting`, `3 waiting` and the item texts; the compaction call carries the
  //   same block; the first step after compaction carries it too; the block is not in any history entry (`historyOf` has no line with the block's text).
  // - Row C "answer with open items" (AC-09.1, AC-09.2): the deep agent has no children in work. Its text answer while item 1 is `running` -> the next model input holds a `notice` whose text names the number 1
  //   and the item text, and the run is not finished (status still active); after `task_list { set: [[1,'done'],[2,'cancelled'],[3,'done']] }` the next text answer ends the run with that text as its report.
  it.todo('INT-3: the plan is written with the step and survives a replayed step, a restart and compaction without a double or a renumbering, and an answer with an open item is refused with a notice naming it');
});
