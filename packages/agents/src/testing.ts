import type {
  AgentToolCall,
  AgentTurnCall,
  AgentTurnGeneration,
  AgentTurnMessage,
  AgentTurnModelClient,
  ReportedUsage,
  StreamTurnOptions,
} from './model/mastra-turn.js';

/**
 * The scripted model of the integration tests (ADR-0004: a test double of the package's contract,
 * `@agent-os/agents/testing`): an `AgentTurnModelClient` for `createAgents({ turnClient })`, so it stands
 * INSIDE `ModelClient`, below its ledger write — the token ledger, the retries, the text parts with
 * their offsets and the provider messages are the package's own. A script is a list of replies of one
 * agent; every call is recorded with the messages exactly as the provider would get them, which is the
 * assertion surface for "the next model call sees X". An answer may carry its text in parts, which
 * stream to `onText` in order; it may wait on a latch, so a step is held with its call in flight; a
 * reply may be computed from the call's input; a reply may be a provider error. A call of
 * `agents.completeText` (`purpose: 'complete_text'`) is answered by the separate text script.
 */

/** Usage of an answer that names none: below any compaction threshold of the tests. */
export const DEFAULT_USAGE: ReportedUsage = {
  inputTokens: 1_000,
  outputTokens: 100,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
};

/** The status of a scripted provider error unless named: retryable, so `ModelClient` retries it. */
const DEFAULT_ERROR_STATUS = 503;

/**
 * A point model calls hold at until the test opens it. `reached(n)` resolves once `n` calls arrived;
 * a held call gives up with its signal's reason when the step is cancelled, so a closing harness never
 * waits on a latch the test left shut.
 */
export interface Latch {
  /** Calls that have arrived at the latch. */
  readonly count: number;
  /** Resolves once `count` calls (1 by default) have arrived. */
  reached(count?: number): Promise<void>;
  /** Lets every held call, and every later one, through. */
  open(): void;
  /** Called by the double: counts the arrival and waits until the latch is open or `signal` aborts. */
  pass(signal: AbortSignal): Promise<void>;
}

