import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FixtureSource } from './fixture-server';
import type { AccountStats, RevokeWhich } from './http/authorization-server';
import type { FixtureFiles } from './test-support';

/** The HTTP process entry next to this module. */
const fixtureMainPath: string = fileURLToPath(
  new URL('./main.ts', import.meta.url),
);
const LISTENING_LINE = /^fixture listening (\d+)$/m;
const START_TIMEOUT_MS = 10_000;

/** The test controls of a fixture process (`/_control/*`). */
export interface FixtureControl {
  /** Lifetime of access tokens issued from now on. */
  tokenLifetime(seconds: number): Promise<void>;
  revoke(input: { account: string; which: RevokeWhich }): Promise<void>;
  /** The shared token of `source` stops working (401). */
  revokeShared(source: FixtureSource): Promise<void>;
  /** A reading tool without arguments appears in the source's `tools/list`. */
  addTool(input: { source: FixtureSource; name: string }): Promise<void>;
  /** Refreshes, code exchanges and `authorize` requests of `account` so far. */
  stats(account: string): Promise<AccountStats>;
  /** Every refresh of `account` waits until the file at `path` exists; without `path` the hold is lifted. */
  holdRefresh(input: { account: string; path?: string }): Promise<void>;
}

/** A running fixture process over HTTP. */
export interface FixtureProcess {
  /** `http://127.0.0.1:<port>`, also the issuer of its authorization server. */
  readonly baseUrl: string;
  /** The source's path guarded by `FIXTURE_SHARED_TOKEN`. */
  sharedUrl(source: FixtureSource): string;
  /** The source's path guarded by tokens of the fixture's authorization server. */
  oauthUrl(source: FixtureSource): string;
  readonly control: FixtureControl;
  stop(): Promise<void>;
}

/**
 * Starts `node --import tsx src/main.ts --port 0` logging into the test's call log under its fault rules, and
 * resolves once it listens. Throws when the process does not start.
 */
export async function startFixtureProcess(
  files: FixtureFiles,
): Promise<FixtureProcess> {
  // Node runs the TypeScript source through the `tsx` loader, a dependency of this package.
  const child = spawn(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), fixtureMainPath, '--port', '0'],
    {
      env: {
        ...process.env,
        FIXTURE_CALL_LOG: files.callLog,
        FIXTURE_FAULTS: files.faults,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const port = await listeningPort(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    sharedUrl: (source) => `${baseUrl}/${source}/mcp`,
    oauthUrl: (source) => `${baseUrl}/${source}/oauth/mcp`,
    control: fixtureControl(baseUrl),
    stop: () => stopProcess(child),
  };
}

function listeningPort(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const fail = (reason: string) => {
      clearTimeout(timer);
      child.kill();
      reject(
        new Error(
          `MCP fixture process did not start: ${reason}${stderr ? `\n${stderr}` : ''}`,
        ),
      );
    };
    const timer = setTimeout(
      () => fail(`no listening line within ${START_TIMEOUT_MS} ms`),
      START_TIMEOUT_MS,
    );
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const match = LISTENING_LINE.exec(stdout);
      if (match !== null) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('error', (error) => fail(error.message));
    child.once('exit', (code) => fail(`exited with code ${code}`));
  });
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
  });
}

function fixtureControl(baseUrl: string): FixtureControl {
  const post = async (name: string, body: unknown): Promise<void> => {
    const response = await fetch(`${baseUrl}/_control/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `fixture control ${name} failed: ${response.status} ${await response.text()}`,
      );
    }
  };
  return {
    tokenLifetime: (seconds) => post('token-lifetime', { seconds }),
    revoke: (input) => post('revoke', input),
    revokeShared: (source) => post('revoke-shared', { source }),
    addTool: (input) => post('add-tool', input),
    holdRefresh: (input) => post('hold-refresh', input),
    stats: async (account) => {
      const response = await fetch(
        `${baseUrl}/_control/stats?account=${encodeURIComponent(account)}`,
      );
      if (!response.ok) {
        throw new Error(
          `fixture control stats failed: ${response.status} ${await response.text()}`,
        );
      }
      return (await response.json()) as AccountStats;
    },
  };
}
