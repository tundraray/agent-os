import { createGoogleGenerativeAI } from '@ai-sdk/google';

import {
  type EmbeddingInputType,
  type ProviderAdapter,
  keyHeader,
  rejectionText,
} from './adapters';
import type { ProviderConnection } from './provider-registry';

/** The Gemini task type of each kind of embedded text. */
const TASK_TYPES: Readonly<Record<EmbeddingInputType, string>> = {
  document: 'RETRIEVAL_DOCUMENT',
  query: 'RETRIEVAL_QUERY',
};

function provider(connection: ProviderConnection) {
  return createGoogleGenerativeAI({
    baseURL: connection.baseUrl,
    apiKey: connection.apiKey ?? undefined,
  });
}

/**
 * Gemini through `@ai-sdk/google`. Its model's provider is `google.generative-ai`, so Mastra cleans each tool
 * schema with its Google compatibility layer before the request — the raw JSON Schema of an MCP tool too
 * (task-06 Investigation Notes); the adapter adds nothing to it. Gemini caches the request's start itself.
 */
export const geminiAdapter: ProviderAdapter = {
  languageModel(connection, modelName) {
    return provider(connection)(modelName);
  },
  cacheMark: null,
  embeddings: {
    model(connection, modelName) {
      return provider(connection).embeddingModel(modelName);
    },
    // `gemini-embedding-001` answers 3072 dimensions unless asked for the catalogue's size.
    providerOptions(inputType, dimensions) {
      return {
        google: {
          taskType: TASK_TYPES[inputType],
          outputDimensionality: dimensions,
        },
      };
    },
  },
  toolsRejected(statusCode, body) {
    return (
      rejectionText(statusCode, body)?.message.includes(
        'function_declarations',
      ) ?? false
    );
  },
  // Neither Google's documentation nor its code shows the body of an overflow: none is recognised.
  contextOverflow() {
    return false;
  },
  checkRequest(connection) {
    return {
      url: `${connection.baseUrl}/models`,
      headers: keyHeader('x-goog-api-key', connection.apiKey),
    };
  },
};
