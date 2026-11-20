import { HttpException } from '@nestjs/common';
import { ModelProviderError } from '@agent-os/agents';
import type { ModelProviderErrorCode } from '@agent-os/contracts';
import { apiError } from '../common/api-error.js';

/** HTTP status of each refusal of `Agents.providers` (design-core.md of model-providers, Error handling). */
const STATUS_OF: Record<ModelProviderErrorCode, number> = {
  MODEL_PROVIDER_NOT_FOUND: 404,
  MODEL_PROVIDER_NAME_TAKEN: 409,
  MODEL_PROVIDER_HAS_MODELS: 409,
};

/**
 * Runs an `Agents.providers` operation and answers its `ModelProviderError` with its status, body
 * `ApiErrorSchema`; `MODEL_PROVIDER_HAS_MODELS` carries the number of catalogue models in `count`. Any
 * other error leaves as it came.
 */
export async function providerAnswer<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (!(error instanceof ModelProviderError)) throw error;
    const answer = apiError(STATUS_OF[error.code], error.code, error.message);
    if (error.count === undefined) throw answer;
    throw new HttpException(
      { ...(answer.getResponse() as object), count: error.count },
      answer.getStatus(),
    );
  }
}
