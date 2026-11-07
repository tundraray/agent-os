import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepResearchProcessV2 } from '@agent-os/engine';
import { systemClock } from '@agent-os/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SelfCheckProgram } from '../program.js';
import type { ScenarioAssembly } from '../scenario-assembly.js';
import { loadSelfCheckSettings } from '../settings.js';
import { executeCalibrateCommand } from './calibrate-command.js';

// Contract «Программа самопроверки — команда `calibrate`», Flow 5: the refusals that need no model come before any
// assembly and any call — a verifier prompt with a template field above all, since its call would send other
// instructions than the role's rendered prompt and bind the table to the wrong prompt version. Defect caught: a
// calibration that starts calling the model with a templated prompt, or accepts five groups.

describe('executeCalibrateCommand: refusals before the first call', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'calibrate-command-spec-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  /** A configuration file whose verifier prompt names the `query` field. */
  async function templatedConfig(): Promise<string> {
    const shipped = deepResearchProcessV2 as {
      roles: { verifier: { prompt: string } };
    };
    const config = {
      ...shipped,
      roles: {
        ...shipped.roles,
        verifier: {
          ...shipped.roles.verifier,
          prompt: `${shipped.roles.verifier.prompt}\nThe question was {{query}}.`,
        },
      },
    };
    const path = join(workDir, 'templated.json');
    await writeFile(path, JSON.stringify(config), 'utf8');
    return path;
  }

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
    [
      'a verifier prompt with a template field',
      async () => [
        '--set',
        'smoke',
        '--config',
        await templatedConfig(),
        '--out',
        join(workDir, 'table.json'),
      ],
      'calibration_prompt_has_fields',
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
});
