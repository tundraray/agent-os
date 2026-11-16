import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createLogDataset } from './dataset.js';
import { createFixtureHttpServer } from './http/http-server.js';
import { DatasetVersionSchema } from './versions.js';

/**
 * HTTP process entry: `node dist/main.js --port <n>` (default 4100, `0` picks a free port) serves the three
 * sources, the fixture's authorization server and the test controls on `127.0.0.1`, and prints one line
 * `fixture listening <port>` once it listens. `FIXTURE_DATASET` (default `v1`), `FIXTURE_CALL_LOG` and
 * `FIXTURE_FAULTS` mean what they mean for the stdio entry; these are variables of the fixture process, not
 * an API. Under `NODE_ENV=production` the rules file is never read and `/_control/*` answers 404.
 */
const DEFAULT_PORT = 4100;
const HOST = '127.0.0.1';

const { values } = parseArgs({ options: { port: { type: 'string', default: String(DEFAULT_PORT) } } });
const port = z.coerce.number().int().min(0).max(65_535).parse(values.port);
const production = process.env.NODE_ENV === 'production';
const callLogPath = nonEmpty(process.env.FIXTURE_CALL_LOG);
const faultsPath = production ? undefined : nonEmpty(process.env.FIXTURE_FAULTS);
if (faultsPath !== undefined && callLogPath === undefined) {
  throw new Error('FIXTURE_FAULTS requires FIXTURE_CALL_LOG: fault occurrences are counted by the call log');
}

const server = createFixtureHttpServer({
  dataset: createLogDataset(DatasetVersionSchema.default('v1').parse(nonEmpty(process.env.FIXTURE_DATASET))),
  callLogPath,
  faultsPath,
  controlsEnabled: !production,
});
server.listen(port, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  process.stdout.write(`fixture listening ${actualPort}\n`);
});

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
