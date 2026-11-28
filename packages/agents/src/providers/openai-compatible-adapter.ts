import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import {
  type ProviderAdapter,
  keyHeader,
  overflowText,
  rejectionText,
} from './adapters';
import type { ProviderConnection } from './provider-registry';

/** The server is named by the provider's name; it streams the usage only when asked (`includeUsage`). */
function provider(connection: ProviderConnection) {
  return createOpenAICompatible({
    name: connection.name,
    baseURL: connection.baseUrl,
    apiKey: connection.apiKey ?? undefined,
    includeUsage: true,
  });
}

/**
 * The OpenAI Chat Completions API through `@ai-sdk/openai-compatible`: OpenAI itself or a local server such
 * as vLLM, with or without a key. The server caches the request's start itself; embeddings take no options.
 */
export const openAICompatibleAdapter: ProviderAdapter = {
  languageModel(connection, modelName) {
    return provider(connection).chatModel(modelName);
  },
  cacheMark: null,
  embeddings: {
    model(connection, modelName) {
      return provider(connection).embeddingModel(modelName);
    },
    providerOptions() {
      return undefined;
    },
  },
  toolsRejected(statusCode, body) {
    const error = rejectionText(statusCode, body);
    return (
      error !== null &&
      (error.message.includes('tools') || error.param.startsWith('tools'))
    );
  },
  // One adapter serves every OpenAI-compatible server, so each server's marker is checked: OpenAI and Groq
  // (`code`), OpenRouter (`metadata.error_type`), Mistral and llama.cpp (`type`), vLLM (fixed text, which
  // also catches OpenAI's code-less «This model's maximum context length»).
  contextOverflow(statusCode, body) {
    const error = overflowText(statusCode, body);
    return (
      error !== null &&
      (error.code === 'context_length_exceeded' ||
        error.errorType === 'context_length_exceeded' ||
        error.type === 'invalid_request_prompt_too_long' ||
        error.type === 'exceed_context_size_error' ||
        error.message.includes('maximum context length'))
    );
  },
  checkRequest(connection) {
    return {
      url: `${connection.baseUrl}/models`,
      headers: keyHeader(
        'authorization',
        connection.apiKey === null ? null : `Bearer ${connection.apiKey}`,
      ),
    };
  },
};
