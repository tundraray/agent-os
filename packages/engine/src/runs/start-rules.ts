import type { Investigation, TaskSpec } from '@agent-os/contracts';
import type { ProcessConfig } from '../config/process-config.schema.js';

/** What a start asks of the investigation it records: the thread, its owner, the query and the runtime budget. */
export interface ShellRequest {
  readonly resourceId: string;
  readonly threadId: string;
  readonly query: string;
  readonly maxTasks: number;
  readonly maxToolCalls: number;
}

/**
 * The shell a failed start left (KD-9, DC-19): an `active` investigation of the same thread and owner with the same
 * `query` and budget, without an engine row and without tasks. Shells are interchangeable, so the first one is taken.
 */
export function findShell(
  investigations: readonly Investigation[],
  request: ShellRequest,
  withEngineRow: ReadonlySet<string>,
): Investigation | undefined {
  return investigations.find(
    (investigation) =>
      investigation.status === 'active' &&
      investigation.resourceId === request.resourceId &&
      investigation.threadId === request.threadId &&
      investigation.query === request.query &&
      investigation.budget.maxTasks === request.maxTasks &&
      investigation.budget.maxToolCalls === request.maxToolCalls &&
      (investigation.tasks ?? []).length === 0 &&
      !withEngineRow.has(investigation.investigationId),
  );
}

export type TokenBudgetResolution =
  | { readonly ok: true; readonly tokenBudget: number }
  | { readonly ok: false; readonly code: 'budget_out_of_range' };

/** The investigation's token budget: the configured default without one, otherwise a whole number in [1, max]. */
export function resolveTokenBudget(
  requested: number | undefined,
  limits: ProcessConfig['limits']['investigationTokens'],
): TokenBudgetResolution {
  if (requested === undefined) {
    return { ok: true, tokenBudget: limits.default };
  }
  if (!Number.isInteger(requested) || requested < 1 || requested > limits.max) {
    return { ok: false, code: 'budget_out_of_range' };
  }
  return { ok: true, tokenBudget: requested };
}

/** Workflow type of an investigation's controller task. */
export const CONTROLLER_WORKFLOW = 'research.controller';

/** Subscriber key of the tasks the engine proposes from a start. */
export const ENGINE_REQUESTER_KEY = 'research.engine';

/**
 * The controller task of an investigation (design-engine.md, Runtime settings): its deadline from the configuration,
 * `maxTokens` the investigation's token budget, one tool call and no retries — it calls no tool. The spec depends only
 * on the recorded run, so a repeated start proposes the same task and the runtime answers `subscribed`.
 */
export function controllerTaskSpec(run: {
  readonly investigationId: string;
  readonly config: ProcessConfig;
  readonly tokenBudget: number;
}): TaskSpec {
  return {
    investigationId: run.investigationId,
    workflowType: CONTROLLER_WORKFLOW,
    workflowVersion: 1,
    input: { investigationId: run.investigationId },
    inputRefs: [],
    expectedOutput: { description: 'The answerId and outcome of the investigation', completeness: 'all' },
    dependsOn: [],
    budget: {
      maxToolCalls: 1,
      maxRetries: 0,
      deadlineMs: run.config.limits.taskBudgets[CONTROLLER_WORKFLOW].deadlineMs,
      maxTokens: run.tokenBudget,
    },
  };
}
