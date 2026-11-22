import type { Logger } from '@agent-os/common';
import {
  type EmbeddingFailureReason,
  modelProvider,
} from '@agent-os/contracts';
import {
  type CallUsage,
  CLOCK,
  type Clock,
  type ModelPrice,
  PLATFORM_OWNER_ID,
  TokenLedger,
} from '@agent-os/runtime';
import { Inject, Injectable } from '@nestjs/common';

import type { AccessGate } from '../access-gate';
import { ACCESS_GATE, EMBEDDING_CLIENT } from '../agents.tokens';
import {
  classifyRejection,
  PROVIDER_RETRIES,
  type ProviderError,
  pause,
  providerRetryDelayMs,
} from '../model/retry-policy';
import { tokensOfBytes, utf8Bytes } from '../model/token-estimate';
import {
  type EmbeddingInputType,
  providerAdapter,
} from '../providers/adapters';
import { providerState } from '../providers/provider-readiness';
import {
  AgentsProviders,
  type ProviderConnection,
} from '../providers/provider-registry';
import {
  type EmbeddingBatch,
  type EmbeddingClient,
  EmbeddingTimeoutError,
} from './embedding-client';

/** At most this many texts go in one provider request; a longer list goes in batches, one after another (DC-9). */
export const EMBEDDING_BATCH_SIZE = 100;

export interface EmbedRequest {
  /** Their order is the order of the vectors; an empty list is answered without a provider request. */
  readonly texts: readonly string[];
  readonly inputType: EmbeddingInputType;
  /** The employee whose spend it is, or `null` — the platform's own (`PLATFORM_OWNER_ID`). */
  readonly ownerId: string | null;
  /** The task of the ledger rows, or `null`. */
  readonly taskId: string | null;
  /** The caller's stop: the only rejection of `embed`. */
  readonly signal: AbortSignal;
  /** The caller's logger with its identifiers. */
  readonly logger: Logger;
}

export interface EmbedVectors {
  readonly kind: 'vectors';
  /** A vector per text in the texts' order, each of `dimensions` length and of unit length (DC-8). */
  readonly vectors: readonly (readonly number[])[];
  /** The catalogue id of the model. */
  readonly model: string;
  readonly dimensions: number;
}

export interface EmbedUnavailable {
  readonly kind: 'unavailable';
  readonly reason: EmbeddingFailureReason;
  /** `null` when no embedding model is chosen. */
  readonly model: string | null;
  /** For the caller's log and state; never the provider's body or a key. */
  readonly message: string;
}

export type EmbedResult = EmbedVectors | EmbedUnavailable;

/** The default embedding model now, or `model_not_configured`. */
export type EmbeddingModelChoice =
  | {
      readonly kind: 'model';
      readonly model: string;
      readonly dimensions: number;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'model_not_configured';
      readonly model: null;
      readonly message: string;
    };

/** One `embed` past the gate and the provider's readiness. */
interface EmbedCall {
  readonly request: EmbedRequest;
  /** The ledger row's owner: the employee or `PLATFORM_OWNER_ID`. */
  readonly owner: string;
  readonly model: string;
  readonly price: ModelPrice;
  readonly dimensions: number;
  /** Carries the key: never logged. */
  readonly connection: ProviderConnection;
}

/** A batch the provider answered, or its error after the retries. */
type BatchOutcome =
  | { readonly kind: 'answered'; readonly batch: EmbeddingBatch }
  | { readonly kind: 'failed'; readonly error: ProviderError };

/** The client's own timeout: no status, retried like a network failure («Как разбирается ошибка провайдера»). */
const TIMED_OUT: ProviderError = {
  statusCode: null,
  retryable: true,
  reason: 'provider_unavailable',
  responseBody: null,
};

const NOT_CONFIGURED_MESSAGE = 'No default embedding model is chosen';

function totalBytes(texts: readonly string[]): number {
  return texts.reduce((bytes, text) => bytes + utf8Bytes(text), 0);
}

/** The vector scaled to unit length (DC-8); a zero vector has no direction and stays as it is. */
function unitLength(vector: readonly number[]): number[] {
  const norm = Math.hypot(...vector);
  return norm === 0 ? [...vector] : vector.map((value) => value / norm);
}

/** The input-only price of an embedding model: the catalogue's input rate, zeros elsewhere (KD-6). */
function inputPrice(inputUsdPerMTok: number): ModelPrice {
  return {
    inputUsdPerMTok,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
  };
}

