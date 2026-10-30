import { NotFoundException } from '@nestjs/common';
import { ErrorCategory, MastraError } from '@mastra/core/error';

/** True for a Mastra error the storage raises for a caller mistake, e.g. updating a missing thread. */
export const isMastraUserError = (error: unknown): boolean =>
  error instanceof MastraError && error.category === ErrorCategory.USER;

/**
 * The only source of the 404 THREAD_NOT_FOUND body: missing, foreign and deleted
 * threads must stay indistinguishable to the client.
 */
export const threadNotFound = (): NotFoundException =>
  new NotFoundException('Thread not found', { errorCode: 'THREAD_NOT_FOUND' });
