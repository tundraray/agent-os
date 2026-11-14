import { createAnthropic } from '@ai-sdk/anthropic';
import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { noopLogger } from '@mastra/core/logger';
import { createTool } from '@mastra/core/tools';
import type { z } from 'zod';

/**
 * The model instance a request agent runs on: an AI SDK model object, never a string id or a
 * `{ id, url }` config (a config with `url` sends Mastra to the OpenAI-compatible client).
 */
export type TurnModel = Extract<MastraModelConfig, { doGenerate: unknown }>;

/** By a catalog model id (`anthropic/…`) returns the model instance; touches no network. */
export type ResolveModel = (modelId: string) => TurnModel;

/** Usage fields of a result as Mastra reports them; a field the provider did not report is null. */
export interface ReportedUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
}

/** The provider options of the message the cache mark ends at: an `ephemeral` cache breakpoint (KD-6). */
const CACHE_MARK = { anthropic: { cacheControl: { type: 'ephemeral' } } } as const;

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
  /** Catalog model id (`anthropic/…`), resolved by the client's `ResolveModel`. */
  readonly model: string;
  readonly instructions: string;
  readonly messages: readonly AgentTurnMessage[];
  readonly tools: readonly AgentToolDefinition[];
  readonly maxOutputTokens: number;
}

/** A resolved turn: its finish reason, text, the tool calls not yet run, and usage. */
export interface AgentTurnGeneration {
  readonly finishReason: string | undefined;
  readonly text: string;
  readonly toolCalls: readonly AgentToolCall[];
  readonly usage: ReportedUsage;
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

/** What one request agent needs: who it is, its system block and model, and the tools the model may call. */
interface RequestAgentConfig {
  readonly id: string;
  readonly name: string;
  readonly instructions: SystemBlock;
  readonly model: TurnModel;
  readonly tools: Record<string, ReturnType<typeof createTool>>;
}

/** A system block that carries the cache mark. */
interface SystemBlock {
  readonly role: 'system';
  readonly content: string;
  readonly providerOptions: typeof CACHE_MARK;
}

/**
 * The agent of one model request (ADR-0001, KD-6): a plain Mastra `Agent` without a `Mastra`
 * instance, memory or storage. `errorProcessorDefaults: false` drops Mastra's default error
 * processors, which retry a provider error on their own — so one `stream` is one request and only
 * `ModelClient` retries. `noopLogger` silences Mastra's console line on a provider error, which
 * carries the request body with the prompt.
 */
function createRequestAgent(config: RequestAgentConfig): Agent {
  const agent = new Agent({ ...config, errorProcessorDefaults: false });
  agent.__setLogger(noopLogger);
  return agent;
}

/** The usage of a result, each field the provider did not report as null. */
function reportedUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
}): ReportedUsage {
  return {
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    cachedInputTokens: usage.cachedInputTokens ?? null,
    cacheCreationInputTokens: usage.cacheCreationInputTokens ?? null,
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
function withCacheMark(sent: ReturnType<typeof turnMessage>) {
  if (sent.role !== 'tool') return { ...sent, providerOptions: CACHE_MARK };
  const last = sent.content.length - 1;
  return {
    ...sent,
    content: sent.content.map((part, index) => (index === last ? { ...part, providerOptions: CACHE_MARK } : part)),
  };
}

/** The session messages of a turn; the cache mark ends at the last one, so the provider caches the session so far. */
function turnMessages(messages: readonly AgentTurnMessage[]) {
  return messages.map((message, index) => {
    const sent = turnMessage(message);
    return index === messages.length - 1 ? withCacheMark(sent) : sent;
  });
}

/** The tools as Mastra tools without `execute`: the model may call them, Mastra cannot run them. */
function turnTools(tools: readonly AgentToolDefinition[]): Record<string, ReturnType<typeof createTool>> {
  return Object.fromEntries(
    tools.map(({ name, description, inputSchema }) => [name, createTool({ id: name, description, inputSchema })]),
  );
}

/** The request agent of one turn: its system block with the cache mark, its model and its tools. */
function turnAgent(call: AgentTurnCall, model: TurnModel): Agent {
  return createRequestAgent({
    id: `agent-${call.agentName}`,
    name: `Agent ${call.agentName}`,
    instructions: { role: 'system', content: call.instructions, providerOptions: CACHE_MARK },
    model,
    tools: turnTools(call.tools),
  });
}

/** Hands every non-empty part of the text stream to `onText`, in order, until the stream ends. */
async function readTextParts(textStream: AsyncIterable<string>, onText: (text: string) => void): Promise<void> {
  for await (const part of textStream) {
    if (part !== '') onText(part);
  }
}

/**
 * The production turn client: a new request agent per turn, `Agent.stream` with `maxSteps: 1`, so one
 * stream is one request and its tool calls come back as data (ADR-0001, KD-3, KD-6). Each part of
 * `textStream` goes to `onText`; the text, tool calls and usage come from the output's promises. A
 * provider error ends `textStream` without an exception: Mastra keeps it as the output's `error` (what
 * `generate` throws after reading the whole stream), so it is thrown here and `ModelClient` retries it.
 * The system block carries the cache mark, so the tools and instructions before it are cached.
 */
export function createMastraTurnClient(resolveModel: ResolveModel): AgentTurnModelClient {
  return {
    async streamTurn(call, { signal, onText }) {
      const agent = turnAgent(call, resolveModel(call.model));
      const output = await agent.stream(turnMessages(call.messages), {
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
      return {
        finishReason,
        text,
        toolCalls: toolCalls.map(({ payload }) => ({
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          args: payload.args,
        })),
        usage: reportedUsage(usage),
      };
    },
  };
}

const ANTHROPIC_PREFIX = 'anthropic/';

/** Where the Anthropic Messages API is and the key it takes. */
export interface AnthropicSettings {
  readonly anthropicBaseUrl: string;
  readonly anthropicApiKey: string;
}

/**
 * The `ResolveModel` of the package: an Anthropic Messages client from `@ai-sdk/anthropic` on the
 * unversioned base plus `/v1`, and the model by its id without the `anthropic/` prefix. Not a Mastra
 * model config with `url` — that sends the call to the OpenAI-compatible `/chat/completions`. Building
 * a model touches no network; an id of another provider throws.
 */
export function createResolveModel(settings: AnthropicSettings): ResolveModel {
  const anthropic = createAnthropic({
    baseURL: `${settings.anthropicBaseUrl.replace(/\/+$/, '')}/v1`,
    apiKey: settings.anthropicApiKey,
  });
  return (modelId) => {
    if (!modelId.startsWith(ANTHROPIC_PREFIX)) {
      throw new Error(`model ${modelId} is not an Anthropic model: only ${ANTHROPIC_PREFIX}… ids resolve`);
    }
    return anthropic(modelId.slice(ANTHROPIC_PREFIX.length));
  };
}
