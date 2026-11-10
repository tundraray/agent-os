import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { ResolveModel } from '@agent-os/engine';
import { loadScenarioSet } from '@agent-os/mcp-fixture';
import { systemClock } from '@agent-os/runtime';
import { runCli } from '../../src/self-check/cli.js';
import {
  CALIBRATION_ERRS_ON_VARIABLE,
  REPORTS_DIR_VARIABLE,
} from './selfCheckChild.js';
import {
  createSelfCheckModels,
  type ScenarioBehaviour,
  type SelfCheckModels,
} from './selfCheckModels.js';

/**
 * Entry of the self-check child process (E2E-1), run only compiled (`pnpm --filter api build:child` →
 * `dist/test-child/`); `dist/self-check/main.js` and `src/` never import it. It runs the same `runCli` as `main.ts`
 * with the same arguments and environment; only the model boundary differs: `resolveModel` and the token counter of
 * `selfCheckModels.ts`, without network. The reports directory comes from `SELF_CHECK_REPORTS_DIR`.
 *
 * The scripted roles answer from the key of the scenario the program is assembling. The child cannot observe the
 * assembly itself, so it follows it through the model boundary: every scenario assembly builds its engine, which
 * resolves its models through `resolveModel` at creation (design-engine.md, `resolveModel`), and the program assembles
 * the scenarios of the set one after another in set order (`run`). A `resolveModel` call after a model call therefore
 * opens the next assembly; the assembly after the last scenario is the judge checks', which answer by claim ids.
 *
 * Under `calibrate` the verifier answers the calibration pairs of the set by their key, erring on the pair kinds named in
 * `SELF_CHECK_CALIBRATION_ERRS_ON` (comma-separated; empty — no error), so two calibrations of one test give two
 * different tables. An agents-form file given with `--config` — the same file the server of the row loads — has its
 * definitions told to the double, so its edited checker agent is recognised.
 */

/**
 * The script of a cause scenario under the shipped configuration: the change is stated as established on records of
 * the quarter hour before the change, so the run is answered but not grounded.
 */
const UNGROUNDED_CAUSE: ScenarioBehaviour = {
  reads: 'before_change',
  statements: [
    { statement: 'change', section: 'established' },
    { statement: 'link', section: 'assumed' },
  ],
};

/** The pair kinds the calibration verifier errs on, from the mode variable only this child reads. */
function calibrationErrsOn(): string[] {
  return (process.env[CALIBRATION_ERRS_ON_VARIABLE] ?? '')
    .split(',')
    .filter((kind) => kind !== '');
}

/**
 * The scenarios of the command's set in set order (empty for a command without `--set` or with an unknown set, which
 * the program refuses itself), with every cause scenario scripted as {@link UNGROUNDED_CAUSE}.
 */
function scriptScenarios(
  models: SelfCheckModels,
  argv: readonly string[],
): string[] {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      set: { type: 'string' },
      config: { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
  });
  if (typeof values.set !== 'string') return [];
  const loaded = loadScenarioSet(values.set);
  if (!loaded.ok) return [];
  models.useSet(values.set);
  if (argv[0] === 'calibrate') {
    models.calibrating(values.set, calibrationErrsOn());
    recognizeConfigFile(models, values.config);
  }
  const scenarios = loaded.set.scenarios.map(
    (scenario) => `${scenario.setName}/${scenario.scenarioId}`,
  );
  for (const scenario of scenarios) {
    if (models.keyOf(scenario).kind === 'cause') {
      models.behave(scenario, UNGROUNDED_CAUSE);
    }
  }
  return scenarios;
}

/** Tells the double the definitions of an agents-form `--config` file; anything else is the program's to refuse. */
function recognizeConfigFile(models: SelfCheckModels, file: unknown): void {
  if (typeof file !== 'string') return;
  const config = JSON.parse(readFileSync(file, 'utf8')) as { agents?: unknown };
  if (config.agents !== undefined) models.recognizeConfig(config);
}

/** `resolveModel` of the double that tells it which scenario each assembly is for (see the file comment). */
function followAssemblies(
  models: SelfCheckModels,
  scenarios: readonly string[],
): ResolveModel {
  let assembly = -1;
  let callsAtAssembly = -1;
  return (modelId) => {
    if (models.calls.length !== callsAtAssembly) {
      assembly += 1;
      callsAtAssembly = models.calls.length;
      const scenario = scenarios[assembly];
      if (scenario !== undefined) models.assembling(scenario);
    }
    return models.resolveModel(modelId);
  };
}

async function main(): Promise<number> {
  const reportsDir = process.env[REPORTS_DIR_VARIABLE];
  if (reportsDir === undefined || reportsDir === '') {
    throw new Error(
      `The self-check child needs its reports directory: set ${REPORTS_DIR_VARIABLE}`,
    );
  }
  const argv = process.argv.slice(2);
  const models = createSelfCheckModels();
  const scenarios = scriptScenarios(models, argv);
  return runCli({
    argv,
    env: process.env,
    reportsDir,
    clock: systemClock,
    resolveModel: followAssemblies(models, scenarios),
    tokenCounter: models.tokenCounter,
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
