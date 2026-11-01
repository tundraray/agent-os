// deep-research / engine — wiring of EngineModule in apps/api against real Postgres (design-engine.md, C2; ADR-0004).
// Design Doc: docs/features/deep-research/design-engine.md (C2, Contract Definitions: createEngine, Engine.sourceMode, KD-7, KD-8).
// The engine's own behaviour is proven in packages/engine; this file proves only what a package test cannot see: where in
// the Nest phases EngineModule calls createEngine.
// Budget: one test beyond the integration budget of the part (as UC-9 of mcp-source); the plan records the exception (T6.1).
// Covers: C2 (the engine handlers are registered before the workers start), Engine.sourceMode `sources` with the fixture.
// Primary failure mode (turns red when): createEngine runs after the workers start (onApplicationBootstrap) — the handlers
// register after "Runtime workers started" — or before SourcesModule binds the source registry (a provider factory) —
// DC-14 refuses the configuration against the empty registry and app.init() throws.
// Verification items:
// - AppModule with RUNTIME_WORKERS=on, the model and token counter replaced by doubles: the four engine handlers register
//   after source.fetch and before the workers start
// - RESEARCH_ENGINE resolves to an Engine with sourceMode `sources`; a started investigation reaches its research.controller
//   task in research_tasks
// Run: `pnpm --filter api test:e2e:runtime`, never in parallel with other suites against one database.

import { randomUUID } from 'node:crypto';
import type { Engine, ResolveModel, TokenCounter } from '@agent-os/engine';
import { HandlerRegistry } from '@agent-os/runtime';
import { Logger } from '@nestjs/common';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENGINE_RESOLVE_MODEL,
  ENGINE_TOKEN_COUNTER,
  RESEARCH_ENGINE,
} from '../src/engine/engine.tokens.js';
import { createRuntimeApp } from './support/runtimeApp.js';
import { newUser } from './support/seed.js';
import { closeRuntimeDb, query } from './support/wiring-handlers.js';

/** A role model that answers nothing: every call waits until its signal aborts (the workers' stop). */
const silentModel: ResolveModel = (modelId) =>
  new MockLanguageModelV4({
    provider: 'test',
    modelId,
    doGenerate: ({ abortSignal }) =>
      new Promise((_, reject) => {
        if (!abortSignal) {
          reject(new Error('role model call without abortSignal'));
          return;
        }
        abortSignal.addEventListener(
          'abort',
          () => reject(abortSignal.reason as Error),
          { once: true },
        );
      }),
  });

const fixedCounter: TokenCounter = {
  countInputTokens: () =>
    Promise.resolve({ outcome: 'counted', inputTokens: 100 }),
};

describe('deep-research / engine - wiring of EngineModule (in-process Nest + real Postgres)', () => {
  const WORKERS_STARTED = 'Runtime workers started';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeRuntimeDb();
  });

  it('creates the engine after the sources are bound and before the workers start', async () => {
    const register = vi.spyOn(HandlerRegistry.prototype, 'register');
    const log = vi.spyOn(Logger.prototype, 'log');
    const runtime = await createRuntimeApp({
      handlers: [],
      runtime: { shutdownGraceMs: 1_000 },
      overrides: [
        { token: ENGINE_RESOLVE_MODEL, value: silentModel },
        { token: ENGINE_TOKEN_COUNTER, value: fixedCounter },
      ],
    });

    try {
      const workersStarted = log.mock.calls.findIndex(([message]) =>
        String(message).startsWith(WORKERS_STARTED),
      );
      expect(workersStarted).toBeGreaterThanOrEqual(0);
      const startedAt = log.mock.invocationCallOrder[workersStarted]!;
      const registeredBeforeStart = register.mock.calls
        .filter(
          (_, index) => register.mock.invocationCallOrder[index]! < startedAt,
        )
        .map(
          ([handler]) => `${handler.workflowType}@${handler.workflowVersion}`,
        );
      expect(registeredBeforeStart).toEqual([
        'source.fetch@1',
        'research.controller@1',
        'research.analyze@1',
        'research.verify@1',
        'research.synthesize@1',
      ]);

      const engine = runtime.app.get<Engine>(RESEARCH_ENGINE);
      expect(engine.sourceMode).toBe('sources');

      const resourceId = newUser();
      const threadId = await runtime.createThread(resourceId);
      const started = await engine.startInvestigation({
        resourceId,
        threadId,
        query: 'Why did checkout fail at 10:00?',
        processId: 'deep-research',
        launchKey: randomUUID(),
      });
      expect(started.outcome).toBe('created');
      if (started.outcome !== 'created') return;
      const tasks = await query<{ workflowType: string }>(
        `SELECT workflow_type AS "workflowType" FROM app.research_tasks
          WHERE investigation_id = $1 AND task_id = $2`,
        [started.investigationId, started.controllerTaskId],
      );
      expect(tasks).toEqual([{ workflowType: 'research.controller' }]);
    } finally {
      await runtime.close();
    }
  }, 60_000);
});
