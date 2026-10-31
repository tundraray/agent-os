import type { StopReason } from './tool-executor.js';

/**
 * The attempt ended without an outcome of its own (`fenced`, `not_current_attempt`, `shutdown`, `lease_lost`):
 * `FetchHandler` throws it and the Dispatcher's outcome guarantees decide what, if anything, is written.
 */
export class AttemptStoppedError extends Error {
  override readonly name = 'AttemptStoppedError';

  constructor(readonly reason: StopReason) {
    super(`The attempt stopped: ${reason}`);
  }
}
