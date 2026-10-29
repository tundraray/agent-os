import { setTimeout as delay } from 'node:timers/promises';
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

/** Title every e2e app gets unless a test scripts the title model. */
export const DEFAULT_TEST_TITLE = 'Тестовый заголовок';

/** One `doGenerate` result of the mock title model. */
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type GenerateOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];

/**
 * What the title model does on each call until switched: answer `title`
 * (after `delayMs`, when given), or reject with `error`.
 */
export type TitleScenario =
  { title: string; delayMs?: number } | { error: Error };

/** Scenario "title": the model answers `title` at once. */
export function titleSuccess(title: string): TitleScenario {
  return { title };
}

/** Scenario "title model error": every call rejects. */
export function titleError(message = 'mock title failure'): TitleScenario {
  return { error: new Error(message) };
}

/** Scenario "slow title": the model answers `title` after `delayMs` (aborts early on its signal). */
export function titleDelayed(title: string, delayMs: number): TitleScenario {
  return { title, delayMs };
}

/** Mock model of the title agent: records each call's user text; the scenario is switchable. */
export interface TitleModel {
  model: MockLanguageModelV4;
  /** Concatenated user text of each call's prompt, in call order. */
  prompts: string[];
  /** Replaces the scenario for the following calls. */
  use(scenario: TitleScenario): void;
}

function promptUserText(prompt: GenerateOptions['prompt']): string {
  return prompt
    .flatMap((message) => (message.role === 'user' ? message.content : []))
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('');
}

function titleResult(title: string): GenerateResult {
  return {
    content: [{ type: 'text', text: title }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: USAGE,
    warnings: [],
  };
}

/**
 * Mock title model; by default answers `DEFAULT_TEST_TITLE`, so no e2e that
 * finishes a chat reply ever reaches a network title model.
 */
export function titleModel(
  initial: TitleScenario = titleSuccess(DEFAULT_TEST_TITLE),
): TitleModel {
  let scenario = initial;
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-title',
    doGenerate: async (options) => {
      prompts.push(promptUserText(options.prompt));
      const current = scenario;
      if ('error' in current) throw current.error;
      if (current.delayMs !== undefined) {
        await delay(current.delayMs, undefined, {
          signal: options.abortSignal,
        });
      }
      return titleResult(current.title);
    },
  });
  return {
    model,
    prompts,
    use: (next) => {
      scenario = next;
    },
  };
}
