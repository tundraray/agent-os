// One script run in a fresh QuickJS runtime and context: nothing but the language built-ins and the
// script API (`callTool`, `readResult`, `console.*`). Runs inside the executor process, so it imports
// only `node:` built-ins, QuickJS types and the protocol (any other import ends in ERR_ACCESS_DENIED).
import { Buffer } from 'node:buffer';
import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import {
  type CallMessage,
  type DoneMessage,
  type ErrorMessage,
  type ReadMessage,
  type ReplyMessage,
  type RunLimits,
  type ScriptError,
  createOutputLimit,
} from '#executor/protocol';

/** QuickJS stack limit; well below the WASM stack, so deep recursion ends in a "stack overflow" exception. */
const MAX_STACK_BYTES = 256 * 1024;
const SCRIPT_FILE = 'script.js';
/** The JavaScript line terminators, so error lines are counted the way the engine counts them. */
const LINE_TERMINATOR = /\r\n|[\n\r\u2028\u2029]/;

export type ScriptRequest = CallMessage | ReadMessage;

/** How the sandbox talks to the API process: frames over stdin/stdout in the executor, a double in tests. */
export interface SandboxBridge {
  /** Sends a request of the script; resolves with the API process's reply to it. */
  request(request: ScriptRequest): Promise<ReplyMessage>;
  /** One line of script output; after `OUTPUT_TRUNCATED_MARK` no more lines come. */
  output(line: string): void;
}

export interface RunScriptInput {
  script: string;
  limits: RunLimits;
  bridge: SandboxBridge;
  /** The loaded QuickJS module; the executor imports it by absolute path, tests by package name. */
  quickJs: QuickJSWASMModule;
}

/** The last frame of a run. */
export type ScriptEnd = DoneMessage | ErrorMessage;

// Evaluated once per context before the script. Captures `JSON.stringify` so the script cannot swap it,
// and keeps `host` in closures only: the script sees `callTool`, `readResult` and `console`, never `host`.
const SCRIPT_API_SOURCE = `(host) => {
  const stringify = JSON.stringify;
  const format = (value) => {
    if (typeof value === 'string') return value;
    try {
      const json = stringify(value);
      if (json !== undefined) return json;
    } catch {}
    return String(value);
  };
  const print = (...values) => host.output(values.map(format).join(' '));
  globalThis.console = { log: print, info: print, warn: print, error: print };
  globalThis.callTool = (name, args) => {
    const json = stringify(args === undefined ? {} : args);
    if (json === undefined) throw new TypeError('callTool: args is not a JSON value');
    return host.call(String(name), json);
  };
  globalThis.readResult = (id) => host.read(String(id));
}`;

/** Runs one script to its end; never throws for anything the script does. */
export async function runScript(input: RunScriptInput): Promise<ScriptEnd> {
  const { limits, quickJs } = input;
  const deadline = Date.now() + limits.timeoutMs;
  let interrupted = false;
  const runtime = quickJs.newRuntime();
  runtime.setMemoryLimit(limits.memoryMb * 1024 * 1024);
  runtime.setMaxStackSize(MAX_STACK_BYTES);
  runtime.setInterruptHandler(() => {
    if (Date.now() <= deadline) return false;
    interrupted = true;
    return true;
  });
  const context = runtime.newContext();
  const run = createRun({
    context,
    runtime,
    input,
    deadline,
    isInterrupted: () => interrupted,
  });
  try {
    return await run.execute();
  } finally {
    run.dispose();
    context.dispose();
    runtime.dispose();
  }
}

interface RunParts {
  context: QuickJSContext;
  runtime: QuickJSRuntime;
  input: RunScriptInput;
  deadline: number;
  /** True once the interrupt handler stopped the script at the deadline. */
  isInterrupted: () => boolean;
}

