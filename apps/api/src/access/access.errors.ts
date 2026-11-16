import type { HttpException } from '@nestjs/common';
import type {
  AccessErrorCode,
  GrantInvalidReason,
  GrantTargetUnknownReason,
} from '@agent-os/contracts';
import { apiError } from '../common/api-error.js';

/** HTTP status and constant message of each access error code (design-access.md, Error handling). */
const ANSWERS: Record<AccessErrorCode, { status: number; message: string }> = {
  MODEL_NOT_FOUND: { status: 404, message: 'Model not found' },
  MODEL_ID_TAKEN: { status: 409, message: 'Model id is taken' },
  GRANT_NOT_FOUND: { status: 404, message: 'Grant not found' },
  GRANT_EXISTS: {
    status: 409,
    message: 'The holder already has this grant',
  },
  GRANT_TARGET_UNKNOWN: { status: 422, message: 'Grant target is unknown' },
  GRANT_INVALID: { status: 422, message: 'Grant is invalid' },
};

/** The answer of an access error code, body `ApiErrorSchema`; `reason` for the two 422 codes. */
export function accessError(
  code: AccessErrorCode,
  reason?: GrantInvalidReason | GrantTargetUnknownReason,
): HttpException {
  const { status, message } = ANSWERS[code];
  return apiError(status, code, message, reason);
}
