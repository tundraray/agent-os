import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemClock } from '@agent-os/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SelfCheckProgram } from '../program.js';
import type { ScenarioAssembly } from '../scenario-assembly.js';
import { loadSelfCheckSettings } from '../settings.js';
import { executeRunCommand, THRESHOLDS_COPY_FILE_NAME } from './run-command.js';

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
