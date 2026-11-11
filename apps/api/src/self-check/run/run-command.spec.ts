import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepResearchProcessV3, readTranscripts } from '@agent-os/engine';
import { systemClock } from '@agent-os/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SelfCheckProgram } from '../program.js';
import type { ScenarioAssembly } from '../scenario-assembly.js';
import { loadSelfCheckSettings } from '../settings.js';
import {
  type AgentModel,
  executeRunCommand,
  loadRunnableConfig,
  parseAgentModels,
  runDeadlineMs,
  swapModels,
  THRESHOLDS_COPY_FILE_NAME,
} from './run-command.js';
import { waitForScenarioRuns } from './run-waiter.js';

vi.mock('@agent-os/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-os/engine')>()),
  readTranscripts: vi.fn(),
}));
vi.mock('./run-waiter.js', () => ({
  scenarioWaiterPorts: () => ({}),
  waitForScenarioRuns: vi.fn(),
}));

// Invariant 7, plan Notes 2, AC-05.2: the copy of the thresholds file is in the run directory before the first
// `startInvestigation` of the run. E2E-1 sees the copy only once the first investigation is visible to its poll; the
// order itself is proven here, on a scripted assembly whose first start records what the run directory holds.

const THRESHOLDS_TEXT =
  '{"bands":{"solvedShare":0.1,"honestRefusalShare":0.1,"solvedScenarioCost":0.1,"contradictionShare":0.1},"levels":{"judgeAgreementMin":0.8,"unclearMax":0.2,"injectionInfluenceMax":0.25}}';

describe('executeRunCommand: the thresholds copy before the first investigation (invariant 7)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'run-command-spec-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('writes the copy, byte-equal to the file, before the first startInvestigation call', async () => {
    const thresholdsFile = join(workDir, 'thresholds.json');
    await writeFile(thresholdsFile, THRESHOLDS_TEXT, 'utf8');
    const reportsDir = join(workDir, 'reports');
    const steps: string[] = [];
    const copiesAtFirstStart: (string | null)[] = [];
    const scripted = {
      engine: {
        startInvestigation: () => {
          steps.push('startInvestigation');
          const [runDir] = existsSync(reportsDir)
            ? readdirSync(reportsDir)
            : [];
          const copy =
            runDir === undefined
              ? null
              : join(reportsDir, runDir, THRESHOLDS_COPY_FILE_NAME);
          copiesAtFirstStart.push(
            copy !== null && existsSync(copy)
              ? readFileSync(copy, 'utf8')
              : null,
          );
          // Stops the run at its first start: nothing after it is under test.
          return Promise.resolve({ outcome: 'rejected', code: 'stopped' });
        },
      },
      close: () => Promise.resolve(),
    } as unknown as ScenarioAssembly;
    const program = {
      settings: loadSelfCheckSettings(),
      reportsDir,
      clock: systemClock,
      logger: { debug() {}, log() {}, warn() {}, error() {} },
      cancelLeftovers: () => Promise.resolve(),
      assembleScenario: () => {
        steps.push('assembleScenario');
        return Promise.resolve(scripted);
      },
    } as unknown as SelfCheckProgram;

    await expect(
      executeRunCommand(
        ['--set', 'smoke', '--runs', '1', '--thresholds', thresholdsFile],
        program,
      ),
    ).rejects.toThrow('run 0 of scenario timeout-lowered was refused: stopped');

    expect(steps).toEqual(['assembleScenario', 'startInvestigation']);
    expect(copiesAtFirstStart).toEqual([THRESHOLDS_TEXT]);
  });
});

