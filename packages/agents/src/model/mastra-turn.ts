import type { CallUsage } from '@agent-os/runtime';
import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { noopLogger } from '@mastra/core/logger';
import { createTool } from '@mastra/core/tools';
import type { z } from 'zod';

import { type ProviderOptions, providerAdapter } from '../providers/adapters';
import type { ProviderConnection } from '../providers/provider-registry';

/**
 * The model instance a request agent runs on: an AI SDK model object, never a string id or a
 * `{ id, url }` config (a config with `url` sends Mastra to the OpenAI-compatible client).
 */
export type TurnModel = Extract<MastraModelConfig, { doGenerate: unknown }>;

/** The JSON Schema of an object, as an MCP server lists the arguments of its tool. */
export interface JsonSchemaObject {
  readonly type: 'object';
  readonly [keyword: string]: unknown;
}

/**
 * One tool as the model sees it: its name, description and argument schema — a zod schema of a
 * built-in tool or the JSON Schema an MCP server listed, sent unchanged (KD-6). It has no
 * `execute`: the package checks and runs the call itself.
 */
export interface AgentToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown> | JsonSchemaObject;
}

/** One tool call of a model answer, as the model wrote it; its arguments are not checked yet. */
export interface AgentToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
}

/** A JSON value: what a tool result carries back to the model. */
export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

/** The result of one tool call, as the session hands it back to the model. */
export interface AgentToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: JsonValue;
}

/** One message of an agent session: a text, a model answer with its tool calls, or the results of those calls. */
export type AgentTurnMessage =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string; readonly toolCalls: readonly AgentToolCall[] }
  | { readonly role: 'tool'; readonly results: readonly AgentToolResult[] };

/**
 * Why the package calls the model: a turn of an agent session, or a one-off `completeText` outside any
 * task (the conversation title) — the scripted double of the tests answers the two from separate scripts.
 */
export type TurnPurpose = 'agent_turn' | 'complete_text';

/** What one turn of an agent sends: one request with its tools, none of them executable. */
export interface AgentTurnCall {
  readonly purpose: TurnPurpose;
  readonly agentName: string;
  /** Catalog model id `<provider>/<model name>`; the name goes to the adapter of the connection's kind. */
  readonly model: string;
  /**
   * The model provider's connection read from its row for this call (KD-1, KD-2): the address and key the
   * request goes with. It carries the key, so it is never logged or recorded.
   */
  readonly connection: ProviderConnection;
  readonly instructions: string;
  readonly messages: readonly AgentTurnMessage[];
  readonly tools: readonly AgentToolDefinition[];
  readonly maxOutputTokens: number;
}

/** A resolved turn: its finish reason, text, the tool calls not yet run, and usage as the ledger takes it. */
export interface AgentTurnGeneration {
  readonly finishReason: string | undefined;
  readonly text: string;
  readonly toolCalls: readonly AgentToolCall[];
  readonly usage: CallUsage;
}

/** How a streamed turn is watched: its cancel and the receiver of each text part, in order (KD-3). */
export interface StreamTurnOptions {
  readonly signal: AbortSignal;
  readonly onText: (text: string) => void;
}

/**
 * The model client of an agent turn: one streamed request that hands each text part to `onText` and
 * returns the tool calls instead of running them. A provider error rejects the returned promise.
 */
export interface AgentTurnModelClient {
  streamTurn(call: AgentTurnCall, options: StreamTurnOptions): Promise<AgentTurnGeneration>;
}

/**
 * Usage as the ledger takes it: Mastra's `inputTokens` is the whole input, the cached parts included.
 * A field the provider did not report counts as zero.
 */
function callUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
}): CallUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cachedInputTokens ?? 0,
    cacheWriteTokens: usage.cacheCreationInputTokens ?? 0,
  };
}

/** One session message in the form `stream` sends it. */
function turnMessage(message: AgentTurnMessage) {
  switch (message.role) {
    case 'user':
      return { role: 'user' as const, content: message.content };
    case 'assistant':
      return {
        role: 'assistant' as const,
        content: [
          ...(message.content === '' ? [] : [{ type: 'text' as const, text: message.content }]),
          ...message.toolCalls.map(({ toolCallId, toolName, args }) => ({
            type: 'tool-call' as const,
            toolCallId,
            toolName,
            input: args,
          })),
        ],
      };
    case 'tool':
      return {
        role: 'tool' as const,
        content: message.results.map(({ toolCallId, toolName, output }) => ({
          type: 'tool-result' as const,
          toolCallId,
          toolName,
          output: { type: 'json' as const, value: output },
        })),
      };
  }
}

