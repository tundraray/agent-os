// source-planning / catalog-planning Integration Test Skeletons (engine side) - Design Doc: docs/features/source-planning/design-catalog-planning.md (v1.2, approved 2026-11-10)
// PRD: docs/features/source-planning/prd.md (FR-01..FR-10; AC-05.2 as the design words it: a catalog that does not fit is refused at server start, `process_config_rejected`).
// Consumes: docs/features/agent-runtime/design-agent-core.md and design-research-flow.md (their int skeletons `agent-runtime-agent-core.int.e2e-spec.ts` / `agent-runtime-research-flow.int.e2e-spec.ts`
// already prove the agent's turn, the tool executor in general, the forms and the closure; what they prove is not proven again here). UXRD: none (part without UI; the one card rule, AC-09.2, is in the api E2E file).
// Generated: 2026-11-10 | Part: catalog-planning | Test type: Integration (in-process runtime + engine + real Postgres, scripted model, the SHIPPED v3 configuration), CI job `e2e-engine`
// Implementation timing: created alongside the slice each test names (INT-1 start step + `source_catalog` + `{{sources}}`/`{{catalog}}`; INT-2 `plan_write` gate + `gather` `plan_missing` + stop reason; INT-3 executor checks).
//
// File name and placement. Same package, harness and config as `agent-runtime-research-flow.int.e2e-spec.ts` (`test/**/*.e2e-spec.ts` of `vitest.config.e2e.ts`; run with
// `pnpm --filter @agent-os/engine test:e2e`, never in the default `vitest run`). The api half of the part is `apps/api/test/source-planning-catalog-planning.int.e2e-spec.ts` (INT-4)
// and `apps/api/test/source-planning-catalog-planning.e2e-spec.ts` (E2E-1).
//
// Generated as `it.todo` skeletons so the file loads under lint, typecheck and `vitest run`. Implement each todo following its Given/When/Then comments when its slice lands. Do not convert a todo into a passing stub.
//
// Light test process (owner decision): integration/E2E skeletons exist only for the risky UCs of the Test Strategy - the catalog from start to every agent (UC-1, UC-2, UC-3, UC-E1), the plan gate and the stop it ends in (UC-4, UC-E2, UC-N1),
// the per-call checks and the revoke (UC-E3, UC-E5). Pure rules are unit tests named in the plan (list "Proven elsewhere" at the end).
//
// Environment (Design Doc "Test Strategy": the scenarios run on the shipped v3 with two training sources, each agent's model answers by script with tool calls):
// - Postgres 16 from infra/docker-compose.yml. Real `createRuntime` and real `createEngine`, real `AgentRunHandler`, the real research tools (`gather`, `plan_write`, `claims_write`), the real forms, the real `ToolExecutor`,
//   the real answer gateway. Boundary doubles only: the scripted language-model double (per agent) and TWO counting sources (`countingSource.ts`), one impersonating `fixture` (`search_logs`, `aggregate_logs`, `get_trace`)
//   and one `backoffice` (`search_orders`, `get_order`), each with the declaration's descriptions, so the shipped ceiling passes its source check unchanged. The counting sources are the independent counter of "source called".
// - The process is the SHIPPED `deep-research` v3 (`version: 3`), with `backoffice/search_orders` and `backoffice/get_order` in its ceiling. Rows that need small numbers use `researchFlowV3Config(overrides)`.
// - The rights port is a test double of `ToolAccessPolicy` (a table per owner that a test can change between calls and that counts its questions): it is the boundary the `access-control` feature will replace, and the counter of
//   "the port was not asked". `SourceAccessTable` itself is exercised in the api files.
// - Group table: built from the loaded config, as in the research-flow int file. Isolation: a unique `resourceId` and `launchKey` per test (test/support/new-user.ts); `fileParallelism: false`; `cancelStarted()` in afterEach.
// - "Model evaluates, algorithm decides": the double returns only tool calls by schema; no assertion reads a keyword of model text. The one text check is the transcript check of NFR-02 / AC-07.1 / AC-06.1 (an id or a description is
//   present or absent in a recorded prompt): it compares against the literals of the declaration, not against model output.
//
// Support the plan must add FIRST (existing support files are NOT edited by this skeleton set):
// 1. countingSource.ts - a second source id and a per-source tool list; `backoffice` records shaped like the fixture's order records (the lesson of research-flow UC-R1: a double whose records differ from the real source hides the defect).
// 2. test-configs.ts / engineHarness.ts - `connectedSources` of both sources, the rights-port double as an option, the shipped declaration descriptions passed to the registry double, `researchFlowV3Config` with the two-source ceiling.
// 3. engineDb.ts - read-only snapshots: `research_engine_runs.source_catalog` and `mode`; plan revisions with branch `sources`/`sourceReason`; `research_agent_tool_calls` with outcome, reason and `source`; the audit rows of source calls.
// 4. scriptedModel.ts - `model.promptsOfAgent(name)` (the whole recorded prompt of every call) for the transcript checks, and the `{ toolCalls: (view) => [...] }` step of the research-flow file.
//
// Budget (this file): Integration 3 of the part's 4 (INT-4 is in the api file; limit 3, a fourth only with its named defect). Each test groups the rows of one boundary:
//   INT-1 the catalog (start, storage, what every agent is shown), INT-2 the plan gate and its stop, INT-3 the per-call checks. Nothing here repeats a unit-proven rule's variants.
//
// AC -> proving test (the plan reads this to avoid a second test for an AC already proven; "unit" = a table-driven unit spec named in the plan):
// - AC-03.1, AC-04.1, NFR-02: INT-1 B; AC-03.2, AC-09.1: INT-1 B (the empty-catalog row); AC-04.2: INT-1 C; AC-04.3, AC-05.1, AC-07.1, AC-07.3: INT-1 A
// - AC-05.3, AC-06.1: INT-2 A; AC-06.2: INT-2 B; NFR-03: INT-1 A (no model call before the root's first turn) and INT-2 A (one turn more per rejected call)
// - AC-07.2, NFR-01 (never called): INT-3 A; AC-08.1, AC-08.2: INT-3 B
// - AC-09.2 (the card and the offer): E2E-1 S3; AC-01.2: E2E-1 S1; AC-05.2, DC-2: INT-4 (api); AC-01.1, AC-02.1, AC-02.2, AC-10.1: unit
// - tool_not_in_catalog (UC-E4, AC-07.2 for a tool outside the ceiling of a catalog source): unit of `gather` (a pair check against the ceiling; the source is not reached because the task is never created)

