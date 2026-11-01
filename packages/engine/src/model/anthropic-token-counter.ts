import { z } from 'zod';
import type {
  TokenCounter,
  TokenCountRequest,
  TokenCountResult,
} from './token-counter.js';

const ANTHROPIC_VERSION = '2023-06-01';
const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';
const PROVIDER_PREFIX = /^[^/]+\//;

const CountTokensResponseSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
});

export interface AnthropicTokenCounterOptions {
  readonly apiKey: string;
  /** Unversioned base, e.g. `https://api.anthropic.com`; may carry a path and a trailing `/`. */
  readonly baseUrl: string;
}

/**
 * `TokenCounter` over the provider's `count_tokens` (design-engine.md, Contract Definitions):
 * `POST <base>/v1/messages/count_tokens` with `x-api-key` and `anthropic-version`, the model
 * without its `anthropic/` prefix and the body of the call — role messages and `output_config`
 * with the output JSON schema. The key and base come from the assembly point, never from the
 * environment. Network failures and non-2xx answers come back as `failed`, not as exceptions.
 */
export class AnthropicTokenCounter implements TokenCounter {
  private readonly url: string;

  constructor(private readonly options: AnthropicTokenCounterOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, '')}${COUNT_TOKENS_PATH}`;
  }

  async countInputTokens(
    request: TokenCountRequest,
    signal: AbortSignal,
  ): Promise<TokenCountResult> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(countTokensBody(request)),
        signal,
      });
    } catch {
      return { outcome: 'failed', statusCode: null };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { outcome: 'failed', statusCode: response.status };
    }
    try {
      const parsed = CountTokensResponseSchema.safeParse(await response.json());
      return parsed.success
        ? { outcome: 'counted', inputTokens: parsed.data.input_tokens }
        : { outcome: 'failed', statusCode: response.status };
    } catch {
      // The body broke off or is not JSON.
      return { outcome: 'failed', statusCode: null };
    }
  }
}

function countTokensBody(request: TokenCountRequest) {
  return {
    model: request.model.replace(PROVIDER_PREFIX, ''),
    system: request.system,
    messages: request.messages,
    output_config: {
      effort: request.effort,
      format: { type: 'json_schema', schema: request.outputSchema },
    },
  };
}
