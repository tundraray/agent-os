// A hostile executor entry for E2E-2 group A (UC-E4): the same preparation as `executor-main.ts`, then, in
// place of QuickJS, Node code that tries one way out of the process. The attempt and its targets come in
// the `script` of the `start` frame as JSON; the entry answers one `done` frame whose value is a
// `ProbeOutcome` as JSON. Run under the production flags, so it imports only `node:` built-ins and the
// executor-side modules of the package.
import dgram from 'node:dgram';
import dns from 'node:dns';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { prepareProcess } from '#executor/prepare-process';
import { createFrameDecoder, encodeFrame } from '#executor/protocol';

prepareProcess();

export type AttemptName =
  | 'read_sentinel_env'
  | 'read_api_env'
  | 'tcp'
  | 'http'
  | 'fetch'
  | 'dns_lookup'
  | 'dgram'
  | 'local_socket'
  | 'child_process_spawn'
  | 'worker'
  | 'process_dlopen'
  | 'process_binding'
  | 'inspector_open'
  | 'debug_api_process'
  | 'write_file_outside'
  | 'write_file_own_dir'
  | 'print_env';

/** What the hostile code aims at; the test holds every one of them. */
export interface ProbeTargets {
  sentinelEnvPath: string;
  apiEnvPath: string;
  tcpPort: number;
  udpPort: number;
  /** A named pipe on Windows, a unix socket on Linux. */
  localSocketPath: string;
  apiPid: number;
  writeOutsidePath: string;
  writeOwnDirPath: string;
}

export interface HostileProbe {
  attempt: AttemptName;
  targets: ProbeTargets;
}

/**
 * `refused` with the error code when the attempt failed; `allowed` with what it reached otherwise.
 * `NOT_A_FUNCTION` is the code of a `process` method that preparation removed.
 */
export type ProbeOutcome =
  { refused: true; code: string } | { refused: false; detail: string };

const NOT_A_FUNCTION = 'NOT_A_FUNCTION';

const refused = (error: unknown): ProbeOutcome => ({
  refused: true,
  code: codeOf(error),
});
const allowed = (detail: string): ProbeOutcome => ({ refused: false, detail });

/** The Node error code, or the code of its cause (`fetch` wraps the refusal in `TypeError: fetch failed`). */
function codeOf(error: unknown): string {
  const own = Reflect.get(Object(error), 'code');
  if (typeof own === 'string') return own;
  const cause = Reflect.get(Object(error), 'cause');
  const causeCode =
    cause === undefined ? undefined : Reflect.get(Object(cause), 'code');
  return typeof causeCode === 'string' ? causeCode : String(error);
}

/** Runs an attempt that may throw at once or fail later; either way the refusal is caught. */
async function attempt(
  run: () => Promise<string> | string,
): Promise<ProbeOutcome> {
  try {
    return allowed(await run());
  } catch (error) {
    return refused(error);
  }
}

function connect(options: net.NetConnectOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(options);
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
  });
}

function httpGet(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/' },
      (response) => {
        response.resume();
        resolve(`status ${response.statusCode}`);
      },
    );
    request.once('error', reject);
  });
}

function sendDatagram(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', reject);
    socket.send('hostile', port, '127.0.0.1', (error) => {
      socket.close();
      if (error) reject(error);
      else resolve('sent');
    });
  });
}

function spawnChild(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => resolve(`spawned pid ${child.pid}`));
  });
}

function startWorker(): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker('0', { eval: true });
    worker.once('error', reject);
    worker.once('online', () => {
      void worker.terminate();
      resolve('worker online');
    });
  });
}

/** Calls a `process` method by name, as code that got hold of `process` would. */
function callProcessMethod(name: string, ...args: unknown[]): string {
  const method: unknown = Reflect.get(process, name);
  if (typeof method !== 'function')
    throw Object.assign(new Error(`process.${name} is gone`), {
      code: NOT_A_FUNCTION,
    });
  return String(Reflect.apply(method, process, args));
}

async function openInspector(): Promise<string> {
  const inspector = await import('node:inspector');
  inspector.open(0);
  return `inspector at ${inspector.url()}`;
}

const ATTEMPTS: Record<
  Exclude<AttemptName, 'print_env'>,
  (targets: ProbeTargets) => Promise<string> | string
> = {
  read_sentinel_env: (targets) => readFileSync(targets.sentinelEnvPath, 'utf8'),
  read_api_env: (targets) => readFileSync(targets.apiEnvPath, 'utf8'),
  tcp: (targets) => connect({ host: '127.0.0.1', port: targets.tcpPort }),
  http: (targets) => httpGet(targets.tcpPort),
  fetch: async (targets) =>
    `status ${(await fetch(`http://127.0.0.1:${targets.tcpPort}/`)).status}`,
  dns_lookup: async () =>
    JSON.stringify(await dns.promises.lookup('localhost')),
  dgram: (targets) => sendDatagram(targets.udpPort),
  local_socket: (targets) => connect({ path: targets.localSocketPath }),
  child_process_spawn: () => spawnChild(),
  worker: () => startWorker(),
  process_dlopen: () =>
    callProcessMethod('dlopen', { exports: {} }, 'hostile.node'),
  process_binding: () => callProcessMethod('binding', 'fs'),
  inspector_open: () => openInspector(),
  debug_api_process: (targets) =>
    callProcessMethod('_debugProcess', targets.apiPid),
  write_file_outside: (targets) => {
    writeFileSync(targets.writeOutsidePath, 'hostile');
    return 'written';
  },
  write_file_own_dir: (targets) => {
    writeFileSync(targets.writeOwnDirPath, 'hostile');
    return 'written';
  },
};

async function probe({
  attempt: name,
  targets,
}: HostileProbe): Promise<ProbeOutcome> {
  // Not a refusal to prove: the environment is what the host gave the process, and the test reads it whole.
  if (name === 'print_env') return allowed(JSON.stringify(process.env));
  return attempt(() => ATTEMPTS[name](targets));
}

const decoder = createFrameDecoder({
  frameMaxBytes: Number.MAX_SAFE_INTEGER,
  totalMaxBytes: Number.MAX_SAFE_INTEGER,
});
let started = false;

process.stdin.on('data', (chunk: Buffer) => {
  for (const frame of decoder.push(chunk).frames) {
    const message: unknown = frame;
    if (started || Reflect.get(Object(message), 'op') !== 'start') continue;
    started = true;
    const script: unknown = Reflect.get(Object(message), 'script');
    if (typeof script !== 'string')
      throw new Error('The start frame of the hostile entry carries no script');
    void probe(JSON.parse(script) as HostileProbe).then((outcome) =>
      process.stdout.write(
        encodeFrame({ op: 'done', value: JSON.stringify(outcome) }),
        () => process.exit(0),
      ),
    );
  }
});
