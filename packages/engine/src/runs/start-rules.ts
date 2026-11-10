import type { Investigation, TaskSpec } from '@agent-os/contracts';
import { AGENT_ROOT_WORKFLOW, AGENT_WORKFLOW_VERSION, type AgentTaskInput } from '../agents/agent-task-spec.js';
import type { AgentProcessConfig } from '../config/agent-config.schema.js';
import type { SourceMode } from '../config/source-check.js';

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
  limits: AgentProcessConfig['limits']['investigationTokens'],
): TokenBudgetResolution {
  if (requested === undefined) {
    return { ok: true, tokenBudget: limits.default };
  }
  if (!Number.isInteger(requested) || requested < 1 || requested > limits.max) {
    return { ok: false, code: 'budget_out_of_range' };
  }
  return { ok: true, tokenBudget: requested };
}

/** Subscriber key of the tasks the engine proposes from a start. */
export const ENGINE_REQUESTER_KEY = 'research.engine';

/**
 * The root of an investigation (DC-22): in the mode without sources the definition `modelKnowledgeRoot`
 * when the key is set; otherwise, in either mode, `rootAgent`.
 */
export function rootAgentOf(
  config: Pick<AgentProcessConfig, 'rootAgent' | 'modelKnowledgeRoot'>,
  sourceMode: SourceMode,
): string {
  return sourceMode === 'model_knowledge' && config.modelKnowledgeRoot !== undefined
    ? config.modelKnowledgeRoot
    : config.rootAgent;
}

/**
 * The root task of an investigation (design-agent-core.md, KD-1, KD-4, «Задачи запусков»): `agent.root`
 * version 1 with the question as its assignment, the share the investigation's whole budget, one tool call and no
 * retries, the root definition's deadline. Its sources are the root definition's (the process's without them), none in
 * the mode without sources. The spec depends only on the recorded run, so a repeated start proposes the same task and
 * the runtime answers `subscribed`; `notAfter` of the input is the bound of the recorded start: its time plus the root's
 * deadline. The handler takes `AGENT_DEADLINE_MARGIN_MS` off it (DC-27); the margin is no part of the input, so a change
 * of it keeps the root task's `dedup_key`.
 */
export function rootTaskSpec(run: {
  readonly investigationId: string;
  readonly config: AgentProcessConfig;
  readonly tokenBudget: number;
  readonly query: string;
  readonly sourceMode: SourceMode;
  readonly createdAt: Date;
}): TaskSpec {
  const agentName = rootAgentOf(run.config, run.sourceMode);
  const definition = run.config.agents[agentName];
  if (definition === undefined) throw new Error(`root ${agentName} is not a definition of ${run.config.processId}`);
  const sources =
    run.sourceMode === 'model_knowledge'
      ? []
      : (definition.sources ?? [...new Set(run.config.sources.map((source) => source.sourceId))]);
  const input: AgentTaskInput = {
    agentName,
    assignment: run.query,
    parent: null,
    depth: 0,
    sources,
    notAfter: new Date(run.createdAt.getTime() + definition.limits.deadlineMs).toISOString(),
  };
  return {
    investigationId: run.investigationId,
    workflowType: AGENT_ROOT_WORKFLOW,
    workflowVersion: AGENT_WORKFLOW_VERSION,
    input,
    inputRefs: [],
    expectedOutput: { description: `the result of agent ${agentName}`, completeness: 'all' },
    dependsOn: [],
    budget: { maxToolCalls: 1, maxRetries: 0, deadlineMs: definition.limits.deadlineMs, maxTokens: run.tokenBudget },
  };
}