function inputUsage(inputTokens: number): CallUsage {
  return {
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function unavailable(
  reason: EmbeddingFailureReason,
  model: string | null,
  message: string,
): EmbedUnavailable {
  return { kind: 'unavailable', reason, model, message };
}

/** The reason after the retries: the chat's `provider_tools_rejected` cannot apply to embeddings. */
function failure(call: EmbedCall, error: ProviderError): EmbedUnavailable {
  const status =
    error.statusCode === null ? '' : `, status ${error.statusCode}`;
  const reason =
    error.reason === 'provider_tools_rejected'
      ? 'provider_error'
      : error.reason;
  const message = `Embedding model ${call.model} of provider ${call.connection.name} failed: ${reason}${status}`;
  return unavailable(reason, call.model, message);
}

/**
 * The embeddings of the platform's own features (design-core.md KD-6, Flow 2): the gate's verdict, the
 * provider's readiness, batches of up to 100 texts one after another with the chat's retries, a ledger row per
 * answered batch at the input price on the employee or the platform, the vectors checked against the catalogue's
 * dimensions and scaled to unit length. It keeps no state and never throws for a provider or access problem;
 * texts are never logged.
 */
@Injectable()
export class AgentsEmbeddings {
  constructor(
    /** The seam of the provider: the real client in production, `createScriptedEmbeddings()` in tests. */
    @Inject(EMBEDDING_CLIENT) private readonly client: EmbeddingClient,
    /** Asked once per `embed`: the owner is enabled, and the model with its input price and dimensions. */
    @Inject(ACCESS_GATE) private readonly access: Pick<AccessGate, 'embedding'>,
    /** The provider's connection, read on every `embed`, never kept (KD-1). */
    @Inject(AgentsProviders)
    private readonly providers: Pick<AgentsProviders, 'connection'>,
    @Inject(TokenLedger) private readonly ledger: Pick<TokenLedger, 'record'>,
    /** Times the pauses between retries. */
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Vectors of the texts on the default embedding model, the spend on `ownerId` or on the platform. Every
   * refusal and failure is `unavailable` with its reason; only the caller's `signal` rejects.
   */
  async embed(request: EmbedRequest): Promise<EmbedResult> {
    const startedAt = this.clock.now().getTime();
    const owner = request.ownerId ?? PLATFORM_OWNER_ID;
    const { logger, taskId } = request;
    const prepared = await this.callOf(request, owner);
    let result: EmbedResult;
    if ('kind' in prepared) {
      result = prepared;
    } else {
      logger.info('embeddings started', {
        model: prepared.model,
        provider: prepared.connection.name,
        texts: request.texts.length,
        batches: Math.ceil(request.texts.length / EMBEDDING_BATCH_SIZE),
        inputType: request.inputType,
        ownerId: owner,
        taskId,
      });
      result = await this.embedBatches(prepared);
    }
    const durationMs = this.clock.now().getTime() - startedAt;
    if (result.kind === 'vectors') {
      logger.info('embeddings done', {
        model: result.model,
        vectors: result.vectors.length,
        ownerId: owner,
        taskId,
        durationMs,
      });
    } else {
      const { reason, model, message } = result;
      logger.warn('embeddings unavailable', {
        model,
        reason,
        message,
        ownerId: owner,
        taskId,
        durationMs,
      });
    }
    return result;
  }

  /** Which embedding model is chosen now, without a provider request or a ledger row. */
  async model(): Promise<EmbeddingModelChoice> {
    const verdict = await this.access.embedding(null);
    if (verdict.kind === 'allowed') {
      return {
        kind: 'model',
        model: verdict.model,
        dimensions: verdict.dimensions,
      };
    }
    return {
      kind: 'unavailable',
      reason: 'model_not_configured',
      model: null,
      message: NOT_CONFIGURED_MESSAGE,
    };
  }

  /** Anything that is no provider rejection (a malformed answer, a kind without embeddings) is `provider_error`. */
  private rejectionOf(
    error: unknown,
    connection: ProviderConnection,
  ): ProviderError {
    if (error instanceof EmbeddingTimeoutError) return TIMED_OUT;
    const rejection = classifyRejection(
      error,
      providerAdapter(connection.kind),
    );
    return (
      rejection ?? {
        statusCode: null,
        retryable: false,
        reason: 'provider_error',
        responseBody: null,
      }
    );
  }

  /** Writes the batch's ledger row: the provider's count, or the estimate by bytes (DC-11). */
  private async record(
    call: EmbedCall,
    texts: readonly string[],
    reported: number | null,
    durationMs: number,
  ): Promise<void> {
    const estimated = reported === null;
    const inputTokens = reported ?? tokensOfBytes(totalBytes(texts));
    const { callId } = await this.ledger.record({
      ownerId: call.owner,
      ...(call.request.taskId === null ? {} : { taskId: call.request.taskId }),
      model: call.model,
      price: call.price,
      usage: inputUsage(inputTokens),
    });
    const fields = {
      model: call.model,
      provider: call.connection.name,
      callId,
      texts: texts.length,
      inputTokens,
      estimated,
      durationMs,
    };
    if (estimated)
      call.request.logger.warn(
        'embedding batch recorded with estimated usage',
        fields,
      );
    else call.request.logger.info('embedding batch recorded', fields);
  }

  /**
   * One batch with up to two retries of a provider error at 1 and 3 seconds. A request the provider rejected
   * leaves no ledger row; a stop that cut a sent request is recorded as an estimate (Invariant 6) and rejects.
   */
  private async sendBatch(
    call: EmbedCall,
    texts: readonly string[],
  ): Promise<BatchOutcome> {
    const { signal, logger } = call.request;
    for (let retries = 0; ; retries += 1) {
      signal.throwIfAborted();
      const startedAt = this.clock.now().getTime();
      let batch: EmbeddingBatch;
      try {
        batch = await this.client.embed({
          connection: call.connection,
          modelName: call.model.slice(call.connection.name.length + 1),
          texts,
          inputType: call.request.inputType,
          dimensions: call.dimensions,
          signal,
        });
      } catch (caught) {
        const durationMs = this.clock.now().getTime() - startedAt;
        if (signal.aborted) {
          if (
            classifyRejection(caught, providerAdapter(call.connection.kind)) ===
            null
          ) {
            await this.record(call, texts, null, durationMs);
          }
          throw signal.reason;
        }
        const error = this.rejectionOf(caught, call.connection);
        // The logger's mask hides any remembered key the provider might echo in its body (KD-7).
        logger.warn('embedding call failed', {
          model: call.model,
          provider: call.connection.name,
          reason: error.reason,
          statusCode: error.statusCode,
          responseBody: error.responseBody,
          error: caught instanceof Error ? caught.message : String(caught),
          retryable: error.retryable,
          attempt: retries + 1,
          durationMs,
        });
        if (!error.retryable || retries === PROVIDER_RETRIES)
          return { kind: 'failed', error };
        await pause(this.clock, providerRetryDelayMs(retries + 1), signal);
        continue;
      }
      await this.record(
        call,
        texts,
        batch.inputTokens,
        this.clock.now().getTime() - startedAt,
      );
      return { kind: 'answered', batch };
    }
  }

  /** The batches one after another; the first failure ends the call, and the rows of earlier batches stay. */
  private async embedBatches(call: EmbedCall): Promise<EmbedResult> {
    const { texts } = call.request;
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
      const outcome = await this.sendBatch(
        call,
        texts.slice(start, start + EMBEDDING_BATCH_SIZE),
      );
      if (outcome.kind === 'failed') return failure(call, outcome.error);
      // The batch's row is written already: the provider counted it (AC-07.4).
      const wrong = outcome.batch.vectors.find(
        (vector) => vector.length !== call.dimensions,
      );
      if (wrong !== undefined) {
        const message = `Embedding model ${call.model} answered a vector of ${wrong.length} dimensions, expected ${call.dimensions}`;
        return unavailable('dimension_mismatch', call.model, message);
      }
      vectors.push(...outcome.batch.vectors.map(unitLength));
    }
    return {
      kind: 'vectors',
      vectors,
      model: call.model,
      dimensions: call.dimensions,
    };
  }

  /** The verdict, the empty list and the provider's readiness: everything decided without a request. */
  private async callOf(
    request: EmbedRequest,
    owner: string,
  ): Promise<EmbedCall | EmbedResult> {
    const verdict = await this.access.embedding(request.ownerId);
    if (verdict.kind === 'refused') {
      const message =
        verdict.reason === 'owner_disabled'
          ? `Owner ${owner} is disabled or unknown`
          : NOT_CONFIGURED_MESSAGE;
      return unavailable(verdict.reason, null, message);
    }
    const { model, dimensions } = verdict;
    if (request.texts.length === 0)
      return { kind: 'vectors', vectors: [], model, dimensions };
    const provider = modelProvider(model);
    const connection = await this.providers.connection(provider);
    if (connection === null) {
      return unavailable(
        'provider_missing',
        model,
        `Provider ${provider} of model ${model} is not registered`,
      );
    }
    const state = providerState(connection);
    if (state !== 'ready') {
      return unavailable(
        `provider_${state}`,
        model,
        `Provider ${provider} of model ${model} is ${state}`,
      );
    }
    return {
      request,
      owner,
      model,
      price: inputPrice(verdict.inputUsdPerMTok),
      dimensions,
      connection,
    };
  }
}
