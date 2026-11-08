// agent-runtime / research-flow E2E Test Skeletons (api process) - Design Doc: docs/features/agent-runtime/design-research-flow.md (v1.3, approved 2026-11-08)
// PRD: docs/features/agent-runtime/prd.md v1.1 (FR-14, FR-16; AC-12.1 and AC-15.1 as the employee meets them). UXRD: none (the employee's screen does not change). Test type: End-to-End (a built api process + real runtime + real engine + real fixture + real Postgres; scripted models)
// Generated: 2026-11-08 | Part: research-flow | CI job `e2e` of apps/api
// Implementation timing: final phase only, after the slices land (the default version in `createEngine`, `RESEARCH_PROCESS_VERSION` and `RESEARCH_GROUP_TABLES_DIR` in the api composition, the launch budget from the default version, the v3 calibration).
// Counterpart in-process files: packages/engine/test/agent-runtime-research-flow.int.e2e-spec.ts (INT-1..INT-4) and apps/api/test/agent-runtime-research-flow.int.e2e-spec.ts (INT-5). The rules and the wiring of the engine and of the self-check are proven there and at unit level;
// this file proves what the owner of a deployment does to move from v2 to v3, and what the employee gets after.
//
// File name follows the project convention (`*.e2e-spec.ts` under apps/api/test, run by `vitest.config.e2e.ts`; no config is created here). The api child is booted the way `agent-quality-engine.e2e-spec.ts` boots it (test/support/chatEntryChild.ts,
// a scratch database per row, `pnpm --filter api build:child` first); `calibrate` runs through the built self-check program as there (test/support/selfCheckChild.ts, a migrated scratch database of its own as `DATABASE_URL`). The npm script is the one named in the int file's header.
//
// Environment:
// - Postgres 16 from infra/docker-compose.yml; a scratch database per row (CREATE DATABASE, dropped afterwards); migrations applied with the entry of @agent-os/db.
// - Doubles are the model boundary only: the scripted chat model (one `deepResearch` call, then plain replies) and the scripted engine models behind `ENGINE_RESOLVE_MODEL`: the existing role program for v2 and an AGENT program for the six shipped v3 definitions (support below). The engine is the REAL one;
//   the real MCP fixture process serves the logs. No network, no API key. No test asserts on keywords of model text.
// - The child runs the real composition with BOTH shipped versions loaded and the settings under test in its environment: `RESEARCH_PROCESS_VERSION`, `RESEARCH_GROUP_TABLES_DIR`. The shipped group tables are the real ones; the table of the row's calibration is written by the built `calibrate` into a directory of the test.
// - Isolation (project convention): a unique user per row (`x-user-id`); a unique temp directory per command; the file runs with `fileParallelism: false`. No latency assertions; the wait for each end state is the harness timeout.
//
// Support the plan must add FIRST (existing support files are NOT edited by this skeleton set):
// 1. engineScriptedRoles.ts / chatEntryChildMain.ts - the mode `E2E_ENGINE_SCRIPTED_ROLES=1` gains an agent program (the same brain as the int file's `selfCheckModels.ts` item 1: it reads tool results from the prompt to build ids) and loads `[deepResearchProcessV2, deepResearchProcessV3]`
//    into `ENGINE_PROCESSES`; the environment variables `RESEARCH_PROCESS_VERSION` and `RESEARCH_GROUP_TABLES_DIR` reach the child (`ENGINE_FILES_VARIABLES`-style); the existing "every supported claim gets `low`" test table is replaced, for v3 rows that need the shipped-table check, by the real shipped table
//    or by the table `calibrate` wrote (S1, S2 need the real check; S3 may use the test table).
// 2. A hold for a v2 investigation (the scripted v2 controller waits for a release file or an endpoint of the child) so S3 can restart the process while a v2 investigation is running.
// 3. selfCheckChildMain.ts - `calibrate` with the shipped v3 configuration (a scripted verifier agent answering each pair by its key, erring on the pair kinds named by `SELF_CHECK_CALIBRATION_ERRS_ON`).
// 4. A reader of the child's logs for the start-up refusal message (S1) and of the investigation's budget row.
//
// Budget: E2E 2 of 2 for the part (the other is the engine restart file). ROI under the raw skill formula does not reach a threshold for these journeys, like the sibling parts; this one stays because nothing at a lower level can prove it:
//   the composition of `apps/api` (that it loads both versions, passes the default version to `createEngine`, reads the budget limits from that version, passes the group-table directory and refuses to start without a table) is invisible to a test that builds the engine directly - the same reasoning
//   as agent-quality / engine E2E-2.
//
// AC -> proving test:
// - AC-14.1 (flag at 2: no agent runs, v2 budget), AC-14.2 (flag changed while a v2 investigation runs: it ends on v2), DC-5 (an unloaded version stops the start): S1, S3
// - AC-14.3 (saved v2 investigations read as before after the switch): S3 (the transcripts and the answer of the investigation that ended on v2 are read through the conversation after the switch); the replay of saved v2 is INT-5 B
// - AC-16.1 (the server with the flag at 3 does not start without a table for the verifier's current pair of fingerprints; the error names them; with the flag at 2 the same server starts): S1
// - AC-16.2 (the calibration report: shares per kind of pair, the comparison with the rule "value not found - not established", the share of right per group): S2 (the rule of the calibration is unit; the report is read here as in agent-quality / engine E2E-2)
// - AC-12.1 and AC-15.1 as the employee meets them (the same kind of answer through the same path, agents of all five stages in the tree), the launch budget of v3 (KD-5): S2, S3
// - AC-19.x: INT-5 C (the verdict is a function of two result files; the owner's flag change after it is S2/S3)

