// A broken executor entry for E2E-2 group B (UC-E5): after the same preparation as `executor-main.ts`, it
// breaks the protocol the way the `script` of the `start` frame names. `answer` is the honest control: one
// `done` frame, so the test can show the host still runs the next start. Run under the production flags,
// so it imports only `node:` built-ins and the executor-side modules of the package.
import { Buffer } from 'node:buffer';
import { prepareProcess } from '#executor/prepare-process';
import { FRAME_MAX_BYTES, createFrameDecoder, encodeFrame } from '#executor/protocol';

prepareProcess();

export type BrokenMode = 'hang' | 'crash' | 'oversized_frame' | 'unknown_operation' | 'answer';

/** The result of `answer`, as JSON text; the test expects the same literal. */
const ANSWER_VALUE = '"still working"';

/** A frame the typed `encodeFrame` would not build: any JSON body. */
function rawFrame(body: string): Buffer {
  const bytes = Buffer.from(body, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([header, bytes]);
}

function breakProtocol(mode: BrokenMode): void {
  switch (mode) {
    case 'hang':
      // Busy, not idle: the host must kill a process that never yields to its event loop.
      for (;;);
    case 'crash':
      throw new Error('The broken entry crashes on start');
    case 'oversized_frame':
      // A well-formed `output` frame just over the 1 MiB limit; the process then waits to be killed.
      process.stdout.write(rawFrame(JSON.stringify({ op: 'output', line: 'x'.repeat(FRAME_MAX_BYTES) })));
      return;
    case 'unknown_operation':
      process.stdout.write(rawFrame(JSON.stringify({ op: 'shell', command: 'whoami' })));
      return;
    case 'answer':
      process.stdout.write(encodeFrame({ op: 'done', value: ANSWER_VALUE }), () => process.exit(0));
  }
}

const decoder = createFrameDecoder({ frameMaxBytes: Number.MAX_SAFE_INTEGER, totalMaxBytes: Number.MAX_SAFE_INTEGER });
let started = false;

process.stdin.on('data', (chunk: Buffer) => {
  for (const frame of decoder.push(chunk).frames) {
    const message: unknown = frame;
    if (started || Reflect.get(Object(message), 'op') !== 'start') continue;
    started = true;
    breakProtocol(Reflect.get(Object(message), 'script') as BrokenMode);
  }
});
