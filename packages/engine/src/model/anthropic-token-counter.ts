import { z } from 'zod';
import type { AgentTurnMessage } from './role-agent.js';
import type { AgentTurnCountRequest, TokenCounter, TokenCountResult } from './token-counter.js';

const ANTHROPIC_VERSION = '2023-06-01';
const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';
const PROVIDER_PREFIX = /^[^/]+\//;

const CountTokensResponseSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
});
/** The provider's error body; only `error.type`, a short identifier, is kept for the log. */
const ProviderErrorSchema = z.object({
  error: z.object({ type: z.string().regex(/^[a-z_]{1,64}$/) }),
});
const NETWORK_ERROR = 'network_error';
const INVALID_RESPONSE = 'invalid_response';
/** A non-2xx answer whose body names no error type. */
const HTTP_ERROR = 'http_error';

export interface AnthropicTokenCounterOptions {
  readonly apiKey: string;
  /** Unversioned base, e.g. `https://api.anthropic.com`; may carry a path and a trailing `/`. */
  readonly baseUrl: string;
}

/**
 * `TokenCounter` over the provider's `count_tokens` (design-engine.md, Contract Definitions):
 * `POST <base>/v1/messages/count_tokens` with `x-api-key` and `anthropic-version`, the model
 * without its `anthropic/` prefix and the body of the turn. The key and base come from the assembly point, never from the
 * environment. Network failures and non-2xx answers come back as `failed`, not as exceptions.
 */
export class AnthropicTokenCounter implements TokenCounter {
  private readonly url: string;

  constructor(private readonly options: AnthropicTokenCounterOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, '')}${COUNT_TOKENS_PATH}`;
  }

  /** The turn's whole input: its tools as `tools`, its calls and results as `tool_use` and `tool_result` blocks (DC-30). */
  countTurnInputTokens(request: AgentTurnCountRequest, signal: AbortSignal): Promise<TokenCountResult> {
    return this.count(turnCountTokensBody(request), signal);
  }

  private async count(body: unknown, signal: AbortSignal): Promise<TokenCountResult> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      return { outcome: 'failed', statusCode: null, errorClass: NETWORK_ERROR };
    }
    if (!response.ok) {
      return { outcome: 'failed', statusCode: response.status, errorClass: await errorTypeOf(response) };
    }
    try {
      const parsed = CountTokensResponseSchema.safeParse(await response.json());
      return parsed.success
        ? { outcome: 'counted', inputTokens: parsed.data.input_tokens }
        : { outcome: 'failed', statusCode: response.status, errorClass: INVALID_RESPONSE };
    } catch {
      // The body broke off or is not JSON.
      return { outcome: 'failed', statusCode: null, errorClass: INVALID_RESPONSE };
    }
  }
}

/** `error.type` of a provider error body; the message is never read, since it may quote the request. */
async function errorTypeOf(response: Response): Promise<string> {
  try {
    const parsed = ProviderErrorSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.error.type : HTTP_ERROR;
  } catch {
    return HTTP_ERROR;
  }
}

type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string };

interface CountedMessage {
  readonly role: 'user' | 'assistant';
  readonly content: ContentBlock[];
}

/** One view message as provider blocks: a tool result is a user block whose content is its JSON text, as the turn sends it. */
function turnBlocks(message: AgentTurnMessage): CountedMessage {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: [{ type: 'text', text: message.content }] };
    case 'assistant':
      return {
        role: 'assistant',
        content: [
          ...(message.content === '' ? [] : [{ type: 'text' as const, text: message.content }]),
          ...message.toolCalls.map(({ toolCallId, toolName, args }) => ({
            type: 'tool_use' as const,
            id: toolCallId,
            name: toolName,
            input: args,
          })),
        ],
      };
    case 'tool':
      return {
        role: 'user',
        content: message.results.map(({ toolCallId, output }) => ({
          type: 'tool_result' as const,
          tool_use_id: toolCallId,
          content: typeof output === 'string' ? output : JSON.stringify(output),
        })),
      };
  }
}

/** Consecutive messages of one role go as one message, as the turn's request merges them. */
function mergedTurnMessages(messages: readonly AgentTurnMessage[]): CountedMessage[] {
  const merged: CountedMessage[] = [];
  for (const message of messages.map(turnBlocks)) {
    const last = merged.at(-1);
    if (last?.role === message.role) {
      last.content.push(...message.content);
    } else {
      merged.push(message);
    }
  }
  return merged;
}

function turnCountTokensBody(request: AgentTurnCountRequest) {
  return {
    model: request.model.replace(PROVIDER_PREFIX, ''),
    system: request.system,
    messages: mergedTurnMessages(request.messages),
    tools: request.tools.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema })),
    tool_choice: request.toolChoice === 'auto' ? { type: 'auto' } : { type: 'tool', name: request.toolChoice.toolName },
    output_config: { effort: request.effort },
  };
}
