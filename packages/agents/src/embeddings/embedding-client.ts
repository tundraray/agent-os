import {
  type EmbeddingInputType,
  providerAdapter,
} from '../providers/adapters';
import type { ProviderConnection } from '../providers/provider-registry';

/** One provider request takes at most this long (design-core.md, Contract `Agents.embeddings.embed`). */
const EMBEDDING_REQUEST_TIMEOUT_MS = 30_000;

/** One batch of texts for the provider; the connection carries the key — never log it. */
export interface EmbeddingRequest {
  readonly connection: ProviderConnection;
  /** The model's name at the provider: the catalogue id after its first slash. */
  readonly modelName: string;
  readonly texts: readonly string[];
  readonly inputType: EmbeddingInputType;
  /** The catalogue's dimensions: the adapter asks the provider for vectors of this size when its kind can. */
  readonly dimensions: number;
  /** The caller's stop: the request rejects with an abort error. */
  readonly signal: AbortSignal;
}

/** The provider's answer: a vector per text in order, and its input tokens or `null` when it reported none. */
export interface EmbeddingBatch {
  readonly vectors: readonly (readonly number[])[];
  readonly inputTokens: number | null;
}

/**
 * The seam of the embeddings (design-core.md KD-6): the real one calls the provider through the adapter of
 * its kind, a test passes `createScriptedEmbeddings()`. A provider rejection rejects as the AI SDK gives it
 * (`AI_APICallError`); the request's own timeout rejects with `EmbeddingTimeoutError`.
 */
export interface EmbeddingClient {
  embed(request: EmbeddingRequest): Promise<EmbeddingBatch>;
}

/** The provider did not answer within `EMBEDDING_REQUEST_TIMEOUT_MS`: retried as `provider_unavailable`. */
export class EmbeddingTimeoutError extends Error {
  override readonly name = 'EmbeddingTimeoutError';

  constructor() {
    super(
      `The embedding request timed out after ${EMBEDDING_REQUEST_TIMEOUT_MS} ms`,
    );
  }
}

/**
 * Calls the embedding model's own `doEmbed`, without the `ai` package: no `ai` version shares the provider
 * packages' copy of `@ai-sdk/provider`, and the retries are the service's (task-10 Investigation Notes).
 */
export function createEmbeddingClient(): EmbeddingClient {
  return {
    async embed({
      connection,
      modelName,
      texts,
      inputType,
      dimensions,
      signal,
    }) {
      const embeddings = providerAdapter(connection.kind).embeddings;
      if (embeddings === null)
        throw new Error(
          `Provider kind ${connection.kind} serves no embedding models`,
        );
      const timeout = AbortSignal.timeout(EMBEDDING_REQUEST_TIMEOUT_MS);
      const providerOptions = embeddings.providerOptions(inputType, dimensions);
      try {
        const result = await embeddings.model(connection, modelName).doEmbed({
          values: [...texts],
          abortSignal: AbortSignal.any([signal, timeout]),
          ...(providerOptions === undefined ? {} : { providerOptions }),
        });
        const tokens = result.usage?.tokens;
        return {
          vectors: result.embeddings,
          inputTokens: tokens !== undefined && tokens > 0 ? tokens : null,
        };
      } catch (error) {
        if (timeout.aborted && !signal.aborted)
          throw new EmbeddingTimeoutError();
        throw error;
      }
    },
  };
}
