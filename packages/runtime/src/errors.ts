/** Error codes of runtime operations (design-runtime.md, Error handling). */
export const RUNTIME_ERROR_CODES = [
  /** The task does not exist or belongs to another owner. */
  'TASK_NOT_FOUND',
  /** No handler is registered for the task type. */
  'UNKNOWN_TASK_TYPE',
  /** A child is created under a finished parent; the parent is first revived by a message. */
  'PARENT_FINISHED',
  /** The input failed the handler's schema; the message carries the path and the reason. */
  'INVALID_TASK_INPUT',
  /** A message payload is larger than `INBOX_PAYLOAD_MAX_BYTES`. */
  'PAYLOAD_TOO_LARGE',
  /** The decision request does not exist or belongs to another owner. */
  'DECISION_NOT_FOUND',
  /** No price is configured for the model. */
  'UNKNOWN_MODEL_PRICE',
] as const;
export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

/** An expected refusal of a runtime operation; the caller maps `code` to its own answer. */
export class RuntimeError extends Error {
  override readonly name = 'RuntimeError';

  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
