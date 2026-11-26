import type { HttpException } from '@nestjs/common';
import type { SchedulesErrorCode } from '@agent-os/contracts';
import { apiError } from '../common/api-error';

/**
 * HTTP status and constant message of each schedules error code (design-schedules.md, «Error handling»). One body
 * per 404, so another employee's schedule answers exactly as a missing one.
 */
const ANSWERS: Record<SchedulesErrorCode, { status: number; message: string }> =
  {
    SCHEDULE_NOT_FOUND: { status: 404, message: 'Schedule not found' },
    SCHEDULE_NOT_RUNNABLE: {
      status: 409,
      message: 'Schedule cannot run now',
    },
    VALIDATION_FAILED: { status: 400, message: 'Validation failed' },
    RECORD_NOT_FOUND: { status: 404, message: 'Record not found' },
    THREAD_NOT_FOUND: { status: 404, message: 'Thread not found' },
    INVALID_CURSOR: { status: 400, message: 'Invalid cursor' },
  };

/** The answer of a schedules error code, body `ApiErrorSchema`. */
export function schedulesError(code: SchedulesErrorCode): HttpException {
  const { status, message } = ANSWERS[code];
  return apiError(status, code, message);
}

/** 400 VALIDATION_FAILED with the problem, in the form `ZodValidationPipe` answers. */
export function invalidSchedule(problem: string): HttpException {
  return apiError(400, 'VALIDATION_FAILED', [problem]);
}
