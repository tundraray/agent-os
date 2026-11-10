import type { HandlerResult, TaskContext, TaskHandler } from '@agent-os/runtime';
import { AttemptStoppedError } from './attempt-stopped.error.js';
import { FetchCheckpointSchema, FetchInputSchema } from './fetch-input.js';
import { SOURCE_FETCH_WORKFLOW as SOURCE_FETCH } from './source-declaration.js';
import type { ToolExecutor, ToolOutcome } from './tool-executor.js';

/** Kind of the input reference that pins a source's snapshot: `{kind: "source", ref: sourceId, snapshot}`. */
const SOURCE_REF_KIND = 'source';

/**
 * Handler of `source.fetch` v1 (design-mcp-source.md, Flow 1): reads `FetchInput`, the snapshot pinned by the
 * task's input reference of the source and the checkpoint of a previous attempt, and runs the tool through
 * `ToolExecutor`. A task with no input reference of its source fails `snapshot_pin_missing` before any call.
 * `stopped` is thrown as `AttemptStoppedError`; the Dispatcher's outcome guarantees decide what is written.
 */
export class FetchHandler implements TaskHandler {
  readonly workflowType = SOURCE_FETCH;
  readonly workflowVersion = 1;
  readonly inputSchema = FetchInputSchema;

  constructor(private readonly executor: ToolExecutor) {}

  async run(ctx: TaskContext): Promise<HandlerResult> {
    const input = FetchInputSchema.parse(ctx.input);
    const pin = ctx.inputRefs.find((ref) => ref.kind === SOURCE_REF_KIND && ref.ref === input.sourceId);
    if (pin === undefined) {
      return result({
        kind: 'failed',
        evidenceRefs: [],
        coverage: null,
        warnings: [],
        failure: {
          class: 'validation_rejected',
          code: 'snapshot_pin_missing',
          message: `The task has no input reference {kind: "source", ref: "${input.sourceId}"} with the pinned snapshot`,
          cause: null,
          attempt: ctx.attempt,
          toolCalls: 0,
          retries: 0,
        },
      });
    }
    const outcome = await this.executor.execute(ctx, {
      workflowType: SOURCE_FETCH,
      sourceId: input.sourceId,
      toolName: input.toolName,
      args: input.args,
      pin: pin.snapshot,
      completeness: ctx.expectedOutput.completeness,
      resume: ctx.checkpoint === null ? null : FetchCheckpointSchema.parse(ctx.checkpoint),
    });
    if (outcome.kind === 'stopped') {
      throw new AttemptStoppedError(outcome.reason);
    }
    return result(outcome);
  }
}

/** `ToolOutcome` in the fields of `HandlerResult`: the stored pages are the task's `outputRefs`. */
function result(outcome: Exclude<ToolOutcome, { kind: 'stopped' }>): HandlerResult {
  return {
    kind: outcome.kind,
    answerOrDelta: null,
    evidenceRefs: [...outcome.evidenceRefs],
    coverage: outcome.coverage,
    missingEvidence: [],
    warnings: [...outcome.warnings],
    proposedTasks: [],
    ...(outcome.kind === 'failed' ? { failure: outcome.failure } : {}),
  };
}
