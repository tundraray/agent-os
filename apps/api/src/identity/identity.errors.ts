import type { HttpException } from '@nestjs/common';
import type {
  IdentityErrorCode,
  IdentityValidationReason,
  ProviderCheckFailure,
} from '@agent-os/contracts';
import { apiError } from '../common/api-error';

/** HTTP status and constant message of each identity error code (design-identity.md, Error handling). */
const ANSWERS: Record<IdentityErrorCode, { status: number; message: string }> =
  {
    AUTH_REQUIRED: { status: 401, message: 'Authentication required' },
    ACCOUNT_DISABLED: { status: 401, message: 'Account disabled' },
    INVALID_CREDENTIALS: { status: 401, message: 'Invalid login or password' },
    ADMIN_REQUIRED: { status: 403, message: 'Administrator right required' },
    ORIGIN_REJECTED: { status: 403, message: 'Origin rejected' },
    USER_NOT_FOUND: { status: 404, message: 'User not found' },
    ROLE_NOT_FOUND: { status: 404, message: 'Role not found' },
    PROVIDER_NOT_FOUND: { status: 404, message: 'Provider not found' },
    LOGIN_TAKEN: { status: 409, message: 'Login is taken' },
    EMAIL_TAKEN: { status: 409, message: 'Email is taken' },
    NOT_LOCAL_ACCOUNT: { status: 409, message: 'Not a local account' },
    ROLE_NAME_TAKEN: { status: 409, message: 'Role name is taken' },
    BUILTIN_ROLE: { status: 409, message: 'Built-in role cannot be changed' },
    PROVIDER_INCOMPLETE: {
      status: 409,
      message: 'Provider settings are incomplete',
    },
    PROVIDER_CHECK_FAILED: { status: 422, message: 'Provider check failed' },
    PUBLIC_URL_REQUIRED: {
      status: 409,
      message: 'Set the public address in the sign-in settings',
    },
  };

/** The answer of an identity error code, body `ApiErrorSchema`; `reason` only for PROVIDER_CHECK_FAILED. */
export function identityError(
  code: IdentityErrorCode,
  reason?: ProviderCheckFailure,
): HttpException {
  const { status, message } = ANSWERS[code];
  return apiError(status, code, message, reason);
}

/** 400 VALIDATION_FAILED with the machine `reason` the identity service names. */
export function validationFailed(
  reason: IdentityValidationReason,
): HttpException {
  return apiError(400, 'VALIDATION_FAILED', 'Validation failed', reason);
}
