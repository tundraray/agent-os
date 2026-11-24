import { ModelProviderErrorCode } from '@agent-os/contracts';

/**
 * An expected refusal of a registry operation (design-core.md, Error handling); the controller maps `code`
 * to its status and passes `count` of `MODEL_PROVIDER_HAS_MODELS` to the body.
 */
export class ModelProviderError extends Error {
  override readonly name = 'ModelProviderError';

  constructor(
    readonly code: ModelProviderErrorCode,
    message: string,
    /** The provider's models in the catalogue, for `MODEL_PROVIDER_HAS_MODELS`. */
    readonly count?: number,
  ) {
    super(message);
  }
}

export function providerNotFound(name: string): ModelProviderError {
  return new ModelProviderError(
    ModelProviderErrorCode.MODEL_PROVIDER_NOT_FOUND,
    `Model provider ${name} is not registered`,
  );
}

export function providerNameTaken(name: string): ModelProviderError {
  return new ModelProviderError(
    ModelProviderErrorCode.MODEL_PROVIDER_NAME_TAKEN,
    `Model provider name ${name} is taken`,
  );
}

export function providerHasModels(
  name: string,
  count: number,
): ModelProviderError {
  return new ModelProviderError(
    ModelProviderErrorCode.MODEL_PROVIDER_HAS_MODELS,
    `Model provider ${name} has ${count} models in the catalogue`,
    count,
  );
}
