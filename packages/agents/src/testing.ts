import { randomUUID } from 'node:crypto';

import {
  ModelProviderKindSchema,
  type ModelProviderState,
  type RecordBody,
  type RecordHeader,
  type ResolvedRecord,
  type ToolCallState,
  type ToolOutcome,
  type ToolRefusalReason,
} from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { CallUsage, ModelPrice } from '@agent-os/runtime';

import type { AccessGate, EmbeddingVerdict, ModelVerdict } from './access-gate';
import type { EmbeddingClient } from './embeddings/embedding-client';
import { foldCalls } from './history/call-state';
import { history } from './store/history.repository';
import type { EmbeddingInputType } from './providers/adapters';
import type { ProviderReadiness } from './providers/provider-readiness';
import type { AgentsProviders } from './providers/provider-registry';
import type { RecordLibrary } from './start/record-library';
import type {
  AgentToolCall,
  AgentTurnCall,
  AgentTurnGeneration,
  AgentTurnMessage,
  AgentTurnModelClient,
  StreamTurnOptions,
} from './model/mastra-turn';

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

/** The largest `seq` a history can have: `agent_messages.seq` is a Postgres `integer`. */
const MAX_SEQ = 2_147_483_647;

/** Usage of an answer that names none: below any compaction threshold of the tests. */
export const DEFAULT_USAGE: CallUsage = {
  inputTokens: 1_000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
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
  readonly usage?: Partial<CallUsage>;
  readonly latch?: Latch;
  /** The answer ends at the output length limit: the double reports `finishReason: 'length'` (KD-3). */
  readonly cutOff?: true;
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
  /** The system text exactly as the provider would get it: the definition's prompt, the knowledge block, the standing rules. */
  readonly instructions: string;
  /** The session's messages exactly as the provider would get them. */
  readonly messages: readonly AgentTurnMessage[];
  /** Names of the tools offered to the model. */
  readonly toolNames: readonly string[];
  /** The description of each offered tool, by name, exactly as the provider would get it. */
  readonly toolDescriptions: Readonly<Record<string, string>>;
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

/** The rejection the provider client gives: `classifyRejection` reads it by `name`, `statusCode` and `responseBody`. */
function providerError(caller: string, statusCode: number, responseBody?: string): Error {
  const error = new Error(`Scripted provider error ${statusCode} for ${caller}`);
  error.name = 'AI_APICallError';
  return Object.assign(error, { statusCode }, responseBody === undefined ? {} : { responseBody });
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
    finishReason: answer.cutOff ? 'length' : calls.length > 0 ? 'tool-calls' : 'stop',
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
        instructions: call.instructions,
        messages: call.messages,
        toolNames: call.tools.map((tool) => tool.name),
        toolDescriptions: Object.fromEntries(call.tools.map((tool) => [tool.name, tool.description])),
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
      if (isModelError(answer)) throw providerError(`agent ${call.agentName}`, answer.statusCode);

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

/** Input tokens the scripted embeddings report per text. */
const SCRIPTED_EMBEDDING_TOKENS_PER_TEXT = 10;

/** An embeddings request as the double received it; `apiKey` is the double registry's test key. */
export interface RecordedEmbeddingCall {
  /** `<provider>/<name at the provider>`: the catalogue id the service called. */
  readonly model: string;
  readonly apiKey: string | null;
  readonly texts: readonly string[];
  readonly inputType: EmbeddingInputType;
  readonly dimensions: number;
}

/**
 * The embeddings seam double (ADR-0004), for `createAgents({ embeddingClient })`: it stands below the service,
 * so the batches, retries, ledger rows and checks are the package's own. The switches are read on every call.
 */
export interface ScriptedEmbeddings {
  readonly client: EmbeddingClient;
  /** Every request in order of arrival; each retry is a request of its own. */
  readonly calls: readonly RecordedEmbeddingCall[];
  /** The provider reports no token count. */
  withoutTokenCount: boolean;
  /** The vectors have this length instead of the requested dimensions; `null` — the requested ones. */
  vectorLength: number | null;
  /** Every request is rejected as the provider client does, with this status and body; `null` — none. */
  failure: { readonly statusCode: number; readonly body?: string } | null;
  /**
   * The vector of a text on a model (the catalogue id), over the length rule: closeness by meaning is
   * arranged by the text; `null` — the length rule. Its length is the test's, `vectorLength` does not apply.
   */
  vectorOf: ((text: string, model: string) => readonly number[]) | null;
}

/**
 * Answers each text with `vectorOf`'s vector, or else with a vector whose component `j` is the text's length
 * plus `j` — not of unit length, so the service's scaling shows — and `SCRIPTED_EMBEDDING_TOKENS_PER_TEXT`
 * input tokens per text.
 */
export function createScriptedEmbeddings(): ScriptedEmbeddings {
  const calls: RecordedEmbeddingCall[] = [];
  const scripted: ScriptedEmbeddings = {
    calls,
    withoutTokenCount: false,
    vectorLength: null,
    failure: null,
    vectorOf: null,
    client: {
      async embed({ connection, modelName, texts, inputType, dimensions, signal }) {
        signal.throwIfAborted();
        const model = `${connection.name}/${modelName}`;
        calls.push({ model, apiKey: connection.apiKey, texts, inputType, dimensions });
        const { failure, vectorOf } = scripted;
        if (failure !== null) throw providerError(`embeddings of ${model}`, failure.statusCode, failure.body);
        const length = scripted.vectorLength ?? dimensions;
        const byLength = (text: string) => Array.from({ length }, (_, index) => text.length + index);
        return {
          vectors: texts.map((text) => (vectorOf === null ? byLength(text) : [...vectorOf(text, model)])),
          inputTokens: scripted.withoutTokenCount ? null : texts.length * SCRIPTED_EMBEDDING_TOKENS_PER_TEXT,
        };
      },
    },
  };
  return scripted;
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

/** What the access gate double answers (plan Notes 6): the shape of the old access table plus literal prices. */
export interface AccessGateDoubleOptions {
  /** `{ <owner id> | '*': [<server>, …] }`: every tool of a listed server is allowed; no row — no servers. */
  readonly servers?: Readonly<Record<string, readonly string[]>>;
  /** The catalogue: a model with a price is allowed at it, any other is `model_not_connected`. */
  readonly prices: Readonly<Record<string, ModelPrice>>;
  /**
   * Owners the gate answers `owner_disabled` for, tools and models alike; read on every question, so a
   * test may refuse an owner mid-run by adding to the array it passed.
   */
  readonly refusedOwners?: readonly string[];
  /** A refusal per model for every owner, such as `quota_exhausted`; it goes before the catalogue. */
  readonly refusedModels?: Readonly<Record<string, ModelRefusal>>;
  /**
   * `{ <owner id>: { <model>: <refusal> } }`: a refusal of a model for one owner, before `refusedModels`;
   * read on every question, so a test may withdraw a model from an owner mid-run by adding to the object.
   */
  readonly ownerModelRefusals?: Readonly<Record<string, Readonly<Record<string, ModelRefusal>>>>;
  /** The default chat model; `null` (no model chosen) by default. */
  readonly defaultChatModel?: string | null;
  /**
   * What `embedding` answers an owner that is not refused; `model_not_configured` by default. Asked on every
   * question, so a test may switch the embedding model, or take it away, mid-run.
   */
  readonly embedding?: () => EmbeddingVerdict;
}

type ModelRefusal = Extract<ModelVerdict, { readonly kind: 'refused' }>;

/** Row of the `servers` option whose servers every owner has. */
const EVERY_OWNER = '*';

/**
 * An `AccessGate` for the package's tests (ADR-0004: a double of the package's own contract): rights by
 * server from a table, prices from literals, no database. `apps/api` implements the real one over its tables.
 */
export function createAccessGateDouble(options: AccessGateDoubleOptions): AccessGate {
  const disabled = (ownerId: string): boolean => options.refusedOwners?.includes(ownerId) === true;
  const serversOf = (ownerId: string): ReadonlySet<string> =>
    new Set([...(options.servers?.[ownerId] ?? []), ...(options.servers?.[EVERY_OWNER] ?? [])]);
  return {
    async tools(ownerId) {
      if (disabled(ownerId)) return { kind: 'owner_disabled' };
      const servers = serversOf(ownerId);
      return { kind: 'allowed', allows: (server) => servers.has(server) };
    },
    async model(ownerId, model) {
      if (disabled(ownerId)) return { kind: 'refused', reason: 'owner_disabled' };
      const refusal = options.ownerModelRefusals?.[ownerId]?.[model] ?? options.refusedModels?.[model];
      if (refusal !== undefined) return refusal;
      const price = options.prices[model];
      return price === undefined
        ? { kind: 'refused', reason: 'model_not_connected' }
        : { kind: 'allowed', price };
    },
    async defaultChatModel() {
      return options.defaultChatModel ?? null;
    },
    async embedding(ownerId) {
      if (ownerId !== null && disabled(ownerId)) return { kind: 'refused', reason: 'owner_disabled' };
      return options.embedding?.() ?? { kind: 'refused', reason: 'model_not_configured' };
    },
  };
}

/** The key every provider of the registry double has, unless it is `key_missing`. */
const DOUBLE_PROVIDER_KEY = 'test-provider-key';

/**
 * The provider registry as `ModelClient` and the start read it (ADR-0004: a double of the package's own
 * contract), without a database. `states` names the registered providers and the state of each; any other
 * name is `missing`. A provider named after a kind (`anthropic`, `gemini`, `openai_compatible`) is of that
 * kind, any other is `anthropic`. Read on every call, so a test may change a state mid-run.
 */
export function createProviderRegistryDouble(
  states: Readonly<Record<string, ModelProviderState>>,
): Pick<AgentsProviders, 'connection' | 'readiness'> {
  return {
    async connection(name) {
      const state = states[name];
      if (state === undefined) return null;
      const kind = ModelProviderKindSchema.safeParse(name);
      return {
        name,
        kind: kind.success ? kind.data : 'anthropic',
        baseUrl: `http://${name}.provider.test`,
        apiKey: state === 'key_missing' ? null : DOUBLE_PROVIDER_KEY,
        enabled: state !== 'disabled',
      };
    },
    async readiness(names) {
      return new Map(names.map((name): [string, ProviderReadiness] => [name, states[name] ?? 'missing']));
    },
  };
}

/** A record the library double holds: its kind and content, its owner and who sees it. */
export type LibraryDoubleRecord = RecordBody & {
  /** A fresh uuid when omitted. */
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
  /** `null` — a system record. */
  readonly ownerId: string | null;
  /** The author's name; the owner id when omitted. */
  readonly ownerName?: string;
  /** Every employee sees it. */
  readonly everyone?: boolean;
  /** Employees besides the owner who see it. */
  readonly viewers?: readonly string[];
  /** The record has holders (AC-18.5). */
  readonly shared?: boolean;
  readonly offerInChat?: boolean;
  readonly builtinKey?: string | null;
};

/** What `edit` changes; the kind of a new body must be the record's kind. */
export interface LibraryDoubleEdit {
  readonly name?: string;
  readonly description?: string;
  readonly body?: RecordBody;
}

/**
 * The `RecordLibrary` double (ADR-0004; design-runtime.md, «Порт `RecordLibrary`»): records in memory and
 * the changes an author or an admin makes while runs go on. A record is visible to its owner always, to
 * others while it is not closed or hidden from them and they are its audience.
 */
export interface LibraryDouble extends RecordLibrary {
  /** Adds a record at version 1 and returns its id. */
  add(record: LibraryDoubleRecord): string;
  /** Saves a new version. */
  edit(recordId: string, change: LibraryDoubleEdit): void;
  remove(recordId: string): void;
  /** An admin closes the record: only its owner sees it. */
  close(recordId: string): void;
  /** The viewer stops seeing the record, as one taken out of its role. */
  hideFrom(recordId: string, viewerId: string): void;
  /** Every `resolve` call in order: who asked for which record. */
  readonly resolveCalls: readonly { readonly viewerId: string; readonly recordId: string }[];
}

interface StoredRecord {
  readonly id: string;
  name: string;
  description: string;
  version: number;
  body: RecordBody;
  readonly ownerId: string | null;
  readonly ownerName: string;
  readonly everyone: boolean;
  readonly viewers: ReadonlySet<string>;
  readonly hiddenFrom: Set<string>;
  closed: boolean;
  readonly shared: boolean;
  readonly offerInChat: boolean;
  readonly builtinKey: string | null;
}

export function createLibraryDouble(): LibraryDouble {
  const records = new Map<string, StoredRecord>();
  const resolveCalls: { viewerId: string; recordId: string }[] = [];

  function stored(recordId: string): StoredRecord {
    const record = records.get(recordId);
    if (record === undefined) throw new Error(`The library double holds no record ${recordId}`);
    return record;
  }

  function visibleTo(record: StoredRecord, viewerId: string): boolean {
    if (record.ownerId === viewerId) return true;
    if (record.closed || record.hiddenFrom.has(viewerId)) return false;
    return record.everyone || record.viewers.has(viewerId);
  }

  function headerOf(record: StoredRecord, viewerId: string): RecordHeader {
    return {
      id: record.id,
      kind: record.body.kind,
      name: record.name,
      description: record.description,
      version: record.version,
      builtinKey: record.builtinKey,
      author:
        record.ownerId === null ? null : { id: record.ownerId, name: record.ownerName, disabled: false },
      mine: record.ownerId === viewerId,
      shared: record.shared,
      offerInChat: record.offerInChat,
    };
  }

  function resolvedOf(record: StoredRecord | undefined, viewerId: string): ResolvedRecord | null {
    if (record === undefined || !visibleTo(record, viewerId)) return null;
    const { kind: _kind, ...header } = headerOf(record, viewerId);
    return { ...header, ...structuredClone(record.body) };
  }

  return {
    resolveCalls,
    add(record) {
      const id = record.id ?? randomUUID();
      if (records.has(id)) throw new Error(`The library double already holds record ${id}`);
      const body: RecordBody =
        record.kind === 'agent'
          ? { kind: 'agent', content: record.content }
          : { kind: 'workflow', content: record.content };
      records.set(id, {
        id,
        name: record.name,
        description: record.description ?? `${record.name} description`,
        version: 1,
        body: structuredClone(body),
        ownerId: record.ownerId,
        ownerName: record.ownerName ?? record.ownerId ?? 'system',
        everyone: record.everyone ?? false,
        viewers: new Set(record.viewers ?? []),
        hiddenFrom: new Set(),
        closed: false,
        shared: record.shared ?? false,
        offerInChat: record.offerInChat ?? false,
        builtinKey: record.builtinKey ?? null,
      });
      return id;
    },
    edit(recordId, change) {
      const record = stored(recordId);
      if (change.body !== undefined && change.body.kind !== record.body.kind) {
        throw new Error(`Record ${recordId} is a ${record.body.kind}, not a ${change.body.kind}`);
      }
      record.name = change.name ?? record.name;
      record.description = change.description ?? record.description;
      record.body = change.body === undefined ? record.body : structuredClone(change.body);
      record.version += 1;
    },
    remove(recordId) {
      stored(recordId);
      records.delete(recordId);
    },
    close(recordId) {
      stored(recordId).closed = true;
    },
    hideFrom(recordId, viewerId) {
      stored(recordId).hiddenFrom.add(viewerId);
    },
    async resolve(viewerId, recordId) {
      resolveCalls.push({ viewerId, recordId });
      return resolvedOf(records.get(recordId), viewerId);
    },
    async resolveBuiltin(viewerId, builtinKey) {
      const record = [...records.values()].find((candidate) => candidate.builtinKey === builtinKey);
      return resolvedOf(record, viewerId);
    },
    async listVisible(viewerId) {
      return [...records.values()]
        .filter((record) => visibleTo(record, viewerId))
        .map((record) => headerOf(record, viewerId));
    },
  };
}

/** A tool call of an agent as the integration tests assert it: the call of its answer with what its records say. */
export interface ToolCallRow {
  readonly taskId: string;
  readonly callId: string;
  readonly answerSeq: number;
  readonly position: number;
  readonly tool: string;
  readonly server: string | null;
  readonly args: unknown;
  readonly state: ToolCallState;
  readonly outcome: ToolOutcome | null;
  readonly refusalReason: ToolRefusalReason | null;
  readonly refusalDetail: { readonly model: string } | null;
  readonly resultText: string | null;
  readonly childTaskId: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  /** How many attempts of a `run_code` read run started. */
  readonly attempts: number;
  readonly output: string | null;
}

/**
 * The tool calls of an agent, by answer and position, folded from its whole history in `agent_messages`
 * by the package's own `foldCalls` — one row per call, whatever was compacted since.
 */
export async function toolCallRowsOf(db: Database, agentId: string): Promise<ToolCallRow[]> {
  const entries = await history.through(db, agentId, MAX_SEQ);
  return foldCalls(entries).map(({ sentAt, result, ...call }) => {
    const startedAt = sentAt ?? result?.startedAt ?? null;
    return {
      taskId: agentId,
      ...call,
      outcome: result?.outcome ?? null,
      refusalReason: result?.refusalReason ?? null,
      refusalDetail: result?.refusalDetail ?? null,
      resultText: result?.text ?? null,
      childTaskId: result?.childTaskId ?? null,
      startedAt: startedAt === null ? null : new Date(startedAt),
      finishedAt: result?.finishedAt == null ? null : new Date(result.finishedAt),
      output: result?.output ?? null,
    };
  });
}
