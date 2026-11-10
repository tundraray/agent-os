import { Agent } from '@mastra/core/agent';
import { noopLogger } from '@mastra/core/logger';
import { createTool } from '@mastra/core/tools';
import type { z } from 'zod';
import type { RoleModel } from '../ports.js';
import type { CountedTool, RoleEffort, RoleMessage } from './token-counter.js';

/** What one role call sends through its agent. */
export interface RoleCall<T> {
  readonly role: string;
  readonly model: RoleModel;
  readonly instructions: string;
  readonly messages: readonly RoleMessage[];
  readonly outputSchema: z.ZodType<T>;
  readonly effort: RoleEffort;
  readonly maxOutputTokens: number;
}

/** Usage fields of a result as Mastra reports them; a field the provider did not report is null. */
export interface ReportedUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
}

/** A resolved `generate`: its finish reason, structured output (not yet checked), raw text and usage. */
export interface RoleGeneration {
  readonly finishReason: string | undefined;
  readonly object: unknown;
  /** `FullOutput.text` of the result; empty when the provider returned no text. */
  readonly text: string;
  readonly usage: ReportedUsage;
}

/** The provider options of the message the cache mark ends at: an `ephemeral` cache breakpoint (KD-6). */
const CACHE_MARK = { anthropic: { cacheControl: { type: 'ephemeral' } } } as const;

/** One message as the role agent sends it to the provider; the transcript stores the same form. */
export type ProviderMessage =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string };

/** The messages of a call in the form `generate` sends them. */
export function providerMessages(messages: readonly RoleMessage[]): ProviderMessage[] {
  return messages.map(({ role, content }) => (role === 'user' ? { role: 'user', content } : { role: 'assistant', content }));
}

/**
 * The model client of `ModelGateway`: one `generate` of a role agent. A provider error rejects
 * (`AI_APICallError`); an aborted call or a refusal resolves (design-engine.md, Error handling).
 */
export interface RoleModelClient {
  generate<T>(call: RoleCall<T>, signal: AbortSignal): Promise<RoleGeneration>;
}

/** What one request agent needs: who it is, its system block and model, and the tools the model may call. */
interface RequestAgentConfig {
  readonly id: string;
  readonly name: string;
  readonly instructions: string | SystemBlock;
  readonly model: RoleModel;
  readonly tools?: Record<string, ReturnType<typeof createTool>>;
}

/** A system block that carries the cache mark. */
interface SystemBlock {
  readonly role: 'system';
  readonly content: string;
  readonly providerOptions: typeof CACHE_MARK;
}

/**
 * The agent of one model request (KD-7, KD-1): a plain Mastra `Agent` without a `Mastra` instance, memory or
 * sub-agents, on the model instance from `resolveModel`. `errorProcessorDefaults: false` drops Mastra's default error
 * processors, which retry a provider error on their own past any reservation — so one `generate` is one request and
 * only `ModelGateway` retries. `noopLogger` silences Mastra's console line on a provider error, which carries the
 * request body with the prompt.
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

/** The production client: one role agent per call, structured output in the native JSON format. */
export const mastraRoleModelClient: RoleModelClient = {
  async generate(call, signal) {
    const agent = createRequestAgent({
      id: `research-${call.role}`,
      name: `Research ${call.role}`,
      instructions: call.instructions,
      model: call.model,
    });
    const result = await agent.generate(providerMessages(call.messages), {
      // `warn` resolves an output the schema refuses instead of rejecting; ModelGateway checks it.
      structuredOutput: { schema: call.outputSchema, errorStrategy: 'warn' },
      modelSettings: { maxOutputTokens: call.maxOutputTokens },
      providerOptions: { anthropic: { effort: call.effort } },
      abortSignal: signal,
    });
    return {
      finishReason: result.finishReason,
      object: result.object,
      text: result.text,
      usage: reportedUsage(result.usage),
    };
  },
};

/**
 * One tool of the agent definition as the model sees it: its name, description and argument schema. It has no
 * `execute`: the engine checks and runs the call itself (KD-1).
 */
export interface AgentToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
}

/** One tool call of a model answer, as the model wrote it; its arguments are not checked yet. */
export interface AgentToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
}

/** A JSON value: what a tool result carries back to the model. */
export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

/** The result of one tool call the engine ran, as the session hands it back to the model. */
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

/** `auto` lets the model choose among the tools; a named tool forces it (the last turn forces `finish`). */
export type AgentToolChoice = 'auto' | { readonly toolName: string };

