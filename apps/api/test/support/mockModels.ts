import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';

/** One `doStream` result of the mock model (one step of the agent loop). */
export type StreamStep = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart =
  StreamStep['stream'] extends ReadableStream<infer Part> ? Part : never;
type FinishReason = Extract<StreamPart, { type: 'finish' }>['finishReason'];

/** Options of one `doStream` call (prompt, `abortSignal`, …). */
type CallOptions = Parameters<MockLanguageModelV4['doStream']>[0];

/**
 * A queued model call: a stream to return, an error `doStream` rejects with,
 * or a function building the stream from the call options.
 */
export type AssistantStep =
  StreamStep | Error | ((options: CallOptions) => StreamStep);

/** Tool names registered on the test `assistant` agent (see `createTestApp`). */
export const WEATHER_TOOL = 'getWeather';
export const FAILING_TOOL = 'failing';

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

// Tool call ids must stay unique within a thread when the scenario repeats.
let toolCallSeq = 0;

function finish(unified: FinishReason['unified']): StreamPart {
  return {
    type: 'finish',
    finishReason: { unified, raw: unified },
    usage: USAGE,
  };
}

function textParts(id: string, text: string): StreamPart[] {
  return [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: text },
    { type: 'text-end', id },
  ];
}

function step(parts: StreamPart[]): StreamStep {
  return {
    stream: convertArrayToReadableStream<StreamPart>([
      { type: 'stream-start', warnings: [] },
      ...parts,
    ]),
  };
}

/** Scenario "text": the assistant answers with a single text part. */
export function textStep(text: string): StreamStep {
  return step([...textParts('text-1', text), finish('stop')]);
}

/**
 * Scenario "reasoning + 2 tools": step 1 streams a reasoning part and calls
 * `getWeather` (succeeds) and `failing` (throws `'boom'`); step 2 answers with
 * `finalText` after the tool results. Consumes two model calls.
 */
export function reasoningWithToolsSteps(options: {
  reasoning: string;
  city: string;
  finalText: string;
}): [StreamStep, StreamStep] {
  toolCallSeq += 1;
  const toolsStep = step([
    { type: 'reasoning-start', id: 'reasoning-1' },
    { type: 'reasoning-delta', id: 'reasoning-1', delta: options.reasoning },
    { type: 'reasoning-end', id: 'reasoning-1' },
    {
      type: 'tool-call',
      toolCallId: `call-weather-${toolCallSeq}`,
      toolName: WEATHER_TOOL,
      input: JSON.stringify({ city: options.city }),
    },
    {
      type: 'tool-call',
      toolCallId: `call-failing-${toolCallSeq}`,
      toolName: FAILING_TOOL,
      input: JSON.stringify({}),
    },
    finish('tool-calls'),
  ]);
  return [toolsStep, textStep(options.finalText)];
}

/**
 * Scenario "partial text, then stream error": the model starts answering with
 * `partialText` and the stream then reports `message` as an error part, without
 * finishing the text part or the step (a provider failure mid-stream).
 */
export function partialTextThenErrorStep(
  partialText: string,
  message = 'mock stream failure',
): StreamStep {
  return step([
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: partialText },
    { type: 'error', error: new Error(message) },
  ]);
}

/** A step whose stream stays open until the model call is aborted. */
export interface AbortableStep {
  step: (options: CallOptions) => StreamStep;
  /** Resolves when the call's `abortSignal` fired and the stream was ended. */
  aborted: Promise<void>;
}

/**
 * Scenario "partial text, then the stream hangs until cancelled": the model
 * starts answering with `partialText` and never finishes the text part or the
 * step. When the call's `abortSignal` fires (the server passed a client
 * disconnect to the model), the stream errors with the abort reason, as a
 * provider stream does, and `aborted` resolves — a deterministic signal for
 * the test. Without an `abortSignal` the stream errors at once and `aborted`
 * never resolves.
 */
export function partialTextUntilAbortStep(partialText: string): AbortableStep {
  let resolveAborted: () => void = () => undefined;
  const aborted = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });
  const stepFor = ({ abortSignal }: CallOptions): StreamStep => ({
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'text-start', id: 'text-1' });
        controller.enqueue({
          type: 'text-delta',
          id: 'text-1',
          delta: partialText,
        });
        if (!abortSignal) {
          controller.error(new Error('mock model call has no abortSignal'));
          return;
        }
        const onAbort = () => {
          controller.error(abortSignal.reason);
          resolveAborted();
        };
        if (abortSignal.aborted) onAbort();
        else abortSignal.addEventListener('abort', onAbort, { once: true });
      },
    }),
  });
  return { step: stepFor, aborted };
}

/** Scenario "model error": the model call rejects with this error. */
export function modelErrorStep(message = 'mock model failure'): Error {
  return new Error(message);
}

/**
 * Mock assistant model answering model calls from a queue, in order, one entry
 * per `doStream` call; multi-turn conversations queue one entry per turn
 * (two for `reasoningWithToolsSteps`). An exhausted queue rejects, so a test
 * that makes more calls than it scripted fails instead of hanging.
 */
export function assistantModel(...steps: AssistantStep[]): MockLanguageModelV4 {
  const queue = [...steps];
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-assistant',
    doStream: (options) => {
      const next = queue.shift();
      if (next === undefined) {
        return Promise.reject(
          new Error('mock assistant model: no scripted response left'),
        );
      }
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(typeof next === 'function' ? next(options) : next);
    },
  });
}
