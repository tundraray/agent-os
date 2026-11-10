import type { TaskSpec } from '@agent-os/contracts';
import { z } from 'zod';

/**
 * The tasks of agent runs (design-agent-core.md, KD-1, «Задачи запусков»): the root is `agent.root` and every child
 * `agent.run`, both version 1. The input carries what the run row is written from, and the dedup key is made of it.
 */
export const AGENT_RUN_WORKFLOW = 'agent.run';
/** The root of an agent tree; the end of its task closes the investigation (KD-1). */
export const AGENT_ROOT_WORKFLOW = 'agent.root';
export const AGENT_WORKFLOW_VERSION = 1;

/** The input of a run task: the agent, its assignment, the parent run and call, the depth, the sources and `notAfter`. */
export const AgentTaskInputSchema = z.strictObject({
  agentName: z.string().min(1),
  assignment: z.string().min(1),
  parent: z.strictObject({ taskId: z.uuid(), callIndex: z.number().int().nonnegative() }).nullable(),
  depth: z.number().int().nonnegative(),
  sources: z.array(z.string().min(1)),
  /** ISO time after which the run starts no turn (DC-27). */
  notAfter: z.iso.datetime(),
});
export type AgentTaskInput = z.infer<typeof AgentTaskInputSchema>;

/** The least `deadlineMs` a task may have (`TaskBudgetSchema`). */
const DEADLINE_MIN_MS = 1_000;

/** What a child's task is made of. */
export interface ChildTaskRequest {
  readonly investigationId: string;
  readonly agentName: string;
  readonly assignment: string;
  readonly parent: { readonly taskId: string; readonly callIndex: number; readonly notAfter: Date };
  /** The child's depth: the parent's plus one. */
  readonly depth: number;
  readonly sources: readonly string[];
  /** The child definition's `limits.deadlineMs`. */
  readonly definitionDeadlineMs: number;
  /** The share granted to the child: its task's `maxTokens`. */
  readonly shareTokens: number;
  readonly now: Date;
  /** `AGENT_DEADLINE_MARGIN_MS` and `RUNTIME_LEASE_MS`. */
  readonly timings: { readonly deadlineMarginMs: number; readonly leaseMs: number };
}

/**
 * The child's task (Contract «Задачи запусков», DC-27): `maxToolCalls` 1 — the engine runs the tools and sources are
 * called by gather tasks; `maxRetries` 0; `deadlineMs` the definition's, but no more than what is left of the parent's
 * run; `maxTokens` the share. `notAfter` is the smaller of the task's deadline minus the margin and the parent's
 * `notAfter` minus one lease, so the child ends before its parent by at least one guarded write.
 */
export function childTaskSpec(request: ChildTaskRequest): TaskSpec {
  const parentLeftMs = request.parent.notAfter.getTime() - request.now.getTime();
  const deadlineMs = Math.max(DEADLINE_MIN_MS, Math.min(request.definitionDeadlineMs, parentLeftMs));
  const notAfterMs = Math.min(
    request.now.getTime() + deadlineMs - request.timings.deadlineMarginMs,
    request.parent.notAfter.getTime() - request.timings.leaseMs,
  );
  const input: AgentTaskInput = {
    agentName: request.agentName,
    assignment: request.assignment,
    parent: { taskId: request.parent.taskId, callIndex: request.parent.callIndex },
    depth: request.depth,
    sources: [...request.sources],
    notAfter: new Date(notAfterMs).toISOString(),
  };
  return {
    investigationId: request.investigationId,
    workflowType: AGENT_RUN_WORKFLOW,
    workflowVersion: AGENT_WORKFLOW_VERSION,
    input,
    inputRefs: [],
    expectedOutput: { description: `the result of agent ${request.agentName}`, completeness: 'all' },
    dependsOn: [],
    budget: { maxToolCalls: 1, maxRetries: 0, deadlineMs, maxTokens: request.shareTokens },
  };
}

/** The sources of a child run: its parent's, narrowed to its definition's when it names any (DC-12, invariant 8). */
export function childSources(parentSources: readonly string[], definitionSources: readonly string[] | undefined): string[] {
  if (definitionSources === undefined) return [...parentSources];
  return parentSources.filter((sourceId) => definitionSources.includes(sourceId));
}

/**
 * The run's deadline `notAfter` (DC-27): the smallest of its task's deadline minus `AGENT_DEADLINE_MARGIN_MS`, the
 * `notAfter` of its task input and, for a child, its parent's `notAfter` minus `RUNTIME_LEASE_MS`, so a child ends
 * before its parent by at least one guarded write (DC-7). A child's input bound is already less its margins (its parent
 * set it); the root's is the recorded start's bound without the margin — the margin stays out of the root's
 * `dedup_key` — so the margin is taken off it here.
 */
export function runNotAfter(input: {
  readonly taskDeadlineAt: Date;
  readonly deadlineMarginMs: number;
  readonly inputNotAfter: Date;
  readonly parent: { readonly notAfter: Date; readonly leaseMs: number } | null;
}): Date {
  const own = input.taskDeadlineAt.getTime() - input.deadlineMarginMs;
  if (input.parent === null) return new Date(Math.min(own, input.inputNotAfter.getTime() - input.deadlineMarginMs));
  const parent = input.parent.notAfter.getTime() - input.parent.leaseMs;
  return new Date(Math.min(own, input.inputNotAfter.getTime(), parent));
}
