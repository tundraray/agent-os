import { HttpException } from '@nestjs/common';
import type {
  AccessErrorCode,
  GrantInvalidReason,
  GrantTargetUnknownReason,
  ModelDefaultInvalidReason,
  ModelProviderInvalidReason,
  ModelPurpose,
} from '@agent-os/contracts';
import { apiError } from '../common/api-error.js';

/** HTTP status and constant message of each access error code (design-access.md, Error handling). */
const ANSWERS: Record<AccessErrorCode, { status: number; message: string }> = {
  MODEL_NOT_FOUND: { status: 404, message: 'Model not found' },
  MODEL_ID_TAKEN: { status: 409, message: 'Model id is taken' },
  MODEL_PROVIDER_INVALID: {
    status: 422,
    message: 'The model provider does not take this model',
  },
  MODEL_DEFAULT_INVALID: {
    status: 422,
    message: 'The default model is not a catalogue model of its purpose',
  },
  GRANT_NOT_FOUND: { status: 404, message: 'Grant not found' },
  GRANT_EXISTS: {
    status: 409,
    message: 'The holder already has this grant',
  },
  GRANT_TARGET_UNKNOWN: { status: 422, message: 'Grant target is unknown' },
  GRANT_INVALID: { status: 422, message: 'Grant is invalid' },
};

/** The answer of an access error code, body `ApiErrorSchema`; `reason` for the 422 codes. */
export function accessError(
  code: AccessErrorCode,
  reason?:
    | GrantInvalidReason
    | GrantTargetUnknownReason
    | ModelProviderInvalidReason,
): HttpException {
  const { status, message } = ANSWERS[code];
  return apiError(status, code, message, reason);
}

/** 422 MODEL_DEFAULT_INVALID, body `ModelDefaultInvalidErrorSchema`: the reason and the rejected id in `model`. */
export function modelDefaultError(
  reason: ModelDefaultInvalidReason,
  model: string,
): HttpException {
  const answer = accessError('MODEL_DEFAULT_INVALID');
  return new HttpException(
    { ...(answer.getResponse() as object), reason, model },
    answer.getStatus(),
  );
}

/** 400 VALIDATION_FAILED: an update of a catalogue model names fields of the other purpose. */
export function foreignFieldsError(
  purpose: ModelPurpose,
  fields: readonly string[],
): HttpException {
  return apiError(
    400,
    'VALIDATION_FAILED',
    fields.map((field) => `${field}: not a field of a ${purpose} model`),
  );
}
