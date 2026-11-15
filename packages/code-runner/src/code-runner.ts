import { type ChildProcess, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@agent-os/common';
import {
  CALL_ARGS_MAX_BYTES,
  type ExecutorMessage,
  type FailReason,
  type HostMessage,
  type ProtocolViolation,
  RUN_ARGS_MAX_BYTES,
  RUN_DATA_MAX_BYTES,
  RUN_FRAMES_MAX_BYTES,
  type RunLimits,
  type ScriptError,
  createFrameDecoder,
  createOutputLimit,
  encodeFrame,
  frameMaxBytes,
  parseExecutorMessage,
} from './protocol.js';

/** The API process kills the executor this long after the run's time limit (Runtime settings). */
const KILL_AFTER_LIMIT_MS = 1000;
/** V8 heap of the executor; QuickJS memory is a WASM ArrayBuffer, not V8 heap (spike). */
const EXECUTOR_MAX_OLD_SPACE_MB = 64;
const STDERR_TAIL_BYTES = 16 * 1024;
const QUICKJS_CORE = 'quickjs-emscripten-core';
const QUICKJS_VARIANT = '@jitl/quickjs-wasmfile-release-sync';
const QUICKJS_FFI_TYPES = '@jitl/quickjs-ffi-types';

/** A failed run's `text` is the script's own message (`syntax`, `exception`), `null` otherwise; the caller words the reason. */
export type RunOutcome =
  | { status: 'returned'; value: string | null; output: string }
  | { status: 'failed'; reason: FailReason; text: string | null; line: number | null; output: string };

/** A request of the script, as the executor sent it; nothing in it is trusted. */
export type BridgeRequest =
  | { op: 'call'; id: number; name: string; args: unknown }
  | { op: 'read'; id: number; resultId: string };

/** How the caller answers a request: a value or an error for the script, or "end the run with this failure". */
export type RequestAnswer =
  | { kind: 'value'; value: unknown }
  | { kind: 'error'; error: ScriptError }
  | { kind: 'finish'; reason: FailReason };

export interface RunRequest {
  script: string;
  limits: RunLimits;
  /** Called strictly one request at a time; `signal` aborts when the run ends first. */
  onRequest(request: BridgeRequest, signal: AbortSignal): Promise<RequestAnswer>;
  signal?: AbortSignal;
  /** Bound to the run's identifiers. */
  logger: Logger;
}

export interface CodeRunner {
  /** Runs one script in a new executor process. Never throws: every end is a `RunOutcome`. */
  run(request: RunRequest): Promise<RunOutcome>;
}

export interface CodeRunnerOptions {
  maxConcurrent: number;
  logger: Logger;
  /** The executor entry; tests pass a hostile entry run with the same flags (KD-1). */
  entryPath?: string;
  /** Directories the executor may read; each must hold no links leading out (spike). */
  readPaths?: string[];
}

interface QuickJsPaths {
  coreRoot: string;
  variantRoot: string;
  storeEntries: string[];
}

/** The first Node major whose permission model also denies network (ADR-0011); below it TCP and DNS stay open. */
const NETWORK_BARRIER_NODE_MAJOR = 26;

/** Throws unless `nodeVersion` (`process.versions.node`) keeps the executor's network barrier. */
function assertNetworkBarrier(nodeVersion: string): void {
  const major = Number(nodeVersion.split('.')[0]);
  if (major >= NETWORK_BARRIER_NODE_MAJOR) return;
  throw new Error(
    `Node ${nodeVersion} cannot run the code executor: its permission model leaves network open; Node ${NETWORK_BARRIER_NODE_MAJOR} or later is required`,
  );
}

export function createCodeRunner(options: CodeRunnerOptions): CodeRunner {
  assertNetworkBarrier(process.versions.node);
  const entryPath = options.entryPath ?? fileURLToPath(new URL('./executor-main.js', import.meta.url));
  const quickJs = resolveQuickJs();
  const readPaths = options.readPaths ?? [path.dirname(entryPath), ...quickJs.storeEntries];
  const args = [
    '--permission',
    ...readPaths.map((readPath) => `--allow-fs-read=${readPath}`),
    `--max-old-space-size=${EXECUTOR_MAX_OLD_SPACE_MB}`,
    entryPath,
    quickJs.coreRoot,
    quickJs.variantRoot,
  ];
  let active = 0;
  options.logger.info('code runner created', { entryPath, readPaths, maxConcurrent: options.maxConcurrent });

  return {
    async run(request) {
      if (active >= options.maxConcurrent) {
        request.logger.warn('code run refused: no free executor slot', {
          active,
          maxConcurrent: options.maxConcurrent,
        });
        return failed('busy');
      }
      if (request.signal?.aborted) return failed('aborted');
      active += 1;
      try {
        return await runInProcess(args, request);
      } finally {
        active -= 1;
      }
    },
  };
}

/** The QuickJS package roots and their pnpm store entries, by real path (spike, "Флаги spawn"). */
function resolveQuickJs(): QuickJsPaths {
  const coreRoot = packageRoot(QUICKJS_CORE, realpathSync(fileURLToPath(import.meta.resolve(QUICKJS_CORE))));
  const variantRoot = packageRoot(QUICKJS_VARIANT, realpathSync(fileURLToPath(import.meta.resolve(QUICKJS_VARIANT))));
  const ffiTypesRoot = realpathSync(path.join(coreRoot, '..', QUICKJS_FFI_TYPES));
  return {
    coreRoot,
    variantRoot,
    storeEntries: [
      storeEntry(coreRoot, QUICKJS_CORE),
      storeEntry(variantRoot, QUICKJS_VARIANT),
      storeEntry(ffiTypesRoot, QUICKJS_FFI_TYPES),
    ],
  };
}

function packageRoot(name: string, realFile: string): string {
  const marker = path.join('node_modules', name);
  const at = realFile.lastIndexOf(marker + path.sep);
  if (at < 0) throw new Error(`Cannot find the package root of ${name} in ${realFile}`);
  return realFile.slice(0, at + marker.length);
}

/** `.pnpm/<name>@<version>/node_modules`: one level above `name`, two above `@scope/name`. */
function storeEntry(root: string, name: string): string {
  return path.resolve(root, ...name.split('/').map(() => '..'));
}

/** A failed outcome; `finish` fills in the run's output. */
function failed(reason: FailReason, line: number | null = null, text: string | null = null): RunOutcome {
  return { status: 'failed', reason, text, line, output: '' };
}

function runInProcess(args: string[], request: RunRequest): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const { limits, logger } = request;
    const startedAt = Date.now();
    const decoder = createFrameDecoder({
      frameMaxBytes: frameMaxBytes(limits.resultMaxBytes),
      totalMaxBytes: RUN_FRAMES_MAX_BYTES,
    });
    const queue: BridgeRequest[] = [];
    const output = createOutput();
    let stderrTail = '';
    let inFlight: AbortController | null = null;
    let argsBytes = 0;
    let dataBytes = 0;
    let outcome: RunOutcome | null = null;
    let closed = false;
    let child: ChildProcess;

    const settle = (): void => {
      if (outcome !== null && closed) resolve(outcome);
    };

    // The one end of a run (Flow 4): stop taking requests, cancel the call in flight, kill the process, record one outcome.
    const finish = (end: RunOutcome, fields: Record<string, unknown> = {}): void => {
      if (outcome !== null) return;
      outcome = { ...end, output: output.text() };
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      queue.length = 0;
      inFlight?.abort();
      if (!closed) child.kill('SIGKILL');
      const level = end.status === 'failed' && end.reason !== 'exception' && end.reason !== 'syntax' ? 'warn' : 'info';
      logger[level]('code run finished', {
        pid: child.pid,
        status: end.status,
        reason: end.status === 'failed' ? end.reason : undefined,
        line: end.status === 'failed' ? end.line : undefined,
        durationMs: Date.now() - startedAt,
        ...fields,
      });
      settle();
    };

    const violate = (violation: ProtocolViolation): void => {
      logger.warn('code executor broke the protocol', { pid: child.pid, violation });
      finish(failed('protocol'), { violation });
    };

    const pump = async (): Promise<void> => {
      if (inFlight !== null || outcome !== null) return;
      const next = queue.shift();
      if (next === undefined) return;
      const controller = new AbortController();
      inFlight = controller;
      try {
        const answer = await request.onRequest(next, controller.signal);
        if (outcome !== null) return;
        if (answer.kind === 'finish') finish(failed(answer.reason));
        else reply(next.id, answer);
      } catch (error) {
        if (outcome !== null) return;
        logger.error('code run request handler failed', { pid: child.pid, op: next.op, requestId: next.id, error });
        finish(failed('handler_failed'));
      } finally {
        inFlight = null;
      }
      void pump();
    };

    const reply = (id: number, answer: Exclude<RequestAnswer, { kind: 'finish' }>): void => {
      const message: HostMessage =
        answer.kind === 'value'
          ? { op: 'reply', id, ok: true, value: answer.value }
          : { op: 'reply', id, ok: false, error: answer.error };
      const frame = encodeFrame(message);
      dataBytes += frame.length;
      if (dataBytes > RUN_DATA_MAX_BYTES) {
        finish(failed('memory'), { dataBytes });
        return;
      }
      logger.debug('code run request answered', { pid: child.pid, requestId: id, kind: answer.kind, bytes: frame.length });
      child.stdin?.write(frame);
    };

    const take = (message: ExecutorMessage): void => {
      switch (message.op) {
        case 'call': {
          const bytes = Buffer.byteLength(JSON.stringify(message.args), 'utf8');
          argsBytes += bytes;
          if (bytes > CALL_ARGS_MAX_BYTES) return violate('call_args_too_large');
          if (argsBytes > RUN_ARGS_MAX_BYTES) return violate('run_args_too_large');
          logger.debug('code run request received', {
            pid: child.pid,
            op: 'call',
            requestId: message.id,
            name: message.name,
            argsBytes: bytes,
          });
          queue.push(message);
          return void pump();
        }
        case 'read':
          logger.debug('code run request received', {
            pid: child.pid,
            op: 'read',
            requestId: message.id,
            resultId: message.resultId,
          });
          queue.push(message);
          return void pump();
        case 'output':
          output.add(message.line);
          return;
        case 'done':
          // An honest executor sends `error` with `result_too_large` instead; the API process checks again.
          if (message.value !== null && Buffer.byteLength(message.value, 'utf8') > limits.resultMaxBytes) {
            logger.warn('code executor broke the protocol', { pid: child.pid, violation: 'result_too_large' });
            return finish(failed('result_too_large'), {
              violation: 'result_too_large',
            });
          }
          return finish({ status: 'returned', value: message.value, output: '' });
        case 'error':
          return finish(failed(message.reason, message.line, message.text));
      }
    };

    const onStdout = (chunk: Buffer): void => {
      if (outcome !== null) return;
      const decoded = decoder.push(chunk);
      for (const frame of decoded.frames) {
        if (outcome !== null) return;
        const parsed = parseExecutorMessage(frame);
        if ('violation' in parsed) return violate(parsed.violation);
        take(parsed.message);
      }
      if (decoded.violation !== undefined && outcome === null) violate(decoded.violation);
    };

    const onAbort = (): void => finish(failed('aborted'));

    const timer = setTimeout(
      () => finish(failed('timeout')),
      limits.timeoutMs + KILL_AFTER_LIMIT_MS,
    );

    try {
      child = spawn(process.execPath, args, { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      clearTimeout(timer);
      logger.error('code executor did not start', { error });
      resolve(failed('crashed'));
      return;
    }

    logger.info('code executor started', {
      pid: child.pid,
      scriptBytes: Buffer.byteLength(request.script, 'utf8'),
      limits,
    });
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    // A write to a dead process fails with EPIPE; its end is recorded by `close` below.
    child.stdin?.on('error', (error) => logger.debug('code executor stdin closed', { pid: child.pid, error }));
    child.on('error', (error) => {
      logger.error('code executor process error', { pid: child.pid, error });
      if (child.pid === undefined) {
        closed = true;
        finish(failed('crashed'));
      }
    });
    child.on('close', (exitCode, signal) => {
      closed = true;
      logger.info('code executor exited', { pid: child.pid, exitCode, signal, durationMs: Date.now() - startedAt });
      finish(failed('crashed'), { exitCode, signal, stderr: stderrTail });
      settle();
    });

    child.stdin?.write(encodeFrame({ op: 'start', script: request.script, limits }));
  });
}

/** Script output, held to the output limit again here even when the executor sends more. */
function createOutput(): { add(line: string): void; text(): string } {
  const lines: string[] = [];
  const limit = createOutputLimit((line) => lines.push(line));
  return { add: (line) => limit.add(line), text: () => lines.join('\n') };
}
