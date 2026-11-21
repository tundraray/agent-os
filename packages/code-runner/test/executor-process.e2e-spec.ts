// code-execution / code-execution E2E Test - Design Doc: docs/features/code-execution/design-code-execution.md (Test Strategy UC-E4, UC-E5; Security Considerations; Risks "Флаги модели разрешений на Windows")
// PRD: docs/features/code-execution/prd.md v1.8 (AC-02.1, AC-02.2, AC-02.4, NFR-03, NFR-05, NFR-06)
// Test Type: End-to-End Test (the real executor process with its production flags, real OS resources)
//
// Harness: `createCodeRunner` starts the executor with the PRODUCTION flags (permission model, empty `env`, read
// access to directories without links) and a test entry from `test/support/`, run by Node from source as the executor is in tests,
// that, after the same `prepareProcess()`, runs hostile Node code (`test/support/hostile-entry.ts`) or breaks
// the protocol (`test/support/broken-entry.ts`) instead of QuickJS. The test entries need no QuickJS, so the
// host reads only `test/support/` and the executor-side modules in `src/executor/`. The test process plays "the API": its workers run with
// `--disable-sigusr1` (`vitest.config.e2e.ts`), it listens on TCP, UDP and a named pipe (a unix socket on
// Linux), and holds a sentinel `.env` outside the executor's readable directory. Run on Windows locally and on
// Ubuntu in CI: the model's behaviour differs per platform, which is the reason this test exists.
//
// The sandbox rules (what QuickJS refuses) are the unit tables of `src/executor/sandbox.spec.ts`; this file proves only
// what a unit test cannot see - the OS-level second barrier and the host's handling of a dead or lying process.
//
// Budget: E2E 2 of 2 across the part (this file is E2E-2; E2E-1 is `packages/agents/test/code-execution.e2e-spec.ts`).
//
// AC -> proving test: AC-02.1, AC-02.2, AC-02.4, NFR-05, NFR-06: group A; NFR-03, DC-13: group B

import dgram from 'node:dgram';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import inspector from 'node:inspector';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, type LogRecord, type Logger } from '@agent-os/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CodeRunner, type RequestAnswer, type RunLimits, type RunOutcome, createCodeRunner } from '../src/index';
import type { BrokenMode } from './support/broken-entry';
import type { AttemptName, ProbeOutcome, ProbeTargets } from './support/hostile-entry';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
/** The test entries; the directory holds no links. */
const CHILD_ROOT = path.join(PACKAGE_ROOT, 'test', 'support');
const HOSTILE_ENTRY = path.join(CHILD_ROOT, 'hostile-entry.ts');
const BROKEN_ENTRY = path.join(CHILD_ROOT, 'broken-entry.ts');
/** All a test entry may read: its own directory and the executor-side modules it imports. */
const READ_PATHS = [CHILD_ROOT, path.join(PACKAGE_ROOT, 'src', 'executor')];

/** NFR-03: a run ends no later than this after its time limit, whatever the executor does. */
const END_AFTER_LIMIT_MS = 5000;

/** Variables of the API process that must never reach the executor: the provider key, the database, the MCP servers' env, and a sentinel. */
const API_ENV: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: 'sk-ant-e2e2-provider-key-sentinel',
  DATABASE_URL: 'postgres://e2e2:db-password-sentinel@localhost:5432/agent_os',
  FIXTURE_SOURCE: 'mcp-env-sentinel',
  CODE_RUNNER_E2E_SENTINEL: 'e2e2-env-sentinel-value',
};
const SENTINEL_FILE_SECRET = 'SENTINEL_FILE_SECRET=e2e2-dotenv-sentinel-value';

// A test entry never sends a bridge request; one that does ends its run as a broken protocol.
const unexpectedRequest = async (): Promise<RequestAnswer> => ({ kind: 'finish', reason: 'protocol' });

/** The host's log records in memory (the package imports `@agent-os/common` only through its entry `.`). */
interface MemorySink {
  records: LogRecord[];
  write(record: LogRecord): void;
}

function recordingLogger(): { logger: Logger; sink: MemorySink } {
  const records: LogRecord[] = [];
  const sink: MemorySink = { records, write: (record) => void records.push(record) };
  return { sink, logger: createLogger({ sinks: [sink], secrets: [], minLevel: 'debug' }) };
}

/** The pids the host logged when it spawned an executor, in start order. */
function startedPids(sink: MemorySink): number[] {
  return sink.records.filter((record) => record.message === 'code executor started').map((record) => Number(record.fields.pid));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listening(server: net.Server, target: number | string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    if (typeof target === 'number') server.listen(target, '127.0.0.1', resolve);
    else server.listen(target, resolve);
  });
}

