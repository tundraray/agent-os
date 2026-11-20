import { Buffer } from 'node:buffer';
import { type QuickJSWASMModule, newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import type { RunLimits } from './protocol.js';
import { type ScriptEnd, runScript } from './sandbox.js';

// Real QuickJS, no executor process and no database; only the bridge to the API process is a double.
// The process layer of the same escapes and limits is E2E-2 (test/).

const LIMITS: RunLimits = { timeoutMs: 300, memoryMb: 8, resultMaxBytes: 1024 };
/**
 * The time limit of a row that must end for another reason than time: on a loaded CI machine such a run
 * took longer than 0.3 s and ended as a timeout. Below the 5 s of the test itself, so a stalled run still
 * fails with the sandbox's own reason.
 */
const ROOMY_TIMEOUT_MS = 4_000;

let quickJs: QuickJSWASMModule;

beforeAll(async () => {
  quickJs = await newQuickJSWASMModuleFromVariant(import('@jitl/quickjs-wasmfile-release-sync'));
});

interface Run {
  end: ScriptEnd;
  output: string[];
}

async function run(script: string, limits: RunLimits = LIMITS): Promise<Run> {
  const output: string[] = [];
  const end = await runScript({
    script,
    limits,
    quickJs,
    bridge: {
      request: (request) => {
        throw new Error(`no request expected, got ${request.op}`);
      },
      output: (line) => output.push(line),
    },
  });
  return { end, output };
}

describe('a script reaches nothing outside the QuickJS sandbox', () => {
  // AC-02.3, AC-02.5, AC-06.1, AC-07.5, NFR-06 (UC-E1, QuickJS layer). `previous` runs first in its own sandbox.
  it.each<{ name: string; previous?: string; script: string; end: ScriptEnd }>([
    {
      name: 'process',
      script: 'return process.pid;',
      end: { op: 'error', reason: 'exception', text: "ReferenceError: 'process' is not defined", line: 1 },
    },
    {
      name: 'require',
      script: 'return require("fs");',
      end: { op: 'error', reason: 'exception', text: "ReferenceError: 'require' is not defined", line: 1 },
    },
    {
      name: 'fetch',
      script: 'return await fetch("http://127.0.0.1/");',
      end: { op: 'error', reason: 'exception', text: "ReferenceError: 'fetch' is not defined", line: 1 },
    },
    {
      name: 'import()',
      script: 'return await import("fs");',
      end: { op: 'error', reason: 'exception', text: "ReferenceError: could not load module 'fs'", line: null },
    },
    {
      name: 'WebAssembly',
      script: 'return WebAssembly.Module;',
      end: { op: 'error', reason: 'exception', text: "ReferenceError: 'WebAssembly' is not defined", line: 1 },
    },
    {
      name: 'Intl',
      script: 'return new Intl.NumberFormat();',
      end: { op: 'error', reason: 'exception', text: "ReferenceError: 'Intl' is not defined", line: 1 },
    },
    {
      name: 'the constructor chain reaches only the QuickJS global object',
      script:
        'const reached = (() => {}).constructor("return this")();\n' +
        'return [reached === globalThis, typeof reached.process, typeof reached.require];',
      end: { op: 'done', value: '[true,"undefined","undefined"]' },
    },
    {
      name: 'a polluted Object.prototype and a global do not survive into the next run',
      previous: 'Object.prototype.polluted = "yes";\nglobalThis.leaked = "first run";\nreturn 1;',
      script: 'return [typeof ({}).polluted, typeof globalThis.leaked];',
      end: { op: 'done', value: '["undefined","undefined"]' },
    },
    {
      name: 'a syntax error on line 3',
      script: 'const a = 1;\nconst b = 2;\nconst = 3;',
      end: { op: 'error', reason: 'syntax', text: 'SyntaxError: variable name expected', line: 3 },
    },
    {
      name: 'an exception on line 5',
      script: 'const a = 1;\n\n\n\nthrow new Error("boom");',
      end: { op: 'error', reason: 'exception', text: 'Error: boom', line: 5 },
    },
  ])('$name', async ({ previous, script, end }) => {
    if (previous !== undefined) await run(previous);

    expect((await run(script)).end).toEqual(end);
  });
});

describe('a script stops at every limit with its reason', () => {
  // AC-07.1, AC-07.2, AC-07.3, DC-3, DC-14 (UC-E2, sandbox half); limits: 0.3 s, 8 MB, 1024 bytes.
  it.each<{
    name: string;
    script: string;
    end: ScriptEnd;
    lastOutput?: string;
    outputAtLeast: number;
    timeoutMs?: number;
  }>([
    {
      name: 'an endless loop',
      script: 'while (true) {}',
      end: { op: 'error', reason: 'timeout', text: null, line: 1 },
      outputAtLeast: 0,
    },
    {
      name: 'a catastrophic regular expression',
      script: 'return /(a+)+$/.test("a".repeat(40) + "b");',
      end: { op: 'error', reason: 'timeout', text: null, line: 1 },
      outputAtLeast: 0,
    },
    {
      name: 'await of a promise that never settles',
      script: 'await new Promise(() => {});',
      end: { op: 'error', reason: 'timeout', text: null, line: null },
      outputAtLeast: 0,
    },
    {
      name: 'deep recursion',
      script: 'function down(n) { return down(n + 1) + 1; }\nreturn down(0);',
      end: { op: 'error', reason: 'exception', text: 'InternalError: stack overflow', line: 1 },
      outputAtLeast: 0,
    },
    {
      name: 'growing memory',
      script: 'const items = [];\nfor (;;) items.push({ n: items.length });',
      timeoutMs: ROOMY_TIMEOUT_MS,
      end: { op: 'error', reason: 'memory', text: null, line: 2 },
      outputAtLeast: 0,
    },
    {
      name: 'a stream of console.log',
      script: 'for (let i = 0; i < 3000; i++) console.log("line", i);\nreturn "printed";',
      timeoutMs: ROOMY_TIMEOUT_MS,
      end: { op: 'done', value: '"printed"' },
      lastOutput: '[вывод обрезан]',
      outputAtLeast: 16 * 1024 - 64,
    },
    {
      name: 'a result over the limit',
      script: 'return "x".repeat(2000);',
      end: { op: 'error', reason: 'result_too_large', text: null, line: null },
      outputAtLeast: 0,
    },
    {
      name: 'a function as the result',
      script: 'return () => 1;',
      end: { op: 'error', reason: 'result_not_json', text: null, line: null },
      outputAtLeast: 0,
    },
    {
      name: 'a cycle as the result',
      script: 'const node = {};\nnode.self = node;\nreturn node;',
      end: { op: 'error', reason: 'result_not_json', text: null, line: null },
      outputAtLeast: 0,
    },
  ])('$name', async ({ script, end, lastOutput, outputAtLeast, timeoutMs = LIMITS.timeoutMs }) => {
    const result = await run(script, { ...LIMITS, timeoutMs });

    expect(result.end).toEqual(end);
    expect(result.output.at(-1)).toBe(lastOutput);
    const outputBytes = result.output.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0);
    expect(outputBytes).toBeGreaterThanOrEqual(outputAtLeast);
    expect(outputBytes).toBeLessThanOrEqual(16 * 1024);
  });
});
