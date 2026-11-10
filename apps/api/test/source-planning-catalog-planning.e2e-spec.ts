// source-planning / catalog-planning E2E Test Skeletons (api process) - Design Doc: docs/features/source-planning/design-catalog-planning.md (v1.2, approved 2026-11-10)
// PRD: docs/features/source-planning/prd.md (FR-01, FR-03, FR-04, FR-08, FR-09; AC-01.2, AC-09.2, AC-08.x as the employee meets them). UXRD: deep-research/uxrd.md (MC-31..MC-33, the "no sources" flow) - read, not changed by this part.
// Generated: 2026-11-10 | Part: catalog-planning | Test type: End-to-End (a built api process + real runtime + real engine + the TWO real fixture processes + real Postgres; scripted models), CI job `e2e` of apps/api
// Implementation timing: after all catalog-planning slices land (final phase only).
// Counterpart in-process files: packages/engine/test/source-planning-catalog-planning.int.e2e-spec.ts (INT-1..INT-3, scripted tool calls, counting sources) and apps/api/test/source-planning-catalog-planning.int.e2e-spec.ts (INT-4).
// The rules and the wiring of the engine are proven there; this file proves only what a built server with real MCP processes and a restart adds.
//
// Generated as `it.todo` skeletons. Implement each todo following its Given/When/Then comments. Do not convert a todo into a passing stub.
//
// Environment:
// - Postgres 16 from infra/docker-compose.yml; a scratch database per row; the api child booted in the research-flow mode of test/support/chatEntryChild.ts (`pnpm --filter api build:child` first), with
//   `SOURCE_ACCESS_TABLE` set per row and BOTH fixture processes (`logs`, `backoffice`) started by the real `SourcesModule` on one `FIXTURE_SCENARIO` (`two-sources`).
// - Doubles are the model boundary only: the scripted chat model (one `deepResearch` call, then plain replies) and the scripted agents of the shipped v3 behind `ENGINE_RESOLVE_MODEL` (test/support/engineScriptedRoles.ts, researchFlowAgents.ts).
//   No network, no API key. No test asserts on keywords of model text.
// - Isolation: a unique user per row (`x-user-id`); the file runs with `fileParallelism: false`; no latency assertions; the wait for each end state is the harness timeout.
//
// Support the plan must add: the child's `SOURCE_ACCESS_TABLE` per session (and a way to restart the same session's child with a different value, S2); scripted agents of the two-source journey in researchFlowAgents.ts
// (planner names `fixture`; worker gathers from both; for S2 the worker asks `backoffice` before and after the restart); the transcript reader of the existing harness (`ENGINE_JOURNEY`).
//
// Budget: E2E 1 of 2 for the part, one journey in three rows. It stays at this level because nothing below can prove it: the real MCP servers' own tool texts (AC-01.2), the table and the declaration composed by the built server,
//   a restart between two calls of one investigation (the catalog lives in the row, the table is read once at start of the process), and the offer card that reads the deployment flag while the run reads its own mode.
//
// AC -> proving test: AC-01.2 (declared description in every transcript, the MCP server's text in none) and AC-04.3 / AC-07.1 as seen by the employee-side run: S1;
//   AC-08.1, AC-08.2 across a restart (Flow 2 of the Design Doc): S2; AC-09.2 (the offer without the no-sources warning; the running card and the answer with it) and AC-09.1 end to end: S3.

import { describe, it } from 'vitest';

describe('source-planning / catalog-planning - E2E (built api process, two real fixture processes, real Postgres)', () => {
  describe('E2E-1: the employee journey over the catalog', () => {
    // S1 - UC-1 / AC-01.2: a question answered over both sources
    // AC: AC-01.2 "the MCP server reports a tool description different from the declared one: every agent's transcript has the declared text and none of the server's text"
    // Given: `SOURCE_ACCESS_TABLE` lets the user read `fixture` and `backoffice`; the question is the recorded two-source question of the `two-sources` set.
    // When: the user sends it in the conversation; the scripted agents plan with `fixture` only, the worker gathers from both real processes.
    // Then: the investigation ends with an answer in the conversation; the run's catalog shows both sources; the worker's transcript holds the declared description of each source and tool, and not the text the fixture server reports for the same tool;
    //   records from `backoffice` appear in the evidence.
    // Behavior: built server -> declaration + table -> catalog -> real MCP tools/list text ignored, declared text shown -> answer
    // Catches: the server-reported description reaching an agent (the injection path AC-01.2 closes); the second fixture process not started or not given the same scenario (no matching order in the back office); the shipped declaration not fitting the shipped v3 limits.
    // @category: e2e
    // @dependency: full-system
    // @complexity: high
    it.todo('E2E-1 S1 (UC-1, AC-01.2): the two-source question ends with an answer; transcripts carry the declared descriptions, not the MCP server text');

    // S2 - UC-E5 across a restart (Flow 2): the right is taken away while the investigation lives
    // AC: AC-08.1 "the source is not called, the audit has a refusal with employee, source, tool and time, the worker continues"; AC-08.2 "no new audit row for the source after the first refusal"
    // Given: a user allowed both sources; an investigation on the catalog [fixture, backoffice] with a page already gathered from `backoffice`; the server is stopped between the worker's turns.
    // When: the server is started again with `SOURCE_ACCESS_TABLE` allowing only `fixture`; the investigation continues and the worker asks `backoffice` twice, then `fixture`.
    // Then: the catalog row of the investigation is unchanged (still two sources); the first `backoffice` call is `access_denied` with an audit row naming the source; the second is `source_revoked`; the `backoffice` process receives no call after the restart
    //   (its call log); the audit holds no further row naming `backoffice`; the `fixture` gather succeeds and the investigation ends with an answer.
    // Behavior: restart with a narrower table -> catalog read from the row -> port denies -> later calls refused from the recorded fact
    // Catches: the catalog rebuilt from the new table after the restart (the investigation silently losing a source, or a second root); the denial not recorded in a way that survives the restart.
    // @category: e2e
    // @dependency: full-system
    // @complexity: high
    it.todo('E2E-1 S2 (UC-E5, Flow 2): after a restart with a narrower table the catalog stays, backoffice is denied once and then revoked, no audit row after the first denial');

    // S3 - UC-E1 end to end: an employee with no rights
    // AC: AC-09.2 "the catalog is empty: the offer goes without the no-sources warning, the running card and the answer show it as today"; AC-09.1 "no source is called, the answer is from model knowledge"
    // Given: both sources are connected; the user is absent from `SOURCE_ACCESS_TABLE`.
    // When: the user asks a research question and receives the offer, confirms it, and the investigation runs.
    // Then: the offer carries no no-sources warning; the running card and the final answer carry the model-knowledge warnings (MC-31..MC-33); neither fixture process received a call; the run's mode is `model_knowledge`.
    // Behavior: deployment flag (`Engine.sourceMode` = sources) for the offer; the run's own mode (empty catalog) for the card and the answer
    // Catches: the offer built from the run mode (a warning on the offer that says sources are not connected when they are), or the card/answer built from the deployment flag (an answer from model knowledge shown as if it had sources).
    // @category: e2e
    // @dependency: full-system
    // @complexity: medium
    it.todo('E2E-1 S3 (UC-E1): an employee without rights gets an offer without the warning and a model-knowledge run with it; no fixture call');
  });
});
