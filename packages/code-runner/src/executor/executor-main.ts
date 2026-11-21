// The executor process entry. Started by the API process under `--permission` with read access to its own
// directory and the QuickJS store entries only, so it imports nothing but `node:` built-ins, its siblings and
// QuickJS by absolute path: `process.argv[2]` is the `quickjs-emscripten-core` root, `process.argv[3]` the
// `@jitl/quickjs-wasmfile-release-sync` root. In tests plain Node runs this directory from source, with no
// loader: its modules import each other through `#executor/*` of package.json (Node does not resolve a
// relative import without an extension) and hold only syntax Node can strip.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareProcess } from '#executor/prepare-process';
import { type ExecutorMessage, type HostMessage, type ReplyMessage, createFrameDecoder, encodeFrame } from '#executor/protocol';
import { runScript } from '#executor/sandbox';

prepareProcess();

const [coreRoot, variantRoot] = process.argv.slice(2);
if (coreRoot === undefined || variantRoot === undefined) {
  throw new Error('The executor needs the QuickJS core and variant roots as arguments');
}
const entryOf = (root: string): string => pathToFileURL(path.join(root, 'dist', 'index.mjs')).href;
const core = (await import(/* webpackIgnore: true */ entryOf(coreRoot))) as typeof import('quickjs-emscripten-core');
const quickJs = await core.newQuickJSWASMModuleFromVariant(import(/* webpackIgnore: true */ entryOf(variantRoot)));

const send = (message: ExecutorMessage): void => {
  process.stdout.write(encodeFrame(message));
};

const waiting = new Map<number, (reply: ReplyMessage) => void>();
let started = false;

// The API process is trusted and bounds what it sends itself (DC-12), so frames are not limited here.
const decoder = createFrameDecoder({
  frameMaxBytes: Number.MAX_SAFE_INTEGER,
  totalMaxBytes: Number.MAX_SAFE_INTEGER,
});

const take = (message: HostMessage): void => {
  if (message.op === 'reply') {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  if (started) return;
  started = true;
  void runScript({
    script: message.script,
    limits: message.limits,
    quickJs,
    bridge: {
      request: (request) =>
        new Promise((resolve) => {
          waiting.set(request.id, resolve);
          send(request);
        }),
      output: (line) => send({ op: 'output', line }),
    },
  }).then((end) => process.stdout.write(encodeFrame(end), () => process.exit(0)));
};

process.stdin.on('data', (chunk: Buffer) => {
  const decoded = decoder.push(chunk);
  for (const frame of decoded.frames) take(frame as HostMessage);
  if (decoded.violation !== undefined) process.exit(1);
});
// The API process is gone: leave as soon as QuickJS yields control to the event loop.
process.stdin.on('end', () => process.exit(0));
