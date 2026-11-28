import { createAnthropic } from '@ai-sdk/anthropic';

import {
  type ProviderAdapter,
  keyHeader,
  overflowText,
  rejectionText,
} from './adapters';

/** The Messages API version the check request asks for. */
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Anthropic Messages through `@ai-sdk/anthropic` on the provider's versioned address (`…/v1`). Only this kind
 * marks where to cache to: an `ephemeral` breakpoint (KD-6). It serves no embeddings.
 */
export const anthropicAdapter: ProviderAdapter = {
  languageModel(connection, modelName) {
    return createAnthropic({
      baseURL: connection.baseUrl,
      apiKey: connection.apiKey ?? undefined,
    })(modelName);
  },
  cacheMark: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  embeddings: null,
  toolsRejected(statusCode, body) {
    return (
      rejectionText(statusCode, body)?.message.startsWith('tools.') ?? false
    );
  },
  contextOverflow(statusCode, body) {
    const error = overflowText(statusCode, body);
    return (
      error !== null &&
      error.type === 'invalid_request_error' &&
      error.message.startsWith('prompt is too long')
    );
  },
  checkRequest(connection) {
    return {
      url: `${connection.baseUrl}/models`,
      headers: {
        'anthropic-version': ANTHROPIC_VERSION,
        ...keyHeader('x-api-key', connection.apiKey),
      },
    };
  },
};
