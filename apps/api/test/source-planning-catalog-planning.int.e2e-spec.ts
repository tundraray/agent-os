// source-planning / catalog-planning Integration Test Skeletons (api side, composition) - Design Doc: docs/features/source-planning/design-catalog-planning.md (v1.2, approved 2026-11-10)
// PRD: docs/features/source-planning/prd.md (FR-03, FR-05; AC-05.2 as the design words it: a catalog that does not fit is refused at server start, `process_config_rejected`). UXRD: none (part without UI).
// Generated: 2026-11-10 | Part: catalog-planning | Test type: Integration (the Nest application assembled in-process over real Postgres; no model call, no investigation), CI job `e2e` of apps/api
// Implementation timing: created alongside the slice (`SourceAccessTable` + `sources.config.ts` declaration + the catalog-field check wired in `EngineModule`).
//
// File placement: `apps/api/test/*.e2e-spec.ts`, `vitest.config.e2e.ts`, fileParallelism false. The engine half of the part is `packages/engine/test/source-planning-catalog-planning.int.e2e-spec.ts` (INT-1..INT-3);
// the process-level file is `apps/api/test/source-planning-catalog-planning.e2e-spec.ts` (E2E-1).
//
// Generated as `it.todo` skeletons. Implement each todo following its Given/When/Then comments. Do not convert a todo into a passing stub.
//
// Environment: the Nest testing module as in `sources-wiring.e2e-spec.ts` (real `SourcesModule`, `EngineModule`, real Postgres, `RUNTIME_WORKERS=off`); the test overrides only the SETTING under test
// (`SOURCE_ACCESS_TABLE`) or the declaration the module reads (a test-only override of the declaration provider). `app.init()` is the act; the assertion is the thrown start error. No scripted model is needed: nothing runs.
//
// Budget: Integration 1 (INT-4, the part's fourth; engine INT-1..INT-3 are the other three; limit 3, a fourth only with its named defect). Unique defect: the composition in `apps/api` - the declaration and the rights table are
//   read from settings at module bootstrap and fed to `createSources` / `createEngine`. The rules themselves (table parse, description length, field size) are unit-proven; a unit spec cannot see an `EngineModule` that
//   builds the engine with an old allowlist, the default "allow everything" port, or a declaration that is not the one the sources use. The description-missing refusal (AC-01.1) is a `createSources` unit row and is not repeated here.
//
// AC -> proving test: DC-2 (a rights table naming a source that is not declared does not start, the error names the user and the source): INT-4 A;
//   AC-05.2 (a catalog that does not fit the planner's window is refused at start with `process_config_rejected` naming the process and `planner`; no investigation begins): INT-4 B.

import { describe, it } from 'vitest';

describe('source-planning / catalog-planning - integration (api composition, real Postgres)', () => {
  describe('INT-4: the server does not start on a bad rights table or a catalog that does not fit', () => {
    // INT-4 A - UC-E7
    // AC: DC-2 "a rights table with an unreadable value or a source absent from the declaration does not pass the start; the error names the user and the source"
    // Given: `SOURCE_ACCESS_TABLE` = `{"user-1":["crm"]}`; `crm` is not in the declaration.
    // When: the application is initialised.
    // Then: `app.init()` rejects; the error names `user-1` and `crm`; no worker was started and no investigation row exists.
    // Behavior: settings -> `SourceAccessTable` built against the declaration -> refusal aborts the module bootstrap
    // Catches: the table read but not checked against the declaration in the real composition (a typo in a source id silently gives that employee an empty catalog); the table never wired (the old `CONFIGURATION_ACCESS_POLICY` kept).
    // @category: integration
    // @dependency: ConfigService, SourceAccessTable, sources.config declaration, EngineModule, real Postgres
    // @complexity: low
    it.todo('INT-4 A (UC-E7): a rights table naming `crm` aborts start with the user and the source');

    // INT-4 B - UC-E6
    // AC: AC-05.2 "the largest catalog the planner can get (every declared source in the ceiling, with descriptions) does not fit: the process config is rejected at load with `process_config_rejected` naming the process and the planner agent; the server does not start; the catalog is not trimmed"
    // Given: a declaration (test override) whose descriptions make the largest value of `{{catalog}}` longer than 8 192 bytes.
    // When: the application is initialised.
    // Then: `app.init()` rejects with `process_config_rejected` naming `deep-research` and `planner` (path `agents.planner.prompt`); no investigation row exists.
    // Behavior: declaration -> largest catalog field -> loader check in the engine built by the module -> refusal at start
    // Catches: the catalog field size computed from nothing (the loader sees no declared sources), so an oversized catalog starts the server and is cut or overflows the window at the first investigation.
    // @category: integration
    // @dependency: sources.config declaration, SourceRegistry, createEngine loader (`CATALOG_FIELD_MAX_BYTES`), real Postgres
    // @complexity: medium
    it.todo('INT-4 B (UC-E6): an oversized declaration aborts start with process_config_rejected naming the process and planner');
  });
});

// Proven elsewhere (unit):
// - AC-01.1 (no description on a source or a tool; a source without an adapter): `createSources` spec; AC-03.1/AC-03.2 answers of `SourceAccessTable` and the table parse: its spec.
// - AC-02.1, AC-02.2, UC-6 (the order numbers of the logs exist in the back office; every scenario's key names both sources and a recorded answer): `packages/mcp-fixture` spec over the generated `two-sources` set.
// - AC-10.1, UC-7 (`planNamedKeySources` per scenario from the FIRST accepted revision, the share two thirds): spec of the run-result / report builders over scripted `RunResult`s. The assembly of two adapters and the system owner's stub
//   in `assembleScenario` is not run end to end by a test of this part (see the report note).
