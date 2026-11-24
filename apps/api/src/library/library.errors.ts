import type { HttpException } from '@nestjs/common';
import type {
  LibraryErrorCode,
  LibraryRejectReason,
  RecordNameTakenReason,
} from '@agent-os/contracts';
import { apiError } from '../common/api-error';

/**
 * HTTP status and constant message of each library error code (design-library.md, Error handling).
 * One body for every 404, so an invisible record answers exactly as a missing one (AC-02.1).
 */
const ANSWERS: Record<LibraryErrorCode, { status: number; message: string }> = {
  RECORD_NOT_FOUND: { status: 404, message: 'Record not found' },
  RECORD_READ_ONLY: { status: 403, message: 'Record is read-only' },
  RECORD_VERSION_CONFLICT: {
    status: 409,
    message: 'Record was changed after this edit started',
  },
  RECORD_NAME_TAKEN: { status: 409, message: 'Record name is taken' },
  RECORD_REJECTED: { status: 422, message: 'Record is rejected' },
  MEMORY_FORBIDDEN: { status: 403, message: 'Memory is not open to you' },
};

/** The answer of a library error code, body `ApiErrorSchema`; `reason` for RECORD_NAME_TAKEN and RECORD_REJECTED. */
export function libraryError(
  code: LibraryErrorCode,
  reason?: RecordNameTakenReason | LibraryRejectReason,
): HttpException {
  const { status, message } = ANSWERS[code];
  return apiError(status, code, message, reason);
}

/**
 * A save whose body names another kind than the stored record: an ordinary validation failure, the
 * code `ZodValidationPipe` answers, because a record never changes kind.
 */
export function kindChangedError(): HttpException {
  return apiError(400, 'VALIDATION_FAILED', [
    'kind: a record never changes its kind',
  ]);
}
