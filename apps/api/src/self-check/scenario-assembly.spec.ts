import {
  type CreateEngineOptions,
  deepResearchProcessV3,
} from '@agent-os/engine';
import {
  parseRuntimeConfig,
  type Runtime,
  systemClock,
} from '@agent-os/runtime';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { assembleScenario } from './scenario-assembly.js';
import { loadSelfCheckSettings } from './settings.js';

// FR-07, DC-15, DC-18 (the `show` half): an assembly with the workers off builds the engine for `Engine.assess` but
// never starts the runtime — no dispatcher, relay or sweeper, so a task left queued by a dropped `run` cannot be
// claimed by a process that only judges. Defect caught: `assembleScenario` calling `runtime.start()` regardless of
// `workers`, or the workers-off assembly refusing to build the engine.

/** The runtimes the module under test created, each with its `start` observed. */
const created = vi.hoisted(
  () => [] as { runtime: Runtime; start: Mock<() => void> }[],
);

/** The options of every engine the module under test created. */
const engines = vi.hoisted(() => [] as CreateEngineOptions[]);

vi.mock('@agent-os/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-os/engine')>();
  return {
    ...actual,
    createEngine: (options: CreateEngineOptions) => {
      engines.push(options);
      return actual.createEngine(options);
    },
  };
});

vi.mock('@agent-os/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-os/runtime')>();
  return {
    ...actual,
    createRuntime: (options: Parameters<typeof actual.createRuntime>[0]) => {
      const real = actual.createRuntime(options);
      const start = vi.fn(real.start.bind(real));
      const runtime: Runtime = { ...real, start };
      created.push({ runtime, start });
      return runtime;
    },
  };
});

describe('assembleScenario with the workers off (show)', () => {
  beforeEach(() => {
    created.length = 0;
    engines.length = 0;
  });

  function assemble(processConfig: unknown, logs: string[] = []) {
    return assembleScenario({
      // Nothing listens here: the assembly connects lazily, and a judge-only assembly makes no query before a call.
      databaseUrl: 'postgres://nobody:nobody@127.0.0.1:1/none',
      scenario: 'v1',
      processConfig,
      judgeModel: loadSelfCheckSettings().judge.model,
      runtime: { ...parseRuntimeConfig({}), workers: false },
      clock: systemClock,
      resolveModel: (modelId) =>
        new MockLanguageModelV4({ provider: 'spec', modelId }),
      tokenCounter: {
        countTurnInputTokens: () =>
          Promise.reject(new Error('the self-check runs no agent turn')),
      },
      logger: {
        debug() {},
        log: (message: string) => {
          logs.push(message);
        },
        warn() {},
        error() {},
      },
    });
  }

  // Flow 4: `Engine.assessAgent` may call the checker agent's model. Defect caught: a calibration whose every pair is
  // rejected as `model_unavailable`, because the checker agent's model is missing from the allowed list.
  it("allows the model of the checker agent for the configuration's calibration", async () => {
    const assembly = await assemble(deepResearchProcessV3);
    try {
      expect(engines.at(-1)?.assessModels).toEqual([
        'anthropic/claude-sonnet-5-5',
        'anthropic/claude-haiku-5-5',
      ]);
    } finally {
      await assembly.close();
    }
  });

  it('builds the engine for the judge and the checker models and never calls runtime.start', async () => {
    const logs: string[] = [];
    const assembly = await assemble(deepResearchProcessV3, logs);
    try {
      // The observed runtime is the one of the assembly: the observation is wired, not vacuous.
      expect(created).toHaveLength(1);
      expect(assembly.runtime).toBe(created[0]!.runtime);
      expect(created[0]!.start).not.toHaveBeenCalled();
      expect(
        logs.filter((message) => message.startsWith('Runtime workers')),
      ).toEqual([]);
      // The engine is there for the judge call.
      expect(typeof assembly.engine.assess).toBe('function');
      // design-engine.md, «Кто оценивает»: `Engine.assess` may call the judge and the configuration's checker model —
      // calibration's call. Defect caught: an assembly whose calibration call is refused as `model_unavailable`.
      expect(engines.at(-1)?.assessModels).toEqual([
        'anthropic/claude-sonnet-5-5',
        'anthropic/claude-haiku-5-5',
      ]);
    } finally {
      await assembly.close();
    }
  });
});
