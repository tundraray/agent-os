// agent-harness / core - agents-package integration skeletons (in-process `createRuntime` + `createAgents` over real Postgres, real MCP fixture process, scripted model)
// Design Doc: docs/features/agent-harness/design-core.md (v1.0, Draft), Test Strategy UC-2, UC-4, UC-6, UC-8, UC-9, UC-10 (+ the journal half of UC-2) (KD-1, KD-3, KD-4, KD-5, KD-6, KD-7)
// PRD: docs/features/agent-harness/prd.md FR-01..FR-07 (AC-01.1, AC-01.2, AC-02.1, AC-03.1, AC-04.1, AC-04.2, AC-05.1, AC-06.1, AC-06.2, AC-07.1, AC-07.2) and NFR-01
// Generated: 2026-11-21 | Part: core | Test type: Integration (no E2E file: see "Budget")
// Implementation timing: written alongside the slice each test names and run once, at the end of the part (project rule "Tests only at the end"):
//   INT-1 with the argument check, the repeat rule, the `tool_call_refused` audit entry and the journal fields of the model step;
//   INT-2 with `toOutcome` / `unknown` and the text of a failed call;
//   INT-3 with `cutOff` of `ModelClient` and the `endOfTurn` input;
//   INT-4 with the empty-summary branch of the compaction step.
//
// File name follows the repo convention of the `agents` package (`<feature>-<part>.int.e2e-spec.ts` under packages/agents/test, picked up by `vitest.config.e2e.ts`, run with
// `pnpm --filter @agent-os/agents test:e2e`, never in the default `vitest run`). Every test is `it.todo`: the comments above it are its specification; the implementing task
// replaces `it.todo` by `it` and fills the body (a skeleton that passes on day one proves nothing).
//
// Harness: `createAgentsHarness` of support/agentsHarness.ts (real Postgres, real runtime and agents, scripted `ModelClient` of `@agent-os/agents/testing` as the only model double,
// the real MCP fixture process registered under the run's names). Isolation: a unique owner `newUser()` per test, its own `createFixtureFiles(...)`, a root record
// `testRecord(...)`; no sleeps, `script.called(n)` and `waitForTaskStatus` order the steps.
//
// Support the implementation tasks add (not skeletons, no test of their own):
//   - `createAgentsHarness`: an `audit` capture. Today the harness passes `audit: async () => {}`; INT-1 reads the entries `createAgents` was given (`harness.auditEntries`).
//     The real hook in `apps/api` (`accessAudit` in agents.module.ts) hands the entry to `AuditLog.record` unchanged and `audit_events.kind` is a free string, so a capture at the
//     port is the whole of what a test can see; no apps/api test is written for the new kind.
//   - `src/testing.ts`: a scripted answer may be marked `cutOff: true`; the double then answers with `finishReason: 'length'` (today it is `tool-calls` or `stop`). That is the same
//     value the real turn client reads from the provider, so the mapping of `ModelClient.call` to its `cutOff` flag is exercised by INT-3 as well.
//
// Budget: Integration 4 of 3, E2E 0 of 1-2.
//   The fourth integration test (INT-4) uses the "up to 5" allowance of integration-e2e-testing: its defect is named in its own block and no other test catches it (it is the only
//   test where a compaction step commits without a `compaction` entry over the real database). INT-1 and INT-2 each merge several ACs into one scripted run (table rows).
//   E2E: none. The only user-visible journey of this part is the owner's rerun of the deep-research tasks on Haiku (PRD, Success Criteria): a paid manual check, not a CI test;
//   INT-1..INT-4 already prove the platform side of it (what the model is told about its mistakes) against the real database and the real MCP server.
//
// Proven elsewhere (not in this file; the plan reads this to avoid a second test for an AC already proven). The unit tests are written by the implementation phases,
// one table-driven test per rule, none of them skeletoned here:
// - unit, packages/agents/src/step/turn-rules.spec.ts (extend the existing `endOfTurn` table): cut-off x {no executor, unfinished children, root, coordinator with an answer executor} - UC-1, AC-01.1 (rule), DC-1
// - unit, packages/agents/src/model/model-client.spec.ts (extend): `finishReason: 'length'` -> `cutOff: true`, any other reason -> false, for the model step and the compaction call alike - KD-3
// - unit, ToolRunner.check (next to tool-runner/tool-gate specs): MCP schema missing arg / wrong type -> `invalid_arguments` with the argument name and what was expected; built-in tool
//   with a number for a string -> the same; a schema of unknown dialect or one that does not compile -> allowed with the "not checked" reason; the error text is cut at the code constant;
//   a call from `run_code` gets the same text - UC-3, AC-02.2, AC-02.3 (the log line itself: INT-1 row C asserts it is without values), DC-2
// - unit, packages/agents/src/mcp/mcp-outcome.spec.ts (extend the existing table): read-only x {timeout, connection_lost, protocol_error, unauthorized, client_error} -> `transport_failure`
//   with the reason text; mutating x the same -> `unknown` for the first three and `transport_failure` for the last two, always with `failureReason`; a call from a script of class `write` goes
//   through the same function - UC-5, AC-03.1, AC-03.2, AC-04.2 (rule), DC-3, DC-4, DC-5
// - unit, the repeat-rule function (pure-decision, own file): no earlier call -> run; one -> run with the mark naming its id; two -> refuse; one with another key order -> mark; two refused by
//   the check -> run; one in the same answer -> mark; `list_agents` twice -> run; a call before the last compaction is not counted - UC-7, AC-06.1 (rule), AC-06.2 (rule), AC-06.3, DC-7, DC-8, DC-9
// - unit, the log-field builder of the model step (if the task extracts it; else the arithmetic is covered by INT-1 row C only): `directCalls` / `runCodeCalls` / `toolsChosen` for an answer with
//   zero, one and several `run_code` calls - AC-07.1 (arithmetic), DC-10
// - existing, packages/agents/test/agent-platform-agents.int.e2e-spec.ts INT-3 F: a read call whose connection drops ends `transport_failure` with reason `connection_lost` and the agent goes
//   on; the new text for that reason is a row of the `toOutcome` table, not another integration test
// - existing, packages/agents/test/agent-platform-agents.int.e2e-spec.ts INT-3 B/C/E: a mutating call is held for confirmation, approved once, and a lost step closes it `unknown` - the
//   confirmation path is reused by INT-2 and not re-proven
// - not automated: the web showing the new refusal reason and the English transport text (Out of scope of the part); the first-time check that Google and OpenAI-compatible providers
//   report `length` on an output-limit stop (design Risks; the plan checks it by hand against the real providers, the `cutOff` field of `agent step finished` shows it afterwards)
// - not automated: the CHECK of `agent_code_calls.refusal_reason` gets `repeated_call` through the generated migration; the existing `packages/db/test/migrations.e2e-spec.ts` applies every migration to a
//   scratch database, so a CHECK that does not match the schema set fails there
//
// acProof (the same mapping as the JSON of the generation report):
// - AC-01.1, AC-01.2: INT-3 (wiring, journal `cutOff`); rule: unit
// - AC-02.1: INT-1 row A; AC-02.2, AC-02.3: unit
// - AC-03.1, AC-03.2: unit (`toOutcome` text); INT-2 row B shows the text reaches the model for `timeout`
// - AC-04.1: INT-2 row A; AC-04.2: INT-2 row B + unit
// - AC-05.1: INT-4
// - AC-06.1, AC-06.2: INT-1 row B; AC-06.3: unit
// - AC-07.1: INT-1 row C (+ INT-3 for the `cutOff` field); AC-07.2: INT-1 row C
// - NFR-01 (no values in the new records): INT-1 row C