function createRun({
  context,
  runtime,
  input,
  deadline,
  isInterrupted,
}: RunParts) {
  const { script, limits, bridge } = input;
  const scriptLines = script.split(LINE_TERMINATOR).length;
  const output = createOutputLimit((line) => bridge.output(line));
  const open = new Set<QuickJSDeferredPromise>();
  const json = context.getProp(context.global, 'JSON');
  const jsonParse = context.getProp(json, 'parse');
  const jsonStringify = context.getProp(json, 'stringify');
  let lastRequestId = 0;
  let wake: (() => void) | null = null;

  // The texts of the reasons are the API process's; only the script's own message travels.
  const fail = (
    reason: ErrorMessage['reason'],
    line: number | null = null,
    text: string | null = null,
  ): ErrorMessage => ({
    op: 'error',
    reason,
    text,
    line,
  });

  const timeoutEnd = (line: number | null = null): ErrorMessage =>
    fail('timeout', line);
  const notJsonEnd = (): ErrorMessage => fail('result_not_json');

  /** Turns a QuickJS exception into the run's end; the handle stays the caller's. */
  const failWith = (
    error: QuickJSHandle,
    reason: 'syntax' | 'exception',
  ): ErrorMessage => {
    const dumped: unknown = context.dump(error);
    const line = lineOf(dumped, scriptLines);
    if (isInterrupted()) return timeoutEnd(line);
    if (isOutOfMemory(dumped)) return fail('memory', line);
    return fail(reason, line, describe(dumped));
  };

  /** Resolves with the reply value, parsed from JSON inside QuickJS; a failed parse (memory, deadline) rejects. */
  const resolveWith = (
    deferred: QuickJSDeferredPromise,
    value: unknown,
  ): void => {
    const text = JSON.stringify(value);
    if (text === undefined) return deferred.resolve();
    const parsed = context
      .newString(text)
      .consume((handle) =>
        context.callFunction(jsonParse, context.undefined, handle),
      );
    if (parsed.error !== undefined)
      parsed.error.consume((error) => deferred.reject(error));
    else parsed.value.consume((handle) => deferred.resolve(handle));
  };

  /** A rejected `callTool` / `readResult` gets an Error that carries the outcome, reason and text. */
  const toolErrorOf = (error: ScriptError): QuickJSHandle => {
    const handle = context.newError({ name: 'ToolError', message: error.text });
    context
      .newString(error.outcome)
      .consume((value) => context.setProp(handle, 'outcome', value));
    if (error.reason === null) context.setProp(handle, 'reason', context.null);
    else
      context
        .newString(error.reason)
        .consume((value) => context.setProp(handle, 'reason', value));
    context
      .newString(error.text)
      .consume((value) => context.setProp(handle, 'text', value));
    return handle;
  };

  const settle = (
    deferred: QuickJSDeferredPromise,
    reply: ReplyMessage,
  ): void => {
    open.delete(deferred);
    if (!deferred.alive) return;
    if (reply.ok) resolveWith(deferred, reply.value);
    else toolErrorOf(reply.error).consume((error) => deferred.reject(error));
    wake?.();
  };

  const send = (build: (id: number) => ScriptRequest): QuickJSHandle => {
    lastRequestId += 1;
    const deferred = context.newPromise();
    open.add(deferred);
    void bridge
      .request(build(lastRequestId))
      .then((reply) => settle(deferred, reply));
    return deferred.handle;
  };

  const installApi = (): void => {
    const host = context.newObject();
    context
      .newFunction('output', (line) => {
        output.add(context.getString(line));
      })
      .consume((fn) => context.setProp(host, 'output', fn));
    context
      .newFunction('call', (name, args) =>
        send((id) => ({
          op: 'call',
          id,
          name: context.getString(name),
          args: JSON.parse(context.getString(args)),
        })),
      )
      .consume((fn) => context.setProp(host, 'call', fn));
    context
      .newFunction('read', (resultId) =>
        send((id) => ({
          op: 'read',
          id,
          resultId: context.getString(resultId),
        })),
      )
      .consume((fn) => context.setProp(host, 'read', fn));
    const factory = context.unwrapResult(
      context.evalCode(`(${SCRIPT_API_SOURCE})`, 'api.js', { type: 'global' }),
    );
    context
      .unwrapResult(context.callFunction(factory, context.undefined, host))
      .dispose();
    factory.dispose();
    host.dispose();
  };

  /** The script's value as JSON text, or why it cannot be the result. */
  const resultOf = (value: QuickJSHandle): ScriptEnd => {
    const type = context.typeof(value);
    if (type === 'undefined') return { op: 'done', value: null };
    if (type === 'function' || type === 'symbol') return notJsonEnd();
    // BigInt and cycles make JSON.stringify throw; a deadline or memory end inside it keeps its own reason.
    const stringified = context.callFunction(
      jsonStringify,
      context.undefined,
      value,
    );
    if (stringified.error !== undefined) {
      const end = stringified.error.consume((error) =>
        failWith(error, 'exception'),
      );
      return end.reason === 'exception' ? notJsonEnd() : end;
    }
    const text: unknown = stringified.value.consume((handle) =>
      context.dump(handle),
    );
    if (typeof text !== 'string') return notJsonEnd();
    if (Buffer.byteLength(text, 'utf8') > limits.resultMaxBytes) {
      return fail('result_too_large');
    }
    return { op: 'done', value: text };
  };

  /** Waits for a reply, or for the deadline; true when a reply came in time. */
  const waitForReply = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => resolve(false),
        Math.max(0, deadline - Date.now()),
      );
      wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
    }).finally(() => {
      wake = null;
    });

  return {
    async execute(): Promise<ScriptEnd> {
      installApi();
      // The script is the body of an async function; it starts on line 1 so error lines match the script's.
      const evaluated = context.evalCode(
        `(async () => {${script}\n})()`,
        SCRIPT_FILE,
        { type: 'global' },
      );
      // Only compiling can fail here: the function body runs into the promise.
      if (evaluated.error !== undefined)
        return evaluated.error.consume((error) => failWith(error, 'syntax'));
      const promise = evaluated.value;
      try {
        for (;;) {
          runtime.executePendingJobs();
          const state = context.getPromiseState(promise);
          if (state.type === 'fulfilled') return state.value.consume(resultOf);
          if (state.type === 'rejected')
            return state.error.consume((error) => failWith(error, 'exception'));
          // With no request open nothing can settle the script any more, so the wait runs to the deadline.
          if (!(await waitForReply())) return timeoutEnd();
        }
      } finally {
        promise.dispose();
      }
    },
    dispose(): void {
      for (const deferred of open) deferred.dispose();
      open.clear();
      jsonParse.dispose();
      jsonStringify.dispose();
      json.dispose();
    },
  };
}

