import type { Coverage } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { HandlerResult, TaskContext } from '@agent-os/runtime';
import { ProcessConfigSchema } from '../config/process-config.schema.js';
import type { SourceMode } from '../config/source-check.js';
import { controllerRepository } from '../controller/decisions.repository.js';
import type { InvestigationFrame } from '../controller/plan-role.js';
import { ENGINE_FAILURE_CLASSES, type EngineFailureCode } from '../engine-errors.js';

/** The investigation as one attempt of an engine task sees it: its frozen configuration, mode and query, and the owner. */
export interface TaskFrame extends InvestigationFrame {
  readonly resourceId: string;
  readonly threadId: string;
}

/** The attempt ends without an outcome: a cancel or a lost attempt; the runtime decides it by the abort or the fence. */
class AttemptAbandonedError extends Error {
  override readonly name = 'AttemptAbandonedError';
}

/** Ends the attempt of `workflowType` without an outcome. */
export function abandon(workflowType: string, cause: 'cancelled' | 'fenced'): never {
  throw new AttemptAbandonedError(`${workflowType} attempt ended without an outcome: ${cause}`);
}

/** The frame of the task's investigation, read from its engine row (DC-15, DC-16); `notAfter` comes from the task input. */
export async function readTaskFrame(db: Database, ctx: TaskContext, notAfter: Date): Promise<TaskFrame> {
  const read = await controllerRepository.readRun(db, ctx.investigationId);
  if (read === undefined) {
    throw new Error(`investigation ${ctx.investigationId} has no engine row`);
  }
  return {
    investigationId: ctx.investigationId,
    resourceId: read.run.resourceId,
    threadId: read.threadId,
    query: read.query,
    config: ProcessConfigSchema.parse(read.run.processConfig),
    sourceMode: read.run.sourceMode as SourceMode,
    notAfter,
  };
}

/** A `succeeded` outcome of an engine task: it writes no evidence and proposes through the scheduler. */
export function succeeded(
  answerOrDelta: HandlerResult['answerOrDelta'],
  options: { readonly coverage?: Coverage | null; readonly warnings?: string[] } = {},
): HandlerResult {
  return {
    kind: 'completed',
    answerOrDelta,
    evidenceRefs: [],
    coverage: options.coverage ?? null,
    missingEvidence: [],
    warnings: options.warnings ?? [],
    proposedTasks: [],
  };
}

/** A `failed` outcome with the engine code and its `FailureReason` class (Error handling). */
export function failed(ctx: TaskContext, code: EngineFailureCode, message: string): HandlerResult {
  return {
    kind: 'failed',
    answerOrDelta: null,
    evidenceRefs: [],
    coverage: null,
    missingEvidence: [],
    warnings: [],
    proposedTasks: [],
    failure: { class: ENGINE_FAILURE_CLASSES[code], code, message, cause: null, attempt: ctx.attempt, toolCalls: 0, retries: 0 },
  };
}