/** What one turn of an agent sends: one request with the definition tools, none of them executable. */
export interface AgentTurnCall {
  readonly agentName: string;
  readonly model: RoleModel;
  readonly instructions: string;
  readonly messages: readonly AgentTurnMessage[];
  readonly tools: readonly AgentToolDefinition[];
  readonly toolChoice: AgentToolChoice;
  readonly effort: RoleEffort;
  readonly maxOutputTokens: number;
}

/** A resolved turn: its finish reason, text, the tool calls not yet run, and usage. */
export interface AgentTurnGeneration {
  readonly finishReason: string | undefined;
  readonly text: string;
  readonly toolCalls: readonly AgentToolCall[];
  readonly usage: ReportedUsage;
}

/** The model client of an agent turn: one request that returns the tool calls instead of running them (KD-1). */
export interface AgentTurnModelClient {
  generateTurn(call: AgentTurnCall, signal: AbortSignal): Promise<AgentTurnGeneration>;
}

/** One session message in the form `generate` sends it. */
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
 * The cache mark on a sent message. Mastra drops the message-level provider options of a `tool` message, so there the
 * mark goes on its last result part, where the provider reads it the same way (KD-6, AC-21.1). Mastra copies a result
 * part's options onto the tool call it answers, so the answer just before carries a mark too: three breakpoints with the
 * system block, within the provider's four, and none left on an older turn.
 */
function withCacheMark(sent: ReturnType<typeof turnMessage>) {
  if (sent.role !== 'tool') return { ...sent, providerOptions: CACHE_MARK };
  const last = sent.content.length - 1;
  return { ...sent, content: sent.content.map((part, index) => (index === last ? { ...part, providerOptions: CACHE_MARK } : part)) };
}

/** The session messages of a turn; the cache mark ends at the last one, so the provider caches the session so far (KD-6). */
function turnMessages(messages: readonly AgentTurnMessage[]) {
  return messages.map((message, index) => {
    const sent = turnMessage(message);
    return index === messages.length - 1 ? withCacheMark(sent) : sent;
  });
}

/** The definition tools as Mastra tools without `execute`: the model may call them, Mastra cannot run them. */
function turnTools(tools: readonly AgentToolDefinition[]): Record<string, ReturnType<typeof createTool>> {
  return Object.fromEntries(
    tools.map(({ name, description, inputSchema }) => [name, createTool({ id: name, description, inputSchema })]),
  );
}

/** The request agent of one turn: its system block with the cache mark, its model and the definition tools. */
function turnAgent(call: Pick<AgentTurnCall, 'agentName' | 'model' | 'instructions' | 'tools'>): Agent {
  return createRequestAgent({
    id: `agent-${call.agentName}`,
    name: `Agent ${call.agentName}`,
    instructions: { role: 'system', content: call.instructions, providerOptions: CACHE_MARK },
    model: call.model,
    tools: turnTools(call.tools),
  });
}

/**
 * The tools of a turn as the provider counts them, in their order, with the JSON schemas of their arguments exactly as
 * `mastraAgentTurnClient` sends them on `model` (DC-30): the same request agent builds the same tools with the
 * compatibility layer of that model, so the count of a turn takes the bytes its request sends, not the schema as zod
 * writes it.
 */
export async function countedTurnTools(model: RoleModel, tools: readonly AgentToolDefinition[]): Promise<CountedTool[]> {
  const built = await turnAgent({ agentName: 'count', model, instructions: '', tools }).getToolsForExecution({});
  return tools.map(({ name, description }) => {
    const parameters = built[name]?.parameters;
    const json: unknown = parameters !== undefined && 'jsonSchema' in parameters ? parameters.jsonSchema : undefined;
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      throw new Error(`tool ${name}: Mastra gave no JSON schema of its arguments`);
    }
    return { name, description, inputSchema: json as Readonly<Record<string, unknown>> };
  });
}

/**
 * The production turn client: a new request agent per turn with the definition tools and `maxSteps: 1`, so one
 * `generate` is one request and its tool calls come back as data (KD-1, ADR-0001). The system block carries the cache
 * mark, so the tools and instructions before it are cached.
 */
export const mastraAgentTurnClient: AgentTurnModelClient = {
  async generateTurn(call, signal) {
    const agent = turnAgent(call);
    const result = await agent.generate(turnMessages(call.messages), {
      maxSteps: 1,
      toolChoice: call.toolChoice === 'auto' ? 'auto' : { type: 'tool', toolName: call.toolChoice.toolName },
      modelSettings: { maxOutputTokens: call.maxOutputTokens },
      providerOptions: { anthropic: { effort: call.effort } },
      abortSignal: signal,
    });
    return {
      finishReason: result.finishReason,
      text: result.text,
      toolCalls: result.toolCalls.map(({ payload }) => ({
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        args: payload.args,
      })),
      usage: reportedUsage(result.usage),
    };
  },
};