export function createLatch(): Latch {
  let arrived = 0;
  let isOpen = false;
  const openWaiters: (() => void)[] = [];
  const countWaiters: { count: number; resolve: () => void }[] = [];

  return {
    get count() {
      return arrived;
    },
    reached(count = 1) {
      if (arrived >= count) return Promise.resolve();
      return new Promise<void>((resolve) => countWaiters.push({ count, resolve }));
    },
    open() {
      isOpen = true;
      for (const resolve of openWaiters.splice(0)) resolve();
    },
    pass(signal) {
      arrived += 1;
      for (const waiter of countWaiters.slice()) {
        if (arrived >= waiter.count) {
          countWaiters.splice(countWaiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
      if (isOpen) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        openWaiters.push(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    },
  };
}

/** One tool call of a scripted answer, by the name the model sees (`start_agent`, `mcp__logs__get_trace`). */
export interface ScriptedToolCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * One answer of a script: text and/or tool calls, its usage, and an optional latch it waits on first.
 * `text` as a list is the text in parts: each part streams to `onText` in order, the answer's text is
 * their concatenation.
 */
export interface ScriptedAnswer {
  readonly text?: string | readonly string[];
  readonly calls?: readonly ScriptedToolCall[];
  /** Over {@link DEFAULT_USAGE}. */
  readonly usage?: Partial<ReportedUsage>;
  readonly latch?: Latch;
}

/**
 * A provider error instead of an answer: the double rejects the call as the provider client does
 * (`AI_APICallError` with `statusCode`). Each retry of `ModelClient` is a call of its own, so a script
 * whose every call fails (`thereafter: modelError()`) makes the session's model call end in
 * `model_error` after the retries (1000 and 3000 ms: about 4 s per failing agent).
 */
export interface ScriptedModelError {
  readonly kind: 'model_error';
  readonly statusCode: number;
}

export function modelError(statusCode = DEFAULT_ERROR_STATUS): ScriptedModelError {
  return { kind: 'model_error', statusCode };
}

/** A reply computed from the call's input: the messages exactly as the provider would get them. */
export type ReplyFromInput = (
  messages: readonly AgentTurnMessage[],
) => ScriptedAnswer | ScriptedModelError;

/** What a script answers one call with. */
export type ScriptedReply = ScriptedAnswer | ScriptedModelError | ReplyFromInput;

/** A model call as the double received it. */
export interface RecordedModelCall {
  readonly agentName: string;
  readonly model: string;
  /** The session's messages exactly as the provider would get them. */
  readonly messages: readonly AgentTurnMessage[];
  /** Names of the tools offered to the model. */
  readonly toolNames: readonly string[];
  /** Ids the double gave the tool calls of its answer, in order; empty until it answered. */
  readonly toolCallIds: string[];
}

/**
 * Which calls a script answers: `task` — the latest user message of the call equals this text (the
 * agent's task; the latest one wins, so a fork is told apart from the parent whose history it carries);
 * `agent` — the definition name, for an agent whose task the model no longer sees (after compaction)
 * or whose task the test does not know in advance.
 */
export type ScriptKey = { readonly task: string } | { readonly agent: string };

export interface ScriptOptions {
  /** Answers every call past the listed replies; without it such a call fails the step. */
  readonly thereafter?: ScriptedReply;
}

/** The calls one script answered, in order. */
export interface Script {
  readonly calls: readonly RecordedModelCall[];
  /** Resolves once `count` calls of this script have started. */
  called(count: number): Promise<void>;
}

/** A `completeText` call as the double received it. */
export interface RecordedTextCall {
  readonly model: string;
  /** The system block (`completeText`'s `system`). */
  readonly system: string;
  /** The one user message (`completeText`'s `prompt`). */
  readonly prompt: string;
}

/** The `completeText` calls the text script answered, in order (each retry is a call of its own). */
export interface TextScript {
  readonly calls: readonly RecordedTextCall[];
  /** Resolves once `count` calls have started. */
  called(count: number): Promise<void>;
}

export interface ScriptedModel {
  /** The double, for `createAgents({ turnClient })`. */
  readonly turnClient: AgentTurnModelClient;
  /** Every agent call of every script, in order of arrival; `completeText` calls are not among them. */
  readonly calls: readonly RecordedModelCall[];
  /** Adds the replies of one agent. */
  script(key: ScriptKey, replies: readonly ScriptedReply[], options?: ScriptOptions): Script;
  /**
   * Sets the reply to every `completeText` call: an answer (its latch holds the call), or a provider
   * error on every attempt. Without it a `completeText` call fails as a defect of the test.
   */
  completeText(reply: ScriptedAnswer | ScriptedModelError): TextScript;
}

interface ScriptState {
  readonly key: ScriptKey;
  readonly replies: readonly ScriptedReply[];
  readonly thereafter: ScriptedReply | undefined;
  readonly calls: RecordedModelCall[];
  readonly waiters: { count: number; resolve: () => void }[];
}

function describeKey(key: ScriptKey): string {
  return 'task' in key ? `task "${key.task}"` : `agent "${key.agent}"`;
}

function isModelError(reply: ScriptedAnswer | ScriptedModelError): reply is ScriptedModelError {
  return 'kind' in reply && reply.kind === 'model_error';
}

/** The rejection the provider client gives: `ModelClient` reads it by `name` and `statusCode`. */
function providerError(agentName: string, statusCode: number): Error {
  const error = new Error(`Scripted provider error ${statusCode} for agent ${agentName}`);
  error.name = 'AI_APICallError';
  return Object.assign(error, { statusCode });
}

/** Resolves the waiters whose count the calls reached. */
function resolveWaiters(waiters: { count: number; resolve: () => void }[], arrived: number): void {
  for (const waiter of waiters.slice()) {
    if (arrived >= waiter.count) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  }
}

/**
 * Answers a call as the provider would stream it: after the latch (if any), each text part goes to
 * `onText` in order, then the generation with the tool calls `toolCalls` makes and the usage.
 */
async function streamAnswer(
  answer: ScriptedAnswer,
  { signal, onText }: StreamTurnOptions,
  toolCalls: () => AgentToolCall[],
): Promise<AgentTurnGeneration> {
  await answer.latch?.pass(signal);
  signal.throwIfAborted();
  const parts = typeof answer.text === 'string' ? [answer.text] : (answer.text ?? []);
  for (const part of parts) {
    if (part !== '') onText(part);
  }
  const calls = toolCalls();
  return {
    finishReason: calls.length > 0 ? 'tool-calls' : 'stop',
    text: parts.join(''),
    toolCalls: calls,
    usage: { ...DEFAULT_USAGE, ...answer.usage },
  };
}

export function createScriptedModel(): ScriptedModel {
  const scripts: ScriptState[] = [];
  const calls: RecordedModelCall[] = [];
  let nextCallId = 0;

  /** The latest user message equal to a script's task decides; else the definition name; else a defect of the test. */
  function scriptOf(call: AgentTurnCall): ScriptState {
    for (const message of [...call.messages].reverse()) {
      if (message.role !== 'user') continue;
      const byTask = scripts.find((state) => 'task' in state.key && state.key.task === message.content);
      if (byTask !== undefined) return byTask;
    }
    const byAgent = scripts.find((state) => 'agent' in state.key && state.key.agent === call.agentName);
    if (byAgent !== undefined) return byAgent;
    throw new Error(`No script answers a call of agent ${call.agentName}`);
  }

  const textCalls: RecordedTextCall[] = [];
  const textWaiters: { count: number; resolve: () => void }[] = [];
  let textReply: ScriptedAnswer | ScriptedModelError | undefined;

  /** Answers a `completeText` call from the text script. */
  async function answerText(call: AgentTurnCall, options: StreamTurnOptions): Promise<AgentTurnGeneration> {
    const prompt = call.messages[0];
    textCalls.push({
      model: call.model,
      system: call.instructions,
      prompt: prompt?.role === 'user' ? prompt.content : '',
    });
    resolveWaiters(textWaiters, textCalls.length);
    if (textReply === undefined) throw new Error('No text script answers a completeText call');
    if (isModelError(textReply)) throw providerError('completeText', textReply.statusCode);
    return streamAnswer(textReply, options, () => []);
  }

  const turnClient: AgentTurnModelClient = {
    async streamTurn(call, options): Promise<AgentTurnGeneration> {
      if (call.purpose === 'complete_text') return answerText(call, options);
      const state = scriptOf(call);
      const recorded: RecordedModelCall = {
        agentName: call.agentName,
        model: call.model,
        messages: call.messages,
        toolNames: call.tools.map((tool) => tool.name),
        toolCallIds: [],
      };
      calls.push(recorded);
      state.calls.push(recorded);
      const index = state.calls.length - 1;
      resolveWaiters(state.waiters, state.calls.length);

      const reply = state.replies[index] ?? state.thereafter;
      if (reply === undefined) {
        throw new Error(`Script of ${describeKey(state.key)} has no answer for call ${index + 1}`);
      }
      const answer = typeof reply === 'function' ? reply(call.messages) : reply;
      if (isModelError(answer)) throw providerError(call.agentName, answer.statusCode);

      const generation = await streamAnswer(answer, options, () =>
        (answer.calls ?? []).map((scripted) => {
          nextCallId += 1;
          return { toolCallId: `call-${nextCallId}`, toolName: scripted.tool, args: scripted.args };
        }),
      );
      recorded.toolCallIds.push(...generation.toolCalls.map((toolCall) => toolCall.toolCallId));
      return generation;
    },
  };

  return {
    turnClient,
    calls,
    completeText(reply) {
      textReply = reply;
      return {
        calls: textCalls,
        called(count) {
          if (textCalls.length >= count) return Promise.resolve();
          return new Promise<void>((resolve) => textWaiters.push({ count, resolve }));
        },
      };
    },
    script(key, replies, options = {}) {
      const state: ScriptState = {
        key,
        replies,
        thereafter: options.thereafter,
        calls: [],
        waiters: [],
      };
      scripts.push(state);
      return {
        calls: state.calls,
        called(count) {
          if (state.calls.length >= count) return Promise.resolve();
          return new Promise<void>((resolve) => state.waiters.push({ count, resolve }));
        },
      };
    },
  };
}

/**
 * A model input as short literal lines: `user: <text>`, `assistant: <text> [<tool>, …]`,
 * `tool: <tool>, …` — what the tests compare with expected literals.
 */
export function inputLines(messages: readonly AgentTurnMessage[]): string[] {
  return messages.map((message) => {
    switch (message.role) {
      case 'user':
        return `user: ${message.content}`;
      case 'assistant':
        return `assistant: ${message.content} [${message.toolCalls.map((call) => call.toolName).join(', ')}]`;
      case 'tool':
        return `tool: ${message.results.map((result) => result.toolName).join(', ')}`;
    }
  });
}
