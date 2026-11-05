import { randomUUID } from 'node:crypto';
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
 * or a function building the stream (or a promise of it) from the call options.
 */
export type AssistantStep =
  | StreamStep
  | Error
  | ((options: CallOptions) => StreamStep | Promise<StreamStep>);

/** Tool names registered on the test `assistant` agent (see `createTestApp`). */
export const WEATHER_TOOL = 'getWeather';
export const FAILING_TOOL = 'failing';
/** The part's research tool (design-chat-entry.md, KD-1); the research chat app registers it on the test agent. */
export const DEEP_RESEARCH_TOOL = 'deepResearch';

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

/** A scripted `deepResearch` call; `toolCallId` is the `launchKey` the tool gives the new launch. */
export interface DeepResearchCall {
  step: StreamStep;
  toolCallId: string;
}

/**
 * Scenario "deepResearch call": the model calls the part's tool with `goal`
 * and, when given, `tokenBudget`, and ends the step for the tool (one model
 * call). The tool call id is unique across runs: the launch key of the row
 * the tool writes is derived from it.
 */
export function deepResearchCallStep(input: {
  goal: string;
  tokenBudget?: number;
}): DeepResearchCall {
  const toolCallId = `call-${DEEP_RESEARCH_TOOL}-${randomUUID()}`;
  return {
    toolCallId,
    step: step([
      {
        type: 'tool-call',
        toolCallId,
        toolName: DEEP_RESEARCH_TOOL,
        input: JSON.stringify(input),
      },
      finish('tool-calls'),
    ]),
  };
}

/**
 * Scenario "held turn": the model call answers `answer` only once `until`
 * resolves, so the chat run stays registered in `ThreadRunRegistry` meanwhile.
 * Hold it with a latch the harness releases on reset (`ResearchChatApp.gate`).
 */
export function heldStep(
  until: Promise<void>,
  answer: StreamStep,
): AssistantStep {
  return async () => {
    await until;
    return answer;
  };
}

/** The answer of the next queued step for `options`; an exhausted queue rejects. */
function nextFromQueue(
  queue: AssistantStep[],
  options: CallOptions,
  label: string,
): Promise<StreamStep> {
  const next = queue.shift();
  if (next === undefined) {
    return Promise.reject(new Error(`${label}: no scripted response left`));
  }
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(typeof next === 'function' ? next(options) : next);
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
    doStream: (options) =>
      nextFromQueue(queue, options, 'mock assistant model'),
  });
}

/** What one chat model call received, as the turn options reached the model. */
export interface RecordedChatCall {
  /** Id of the model that served the call (`ScriptedChatModel.modelFor`): which model the agent picked for the turn. */
  modelId: string;
  /** The tool choice of the call; `{ type: 'tool', toolName }` when a tool is forced. */
  toolChoice: CallOptions['toolChoice'];
  /** Names of the tools offered to the model, in the order of the call. */
  tools: string[];
  /** The call's `reasoning` setting. */
  reasoning: CallOptions['reasoning'];
  /** `providerOptions.anthropic.thinking` of the call: the thinking setting of the turn. */
  thinking: unknown;
  /** The whole `providerOptions` object of the call. */
  providerOptions: CallOptions['providerOptions'];
  /** The system text (the agent's instruction), the system messages joined by a blank line. */
  system: string;
  /** The messages the model received, without the system messages. */
  messages: CallOptions['prompt'];
}

/**
 * The chat model of the research chat app: a queue scripted per test (the queue
 * of {@link assistantModel}) that records the options of every call. One
 * instance serves the app for the whole file; `reset` empties the queue and
 * the records between tests.
 */
export interface ScriptedChatModel {
  /** The chat model, `modelFor(SCRIPTED_CHAT_MODEL_ID)`. */
  readonly model: MockLanguageModelV4;
  /**
   * The model with id `modelId`, one instance per id, serving the same queue and records: an agent whose model
   * follows the turn (design-chat-entry.md, KD-9) maps the model id it picks to one of these.
   */
  modelFor(modelId: string): MockLanguageModelV4;
  /** Every call in arrival order. */
  readonly calls: readonly RecordedChatCall[];
  /** Appends steps to the queue. */
  script(...steps: AssistantStep[]): void;
  /** Steps still queued: a finished test expects zero. */
  remaining(): number;
  reset(): void;
}

/** Id of the scripted chat model: what `ScriptedChatModel.model` reports as the model of a call. */
export const SCRIPTED_CHAT_MODEL_ID = 'mock/chat';

function recordCall(modelId: string, options: CallOptions): RecordedChatCall {
  const anthropic = options.providerOptions?.anthropic;
  return {
    modelId,
    toolChoice: options.toolChoice,
    tools: (options.tools ?? []).map((tool) => tool.name),
    reasoning: options.reasoning,
    thinking: anthropic?.thinking,
    providerOptions: options.providerOptions,
    system: options.prompt
      .flatMap((message) =>
        message.role === 'system' ? [message.content] : [],
      )
      .join('\n\n'),
    messages: options.prompt.filter((message) => message.role !== 'system'),
  };
}

export function scriptedChatModel(): ScriptedChatModel {
  const queue: AssistantStep[] = [];
  const calls: RecordedChatCall[] = [];
  const models = new Map<string, MockLanguageModelV4>();
  const modelFor = (modelId: string): MockLanguageModelV4 => {
    let model = models.get(modelId);
    if (model === undefined) {
      model = new MockLanguageModelV4({
        provider: 'mock',
        modelId,
        doStream: (options) => {
          calls.push(recordCall(modelId, options));
          return nextFromQueue(queue, options, 'scripted chat model');
        },
      });
      models.set(modelId, model);
    }
    return model;
  };
  return {
    model: modelFor(SCRIPTED_CHAT_MODEL_ID),
    modelFor,
    calls,
    script: (...steps) => {
      queue.push(...steps);
    },
    remaining: () => queue.length,
    reset: () => {
      queue.length = 0;
      calls.length = 0;
    },
  };
}

/** Title every e2e app gets unless a test scripts the title model. */
const DEFAULT_TEST_TITLE = 'Тестовый заголовок';

/** One `doGenerate` result of the mock title model. */
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type GenerateOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];

/**
 * What the title model does on each call until switched: answer `{"title": title}`
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

/** A structured answer: the JSON text `{"title":"…"}` the title agent's schema parses. */
function titleResult(title: string): GenerateResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ title }) }],
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
