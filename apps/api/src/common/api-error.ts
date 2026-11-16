import { STATUS_CODES } from 'node:http';
import { HttpException } from '@nestjs/common';

/**
 * The one builder of an API error answer, body `ApiErrorSchema`: `{ statusCode, error, errorCode,
 * message }`, plus the machine `reason` when the caller names one.
 */
export function apiError(
  status: number,
  errorCode: string,
  message: string | string[],
  reason?: string,
): HttpException {
  const body = {
    statusCode: status,
    error: STATUS_CODES[status],
    errorCode,
    message,
  };
  return new HttpException(
    reason === undefined ? body : { ...body, reason },
    status,
  );
}
