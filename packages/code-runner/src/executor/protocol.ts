// The bridge between the API process and the executor process: messages, frames and limits.
// One module for both sides. The executor process may read only its own directory and QuickJS,
// so this module imports nothing but `node:` built-ins (any other import ends in ERR_ACCESS_DENIED).
//
// Process arguments: after the entry, the executor gets the QuickJS package roots it imports by
// absolute path — `process.argv[2]` is `quickjs-emscripten-core`, `process.argv[3]` is the variant
// `@jitl/quickjs-wasmfile-release-sync`.
import { Buffer } from 'node:buffer';

const KIB = 1024;
const MIB = 1024 * KIB;

/** A frame body from the executor: at most this, or the result limit plus `FRAME_RESULT_MARGIN_BYTES` when that is larger. */
export const FRAME_MAX_BYTES = 1 * MIB;
const FRAME_RESULT_MARGIN_BYTES = 64 * KIB;
/** All frames from the executor in one run, headers included. */
export const RUN_FRAMES_MAX_BYTES = 4 * MIB;
/** Arguments of one `call`, as JSON. */
export const CALL_ARGS_MAX_BYTES = 64 * KIB;
/** Arguments of all `call`s of one run, as JSON. */
export const RUN_ARGS_MAX_BYTES = 1 * MIB;
/** Data the API process hands to the script in one run (reply frames); more ends the run with `memory` (DC-12). */
export const RUN_DATA_MAX_BYTES = 64 * MIB;
/** Script output kept for one run; the last `output` frame carries `OUTPUT_TRUNCATED_MARK`. */
const OUTPUT_MAX_BYTES = 16 * KIB;
const OUTPUT_TRUNCATED_MARK = '[вывод обрезан]';

const HEADER_BYTES = 4;

export interface RunLimits {
  timeoutMs: number;
  memoryMb: number;
  resultMaxBytes: number;
}

/** Why a run failed. */
export type FailReason =
  | 'syntax'
  | 'exception'
  | 'timeout'
  | 'memory'
  | 'result_too_large'
  | 'result_not_json'
  | 'call_limit'
  | 'protocol'
  | 'crashed'
  /** The API process failed to answer a request of the script (e.g. its audit write); the executor is fine. */
  | 'handler_failed'
  | 'busy'
  | 'aborted';

/** The reasons the executor itself may report in an `error` frame; the rest belong to the API process. */
export const EXECUTOR_FAIL_REASONS = [
  'syntax',
  'exception',
  'timeout',
  'memory',
  'result_too_large',
  'result_not_json',
] as const satisfies readonly FailReason[];
export type ExecutorFailReason = (typeof EXECUTOR_FAIL_REASONS)[number];

/** What a rejected `callTool` / `readResult` promise carries into the script. */
export interface ScriptError {
  outcome: string;
  reason: string | null;
  text: string;
}

// --- API process → executor ---

export interface StartMessage {
  op: 'start';
  script: string;
  input: unknown;
  limits: RunLimits;
}

export type ReplyMessage =
  | { op: 'reply'; id: number; ok: true; value: unknown }
  | { op: 'reply'; id: number; ok: false; error: ScriptError };

export type HostMessage = StartMessage | ReplyMessage;

// --- executor → API process ---

export interface CallMessage {
  op: 'call';
  id: number;
  name: string;
  args: unknown;
}

export interface ReadMessage {
  op: 'read';
  id: number;
  resultId: string;
}

export interface OutputMessage {
  op: 'output';
  line: string;
}

/** `value` is the result as JSON text; `null` when the script returned nothing. */
export interface DoneMessage {
  op: 'done';
  value: string | null;
}

/** `text` is the script's own message (`syntax`, `exception`); `null` for every other reason. */
export interface ErrorMessage {
  op: 'error';
  reason: ExecutorFailReason;
  text: string | null;
  line: number | null;
}

export type ExecutorMessage =
  CallMessage | ReadMessage | OutputMessage | DoneMessage | ErrorMessage;

export type ProtocolViolation =
  | 'frame_too_large'
  | 'run_frames_too_large'
  | 'invalid_json'
  | 'invalid_message'
  | 'unknown_operation'
  | 'call_args_too_large'
  | 'run_args_too_large'
  | 'result_too_large';