// UC-E8, design-self-check.md (Constraints «Бюджет токенов»); moved from INT-5 A (moved INT-3 R3) of
// test/agent-runtime-research-flow.int.e2e-spec.ts. The rule of the budget is run-budget.spec.ts; this row proves the
// wiring: the run charges the judge transcripts bound to a scenario's runs before it admits the next scenario. Defect
// caught: the judge spend left out of `--budget`, so a scenario the investigations alone would afford still runs.
describe('executeRunCommand: the judge spend counts against the run budget', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'run-command-spec-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    vi.mocked(readTranscripts).mockReset();
    vi.mocked(waitForScenarioRuns).mockReset();
  });

  it('leaves the next scenario not run when the investigation spend alone would afford it but the judge spend does not', async () => {
    const loaded = loadRunnableConfig(deepResearchProcessV3);
    if (!loaded.ok) throw new Error(loaded.rejection.message);
    const runTokenBudget = loaded.config.limits.investigationTokens.default;
    const investigationTokens = 100;
    const judgeTokens = 50;
    vi.mocked(waitForScenarioRuns).mockResolvedValue([
      {
        investigationId: 'run-1',
        outcome: 'timeout',
        usage: { totalTokens: investigationTokens },
        record: {
          investigationId: 'run-1',
          status: 'cancelled',
          answer: null,
          usage: { totalTokens: investigationTokens, totalCostUsd: 0 },
          calls: [],
          claims: [],
          planRevisions: [],
          agentTree: { runs: [] },
          config: { processConfig: deepResearchProcessV3 },
        },
      },
    ] as never);
    vi.mocked(readTranscripts).mockResolvedValue({
      outcome: 'found',
      transcripts: [
        {
          role: 'judge',
          taskId: null,
          usage: { inputTokens: 30, outputTokens: judgeTokens - 30 },
        },
      ],
    } as never);
    const assembled: string[] = [];
    const notRun: unknown[] = [];
    const scripted = {
      engine: {
        startInvestigation: () =>
          Promise.resolve({ outcome: 'started', investigationId: 'run-1' }),
      },
      database: { db: {} },
      close: () => Promise.resolve(),
    } as unknown as ScenarioAssembly;
    const program = {
      settings: loadSelfCheckSettings(),
      reportsDir: join(workDir, 'reports'),
      clock: systemClock,
      logger: {
        debug() {},
        log(message: string, fields: unknown) {
          if (message === 'scenario not run: run budget') notRun.push(fields);
        },
        warn() {},
        error() {},
      },
      cancelLeftovers: () => Promise.resolve(),
      assembleScenario: ({ scenario }: { scenario: string }) => {
        assembled.push(scenario);
        // The second assembly is the next scenario's, or the end-of-run measures': the run stops there.
        return assembled.length === 1
          ? Promise.resolve(scripted)
          : Promise.reject(new Error('stopped at the second assembly'));
      },
    } as unknown as SelfCheckProgram;

    await expect(
      executeRunCommand(
        [
          '--set',
          'smoke',
          '--runs',
          '1',
          '--budget',
          String(runTokenBudget + investigationTokens + judgeTokens - 1),
        ],
        program,
      ),
    ).rejects.toThrow('stopped at the second assembly');

    // The first scenario, then the measures' own assembly: the next scenario was never assembled.
    expect(assembled).toEqual([
      'smoke/timeout-lowered',
      'smoke/timeout-lowered',
    ]);
    expect(notRun).toEqual([
      expect.objectContaining({
        scenarioId: 'ledger-write-errors',
        spentTokens: investigationTokens + judgeTokens,
      }),
      expect.objectContaining({ scenarioId: 'no-cause' }),
    ]);
    expect(readTranscripts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ investigationId: 'run-1' }),
    );
  });
});

const HAIKU = 'anthropic/claude-haiku-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';

const V3_MODELS: Readonly<Record<string, string>> = {
  controller: HAIKU,
  planner: HAIKU,
  worker: HAIKU,
  subworker: HAIKU,
  verifier: HAIKU,
  synthesis: HAIKU,
};

const AgentsDataSchema = z.looseObject({
  agents: z.record(z.string(), z.looseObject({ model: z.string() })),
});

/** A program the refused command must not touch. */
function untouchedProgram(): SelfCheckProgram {
  const untouched = (): never => {
    throw new Error('a refused command does nothing else');
  };
  return {
    cancelLeftovers: untouched,
    assembleScenario: untouched,
  } as unknown as SelfCheckProgram;
}