interface DumpedError {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  lineNumber?: unknown;
}

function asError(dumped: unknown): DumpedError | null {
  return typeof dumped === 'object' && dumped !== null
    ? (dumped as DumpedError)
    : null;
}

function isOutOfMemory(dumped: unknown): boolean {
  const error = asError(dumped);
  return error?.name === 'InternalError' && error.message === 'out of memory';
}

function describe(dumped: unknown): string {
  const error = asError(dumped);
  if (error !== null && typeof error.message === 'string') {
    return typeof error.name === 'string'
      ? `${error.name}: ${error.message}`
      : error.message;
  }
  return typeof dumped === 'string' ? dumped : String(JSON.stringify(dumped));
}

/** The script line of an error: a syntax error's own line, else the innermost script frame of the stack. */
function lineOf(dumped: unknown, scriptLines: number): number | null {
  const error = asError(dumped);
  if (error === null) return null;
  const fromStack =
    typeof error.stack === 'string'
      ? new RegExp(`${SCRIPT_FILE.replace('.', '\\.')}:(\\d+)`).exec(
          error.stack,
        )
      : null;
  const line =
    typeof error.lineNumber === 'number'
      ? error.lineNumber
      : Number(fromStack?.[1] ?? Number.NaN);
  return Number.isSafeInteger(line) && line >= 1 && line <= scriptLines
    ? line
    : null;
}
