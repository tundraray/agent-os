/** Error codes of workflows operations (design-workflows.md, Error handling). */
export type WorkflowsErrorCode =
  /** The run does not exist, belongs to another owner, or the agent is not a template's coordinator. */
  'RUN_NOT_FOUND';

/** An expected refusal of a workflows operation; the caller maps `code` to its own answer. */
export class WorkflowsError extends Error {
  override readonly name = 'WorkflowsError';

  constructor(
    readonly code: WorkflowsErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
