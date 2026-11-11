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

import {
  deepResearchProcessV3,
  type ResolveModel,
  type TokenCounter,
} from '@agent-os/engine';
import { type INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  ENGINE_GROUP_TABLES,
  ENGINE_PROCESSES,
  ENGINE_RESOLVE_MODEL,
  ENGINE_TOKEN_COUNTER,
} from '../src/engine/engine.tokens.js';
import { MASTRA } from '../src/mastra/mastra.constants.js';
import {
  createThreadTitleAgent,
  THREAD_TITLE_AGENT,
} from '../src/threads/thread-title.agent.js';
import { createTestMastra } from './support/createTestApp.js';
import { assistantModel, titleModel } from './support/mockModels.js';
import { TEST_GROUP_TABLES } from './support/testGroupTables.js';
import { closeRuntimeDb, query } from './support/wiring-handlers.js';

/** The log line `ResearchModule` writes when its workers start: a start that got this far was not aborted. */
const WORKERS_STARTED = 'Runtime workers started';

/**
 * `windowTokens` of the planner in the INT-4 B copy of the shipped v3 (`marginTokens` 3 000 stays). The loader's
 * estimate of the planner's least view (`leastViewTokens`, measured on the shipped v3 and declaration): 51 848 tokens
 * with `{{catalog}}` = the no-sources text, 52 069 with the largest `{{catalog}}` of the declaration (705 bytes). The
 * room 55 000 − 3 000 = 52 000 holds the first and not the second, so only a loader that sees the declared sources
 * refuses. Re-measure when the planner's prompt, tools or limits change.
 */
const PLANNER_WINDOW_TOKENS = 55_000;

/** A model that refuses every call: nothing in this file may reach a model. */
const refusingModel: ResolveModel = (modelId) =>
  new MockLanguageModelV4({
    provider: 'test',
    modelId,
    doGenerate: () =>
      Promise.reject(new Error(`model ${modelId} called during a start`)),
  });
const fixedCounter: TokenCounter = {
  countTurnInputTokens: () =>
    Promise.resolve({ outcome: 'counted', inputTokens: 100 }),
};

/** The one field of v3 INT-4 B edits; the rest of the configuration is copied as shipped. */
interface PlannerWindow {
  agents: { planner: { limits: { windowTokens: number } } };
}

/** A copy of the shipped v3 whose planner has `windowTokens`; everything else as shipped. */
function v3WithPlannerWindow(windowTokens: number): unknown {
  const copy = structuredClone(deepResearchProcessV3) as PlannerWindow;
  copy.agents.planner.limits.windowTokens = windowTokens;
  return copy;
}

/** What a start attempt ended with: the error it was aborted with, or `null` when the application started. */
interface StartOutcome {
  error: unknown;
}

/**
 * Compiles and initialises the real `AppModule` with `env` set while the providers are built (settings are read
 * there), the workers on so that a start that is not aborted would show, and the model ports replaced by doubles.
 * The app is closed whenever it was created; the outcome carries the error of `compile()` or `app.init()`.
 */
async function attemptStart(options: {
  env: Record<string, string>;
  processes?: readonly unknown[];
}): Promise<StartOutcome> {
  const restoreEnv = overrideEnv({
    RUNTIME_WORKERS: 'on',
    DB_POOL_MAX: '2',
    ...options.env,
  });
  let app: INestApplication;
  try {
    let builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MASTRA)
      .useFactory({
        factory: (config: ConfigService) =>
          createTestMastra(config, { model: assistantModel() }),
        inject: [ConfigService],
      })
      .overrideProvider(THREAD_TITLE_AGENT)
      .useValue(createThreadTitleAgent(titleModel().model))
      .overrideProvider(ENGINE_GROUP_TABLES)
      .useValue(TEST_GROUP_TABLES)
      .overrideProvider(ENGINE_RESOLVE_MODEL)
      .useValue(refusingModel)
      .overrideProvider(ENGINE_TOKEN_COUNTER)
      .useValue(fixedCounter);
    if (options.processes !== undefined) {
      builder = builder
        .overrideProvider(ENGINE_PROCESSES)
        .useValue(options.processes);
    }
    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication();
  } catch (error) {
    return { error };
  } finally {
    restoreEnv();
  }
  try {
    await app.init();
    return { error: null };
  } catch (error) {
    return { error };
  } finally {
    await app.close();
  }
}

