// agent-runtime / research-flow Integration Test Skeletons (api side, the self-check program on v3) - Design Doc: docs/features/agent-runtime/design-research-flow.md (v1.3, approved 2026-11-08)
// PRD: docs/features/agent-runtime/prd.md v1.1 (FR-14, FR-18, FR-19; AC-14.3 for the replay of saved v2). Self-check contracts it builds on: docs/features/agent-quality/design-self-check.md and design-engine.md ("Самопроверка на v3", KD-6).
// ADRs: ADR-0001, ADR-0004 (the self-check lives in `apps/api`), ADR-0005 / ADR-0009. UXRD: none (part without UI).
// Generated: 2026-11-08 | Part: research-flow | Test type: Integration (the self-check program in-process + real runtime + real fixture process + real Postgres, scripted models), CI job `e2e` of apps/api
// Implementation timing: created alongside the slice each test names (the `run` / `show` path on v3, the `replay` path, the `compare --non-inferiority` mode).
//
// File name and placement. This follows `agent-quality-self-check.int.e2e-spec.ts` (same directory, same config: `apps/api/test/*.e2e-spec.ts`, `vitest.config.e2e.ts`, include '**/*.e2e-spec.ts', fileParallelism false, RUNTIME_WORKERS default 'off'; a file that needs the workers
// turns them on itself). The engine half of the part is packages/engine/test/agent-runtime-research-flow.int.e2e-spec.ts (INT-1..INT-4); the process-level file of this directory is `agent-runtime-research-flow.e2e-spec.ts` (E2E-2).
// The plan adds an npm script next to `test:e2e:self-check` for both api files of this part (the program and the child are built first): `test:e2e:research-flow` = `nest build && pnpm build:child && vitest run --config ./vitest.config.e2e.ts test/agent-runtime-research-flow`.
//
// Generated as `it.todo` skeletons so the file loads under lint, typecheck and `vitest run`. Implement each todo following its Given/When/Then comments. Do not convert a todo into a passing stub.
//
// Light test process (owner decision): only the risky UCs of the Test Strategy have a skeleton - the self-check run and show on v3 (UC-9), the replay (UC-10, AC-14.3), the non-inferiority verdict on real result files (UC-11). The pure rules (the verdict ladder, the signals, the first-error stage, the
// first-error counts, the injection shares, the argument rules) are unit tests named in the plan (list "Proven elsewhere" at the end).
//
// Environment (as `agent-quality-self-check.int.e2e-spec.ts`; Design Doc "Test Strategy"):
// - One migrated scratch database per file as `DATABASE_URL` (test/support/selfCheckDb.ts); the program under test is the one assembly the `run` / `replay` / `show` / `compare` commands share, called in-process with its ports (database URL, report directory, clock, `resolveModel`). The processes it
//   loads are the SHIPPED `deep-research` v2 and v3 (`ENGINE_PROCESSES`-style option of `createSelfCheckApp`), so the run picks the version by `--process-version` as in production.
// - The real runtime and engine, the real MCP fixture process on a scenario (`FIXTURE_SCENARIO`, `FIXTURE_CALL_LOG` per test as the independent counter) over the real `SourceRegistry`. Never mocked.
// - Doubles are the model boundary only: `resolveModel` returns, for v2, the existing scripted role program; for v3, a scripted AGENT program (support item 1). Both build their answers from the scenario key, so the right and the wrong answer are known, and both record every call.
// - Isolation: a unique run directory per test and a unique `launchKey`; the owner is `system:self-check`; employee-side data uses a unique `resourceId = 'e2e-' + randomUUID()`.
//
// Support the plan must add FIRST (existing support files are NOT edited by this skeleton set):
// 1. selfCheckModels.ts - an agent program for the six shipped definitions, keyed by the scenario key like the role program: it reads the PROMPT (tool results by tool name: the page ids `gather` returned, the claim numbers `claims_write` returned) to build the next call;
//    a scenario with a known cause -> planner `plan_write`, workers `gather` the real fixture pages and write the claim(s) with a real pointer, a verifier assessment from the key, the right draft; a no-cause scenario -> an honest `inconclusive` close; a scenario "worker asks a tool
//    outside its definition" and a scenario "a third verifier call refused by `children_limit`" (a config override, support item 3). The agent is recognised by the leading text of its loaded system prompt (see the engine int file, support item 1a). Models are routed by agent name for `--agent-model <agent>=<model>`.
// 2. selfCheckApp.ts - the `processes` option accepts the shipped v2 and v3; `defaultVersions`; the program's `run` / `replay` take `processVersion` and `agentModels`; the shipped v3 group table (or a test table from the loaded config, as in the engine file) for `requireCalibration`-free runs.
// 3. A `researchFlowV3Config(overrides)` for the api (data only; the same builder idea as the engine's, copied or shared through a test package): overrides for the worker's `maxChildren` (the refused verifier call) and nothing else.
// 4. selfCheckDb.ts - read-only snapshots of the agent tables (`research_agent_runs`, `research_agent_tool_calls`, `research_agent_messages`) and `agentTreeOf(investigationId)` via `readAgentTree`; a way to save an employee's v3 investigation (the `EmployeeInvestigation` helper starting v3 in-process).
// 5. A thresholds file builder for `compare` (full, with the four bands of FR-19; and none).
//
// Budget: this file holds the fifth and last integration test of the part (engine INT-1..INT-4 are the other four; limit 3, up to 5 under the integration-e2e-testing rule only when each extra test names the defect no other test catches). INT-5 is an extra - unique defect:
//   the self-check program still wired to v2 decisions (a run on v3 that has no `steps`, a `show` that cannot print a tree, a replay that picks the version of the shipped config instead of the saved investigation's, a comparison that cannot read a v3 result file), found only
//   when the program runs v2 and v3 end to end over the real fixture and compares the real result files. No engine test starts the program.
//   E2E: 1 of the part's 2 in the sibling file (E2E-2); the other is the engine restart.
//
// AC -> proving test (the plan reads this to avoid a second test for an AC already proven):
// - AC-18.1 (verdict, number of model calls and cost per scenario; v2 shows steps): INT-5 A; AC-18.3 (rejected calls with agent, tool and reason; the tree with transcripts; the first-error stage by role; unverified by refusal): INT-5 A; the rules (signals, stage, counts): unit
// - AC-18.2 (replay of a saved v3 on the same slice): INT-5 B; AC-14.3 (a saved v2 is read and replayed as before): INT-5 B; DC-6 of design-self-check (slice) is proven there
// - AC-19.1, AC-19.2, AC-19.3, DC-13 (the four numbers, interval and verdict per number, `switchAllowed` with the blocking numbers; no thresholds file -> no verdict, all four named): INT-5 C for the wiring on two real result files; the ladder, the judge-agreement rule, each variant of UC-11: unit
// - AC-20.1 (`injectionInfluence` and `injectionInBasis` against the allowed share): unit (the metrics) and `Engine.assessAgent` of agent-core (UC-14 there); see "Not observable"
// - AC-14.1, AC-14.2, AC-16.1, AC-16.2, AC-16.3: E2E-2 and unit

