import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { CallLog } from './call-log.js';
import { createLogDataset, type LogDataset } from './dataset.js';
import { FaultSchedule } from './fault-schedule.js';
import { FaultTransport } from './fault-transport.js';
import { FixtureServer } from './fixture-server.js';
import { createScenarioDataset } from './scenarios/scenario-dataset.js';
import { loadScenarioSet } from './scenarios/scenario-sets.js';
import { DatasetVersionSchema } from './versions.js';

/**
 * Process entry: serves the scenario named by `FIXTURE_SCENARIO` (`<set>/<scenario>`) or, when it is empty, the
 * dataset named by `FIXTURE_DATASET` (default `v1`) over stdio, and exits when stdin closes, so a client that dies
 * leaves no orphan process. A scenario value that names no scenario is a startup error with its reason.
 * With `FIXTURE_CALL_LOG` every `tools/call` is logged and `FIXTURE_FAULTS` rules apply; rules without a log are a
 * startup error. Under `NODE_ENV=production` the rules file is never read.
 */
const scenarioName = nonEmpty(process.env.FIXTURE_SCENARIO);
const dataset =
  scenarioName === undefined
    ? createLogDataset(DatasetVersionSchema.default('v1').parse(process.env.FIXTURE_DATASET))
    : scenarioDataset(scenarioName);
const exit = (): never => process.exit(0);

const callLogPath = nonEmpty(process.env.FIXTURE_CALL_LOG);
const faultsPath = process.env.NODE_ENV === 'production' ? undefined : nonEmpty(process.env.FIXTURE_FAULTS);
if (faultsPath !== undefined && callLogPath === undefined) {
  throw new Error('FIXTURE_FAULTS requires FIXTURE_CALL_LOG: fault occurrences are counted by the call log');
}

if (callLogPath === undefined) {
  await new FixtureServer(dataset).connect(new StdioServerTransport(), exit);
} else {
  const transport = new FaultTransport({
    schedule: faultsPath === undefined ? FaultSchedule.empty() : FaultSchedule.fromFile(faultsPath),
    log: new CallLog(callLogPath),
  });
  await new FixtureServer(dataset, (requestId) => transport.takeResultFault(requestId)).connect(transport, exit);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** The dataset of `<set>/<scenario>`; throws with the reason when the value names no scenario. */
function scenarioDataset(value: string): LogDataset {
  const [setName, scenarioId, ...extra] = value.split('/');
  if (scenarioId === undefined || extra.length > 0) {
    throw new Error(`FIXTURE_SCENARIO ${JSON.stringify(value)} is not <set>/<scenario>`);
  }
  const loaded = loadScenarioSet(setName);
  if (!loaded.ok) {
    throw new Error(`FIXTURE_SCENARIO ${JSON.stringify(value)}: ${loaded.reason}: ${loaded.detail}`);
  }
  const scenario = loaded.set.scenarios.find((candidate) => candidate.scenarioId === scenarioId);
  if (scenario === undefined) {
    throw new Error(`FIXTURE_SCENARIO ${JSON.stringify(value)}: set ${setName} has no scenario ${scenarioId}`);
  }
  return createScenarioDataset(scenario);
}