/** Sets `variables` in `process.env` and returns the function restoring the previous values. */
function overrideEnv(variables: Record<string, string>): () => void {
  const previous = Object.fromEntries(
    Object.keys(variables).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, variables);
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** The database clock now: investigations created from it on belong to this test. */
async function databaseNow(): Promise<Date> {
  const [row] = await query<{ now: Date }>('SELECT now() AS now', []);
  return row!.now;
}

async function investigationsCreatedSince(since: Date): Promise<number> {
  const [row] = await query<{ count: number }>(
    'SELECT count(*)::int AS count FROM app.research_investigations WHERE created_at >= $1',
    [since],
  );
  return row!.count;
}

/** Watches the log without changing it; returns the function telling whether the workers started. */
function watchWorkersStart(): () => boolean {
  const log = vi.spyOn(Logger.prototype, 'log');
  return () =>
    log.mock.calls.some(([message]) =>
      String(message).startsWith(WORKERS_STARTED),
    );
}

describe('source-planning / catalog-planning - integration (api composition, real Postgres)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeRuntimeDb();
  });

  describe('INT-4: the server does not start on a bad rights table or a catalog that does not fit', () => {
    // INT-4 A - UC-E7
    // AC: DC-2 "a rights table with an unreadable value or a source absent from the declaration does not pass the start; the error names the user and the source"
    // Given: `SOURCE_ACCESS_TABLE` = `{"user-1":["crm"]}`; `crm` is not in the declaration.
    // When: the application is initialised.
    // Then: the start rejects; the error names `user-1` and `crm`; no worker was started and no investigation row exists.
    //   The refusal comes from the provider factory of `SOURCE_ACCESS_POLICY`, so the bootstrap aborts while the module
    //   compiles, before `app.init()`; `attemptStart` covers both phases.
    // Behavior: settings -> `SourceAccessTable` built against the declaration -> refusal aborts the module bootstrap
    // Catches: the table read but not checked against the declaration in the real composition (a typo in a source id silently gives that employee an empty catalog); the table never wired (the old `CONFIGURATION_ACCESS_POLICY` kept).
    // @category: integration
    // @dependency: ConfigService, SourceAccessTable, sources.config declaration, EngineModule, real Postgres
    // @complexity: low
    it('INT-4 A (UC-E7): a rights table naming `crm` aborts start with the user and the source', async () => {
      const since = await databaseNow();
      const workersStarted = watchWorkersStart();

      const outcome = await attemptStart({
        env: { SOURCE_ACCESS_TABLE: '{"user-1":["crm"]}' },
      });

      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toMatch(
        /SOURCE_ACCESS_TABLE: user user-1 is given source crm, which is not declared/,
      );
      expect(workersStarted()).toBe(false);
      expect(await investigationsCreatedSince(since)).toBe(0);
    }, 60_000);

    // INT-4 B - UC-E6
    // AC: AC-05.2 "the largest catalog the planner can get (every declared source in the ceiling, with descriptions) does not fit: the process config is rejected at load with `process_config_rejected` naming the process and the planner agent; the server does not start; the catalog is not trimmed"
    // Given (task T4.4 over the skeleton): two declared sources at 600 characters per description cannot make
    //   `{{catalog}}` reach 8 192 bytes (that bound is the `agent-config.spec.ts` row of T2.3), so the catalog does not
    //   fit the WINDOW instead: `ENGINE_PROCESSES` = the shipped v3 with the planner's `windowTokens` =
    //   PLANNER_WINDOW_TOKENS, which holds the planner's least view with the no-sources text and not with the largest
    //   `{{catalog}}` of the shipped declaration.
    // When: the application is initialised.
    // Then: `app.init()` rejects with `process_config_rejected` naming `deep-research` and `planner` (path
    //   `agents.planner.limits.windowTokens`); no worker was started and no investigation row exists.
    // Behavior: declaration -> largest catalog field -> loader check in the engine built by the module -> refusal at start
    // Catches: the catalog field size computed from nothing (the loader sees no declared sources), so an oversized catalog starts the server and is cut or overflows the window at the first investigation.
    // @category: integration
    // @dependency: sources.config declaration, SourceRegistry, createEngine loader (least view with `{{catalog}}`), real Postgres
    // @complexity: medium
    it('INT-4 B (UC-E6): a catalog that does not fit the planner window aborts start with process_config_rejected naming the process and planner', async () => {
      const since = await databaseNow();
      const workersStarted = watchWorkersStart();

      const outcome = await attemptStart({
        env: {},
        processes: [v3WithPlannerWindow(PLANNER_WINDOW_TOKENS)],
      });

      expect(outcome.error).toMatchObject({
        code: 'process_config_rejected',
        path: [0, 'agents', 'planner', 'limits', 'windowTokens'],
      });
      expect((outcome.error as Error).message).toMatch(
        /process deep-research: agent planner: the least view/,
      );
      expect(workersStarted()).toBe(false);
      expect(await investigationsCreatedSince(since)).toBe(0);
    }, 60_000);
  });
});

// Proven elsewhere (unit):
// - AC-01.1 (no description on a source or a tool; a source without an adapter): `createSources` spec; AC-03.1/AC-03.2 answers of `SourceAccessTable` and the table parse: its spec.
// - AC-02.1, AC-02.2, UC-6 (the order numbers of the logs exist in the back office; every scenario's key names both sources and a recorded answer): `packages/mcp-fixture` spec over the generated `two-sources` set.
// - AC-10.1, UC-7 (`planNamedKeySources` per scenario from the FIRST accepted revision, the share two thirds): spec of the run-result / report builders over scripted `RunResult`s. The assembly of two adapters and the system owner's stub
//   in `assembleScenario` is not run end to end by a test of this part (see the report note).
