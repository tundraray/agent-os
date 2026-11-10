import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AssessAgentRequest,
  deepResearchProcessV3,
} from '@agent-os/engine';
import { systemClock } from '@agent-os/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SelfCheckProgram } from '../program.js';
import type { ScenarioAssembly } from '../scenario-assembly.js';
import { loadSelfCheckSettings } from '../settings.js';
import { executeCalibrateCommand } from './calibrate-command.js';

// Contract «Программа самопроверки — команда `calibrate`», Flow 5: the refusals that need no model come before any
// assembly and any call. Defect caught: a calibration that starts without a set, or accepts five groups.

describe('executeCalibrateCommand: refusals before the first call', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'calibrate-command-spec-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it.each<[string, () => Promise<string[]>, string]>([
    ['no --set', () => Promise.resolve(['--out', 'table.json']), 'set_invalid'],
    [
      '--groups 5',
      () =>
        Promise.resolve([
          '--set',
          'smoke',
          '--groups',
          '5',
          '--out',
          'table.json',
        ]),
      'invalid_arguments',
    ],
  ])('%s', async (_, args, code) => {
    const assembled: unknown[] = [];
    const program = {
      settings: loadSelfCheckSettings(),
      clock: systemClock,
      logger: { debug() {}, log() {}, warn() {}, error() {} },
      assembleScenario: (request: unknown) => {
        assembled.push(request);
        return Promise.resolve({
          engine: {
            assess: () => Promise.reject(new Error('no call is expected')),
          },
          close: () => Promise.resolve(),
        } as unknown as ScenarioAssembly);
      },
    } as unknown as SelfCheckProgram;

    const outcome = await executeCalibrateCommand(await args(), program);

    expect(outcome).toMatchObject({ ok: false, code });
    expect(assembled).toEqual([]);
  });

  // AC-16.2, Flow 4: the agents form is taken from `--config`. Defects caught: an agents-form file refused by the roles
  // schema; `user` records reaching the turns; a configuration with no checker agent calibrated anyway.
  describe('with an agents-form configuration', () => {
    const V3 = deepResearchProcessV3 as {
      agents: Record<string, Record<string, unknown>>;
    };

    function agentsProgram() {
      const requests: AssessAgentRequest[] = [];
      const closed: boolean[] = [];
      const program = {
        settings: loadSelfCheckSettings(),
        clock: systemClock,
        logger: { debug() {}, log() {}, warn() {}, error() {} },
        assembleScenario: () =>
          Promise.resolve({
            engine: {
              listDefinitionMemory: () =>
                Promise.resolve([
                  { id: 'kept', scope: 'deployment', text: 'a rule' },
                  { id: 'dropped', scope: 'user', text: 'a note' },
                ]),
              assessAgent: (request: AssessAgentRequest) => {
                requests.push(request);
                return Promise.resolve({
                  outcome: 'finished',
                  result: {
                    assessment: {
                      support: 'yes',
                      claimType: 'observation',
                      records: [{ record: 0, relation: 'supports' }],
                    },
                  },
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
              closed.push(true);
              return Promise.resolve();
            },
          } as unknown as ScenarioAssembly),
      } as unknown as SelfCheckProgram;
      return { program, requests, closed };
    }

    async function configFile(config: unknown): Promise<string> {
      const path = join(workDir, 'agents.json');
      await writeFile(path, JSON.stringify(config), 'utf8');
      return path;
    }

    it('accepts it, gives the turns the deployment entries only and writes the v3 table', async () => {
      const { program, requests, closed } = agentsProgram();
      const out = join(workDir, 'table.json');

      const outcome = await executeCalibrateCommand(
        ['--set', 'smoke', '--config', await configFile(V3), '--out', out],
        program,
      );

      expect(outcome).toMatchObject({ ok: true, outPath: out });
      expect(requests[0]).toMatchObject({
        agentName: 'verifier',
        deploymentEntries: [{ id: 'kept', text: 'a rule' }],
      });
      expect(requests[0]!.deploymentEntries).toHaveLength(1);
      const table = JSON.parse(await readFile(out, 'utf8')) as Record<
        string,
        unknown
      >;
      expect(table).toMatchObject({
        model: 'anthropic/claude-haiku-5-5',
        agentFingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
        definitionMemoryFingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
      });
      expect(closed).toEqual([true]);
    });

    it('refuses with invalid_arguments when no definition has the form claim_assessment', async () => {
      const { program, requests, closed } = agentsProgram();
      const without = {
        ...V3,
        agents: {
          ...V3.agents,
          verifier: { ...V3.agents.verifier, result: 'text' },
        },
      };

      const outcome = await executeCalibrateCommand(
        [
          '--set',
          'smoke',
          '--config',
          await configFile(without),
          '--out',
          join(workDir, 'table.json'),
        ],
        program,
      );

      expect(outcome).toMatchObject({ ok: false, code: 'invalid_arguments' });
      expect(requests).toEqual([]);
      expect(closed).toEqual([true]);
    });
  });
});
