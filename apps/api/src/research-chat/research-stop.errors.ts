import {
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

/**
 * Errors of the stop route (design-lifecycle.md, Error handling). The bodies carry only the code: which of the lock,
 * the cancel or the launch transition refused stays in the server log.
 */

/** 404: no launch with this `launchKey` in the caller's thread, or its card was removed by a regenerate. */
export const researchLaunchNotFound = (): NotFoundException =>
  new NotFoundException('Research launch not found', {
    errorCode: 'RESEARCH_LAUNCH_NOT_FOUND',
  });

/** 500: the thread lock, the cancel or the move to `stopped` refused; a retry is safe and finishes the stop. */
export const researchStopFailed = (): InternalServerErrorException =>
  new InternalServerErrorException('Research stop failed', {
    errorCode: 'RESEARCH_STOP_FAILED',
  });
