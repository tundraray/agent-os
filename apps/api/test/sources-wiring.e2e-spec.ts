// research-runtime / mcp-source — UC-9, wiring of SourcesModule in apps/api against real Postgres and the fixture process.
// Design Doc: docs/features/research-runtime/design-mcp-source.md (Contract Definitions, Logging and Monitoring, Test Strategy: UC-9). ADR-0004.
// The allowlist rule (a tool without readOnly is refused) is proven by packages/sources/src/sources.registry.spec.ts; this file proves only
// what a package test cannot see: the order of the Nest phases around createSources and the adapters' close().
// Budget: beyond the integration budget of the part, required by the design (Test Strategy: UC-9); the plan records the exception (T3.4).
// Covers: AC-11.3 (the start is aborted before the workers), Use case UC-9.
// Primary failure mode (turns red when): SourcesModule calls createSources in onApplicationBootstrap (after the workers may claim
// `source.fetch`), closes the adapters in beforeApplicationShutdown (before the workers stop), or lets a refused allowlist start the workers.
// Run: `pnpm --filter api test:e2e:runtime`, never in parallel with other suites against one database.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FixtureSourceAdapter,
  type SourceAdapter,
  type SourceRegistry,
} from '@agent-os/sources';
import { HandlerRegistry } from '@agent-os/runtime';
import { type INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppModule } from '../src/app.module.js';
import { MASTRA } from '../src/mastra/mastra.constants.js';
import {
  SOURCE_ADAPTERS,
  SOURCE_REGISTRY,
} from '../src/sources/sources.module.js';
import {
  createThreadTitleAgent,
  THREAD_TITLE_AGENT,
} from '../src/threads/thread-title.agent.js';
import { assistantModel, titleModel } from './support/mockModels.js';
import { createRuntimeApp } from './support/runtimeApp.js';
import { closeRuntimeDb } from './support/wiring-handlers.js';

describe('research-runtime / mcp-source - UC-9 wiring of SourcesModule (in-process Nest + real Postgres)', () => {
  const PROCESS_EXIT_MS = 10_000;
  const WORKERS_STARTED = 'Runtime workers started';
  const WORKERS_STOPPED = 'Runtime workers stopped';

  const tempDirs: string[] = [];

  /**
   * Watches the phases without changing them (the spies call through) and returns the function listing them in the
   * order they happened: handler registrations, the workers' start and stop, the fixture adapter's close.
   */
  function recordPhases(): () => string[] {
    const register = vi.spyOn(HandlerRegistry.prototype, 'register');
    const log = vi.spyOn(Logger.prototype, 'log');
    const close = vi.spyOn(FixtureSourceAdapter.prototype, 'close');
    return () => {
      const phases: { order: number; phase: string }[] = [
        ...register.mock.calls.map(([handler], index) => ({
          order: register.mock.invocationCallOrder[index]!,
          phase: `register ${handler.workflowType}@${handler.workflowVersion}`,
        })),
        ...log.mock.calls.flatMap(([message], index) => {
          const text = String(message);
          const phase = text.startsWith(WORKERS_STARTED)
            ? WORKERS_STARTED
            : text === WORKERS_STOPPED
              ? WORKERS_STOPPED
              : null;
          return phase === null
            ? []
            : [{ order: log.mock.invocationCallOrder[index]!, phase }];
        }),
        ...close.mock.invocationCallOrder.map((order) => ({
          order,
          phase: 'fixture close',
        })),
      ];
      return phases
        .sort((left, right) => left.order - right.order)
        .map(({ phase }) => phase);
    };
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

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  }

  const CallLogSchema = z.array(z.object({ tool: z.string(), pid: z.int() }));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeRuntimeDb();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('registers source.fetch before the workers start and stops the fixture process after the workers stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sources-wiring-'));
    tempDirs.push(dir);
    const callLog = join(dir, 'calls.jsonl');
    const timeline = recordPhases();

    // Settings are read while the module compiles; the call log carries the fixture process's pid.
    const restoreEnv = overrideEnv({ FIXTURE_CALL_LOG: callLog });
    let runtime: Awaited<ReturnType<typeof createRuntimeApp>>;
    try {
      runtime = await createRuntimeApp({ handlers: [] });
    } finally {
      restoreEnv();
    }

    let pid: number;
    try {
      expect(timeline()).toEqual(['register source.fetch@1', WORKERS_STARTED]);

      // The fixture process starts on the first call through the registry SourcesModule provides.
      const registry = runtime.app.get<SourceRegistry>(SOURCE_REGISTRY);
      const resolved = registry.resolveTool({
        workflowType: 'source.fetch',
        sourceId: 'fixture',
        toolName: 'search_logs',
      });
      expect(resolved).not.toBeNull();
      const outcome = await resolved!.adapter.call({
        toolName: 'search_logs',
        args: {
          from: '2026-01-01T00:00:00Z',
          to: '2026-01-01T01:00:00Z',
          pageSize: 1,
        },
        cursor: null,
        signal: new AbortController().signal,
        timeoutMs: 30_000,
      });
      expect(outcome.kind).toBe('page');
      const calls = CallLogSchema.parse(
        readFileSync(callLog, 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as unknown),
      );
      expect(calls.map((call) => call.tool)).toEqual(['search_logs']);
      pid = calls[0]!.pid;
      expect(isAlive(pid)).toBe(true);
    } finally {
      await runtime.close();
    }

    expect(timeline()).toEqual([
      'register source.fetch@1',
      WORKERS_STARTED,
      WORKERS_STOPPED,
      'fixture close',
    ]);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), {
      timeout: PROCESS_EXIT_MS,
      interval: 50,
    });
  }, 60_000);

  it('aborts the start before the workers when the allowlist names a tool without readOnly', async () => {
    const writable: SourceAdapter = {
      descriptor: {
        sourceId: 'fixture',
        tools: [
          {
            name: 'search_logs',
            paginated: true,
            readOnly: false,
            argsSchema: z.object({}),
            resultSchema: z.unknown(),
          },
        ],
      },
      call: () => Promise.reject(new Error('never called')),
      currentSnapshot: () => Promise.reject(new Error('never called')),
      close: () => Promise.resolve(),
    };
    const timeline = recordPhases();
    const restoreEnv = overrideEnv({ RUNTIME_WORKERS: 'on', DB_POOL_MAX: '2' });
    let app: INestApplication;
    try {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(MASTRA)
        .useFactory({ factory: testMastra, inject: [ConfigService] })
        .overrideProvider(THREAD_TITLE_AGENT)
        .useValue(createThreadTitleAgent(titleModel().model))
        .overrideProvider(SOURCE_ADAPTERS)
        .useValue([writable])
        .compile();
      app = moduleRef.createNestApplication();
    } finally {
      restoreEnv();
    }

    try {
      await expect(app.init()).rejects.toThrow(
        /sourceId fixture, toolName search_logs.*not read-only/,
      );
      expect(timeline()).not.toContain(WORKERS_STARTED);
      expect(timeline()).not.toContain('register source.fetch@1');
    } finally {
      await app.close();
    }
  }, 60_000);
});

/** Mastra on a mock model: only the `assistant` agent's Memory, which the threads module needs at compile time. */
function testMastra(config: ConfigService): Mastra {
  return new Mastra({
    agents: {
      assistant: new Agent({
        id: 'assistant',
        name: 'Assistant',
        instructions: 'You are a test assistant.',
        model: assistantModel(),
        memory: new Memory({ options: { lastMessages: 20 } }),
      }),
    },
    storage: new PostgresStore({
      id: 'agent-os-e2e-sources',
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
    }),
  });
}
