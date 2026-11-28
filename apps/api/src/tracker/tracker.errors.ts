import type { HttpException } from '@nestjs/common';
import type { TrackerErrorCode } from '@agent-os/contracts';
import { apiError } from '../common/api-error';

/**
 * HTTP status and constant message of each tracker error code (task-tracker design-server.md, «Error handling»).
 * One body per 404, so another employee's task answers exactly as a missing one.
 */
const ANSWERS: Record<TrackerErrorCode, { status: number; message: string }> = {
  TRACKER_TASK_NOT_FOUND: { status: 404, message: 'Task not found' },
  TRACKER_NO_CONVERSATION: {
    status: 409,
    message: 'The task has no live conversation',
  },
  VALIDATION_FAILED: { status: 400, message: 'Validation failed' },
};

/** The answer of a tracker error code, body `ApiErrorSchema`. */
export function trackerError(code: TrackerErrorCode): HttpException {
  const { status, message } = ANSWERS[code];
  return apiError(status, code, message);
}
