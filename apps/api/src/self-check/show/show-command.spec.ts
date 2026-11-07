import {
  type AssessRequest,
  deepResearchProcessV2,
  loadProcessConfig,
  type RunRecord,
} from '@agent-os/engine';
import { systemClock } from '@agent-os/runtime';
import { describe, expect, it, vi } from 'vitest';
import type { ScenarioRequest, SelfCheckProgram } from '../program.js';
import type { ScenarioAssembly } from '../scenario-assembly.js';
import { loadSelfCheckSettings } from '../settings.js';
import { executeShowCommand, type ShowProgram } from './show-command.js';

// FR-07, DC-15, DC-18 (the `show` half): `show` asks for an assembly without workers — it reads a stored investigation
// and calls `Engine.assess` once, and must never claim a task left queued by a dropped `run`. Defect caught: the show
// assembly requested with the program's worker settings (an executing dispatcher next to the judge), or a judge that
// is not called through that assembly. The assembly itself honouring `workers: false` is scenario-assembly.spec.ts.

vi.mock('../replay/replay-command.js', () => ({
  readOriginal: () =>
    Promise.resolve({ record: RECORD, threadId: 'thread-of-the-original' }),
}));

vi.mock('@agent-os/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-os/engine')>()),
  readTranscripts: () => Promise.resolve({ outcome: 'found', transcripts: [] }),
}));

const loaded = loadProcessConfig(deepResearchProcessV2);
if (!loaded.ok) throw new Error('the shipped configuration is refused');

const RECORD: RunRecord = {
  investigationId: '00000000-0000-4000-8000-000000000001',
  ownerId: 'system:self-check',
  query: 'Почему 15 сентября выросли ошибки оплаты?',
  status: 'completed',
  config: { processConfig: loaded.config, fingerprint: '0123456789ab' },
  sourceSnapshots: { fixture: 'fx-v1-2157485c' },
  answer: {
    answerId: '00000000-0000-4000-8000-000000000002',
    outcome: 'answered',
    stopReason: null,
    established: [],
    assumed: [],
    unknown: [],
    removed: [],
  },
  claims: [],
  decisions: [],
  evidence: [],
  usage: {
    byRoleAndModel: [],
    totalTokens: 0,
    totalCostUsd: 0,
    tokenBudget: 300_000,
  },
  calls: [],
};

describe('executeShowCommand: the judge assembly runs no workers', () => {
  it('requests the assembly with workers off, judges through its engine once and closes it', async () => {
    const requests: ScenarioRequest[] = [];
    const steps: string[] = [];
    const assessed: AssessRequest<unknown>[] = [];
    const scripted = {
      engine: {
        assess: (request: AssessRequest<unknown>) => {
          steps.push('assess');
          assessed.push(request);
          return Promise.resolve({
            outcome: 'answered',
            output: { answersQuestion: 'yes' },
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costUsd: 0,
            },
          });
        },
      },
      close: () => {
        steps.push('close');
        return Promise.resolve();
      },
    } as unknown as ScenarioAssembly;
    const program = {
      settings: loadSelfCheckSettings(),
      clock: systemClock,
      logger: { debug() {}, log() {}, warn() {}, error() {} },
      // The readers are doubled above: the database handle is never touched.
      selfCheckDatabase: () => ({}),
      assembleScenario: (request: ScenarioRequest) => {
        requests.push(request);
        steps.push('assembleScenario');
        return Promise.resolve(scripted);
      },
    } as unknown as SelfCheckProgram as ShowProgram;

    const outcome = await executeShowCommand(
      [
        '--investigation',
        RECORD.investigationId,
        '--owner',
        RECORD.ownerId,
        '--base',
        'self_check',
      ],
      program,
    );

    expect(outcome.ok).toBe(true);
    expect(requests).toEqual([
      {
        scenario: 'v1',
        processConfig: deepResearchProcessV2,
        workers: false,
      },
    ]);
    expect(steps).toEqual(['assembleScenario', 'assess', 'close']);
    expect(assessed[0]).toMatchObject({
      role: 'judge',
      model: program.settings.judge.model,
      binding: { selfCheckRunId: outcome.ok ? outcome.showRunId : null },
    });
  });
});