/**
 * Passes script output lines on to `onLine` up to `OUTPUT_MAX_BYTES` (a newline per line), then the
 * truncation mark once and nothing after it. Room for the mark is always kept, so the output with the
 * mark never exceeds the limit, and output already cut by this rule passes through it unchanged:
 * the executor and the API process apply the same limiter without cutting or marking twice.
 */
export function createOutputLimit(onLine: (line: string) => void): {
  add(line: string): void;
} {
  const markBytes = Buffer.byteLength(OUTPUT_TRUNCATED_MARK, 'utf8') + 1;
  let bytes = 0;
  let truncated = false;
  return {
    add(line) {
      if (truncated) return;
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (bytes + lineBytes + markBytes > OUTPUT_MAX_BYTES) {
        truncated = true;
        onLine(OUTPUT_TRUNCATED_MARK);
        return;
      }
      bytes += lineBytes;
      onLine(line);
    },
  };
}

/** The largest frame body the API process accepts from the executor in a run with this result limit. */
export function frameMaxBytes(resultMaxBytes: number): number {
  return Math.max(FRAME_MAX_BYTES, resultMaxBytes + FRAME_RESULT_MARGIN_BYTES);
}

/** Four bytes of body length (big-endian), then the JSON body. */
export function encodeFrame(message: HostMessage | ExecutorMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export interface FrameDecoderLimits {
  frameMaxBytes: number;
  totalMaxBytes: number;
}

export interface DecodedFrames {
  frames: unknown[];
  violation?: ProtocolViolation;
}

export interface FrameDecoder {
  /** Takes the next chunk of the stream; after a violation the stream is broken and the caller stops reading. */
  push(chunk: Buffer): DecodedFrames;
}

/** Reads frames from a byte stream; each length is checked against the limits before its body is awaited. */
export function createFrameDecoder(limits: FrameDecoderLimits): FrameDecoder {
  let buffered: Buffer = Buffer.alloc(0);
  let total = 0;
  return {
    push(chunk) {
      buffered =
        buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      const frames: unknown[] = [];
      while (buffered.length >= HEADER_BYTES) {
        const length = buffered.readUInt32BE(0);
        if (length > limits.frameMaxBytes)
          return { frames, violation: 'frame_too_large' };
        if (total + HEADER_BYTES + length > limits.totalMaxBytes) {
          return { frames, violation: 'run_frames_too_large' };
        }
        if (buffered.length < HEADER_BYTES + length) break;
        const body = buffered
          .subarray(HEADER_BYTES, HEADER_BYTES + length)
          .toString('utf8');
        buffered = buffered.subarray(HEADER_BYTES + length);
        total += HEADER_BYTES + length;
        try {
          frames.push(JSON.parse(body));
        } catch {
          return { frames, violation: 'invalid_json' };
        }
      }
      return { frames };
    },
  };
}

/** Checks a decoded frame from the executor by hand: the executor is not trusted. */
export function parseExecutorMessage(
  value: unknown,
): { message: ExecutorMessage } | { violation: ProtocolViolation } {
  if (!isRecord(value) || typeof value.op !== 'string')
    return { violation: 'invalid_message' };
  const message = shapeOf(value);
  if (message === 'unknown') return { violation: 'unknown_operation' };
  return message === null ? { violation: 'invalid_message' } : { message };
}

function shapeOf(
  value: Record<string, unknown>,
): ExecutorMessage | null | 'unknown' {
  switch (value.op) {
    case 'call':
      return isRequestId(value.id) &&
        typeof value.name === 'string' &&
        'args' in value
        ? { op: 'call', id: value.id, name: value.name, args: value.args }
        : null;
    case 'read':
      return isRequestId(value.id) && typeof value.resultId === 'string'
        ? { op: 'read', id: value.id, resultId: value.resultId }
        : null;
    case 'output':
      return typeof value.line === 'string'
        ? { op: 'output', line: value.line }
        : null;
    case 'done':
      return value.value === null || typeof value.value === 'string'
        ? { op: 'done', value: value.value }
        : null;
    case 'error':
      return isExecutorFailReason(value.reason) &&
        (value.text === null || typeof value.text === 'string') &&
        (value.line === null || isLineNumber(value.line))
        ? {
            op: 'error',
            reason: value.reason,
            text: value.text,
            line: value.line,
          }
        : null;
    default:
      return 'unknown';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isLineNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isExecutorFailReason(value: unknown): value is ExecutorFailReason {
  return (EXECUTOR_FAIL_REASONS as readonly unknown[]).includes(value);
}