import { describe, it } from 'vitest';

describe('agent-harness / core - the loop tells the model what went wrong and stops the loops it cannot stop itself', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: refused MCP calls (arguments, repeat) - the server is never reached, one audit entry per refusal, the model reads the reason, the journal holds no values
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-02.1 "Given MCP-инструмент требует аргумент `query`, when модель вызывает его без `query`, then сервер не вызывается, аудит записывает ровно одну запись с отказом, а модель видит, что не хватает `query`."
  //   AC-06.1 "Given исполнитель уже вызвал `logs.search` с аргументами A, when он вызывает `logs.search` с A второй раз, then вызов выполняется, а модель видит в результате пометку о повторе и id первого вызова."
  //   AC-06.2 "Given исполнитель вызвал `logs.search` с аргументами A дважды, when он вызывает его с A третий раз, then сервер не вызывается, аудит записывает ровно одну запись с отказом `repeated_call`, а модель видит подсказку."
  //   AC-07.1 "Given агенту доступны 12 инструментов, when модель выбирает два из них, then запись журнала о шаге содержит число 12, имена показанных инструментов, имена двух выбранных и сколько вызовов прямых, а сколько через `run_code`."
  //   AC-07.2 "Given результат прямого вызова не обёрнут, then журнал записывает его размер."
  //   NFR-01 "Записи журнала этой фичи не содержат значений аргументов, текстов утверждений и цитат, секретов и токенов - только имена, числа, исходы и id."
  //   Design: UC-4, UC-8, UC-10; KD-1, KD-5, KD-6; Flow 2, Flow 4.
  // Behavior: one agent with access to the `logs` server, one scripted run on `get_trace` (its `traceId` is required, 32 lowercase hex; the fixture lists that schema in `tools/list`, which the
  //   registry stored when the harness registered the server) ->
  //   step 1: one answer with two calls: `get_trace {}` (no `traceId`) and `get_trace { traceId: <SECRET_MARK> }` (a value that breaks the pattern and looks like a secret) -> both refused
  //   `invalid_arguments` before any request;
  //   step 2: `get_trace TRACE_A` -> success (first call of A);
  //   step 3: `get_trace TRACE_A` again -> runs, success, the text the model reads ends with the repeat mark that names the id of step 2's call;
  //   step 4: `get_trace TRACE_A` a third time -> refused `repeated_call` with the hint to change the arguments or finish;
  //   step 5: a text report (the agent finishes).
  // Rows (one scripted run, literal expected values; read the exact wording from the first implementation run and write it as a literal, do not build it from the implementation's constants):
  //   A. the two invalid calls (AC-02.1): the fixture's call log holds no entry for either; the history has `tool_result: get_trace refused invalid_arguments` twice; the audit capture holds exactly two
  //      entries `{ kind: 'tool_call_refused', actor: <owner>, objectType: 'tool', objectId: '<LOGS_SERVER>/get_trace', outcome: 'rejected', reason: 'invalid_arguments' }`; the next model input
  //      (`toolOutputOf` of each call id) names `traceId` in both texts and says what was expected (required / 32 lowercase hex characters).
  //   B. the loop (AC-06.1, AC-06.2): the fixture's call log holds exactly two `get_trace` entries for TRACE_A (the third never arrived); the second call's text in the model input is the server's
  //      answer followed by the mark with the first call's id (`toolCallIdOf(script, 1)`), the first call's text has no mark; the stored result row of the second call (`agent_tool_results`, as
  //      read in tool-result-reading INT-1) holds the server's answer only, no mark; the third call is `refused repeated_call`, its text names the earlier call ids and gives the hint; the audit capture
  //      gains exactly one entry with reason `repeated_call` (three entries in all). Refused calls of row A are not counted: the first valid call of A in step 2 carries no mark.
  //   C. the journal (AC-07.1, AC-07.2, NFR-01): the `agent step finished` record of step 1 carries `toolsShown` = the number of tools in the recorded model call (`script.calls[0].toolDescriptions`, taken
  //      independently of the implementation), `toolNamesShown` = those names, `toolsChosen` = `['mcp__<LOGS_SERVER>__get_trace', 'mcp__<LOGS_SERVER>__get_trace']`, `directCalls` 2, `runCodeCalls` 0,
  //      `cutOff` false; the `tool call finished` record of step 2's call carries `resultChars` equal to the length of the text the model read for it (`toolOutputOf(...).length`, the result is short
  //      and not wrapped). Over `harness.logs`, no record named `agent step finished`, `tool call finished`, `tool arguments not checked` or `compaction returned an empty summary` contains
  //      SECRET_MARK anywhere in its JSON (the argument error text may repeat the value and goes to the model and the history only).
  // Catches: (1) a refused call that still reaches the MCP server because the argument check sits after the send, or does not run for a schema read from the stored tool list (the unit test of `check`
  //   starts from a schema it is given and cannot see this); (2) a refusal that is audited twice, or not at all, or as `access_denied` (the port accepts the new entry but the step does not write it, or writes
  //   one per tool call of the answer instead of one per refusal); (3) the repeat rule not given the visible history by the tool step (the pure function is right but always sees an empty list), counting
  //   refused calls, or the mark written into the stored result so that `readResult` hands the model platform text as server data (KD-1); (4) a secret in the argument error text copied into the journal.
  //   Only this test crosses check -> rule -> audit port -> `tool_result` text -> model input -> log over the real database.
  // @category: core-functionality
  // @dependency: ToolRunner.check (MCP schema validator), repeat rule, tool step (ToolStep with the history calls), AccessAudit port, toolResultOf, model step journal, McpRegistry stored tool list, Postgres, MCP fixture (logs), ScriptedModel
  // @complexity: high
  it.todo('INT-1: invalid MCP arguments and a third identical call are refused before the server, once each in the audit, the model reads the reason and the second identical call carries the repeat mark, and the journal holds names and numbers only');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: a mutating call with no answer is `unknown`, a read call with no answer is `transport_failure`, and the model reads the text of each
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-04.1 "Given сотрудник подтвердил вызов, создающий тикет, when сервер не ответил в срок, then в истории вызовов агента у этого вызова исход «неизвестно», а модель видит, что тикет мог быть создан и что повторять вызов без проверки нельзя."
  //   AC-04.2 "Given вызов инструмента «только чтение» не получил ответа в срок, then исход - сбой транспорта, и модель видит причину «таймаут»."
  //   AC-03.1 "Given MCP-сервер не ответил в срок, when модель получает исход вызова, then она видит, что вызов не удался из-за таймаута."
  //   Design: UC-6, KD-4; Flow 3.
  // Behavior: `MCP_CALL_TIMEOUT_MS` set low through the harness `variables` (a few hundred ms) -> the fixture's fault schedule makes the server never answer (`hang`, `occurrences: 'all'`) for
  //   `get_trace` (read, listed with `readOnlyHint`) and for `create_incident_note` (changing, no hint) -> the scripted agent calls `get_trace`, then `create_incident_note`, the employee approves the
  //   request (`sessions.confirmations` / `resolveConfirmation`, as in agent-platform-agents INT-3 C) -> both calls time out -> the agent reads both results and reports.
  // Rows (one scripted run, literal expected values):
  //   A. the changing call: the call record (`toolCallRowsOf`) ends `create_incident_note done unknown`; the history line is `tool_result: create_incident_note unknown`; the text the model reads next
  //      (`toolOutputOf`) says the action may have been done, that it must not be repeated without checking, and names the reason (timeout); the call is not recorded as `transport_failure`.
  //   B. the read call: the call record ends `get_trace done transport_failure`, the history line is `tool_result: get_trace transport_failure`, and the text the model reads names the timeout.
  //   The other reasons (lost connection, protocol error, unauthorized, client error) are rows of the `toOutcome` unit table; INT-3 F of agent-platform-agents already proves a dropped connection on a read.
  // Catches: (1) `readOnly` of the stored tool (`readOnlyHint`) not reaching `toOutcome` from the call path, so a ticket-creating call that timed out is recorded as a harmless failure and the model retries it - a duplicate
  //   ticket in the external system; (2) the outcome `unknown` written for the call but dropped on the way to `tool_result` (or the call record) because only the old path (a lost step) knew that outcome;
  //   (3) the platform text missing from the history entry, so the model reads a bare `[unknown]` / `[transport_failure]` as today. The `toOutcome` unit table starts from a given `readOnly` and a given response and sees none of these.
  // @category: core-functionality
  // @dependency: McpClient (real timeout), toOutcome, tool runner, tool step commit, confirmation request, toolResultOf, McpRegistry stored tool list (readOnlyHint), Postgres, MCP fixture (logs, backoffice, fault schedule), ScriptedModel
  // @complexity: medium
  it.todo('INT-2: a confirmed create_incident_note that times out ends unknown and a get_trace that times out ends transport_failure, and the model reads the text of each');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: a cut-off report of an executor is not the report: the executor gets a notice and writes it again, the coordinator receives the second text
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.1 "Given исполнитель пишет отчёт и ответ модели оборвался на пределе длины без вызовов инструментов, when шаг модели заканчивается, then исполнитель не завершён, координатор отчёта не получил, а в истории исполнителя есть уведомление об обрезке."
  //   AC-01.2 "Given ответ модели был обрезан, when следующий её ответ заканчивается нормально, then отчётом становится этот ответ."
  //   AC-07.1 (the `cutOff` field of the step record). Design: UC-2, KD-3; Flow 1.
  // Behavior: a root (tools `start_agent`, agents `[scout]`) starts a child agent `scout` (a record added to the library double, as in agent-platform-agents INT-3 grandchild setup) -> the scripted model answers
  //   the scout's first call with a text and `cutOff: true` (no tool calls), its second call with a full text -> the scout works to the end.
  // Rows (one test, literal expected values):
  //   A. after the first scout answer: the scout's task is not `completed`, the root's history holds no `child_report` yet (read after `scout` script `called(1)` and before the second answer is released with a latch,
  //      or from the final history: the root has exactly one `child_report`, whose text is the second answer's); the scout's history lines are
  //      `task: ...`, `model_answer: <cut text> []`, `notice: <says the answer was cut off and is not accepted as the report>`, `model_answer: <full text> []`.
  //   B. the scout's second model input holds the notice after the first answer; the root receives the second, full text as the report and never the cut one; the turn counter and the ledger count both
  //      model calls (two ledger rows for the scout).
  //   C. the journal: the scout's two `agent step finished` records carry `cutOff` true and false in that order, `toolsChosen` empty, `directCalls` 0, `runCodeCalls` 0.
  // Catches: the flag set by `ModelClient` but not handed to `endOfTurn` by the model step (the cut text is delivered to the coordinator as a finished report, truncated mid-sentence - the defect that started the
  //   feature); a notice written but the task also completed; a notice that is not part of the next model input; the report taken from the first answer after the notice. `endOfTurn` and the finish-reason mapping are
  //   unit tables, which cannot see how the model step hands one to the other.
  // @category: core-functionality
  // @dependency: ModelClient.call (cutOff), endOfTurn, model step, start_agent, child report delivery, runtime ledger, Postgres, ScriptedModel (cutOff answer)
  // @complexity: medium
  it.todo('INT-3: an executor whose answer is cut off at the length limit gets a notice and finishes only with its next, complete answer, which is the report the coordinator receives');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4: an empty compaction summary does not fail the task, writes no compaction, and the next step is the model over the whole history
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-05.1 "Given модель вернула пустую сводку при сжатии истории, then задача агента не завершена ошибкой, история агента не потеряна, журнал записывает пустую сводку, и агент делает следующий шаг."
  //   Design: UC-9, KD-7; Flow 5.
  // Behavior: `AGENT_COMPACT_AT_TOKENS` set low through `variables` (as INT-1 E of agent-platform-agents) -> the scripted agent's first answer reports `usage.inputTokens` at the threshold -> the employee sends a
  //   message -> the next step is the compaction call, which the script answers with an empty text -> the step after it is a model call, answered with a normal text (small usage).
  // Rows (one test, literal expected values):
  //   A. the task is not `failed` (no `handler_error`) and ends `waiting`; the history lines are `task`, `model_answer: <first>`, `user_message: <the sent message>` (the message the compaction step
  //      delivered is there), `model_answer: <last>`: no `compaction:` line, no `event: compacted`.
  //   B. the third scripted call is a model call over the whole history, not a second compaction: its input ends with the sent message, not with the compaction request (the same literal `COMPACTION_REQUEST` text of
  //      agent-platform-agents); the script was called exactly three times.
  //   C. the log has one `compaction returned an empty summary` warn record with the agent id, the step number and the model (no summary text); the compaction call is in the ledger and the turn counter is not advanced by it.
  // Catches: the step still throwing on an empty summary (the whole task dies with `handler_error` - today's behaviour); the step returning `continue` but leaving `lastInputTokens` above the threshold, so the
  //   next step compacts again and the agent loops on paid empty summaries (row B); the delivered message lost because the commit of the empty-summary branch writes no continuation. A unit test of
  //   the pure helpers cannot see the commit; the happy-path compaction test (INT-1 E of agent-platform-agents) never reaches this branch.
  // @category: edge-case
  // @dependency: compaction step (step-handler commit), step handler order, runtime ledger, logger, Postgres, ScriptedModel
  // @complexity: medium
  it.todo('INT-4: a compaction that returns an empty summary keeps the task running with its whole history, writes no compaction entry, and the next step is a model call, not a second compaction');
});