import { describe, it } from 'vitest';

describe('source-planning / catalog-planning - integration (in-process runtime + engine + real Postgres, scripted model, shipped v3, two counting sources)', () => {
  describe('INT-1: the catalog from start to every agent', () => {
    // INT-1 A - UC-1: an answer over two sources
    // AC: AC-04.3 "the developer opens the run and sees the catalog with descriptions"; AC-05.1 "every branch of the accepted plan has at least one source of the catalog and a reason";
    //   AC-07.1 "in the worker transcript every source and every tool has a description"; AC-07.3 "the plan named only logs for the branch, backoffice is in the catalog: the worker's request to backoffice is accepted"; NFR-03
    // Given: the rights table lets the owner read `fixture` and `backoffice`; the scenario has an order with a payment error in the logs and a record of that order in the back office.
    // When: the owner starts the investigation; the planner writes one plan whose only branch names `fixture` and a reason; the worker of that branch gathers from `fixture` and then from `backoffice`; the run is driven to its answer.
    // Then: `readAgentTree` returns a catalog of two sources, each with its description, its ceiling tools with descriptions and its slice; the plan revision has `sources` and `sourceReason` on the branch;
    //   the `backoffice` gather is accepted and reaches the counting source once; the worker's recorded prompt carries a description for each source and each tool; the planner made no turn besides `plan_write` and `finish`;
    //   the model-call ledger has no row before the root's first turn (the catalog costs no model call).
    // Behavior: start -> catalog into the engine row -> `{{catalog}}` / `{{sources}}` into the agents' system blocks -> plan with sources -> gather outside the branch's sources but inside the catalog -> accepted
    // Catches: a catalog that is built but not stored or not passed to the agents (the planner sees an empty `{{catalog}}`); a worker narrowed to the branch's sources instead of the catalog (AC-07.3); descriptions missing from the worker's block.
    // @category: core-functionality
    // @dependency: startInvestigation, SourceAccessPort double, SourceRegistry double, plan_write, gather, readAgentTree, counting sources, real Postgres
    // @complexity: high
    it.todo('INT-1 A (UC-1): two sources reach the planner and the worker with descriptions; a branch may gather beyond its named sources; the catalog costs no model call');

    // INT-1 B - UC-2, UC-E1: the catalog is the owner's, inside the ceiling; an empty catalog is the model-knowledge path (table rows)
    // AC: AC-03.1 "the table lets the user read only logs: the catalog is the logs"; AC-04.1 "connected and allowed but outside the process ceiling: not in the catalog"; AC-03.2 "the user is not in the table: the catalog is empty";
    //   AC-09.1 "the catalog is empty: no source called, the answer is built from model knowledge"; NFR-02 "the transcripts of all agents contain neither the id nor the description of `backoffice`"
    // Rows (one test each, own owner and launch key):
    //   B1 owner allowed only `fixture`; the question does not mention the back office -> catalog = [fixture]; the recorded prompts of EVERY agent of the run contain neither `backoffice` nor the back-office description;
    //   B2 owner allowed both, the process config (second configuration of the test) lists `backoffice` outside its ceiling -> catalog = [fixture]; no `backoffice` in any prompt;
    //   B3 owner absent from the table, both sources connected -> `source_catalog` empty, mode `model_knowledge`, the root is `synthesis`, no controller/planner started; zero slice reads and zero source calls (counting sources);
    //     `Engine.sourceMode` stays `sources` (the deployment flag that the offer uses).
    // Behavior: owner + connected + ceiling -> port answer per source -> catalog -> mode (empty catalog = model_knowledge)
    // Catches: a source the owner may not read appearing in any agent's input (NFR-02, the leak); the empty-catalog employee entering `sources` mode and stopping with "plan did not pass" instead of a model-knowledge answer (the KD-1 defect);
    //   a slice read from a source the owner is denied.
    // @category: integration
    // @dependency: startInvestigation, SourceAccessPort double, process ceiling, readSourceSnapshots, counting sources, real Postgres
    // @complexity: medium
    it.todo('INT-1 B1 (UC-2): the owner allowed only logs -> catalog [fixture]; no agent prompt names backoffice');
    it.todo('INT-1 B2 (UC-2): backoffice allowed but outside the ceiling -> not in the catalog');
    it.todo('INT-1 B3 (UC-E1): not in the table -> empty catalog, mode model_knowledge, only synthesis runs, no slice read, Engine.sourceMode still sources');

    // INT-1 C - UC-3: the catalog is written once
    // AC: AC-04.2 "a source connected or a right given after the start is not in the catalog of the running investigation, but is in the next investigation of the same employee"
    // Given: a running investigation whose catalog is [fixture]; the rights double then starts allowing `backoffice`.
    // When: the first investigation continues (a worker gathers; `readAgentTree` is read); the owner starts a second investigation; and the first launch key is started again.
    // Then: the first run's catalog and every run's `sources` stay [fixture]; the second investigation's catalog is [fixture, backoffice]; the repeated start with the first key returns the existing investigation and the catalog row is unchanged (the rights double is not asked again).
    // Behavior: catalog fixed at start in the row; a repeated start rebuilds the root from the row, not from the port
    // Catches: the catalog recomputed on read or on a repeated start (a second root task with different sources, the reason the catalog lives in the row - KD-1).
    // @category: integration
    // @dependency: startInvestigation, SourceAccessPort double, research_engine_runs, readAgentTree, real Postgres
    // @complexity: medium
    it.todo('INT-1 C (UC-3): the running investigation keeps its catalog; the next one gets the new right; a repeated launch key does not recompute');
  });

  describe('INT-2: the plan gate and the stop it ends in', () => {
    // INT-2 A - UC-4, UC-N1: a rejected plan is corrected, and the revision is checked against the same catalog
    // AC: AC-06.1 "the plan named a source outside the catalog: the planner's next-turn transcript contains the reason with that id"; AC-05.3 "a revised plan is built on the same catalog and passes the same check"; NFR-03 "one extra planner turn per rejected call"
    // Given: catalog [fixture]; the planner first writes a branch naming `backoffice`, then a corrected plan; a later call of the controller asks for a plan review and the planner writes a revised plan.
    // When: the run is driven through the first plan, the correction and the review.
    // Then: the first `plan_write` is `plan_sources_invalid` with `backoffice` and the branch number in `detail`, no revision is written; the planner's recorded prompt on the next turn contains that reason and the id;
    //   the corrected and the reviewed plans are revisions 1 and 2, both with sources inside the catalog; the planner has exactly one turn more than the same run of INT-1 A (the journal count).
    // Behavior: planner -> `plan_write` -> code compares ids with the run's sources -> reject with the reason / write the revision
    // Catches: a plan with a source the owner cannot read being written (the check missing or done on the schema); a rejection that writes a revision anyway; the reason not reaching the model (AC-06.1); a review revision skipping the check.
    // @category: core-functionality
    // @dependency: plan_write, ToolExecutor, planner session, readAgentTree, real Postgres
    // @complexity: medium
    it.todo('INT-2 A (UC-4, UC-N1): plan_sources_invalid names the id, writes no revision, the reason reaches the planner; the revised plan passes against the same catalog; one turn more');

    // INT-2 B - UC-E2: the attempts run out and the investigation stops with its own reason (rows: the root finishes / the root runs out of turns)
    // AC: AC-06.2 "all attempts rejected: the investigation is stopped with the new reason (plan did not pass the source check, MC-25), no source is called, the employee gets an answer with that reason"
    // Given: catalog [fixture]; the controller first tries to call a worker; the planner writes a plan with `backoffice` three times; then writes a fourth.
    // When: the run is driven (row B1: the controller then `finish`es "not established"; row B2: the controller spends its turns without `finish`).
    // Then: the early `gather` is `plan_missing`; the fourth `plan_write` is `plan_attempts_exhausted` with no revision; there is no plan revision; the counting sources have zero calls;
    //   the investigation is `completed` with an answer of outcome `inconclusive` and stop reason `plan_sources_rejected` (both rows); a plan-less `answer` closure is still refused `plan_missing`.
    // Behavior: three rejected attempts -> `gather` blocked -> root closes without a plan -> precedence rule sets `plan_sources_rejected`
    // Catches: work going on without a plan (a source called, invariant 6); the stop reason falling to a generic one (`failed`, `turns_exhausted`) so the employee gets the wrong text; the forced end of the root losing the reason.
    // @category: core-functionality
    // @dependency: plan_write, gather, research_close, stop-reason rule, forced end of the root, answer gateway, real Postgres
    // @complexity: high
    it.todo('INT-2 B1 (UC-E2): three rejections -> plan_missing for gather, plan_attempts_exhausted for the fourth call, inconclusive answer with plan_sources_rejected, no source call');
    it.todo('INT-2 B2 (UC-E2): the root runs out of turns without finish -> the same answer with the same reason');
  });

  describe('INT-3: the checks before every source call', () => {
    // INT-3 A - UC-E3 (rows per source): a source the owner may not read is never reached, never asked about, never audited
    // AC: AC-07.2 "the worker asked a source outside the catalog: refused, the source not called, the worker gets the reason"; NFR-01 "the source is not called and the port is not asked"
    // Rows: A1 the owner is allowed only `fixture`; the worker asks `backoffice`; A2 the owner is allowed only `backoffice`; the worker asks `fixture` (the same defect from the other side).
    // Given: the run's sources are the catalog; the rights double counts its questions.
    // When: the worker calls `gather` for the source outside the catalog.
    // Then: the result is `source_not_in_catalog`, no `detail`; the counting source of that id has zero calls; the rights double was not asked about the call; the call's audit row exists and carries no source;
    //   the worker continues its branch on the catalog source.
    // Behavior: executor reads the call's source -> not among the run's sources -> refuse before the port
    // Catches: the port being asked (or the source called) for a source outside the catalog; the audit row naming the unreachable source; the refusal giving the worker any fact about the source (NFR-02).
    // @category: core-functionality
    // @dependency: ToolExecutor, gather (`sourceOf`), SourceAccessPort double, audit table, counting sources, real Postgres
    // @complexity: medium
    it.todo('INT-3 A1 (UC-E3): backoffice outside the catalog -> source_not_in_catalog, no port question, audit row without source');
    it.todo('INT-3 A2 (UC-E3): fixture outside the catalog -> the same, from the other side');

    // INT-3 B - UC-E5: the right is revoked in the middle
    // AC: AC-08.1 "after the revoke the source is not called, the audit has a refusal row with employee, source, tool and time, the worker continues"; AC-08.2 "after the first refusal there is no new audit row for the source, the branch goes on without it,
    //   the verifier checks a claim against the records collected before, and the claim can stand in 'Established'"
    // Given: catalog [fixture, backoffice]; one page is already gathered from `backoffice` and a claim is written on it; then the rights double denies `backoffice`.
    // When: the worker asks `backoffice` twice and then `fixture`; the verifier checks the claim written on the back-office page.
    // Then: the first call is `access_denied` (the source not called; the audit row has the owner, `gather`, `backoffice`, time and outcome `access_denied`); the second is `source_revoked` and the rights double was not asked; the audit has no new row naming `backoffice` after the first denial
    //   (the second row has no source); the `fixture` gather goes through; the verifier assesses the claim from the collected page and its status is the one the verifier's script gives (supported -> 'Established' group in the answer).
    // Behavior: port denial recorded -> later calls read that fact from the run's calls -> refuse before the port, audit without source -> earlier records stay usable
    // Catches: the port asked again after a denial (the audit keeps growing for the revoked source - invariant 4); a revoked source dropping the earlier evidence (claims on it becoming "not verifiable"); the worker blocked from the other source.
    // @category: core-functionality
    // @dependency: ToolExecutor, SourceAccessPort double, gather, claims_write, verifier, audit table, answer gateway, real Postgres
    // @complexity: high
    it.todo('INT-3 B (UC-E5): first denial is access_denied with an audit row; the second is source_revoked without a port question or a source in the audit; the other source goes on; the earlier page still supports a claim');
  });
});