/**
 * The cache mark on a sent message. Mastra drops the message-level provider options of a `tool`
 * message, so there the mark goes on its last result part, where the provider reads it the same way
 * (KD-6). Mastra copies a result part's options onto the tool call it answers, so the answer just
 * before carries a mark too: three breakpoints with the system block, within the provider's four.
 */
function withCacheMark(sent: ReturnType<typeof turnMessage>, cacheMark: ProviderOptions) {
  if (sent.role !== 'tool') return { ...sent, providerOptions: cacheMark };
  const last = sent.content.length - 1;
  return {
    ...sent,
    content: sent.content.map((part, index) => (index === last ? { ...part, providerOptions: cacheMark } : part)),
  };
}

/**
 * The session messages of a turn. With the adapter's cache mark it ends at the last one, so the provider
 * caches the session so far; without one (the provider caches the request's start itself) none is marked.
 */
function turnMessages(messages: readonly AgentTurnMessage[], cacheMark: ProviderOptions | null) {
  return messages.map((message, index) => {
    const sent = turnMessage(message);
    return cacheMark !== null && index === messages.length - 1 ? withCacheMark(sent, cacheMark) : sent;
  });
}

/** The model name of a catalog id: the part after the first slash (the provider is the part before). */
function modelName(modelId: string): string {
  return modelId.slice(modelId.indexOf('/') + 1);
}

/** The tools as Mastra tools without `execute`: the model may call them, Mastra cannot run them. */
function turnTools(tools: readonly AgentToolDefinition[]): Record<string, ReturnType<typeof createTool>> {
  return Object.fromEntries(
    tools.map(({ name, description, inputSchema }) => [name, createTool({ id: name, description, inputSchema })]),
  );
}

/** Hands every non-empty part of the text stream to `onText`, in order, until the stream ends. */
async function readTextParts(textStream: AsyncIterable<string>, onText: (text: string) => void): Promise<void> {
  for await (const part of textStream) {
    if (part !== '') onText(part);
  }
}

/**
 * The production turn client: a new request agent per turn — a plain Mastra `Agent` without a `Mastra`
 * instance, memory or storage — and `Agent.stream` with `maxSteps: 1`, so one stream is one request and
 * its tool calls come back as data (ADR-0001, KD-3, KD-6). `errorProcessorDefaults: false` drops
 * Mastra's default error processors, which retry a provider error on their own, so only `ModelClient`
 * retries. `noopLogger` silences Mastra's console line on a provider error, which carries the request
 * body with the prompt. Each part of `textStream` goes to `onText`; the text, tool calls and usage come
 * from the output's promises. A provider error ends `textStream` without an exception: Mastra keeps it
 * as the output's `error` (what `generate` throws after reading the whole stream), so it is thrown here
 * and `ModelClient` retries it. A cancel ends the stream the same quiet way, with the finish reason
 * `aborted` and no usage, so it is thrown too. The model and the cache mark come from the adapter of the
 * connection's kind, built per call from the connection's address and key (KD-1, KD-3); the client reads
 * no settings. When the adapter gives a mark, the system block carries it, so the tools and instructions
 * before it are cached.
 */
export function createMastraTurnClient(): AgentTurnModelClient {
  return {
    async streamTurn(call, { signal, onText }) {
      const adapter = providerAdapter(call.connection.kind);
      const agent = new Agent({
        id: `agent-${call.agentName}`,
        name: `Agent ${call.agentName}`,
        instructions: {
          role: 'system',
          content: call.instructions,
          ...(adapter.cacheMark === null ? {} : { providerOptions: adapter.cacheMark }),
        },
        model: adapter.languageModel(call.connection, modelName(call.model)),
        tools: turnTools(call.tools),
        errorProcessorDefaults: false,
      });
      agent.__setLogger(noopLogger);
      const output = await agent.stream(turnMessages(call.messages, adapter.cacheMark), {
        maxSteps: 1,
        modelSettings: { maxOutputTokens: call.maxOutputTokens },
        abortSignal: signal,
      });
      await readTextParts(output.textStream, onText);
      if (output.error !== undefined) throw output.error;
      const [text, toolCalls, usage, finishReason] = await Promise.all([
        output.text,
        output.toolCalls,
        output.usage,
        output.finishReason,
      ]);
      // Mastra ends a cancelled stream as an answer without usage; it is not one, so the cancel is thrown.
      if (finishReason === 'aborted') signal.throwIfAborted();
      return {
        finishReason,
        text,
        toolCalls: toolCalls.map(({ payload }) => ({
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          args: payload.args,
        })),
        usage: callUsage(usage),
      };
    },
  };
}