// AC-18.2, design-research-flow.md (Contract «Самопроверка»), over the data of the shipped v3. Catches a swap that moves
// other agents: the paid run T6.2 reads its six models from this function before it starts.
describe('run arguments on the agents form', () => {
  it.each<[string, AgentModel[], Readonly<Record<string, string>>]>([
    [
      'one flag changes that agent only',
      [{ agent: 'worker', model: SONNET }],
      { ...V3_MODELS, worker: SONNET },
    ],
    [
      'three flags change exactly those three, the rest keep the shipped model',
      [
        { agent: 'controller', model: SONNET },
        { agent: 'planner', model: SONNET },
        { agent: 'synthesis', model: SONNET },
      ],
      {
        controller: SONNET,
        planner: SONNET,
        worker: HAIKU,
        subworker: HAIKU,
        verifier: HAIKU,
        synthesis: SONNET,
      },
    ],
    ['no flag keeps the shipped configuration', [], V3_MODELS],
  ])('%s', (_, agentModels, models) => {
    const shipped = AgentsDataSchema.parse(deepResearchProcessV3);

    const swapped = swapModels(deepResearchProcessV3, {
      agentModels,
    });

    expect(swapped).toEqual({
      ok: true,
      processConfig: {
        ...shipped,
        agents: Object.fromEntries(
          Object.entries(shipped.agents).map(([name, definition]) => [
            name,
            { ...definition, model: models[name] },
          ]),
        ),
      },
    });
  });

  // FR-19: data without agents has nothing to swap. Defect caught: a swap that writes an `agents` key into it.
  it('refuses --agent-model over data without agents with invalid_arguments', () => {
    const withoutAgents = { processId: 'deep-research', version: 3 };

    expect(
      swapModels(withoutAgents, {
        agentModels: [{ agent: 'worker', model: SONNET }],
      }),
    ).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
    });
  });

  it.each<[string, string[], boolean]>([
    ['several agents', ['worker=a/b', 'planner=c/d'], true],
    ['an agent named twice', ['worker=a/b', 'worker=c/d'], false],
    ['a flag without a model', ['worker='], false],
    ['a flag without an agent', ['=a/b'], false],
    ['a flag without =', ['worker'], false],
  ])('parses %s', (_, flags, ok) => {
    expect(parseAgentModels(flags).ok).toBe(ok);
  });

  it('keeps the order and the values of the flags', () => {
    expect(parseAgentModels(['worker=a/b', 'planner=c/d'])).toEqual({
      ok: true,
      agentModels: [
        { agent: 'worker', model: 'a/b' },
        { agent: 'planner', model: 'c/d' },
      ],
    });
  });

  it.each<[string, string[]]>([
    [
      'an agent named twice',
      ['--agent-model', 'worker=a/b', '--agent-model', 'worker=c/d'],
    ],
  ])('the command refuses %s before anything is done', async (_, flags) => {
    await expect(
      executeRunCommand(['--set', 'smoke', ...flags], untouchedProgram()),
    ).resolves.toMatchObject({ ok: false, code: 'invalid_arguments' });
  });

  it('refuses an unknown agent at its path', () => {
    const swapped = swapModels(deepResearchProcessV3, {
      agentModels: [{ agent: 'no-such-agent', model: HAIKU }],
    });
    if (!swapped.ok) throw new Error(swapped.reason);

    expect(loadRunnableConfig(swapped.processConfig)).toMatchObject({
      ok: false,
      rejection: {
        code: 'process_config_rejected',
        path: ['agents', 'no-such-agent', 'limits'],
      },
    });
  });

  // Catches a deadline read from a named agent or from the controller task instead of the configuration's root.
  it.each<[string, unknown, number]>([
    ['the root definition of the shipped v3', deepResearchProcessV3, 3_600_000],
    [
      'the root definition, whichever agent it names',
      {
        ...AgentsDataSchema.parse(deepResearchProcessV3),
        rootAgent: 'planner',
      },
      600_000,
    ],
  ])('takes the deadline of a run from %s', (_, data, deadlineMs) => {
    const loaded = loadRunnableConfig(data);
    if (!loaded.ok) throw new Error(loaded.rejection.message);

    expect(runDeadlineMs(loaded.config)).toBe(deadlineMs);
  });
});
