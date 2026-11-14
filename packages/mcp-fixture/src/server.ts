import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { CallLog } from './call-log.js';
import { createLogDataset } from './dataset.js';
import { FaultSchedule } from './fault-schedule.js';
import { FaultTransport } from './fault-transport.js';
import { FixtureServer, FixtureSourceSchema } from './fixture-server.js';
import { DatasetVersionSchema } from './versions.js';

/**
 * Process entry: serves the dataset named by `FIXTURE_DATASET` (default `v1`) over stdio, and exits when stdin
 * closes, so a client that dies leaves no orphan process.
 * `FIXTURE_SOURCE` picks what is served: `logs` (default) or `backoffice`, the orders of the same dataset.
 * With `FIXTURE_CALL_LOG` every `tools/call` is logged and `FIXTURE_FAULTS` rules apply; rules without a log are a
 * startup error. Under `NODE_ENV=production` the rules file is never read.
 */
const source = FixtureSourceSchema.default('logs').parse(nonEmpty(process.env.FIXTURE_SOURCE));
const dataset = createLogDataset(DatasetVersionSchema.default('v1').parse(nonEmpty(process.env.FIXTURE_DATASET)));
const exit = (): never => process.exit(0);

const callLogPath = nonEmpty(process.env.FIXTURE_CALL_LOG);
const faultsPath = process.env.NODE_ENV === 'production' ? undefined : nonEmpty(process.env.FIXTURE_FAULTS);
if (faultsPath !== undefined && callLogPath === undefined) {
  throw new Error('FIXTURE_FAULTS requires FIXTURE_CALL_LOG: fault occurrences are counted by the call log');
}

if (callLogPath === undefined) {
  await new FixtureServer(dataset, source).connect(new StdioServerTransport(), exit);
} else {
  const transport = new FaultTransport({
    schedule: faultsPath === undefined ? FaultSchedule.empty() : FaultSchedule.fromFile(faultsPath),
    log: new CallLog(callLogPath),
  });
  await new FixtureServer(dataset, source, (requestId) => transport.takeResultFault(requestId)).connect(
    transport,
    exit,
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