function closed(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('E2E-2: the executor process is a second barrier and cannot take the API down', () => {
  describe('group A: hostile Node code in the executor process', () => {
    const PROBE_LIMITS: RunLimits = { timeoutMs: 10_000, memoryMb: 64, resultMaxBytes: 64 * 1024 };
    const reached = { tcp: 0, udp: 0, localSocket: 0 };
    const savedEnv = new Map<string, string | undefined>();
    let tempDir: string;
    let targets: ProbeTargets;
    let tcpServer: net.Server;
    let localSocketServer: net.Server;
    let udpSocket: dgram.Socket;
    let runner: CodeRunner;
    let logger: Logger;

    beforeAll(async () => {
      for (const [name, value] of Object.entries(API_ENV)) {
        savedEnv.set(name, process.env[name]);
        process.env[name] = value;
      }
      tempDir = mkdtempSync(path.join(os.tmpdir(), 'code-runner-e2e2-'));
      const sentinelEnvPath = path.join(tempDir, '.env');
      writeFileSync(sentinelEnvPath, `${SENTINEL_FILE_SECRET}\n`);

      tcpServer = net.createServer((socket) => {
        reached.tcp += 1;
        socket.destroy();
      });
      await listening(tcpServer, 0);
      localSocketServer = net.createServer((socket) => {
        reached.localSocket += 1;
        socket.destroy();
      });
      const localSocketPath =
        process.platform === 'win32' ? `\\\\.\\pipe\\code-runner-e2e2-${process.pid}` : path.join(tempDir, 'e2e2.sock');
      await listening(localSocketServer, localSocketPath);
      udpSocket = dgram.createSocket('udp4');
      udpSocket.on('message', () => {
        reached.udp += 1;
      });
      await new Promise<void>((resolve) => udpSocket.bind(0, '127.0.0.1', resolve));

      targets = {
        sentinelEnvPath,
        apiEnvPath: path.join(REPO_ROOT, 'apps', 'api', '.env'),
        tcpPort: (tcpServer.address() as net.AddressInfo).port,
        udpPort: udpSocket.address().port,
        localSocketPath,
        apiPid: process.pid,
        writeOutsidePath: path.join(tempDir, 'written-by-executor.txt'),
        writeOwnDirPath: path.join(CHILD_ROOT, 'written-by-executor.txt'),
      };
      ({ logger } = recordingLogger());
      runner = createCodeRunner({ maxConcurrent: 4, logger, entryPath: HOSTILE_ENTRY, readPaths: READ_PATHS });
    });

    afterAll(async () => {
      for (const [name, value] of savedEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await Promise.all([closed(tcpServer), closed(localSocketServer)]);
      udpSocket.close();
      rmSync(targets.writeOwnDirPath, { force: true });
      rmSync(tempDir, { recursive: true, force: true });
    });

    /** Each attempt in its own executor start, as the production host starts it. */
    async function probe(attempt: AttemptName): Promise<ProbeOutcome> {
      const outcome = await runner.run({
        script: JSON.stringify({ attempt, targets }),
        limits: PROBE_LIMITS,
        onRequest: unexpectedRequest,
        logger,
      });
      if (outcome.status !== 'returned' || outcome.value === null) {
        throw new Error(`The hostile entry did not answer: ${JSON.stringify(outcome)}`);
      }
      return JSON.parse(outcome.value) as ProbeOutcome;
    }

    function expectNothingReached(): void {
      expect(reached).toEqual({ tcp: 0, udp: 0, localSocket: 0 });
      expect(inspector.url()).toBeUndefined();
      expect(existsSync(targets.writeOutsidePath)).toBe(false);
      expect(existsSync(targets.writeOwnDirPath)).toBe(false);
    }

    // AC-02.1, AC-02.2, AC-02.4, NFR-05, NFR-06 (UC-E4). `NOT_A_FUNCTION`: `prepareProcess()` removed the method.
    // Catches: a permission flag that does not hold on one platform or one path form - the defect that turns a
    // QuickJS escape into access to the database, the API and the employee's files.
    it.each<[AttemptName, string]>([
      ['read_sentinel_env', 'ERR_ACCESS_DENIED'],
      ['read_api_env', 'ERR_ACCESS_DENIED'],
      ['tcp', 'ERR_ACCESS_DENIED'],
      ['http', 'ERR_ACCESS_DENIED'],
      ['fetch', 'ERR_ACCESS_DENIED'],
      ['dns_lookup', 'ERR_ACCESS_DENIED'],
      ['dgram', 'ERR_ACCESS_DENIED'],
      ['local_socket', 'ERR_ACCESS_DENIED'],
      ['child_process_spawn', 'ERR_ACCESS_DENIED'],
      ['worker', 'ERR_ACCESS_DENIED'],
      ['process_dlopen', 'NOT_A_FUNCTION'],
      ['process_binding', 'NOT_A_FUNCTION'],
      ['inspector_open', 'ERR_ACCESS_DENIED'],
      ['debug_api_process', 'NOT_A_FUNCTION'],
      ['write_file_outside', 'ERR_ACCESS_DENIED'],
      ['write_file_own_dir', 'ERR_ACCESS_DENIED'],
    ])('E2E-2 group A: NFR-06 the Node-level attempt %s is refused (%s) in the production-flag executor process', async (attempt, code) => {
      expect(await probe(attempt)).toEqual({ refused: true, code });
      expectNothingReached();
    });

    // AC-02.2: the environment of the executor is empty (Linux) or the OS variables libuv adds (Windows).
    it('E2E-2 group A: AC-02.2 the executor environment holds no platform, MCP or sentinel variable', async () => {
      const outcome = await probe('print_env');

      expect(outcome.refused).toBe(false);
      const printed = outcome.refused ? '' : outcome.detail;
      const env = JSON.parse(printed) as Record<string, unknown>;
      for (const name of [...Object.keys(API_ENV), 'NODE_OPTIONS']) expect(env).not.toHaveProperty(name);
      for (const value of Object.values(API_ENV)) expect(printed).not.toContain(value);
      expect(printed).not.toContain(SENTINEL_FILE_SECRET);
      expectNothingReached();
    });
  });

  describe('group B: a broken executor process', () => {
    const BROKEN_LIMITS: RunLimits = { timeoutMs: 1000, memoryMb: 16, resultMaxBytes: 64 * 1024 };
    const ANSWERED: RunOutcome = { status: 'returned', value: '"still working"', output: '' };

    function brokenHost(maxConcurrent: number): { runner: CodeRunner; logger: Logger; sink: MemorySink } {
      const { logger, sink } = recordingLogger();
      return {
        runner: createCodeRunner({ maxConcurrent, logger, entryPath: BROKEN_ENTRY, readPaths: READ_PATHS }),
        logger,
        sink,
      };
    }

    function start(
      host: { runner: CodeRunner; logger: Logger },
      mode: BrokenMode,
      overrides: { limits?: RunLimits; signal?: AbortSignal } = {},
    ): Promise<RunOutcome> {
      return host.runner.run({
        script: mode,
        limits: overrides.limits ?? BROKEN_LIMITS,
        onRequest: unexpectedRequest,
        signal: overrides.signal,
        logger: host.logger,
      });
    }

    // NFR-03, UC-E5, Invariant 6. Catches: a run that never ends because the process hangs or lies, an orphan
    // executor process, or an oversized or malformed frame taking the host down.
    it.each<[BrokenMode, string]>([
      ['hang', 'timeout'],
      ['crash', 'crashed'],
      ['oversized_frame', 'protocol'],
      ['unknown_operation', 'protocol'],
    ])('E2E-2 group B: NFR-03 a %s executor ends the run with %s within 5 s of the limit, leaves no process, and the host runs the next start', async (mode, reason) => {
      const host = brokenHost(1);
      const startedAt = Date.now();

      const outcome = await start(host, mode);

      expect(outcome).toMatchObject({ status: 'failed', reason });
      expect(Date.now() - startedAt).toBeLessThanOrEqual(BROKEN_LIMITS.timeoutMs + END_AFTER_LIMIT_MS);
      const [pid] = startedPids(host.sink);
      expect(pid).toBeGreaterThan(0);
      expect(isAlive(pid)).toBe(false);
      expect(await start(host, 'answer')).toEqual(ANSWERED);
    });

    // DC-13: no free slot under the process-wide limit -> `busy` at once, no executor spawned.
    // Catches: a start over the limit that spawns a process anyway or waits for a slot.
    it('E2E-2 group B: DC-13 a start with no free slot ends with busy at once and spawns no executor', async () => {
      const host = brokenHost(1);
      const abort = new AbortController();
      const hanging = start(host, 'hang', { limits: { ...BROKEN_LIMITS, timeoutMs: 30_000 }, signal: abort.signal });

      const refused = await start(host, 'answer');

      expect(refused).toMatchObject({ status: 'failed', reason: 'busy' });
      expect(startedPids(host.sink)).toHaveLength(1);
      abort.abort();
      expect(await hanging).toMatchObject({ status: 'failed', reason: 'aborted' });
      const [pid] = startedPids(host.sink);
      expect(isAlive(pid)).toBe(false);
      expect(await start(host, 'answer')).toEqual(ANSWERED);
    });
  });
});