import { describe, it } from 'vitest';

describe('agent-runtime / research-flow - integration (self-check program in-process + real runtime + real fixture + real Postgres, scripted agent models, shipped v2 and v3)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-5  The self-check program on v3: run and show, replay, and the verdict on real result files (UC-9, UC-10, UC-11)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: "AC-18.1: Given набор сценариев прогнан на v3, Then по каждому сценарию видны вердикт, число вызовов модели и стоимость; для v2 отчёт показывает вместо числа вызовов число шагов."
  // AC: "AC-18.3: Given расследование по v3 без ключа завершено, Then отчёт показывает его сигналы сбоя, в том числе отклонённые вызовы агентов и инструментов с причинами, и дерево агентов с транскриптами."
  // AC (Design Doc): "DC-12: Для непройденного сценария v3 отчёт называет этап первой ошибки и его роль - `controller`, `worker` (вместе с `subworker`), `verifier` или `synthesis`."
  // AC: "AC-18.2: Given сохранённое расследование v3, When разработчик запускает повтор, Then повтор идёт по v3 на том же срезе данных."
  // AC: "AC-14.3: Given расследования v2 сохранены до выпуска фичи, Then их ход, транскрипты и ответы читаются, а их повтор (PRD agent-quality, FR-02) запускается, как до фичи."
  // AC: "AC-19.1: Given v2 и v3 прогнаны на одном наборе сценариев с повторами, Then отчёт сравнения показывает эти четыре числа по каждой версии, интервал разницы и вердикт по каждому числу: «не хуже», «хуже» или «неясно»."
  // AC: "AC-19.2: Given хотя бы по одному из четырёх чисел вердикт «хуже» или «неясно», Then отчёт сравнения говорит, что переключение не разрешено, и называет эти числа."
  // AC: "AC-19.3: Given порог хотя бы одного из четырёх чисел не записан, Then отчёт сравнения не выносит вердикта о переключении и называет числа без порога."
  // Behavior: A - `run --process-version 3` over a set with a known cause, no cause, and two defective workers -> result file (per scenario: verdict, `modelCalls`, cost) and `show` (agent tree, rejected calls, first-error stage, unchecked-by-refusal);
  //   B - `replay` of a saved v3 investigation and of a saved v2 one -> a new investigation on the saved slice by the saved version, and `--process-version 3` over a v2 one; C - `compare --non-inferiority` over the real v2 and v3 result files of the same set.
  // Catches: a program that cannot run v3 or reads the controller's decisions (a result with `decisions` assumed, no `modelCalls`, steps counted from nothing); a `show` that prints no tree or prints transcripts of the wrong role; a rejected call (`tool_not_in_definition`) that is not listed with its agent and tool,
  //   or the `needs_verification` step and a `child_failed` counted as rejections; a first-error stage that names a v2 role that does not exist in the tree or a roleless stage; a claim left unchecked by a refused verifier call not counted; a replay that picks the version from the shipped config instead of the
  //   saved investigation's frozen one, or that replays on another slice (the log window moves); a saved v2 investigation that no longer reads; a `compare --non-inferiority` that cannot read a v3 result, that prints the old three-way verdict, or that allows the switch although a number is "хуже" / "неясно",
  //   or invents a verdict without thresholds.
  // @category: core-functionality
  // @dependency: the self-check program (run, show, replay, compare), the shipped v2 and v3, the MCP fixture process, SourceRegistry, readAgentTree, the result files, real Postgres
  // @complexity: high
  //
  // Row A (UC-9; AC-18.1, AC-18.3, DC-12)
  //   Given: a scenario set of four on the fixture: S1 a known cause (workers collect, write claims with real pointers, verifiers support them, the draft names the cause); S2 a "no answer" scenario (an honest `inconclusive`); S3 a known cause where one worker asks a tool outside its definition (`tool_not_in_definition`)
  //     and the answer is wrong (the first error is the worker's analysis); S4 a known cause run under a config with the worker's `maxChildren` lowered so the third verifier call is refused `children_limit`. v3 run through `resolveModel` with `--agent-model` given for no agent; a v2 run of S1 and S2 for the steps half.
  //   When: the developer runs `run --process-version 3` over the set (and `run` with the default for the v2 half), then `show` for S3's investigation.
  //   Then (verification items):
  //   - Result file (AC-18.1): per scenario of the v3 run - verdict, `modelCalls` (equal to the count of the scripted double's calls and of the ledger rows of role `agent`), cost in money; no `steps` field; in the v2 file the same scenarios carry `steps`, no `modelCalls`; `processVersion` is 3 / 2; `decisions` is empty in the v3 file
  //   - Verdicts follow the key: S1 passes, S2 passes as an honest refusal, S3 fails
  //   - `show` (AC-18.3): the agent tree of S3 - every run with parent, task, result or failure reason, spend and the transcripts of its turns; a separate list of rejected calls holding the agent (`worker`), the tool and the reason `tool_not_in_definition`; the claims left unchecked by a refused or failed verifier call are listed (S4: one claim,
  //     `unverifiedByRefusal` 1 in the file)
  //   - Signals: the rejected calls of S3 are counted, a `needs_verification` step and `child_failed` are not (a scripted S1 round that includes one `needs_verification` must not raise the signal)
  //   - First-error stage (DC-12): S3's failure names the stage "analysis" with the role `worker`; the run's summary counts stages by the four roles `controller`, `worker`, `verifier`, `synthesis` only
  //   - The program's isolation: the investigations are owned by `system:self-check`; `FIXTURE_CALL_LOG` and the counting of source calls are consistent with the pages the workers collected
  // Row B (UC-10; AC-18.2, AC-14.3)
  //   Given: an employee's v3 investigation saved through the real engine (in-process) with a stored slice; an employee's v2 investigation saved the same way (the shipped v2, as before the feature).
  //   When: `replay` for each, and `replay --process-version 3` for the v2 one; for the v3 one also `--agent-model worker=<other>`.
  //   Then: the v3 replay is a NEW investigation on the same slice (same window, same fixture snapshot), started on v3 from the saved frozen configuration, owned by `system:self-check`; the original's rows are unchanged (row versions equal); with `--agent-model` only the worker's calls go to the other model (read from the double's per-call model ids);
  //     the v2 replay runs on v2 as before (no agent runs); with `--process-version 3` the v2 investigation's question runs on v3 on the same slice; `show` on the saved v2 reads its decisions, transcripts and answer as before.
  // Row C (UC-11; AC-19.1, AC-19.2, AC-19.3)
  //   Given: the result file of the v2 run and of the v3 run of the SAME set with the same number of repeats (rows A and an extra v2 run); a full thresholds file for the candidate (four bands); a second call with no thresholds file.
  //   When: `compare --non-inferiority` with v2 as the base.
  //   Then: with the file - the four numbers (share of solved scenarios with a cause, share of honest refusals, share of established claims that contradict the key, cost of a solved scenario in money) for each version, the interval of the difference and a verdict per number from {"не хуже", "хуже", "неясно"},
  //     and `switchAllowed` true only when all four are "не хуже" (scripted so one case is allowed and, in a second pair of files, a worse cost blocks it and the report names the cost); without the file - the four numbers and intervals per version, NO verdict, `switchAllowed` absent, and the report names all four numbers as lacking a threshold;
  //     the plain `compare` (without the flag) over the same two files still prints its three-way verdict as before.
  describe('INT-5', () => {
    it.todo(
      'INT-5 A: the self-check program runs the set on v3, reports per scenario the verdict, the number of model calls and the cost, and shows the agent tree, the rejected calls with their agent and reason, the first-error role and the claims left unchecked',
    );
    it.todo(
      "INT-5 B: a replay of a saved v3 investigation runs on v3 on the same slice, with one agent's model replaceable, and a saved v2 investigation is read and replayed on v2 as before, or on v3 by flag",
    );
    it.todo(
      'INT-5 C: compare --non-inferiority over the real v2 and v3 result files gives four numbers, interval and verdict per number and allows the switch only when all four are not worse, and gives no verdict without a thresholds file',
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Proven elsewhere (named for the plan; no skeleton here, by the light test process)
// ---------------------------------------------------------------------------------------------------------------
// Unit (table-driven, apps/api/src/self-check/**/*.spec.ts), one spec per rule:
// - the verdict of `--non-inferiority` (UC-11 variants; AC-19.1..AC-19.3, DC-13): all four numbers within the bands -> allowed; cost worse -> "хуже", the report names the cost; no thresholds for the candidate -> no verdict, four numbers named; the judge's agreement below `judgeAgreementMin` in either run or the share of
//   "неясно" above `unclearMax` -> every verdict "неясно"; the position of the interval against the band minus the threshold -> "не хуже" / "хуже" / "неясно"; the old `compare` mode unchanged
// - the failure signals on v3 (UC-9, KD-6): `rejectedCalls` counts rows with outcome `rejected` over all runs of the tree, threshold `rejectedCalls` (default 3); `needs_verification` and `child_failed` are not counted; the unchecked-by-refusal count (`unverifiedByRefusal`) for refusals `budget_exhausted`, `children_limit`, `task_limit`
//   and for a failed verifier call; the share of dropped claims is not compared across versions
// - the first-error stage on v3 (DC-12): the table of the four cases (records of the key not collected -> `controller`; analysis -> `worker` or `subworker` by the run that wrote the claim; verification -> `verifier`; answer -> `synthesis`; unchecked claim -> `controller`) and the count by the four roles
// - arguments (`run` / `replay`): `--role-model` with an agents-form configuration and `--agent-model` with a roles-form configuration -> `invalid_arguments`; `--process-version` outside the loaded versions; the deadline of a v3 run is the root definition's `limits.deadlineMs`
// - the injection metrics (UC-12, AC-20.1): `injectionInBasis` = the share of scenarios, among those that ended with an answer, where the basis of an established claim holds a trace record of `injectionTraceIds`; compared with `injectionInfluenceMax`; `injectionInfluence` for v3 goes through `Engine.assessAgent`
//   (agent-core UC-14 proves that call has no task, ledger row or note)
// - DC-10 on the self-check side: with no group table for the pair of fingerprints (a changed verifier), a v3 run gives the lowest group to a `supported` claim (a closure unit test with an empty binding)
//
// Not observable as an assertion (reported to the caller):
// - AC-20.1 "изменил оценку проверяющего агента или вывод ответа": a scripted verifier answers from the scenario key whatever the records say, so a CI run cannot show a model being INFLUENCED by the text; it shows only that the metrics are computed, shown and compared with the allowed share.
//   The real share appears only when the program runs v3 on real models; the allowed share (U-6, PRD agent-quality) is the owner's.
// - INT-5 C proves that the verdict is computed from two real result files and that the switch is blocked/allowed by the rule; whether v3 IS "не хуже" than v2 on real models is the main risk of the design and is the owner's reading of the report after the thresholds are set. No CI test can assert it.
// - The thresholds of the four numbers are not set yet (U-6): INT-5 C uses a test thresholds file; the shipped numbers are a condition of the switch, not of this design.
// - The cost "in money" of a scripted run depends on the double's `usage` and the price table; the test asserts the cost is read from the ledger of the run (not recomputed), with literals computed from the scripted usage.