import { describe, it } from 'vitest';

describe('agent-runtime / research-flow - E2E (built api process, real Postgres, real engine, scripted models, shipped v2 and v3)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-2  The owner switches the default version to v3: start-up checks, calibration, the employee's launch, a running v2 investigation, the way back
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: a deployment owner has run the comparison and is told "not worse" -> calibrates the verifier agent -> sets `RESEARCH_PROCESS_VERSION=3` and restarts the server -> an employee asks a research question in the chat and gets the same kind of answer by the same path,
  //   now from the agents; an investigation that was running on v2 when the server restarted finishes on v2 -> the owner sets the flag back to 2 and new research runs on v2 again.
  // Verification: the composition of the server, end to end, around the flag.
  // Covers (original statements):
  // AC-14.1: "Given переключатель стоит на v2, Then новые расследования идут по v2, и в их ходе нет запусков агентов."
  // AC-14.2: "Given переключатель изменён, пока идёт расследование, Then оно доканчивается по версии, с которой началось."
  // AC-16.1: "Given изменились модель, промпт, инструменты или форма ответа проверяющего агента, Then его отпечаток меняется, и сервер с переключателем на v3 не стартует, пока для нового отпечатка нет таблицы групп; ошибка называет отпечаток."
  // AC-16.2: "Given калибровка v3 прогнана, Then отчёт показывает долю совпадений проверяющего агента с ключом по каждому типу пар, сравнение с правилом «значение не нашлось - не установлено» и долю верных по группам - так же, как для v2."
  // DC-5 (Design Doc): "Старт без версии идёт по версии из `RESEARCH_PROCESS_VERSION`; если эта версия не загружена, сервер не стартует с ошибкой `process_version_not_loaded`, называющей процесс и версию."
  // KD-5 (Design Doc): "запуск v3 из беседы идёт с бюджетом v3" - the budget limits come from the configuration of the default version.
  // Use cases: UC-6, UC-8 (the start-up half), UC-1 (as the employee meets it).
  //
  // Primary failure mode (turns red when): the server starts with the flag at 3 and no table (the calibration check is skipped for the default version, or looks at the wrong pair), or refuses to start with the flag at 2 only because the v3 table is missing; the chat launch still takes the v2 budget (300 000) for a v3 investigation
  //   (the first worker's share is refused and every research ends "budget exhausted"), or the v3 budget for a v2 one; a start without a version goes to the highest loaded version instead of the flag's; an unloaded flag value is accepted and falls back silently; an investigation running on v2 is continued on v3
  //   after the flag changes; the calibration's table does not reach the server (the directory setting not passed) so a freshly calibrated verifier still blocks the start.
  // Behavior: S1 - a start with the flag at 3 and no table, with a version that is not loaded, and with the flag at 2 -> the first two do not start with a named error, the third starts; S2 - `calibrate` writes the table -> the server with the flag at 3 starts -> a chat question runs the v3 tree with the v3 budget and
  //   answers like before; S3 - a v2 investigation held in flight -> the server restarts with the flag at 3 -> it ends on v2 -> a new question runs on v3 -> the flag at 2 -> a new question runs on v2.
  // @category: e2e
  // @dependency: full-system (built api process, runtime, engine, MCP fixture, Postgres, built self-check program)
  // @complexity: high
  //
  // Rows (each in its own scratch database; boots are the cost of the journey):
  //   S1 - start-up checks (a table of three boots):
  //        (a) `RESEARCH_PROCESS_VERSION=3`, no table in `RESEARCH_GROUP_TABLES_DIR` for the verifier's pair (the shipped v3 table is for a different pair - the test edits the shipped verifier prompt by one word through the engine files of the child, as agent-quality / engine E2E-2): the process exits non-zero,
  //            the log line is `calibration_missing` and names the process `deep-research`, the version 3 and both fingerprints;
  //        (b) `RESEARCH_PROCESS_VERSION=4`: the process exits non-zero with `process_version_not_loaded` naming the process and the version;
  //        (c) `RESEARCH_PROCESS_VERSION=2` with the same edited verifier (still no v3 table): the server starts and answers its health check (AC-16.1 second half).
  //   S2 - the owner's path to v3 and the employee's first question:
  //        Given: the edited verifier of S1 (a); the built `calibrate` run with the shipped v3 configuration, the scripted verifier erring on the named pair kinds, `--out` = the directory of `RESEARCH_GROUP_TABLES_DIR`.
  //        When: `calibrate` ends; the server starts with the flag at 3; the employee (a unique user) asks a question that makes the chat model call `deepResearch` once; the investigation ends.
  //        Then: the calibration report shows the share of agreement with the key per kind of pair, the comparison with the rule "value not found - not established" and the share of right per group (AC-16.2, read as agent-quality / engine E2E-2 reads it); the file holds both fingerprints of the verifier and the model;
  //            the server starts (the table reached it through the directory setting); the investigation is `completed` with a tree of agents of all five stages - `planner`, `controller`, `worker`, `verifier`, `synthesis` (AC-12.1); its budget limit is the v3 default, 800 000 (KD-5), read from the
  //            investigation row, not 300 000; the answer message in the conversation passes `ResearchAnswerMetadataSchema` and `ThreadMessagesResponseSchema` and has the same shape as the v2 answer of agent-quality / engine E2E-1 (sections, groups, links, summary - AC-15.1 as the employee reads it);
  //            there is no `research.controller` task for this investigation.
  //   S3 - the flag, a running investigation, the way back:
  //        Given: the server with the flag at 2 and the default v2 launch budget (300 000); an employee's question starts a v2 investigation that the scripted v2 controller HOLDS in flight; the process is stopped (graceful) and started again with the flag at 3 (the table of S2's kind is in place).
  //        When: the held v2 investigation is released and ends; then a new question is asked; then the process is restarted with the flag at 2 and a third question is asked.
  //        Then: (1) before the switch, the first investigation has no agent runs and the v2 budget (AC-14.1); (2) after the restart the same investigation ends on v2 - its frozen configuration version is 2, it has no agent runs, its decisions and transcripts and its answer are read through the conversation as before (AC-14.2, AC-14.3);
  //            (3) the second question runs on v3 with the 800 000 budget and an agent tree; (4) the third runs on v2 again with the 300 000 budget and no agent runs; the second investigation, saved on v3, is read through the conversation unchanged after the way back.
  describe('E2E-2', () => {
    it.todo(
      "E2E-2 S1: a server with the flag at 3 and no table for the verifier's fingerprints, or with a version that is not loaded, does not start and names the cause; with the flag at 2 the same server starts",
    );
    it.todo(
      "E2E-2 S2: after the owner calibrates the verifier agent and sets the flag to 3, the employee's chat question runs the five-stage agent tree with the v3 budget and gets an answer of the same kind",
    );
    it.todo(
      'E2E-2 S3: a v2 investigation running when the flag changes ends on v2, the next question runs on v3 with its budget, and after the flag goes back to 2 new questions run on v2 with the v2 budget',
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Not observable as an assertion (reported to the caller)
// ---------------------------------------------------------------------------------------------------------------
// - The reason for the switch - "v3 is not worse than v2 on real models" - is not an assertion of any test; E2E-2 proves only that the switch works, and INT-5 C that the verdict is computed and blocks or allows. The owner reads the verdict on a real set after setting the U-6 thresholds.
// - S3 "the process is stopped and started again" is a graceful restart of the child with a changed environment, not a kill; a kill in the middle of a v2 investigation on a changed flag is the runtime's matrix and E2E-1 of the engine file, and is not repeated.
// - The design says a server with the flag at 3 "does not start" without a table; the test reads the exit code and the logged error of the child, because the composition fails inside `createEngine` before the HTTP port opens - there is no HTTP error body to assert.
// - The one-word edit of the verifier prompt used to make the shipped v3 table not match is the only way to create "a changed fingerprint" without editing shipped data; it is passed to the child as its engine file, which the existing engine-files mode of the child already supports for v2.