// Proven elsewhere (unit specs the plan names; not skeletons here):
// - UC-E4 / `tool_not_in_catalog`: the pair check of `gather` against the ceiling (table over: tool of another source, tool outside the ceiling, tool of a catalog source). The source is not reached because no task is created.
// - The order of the three executor checks and the audit-without-source rule as a pure function of (run sources, run's prior denials, port answer): src spec of `ToolExecutor`; INT-3 proves the wiring with real tables.
// - `buildSourcesField` (a line per source with descriptions, code-point order, the 8 192-byte limit) and the `{{catalog}}` field with `readsRunCatalog` (placement refusal, size refusal): src specs of the field builders and `definition-check`.
// - `plan_write` rule table (branch without source, source outside the run's sources, 0-8 ids, 1-500 reason) and the attempt counter (three in a row, `plan_attempts_exhausted` and schema refusals do not count): src spec of `plan-write`.
// - The precedence rule's first row (`plan_sources_rejected`) and gate 1 of `research_close` without a plan: src spec of the form and of `stop-reason`.
// - Verifier fingerprint unchanged (KD-8): not tested as a constant (a tautology); the shipped group table still being found at boot is proven by every file that boots the shipped v3.
// - Existing research-flow int/E2E files and the recorded-run fixture run on v3 whose planner schema and gather gate change: the plan lists their update (planner scripts name sources; recorded real-model answers may need a re-record).
