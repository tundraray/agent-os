import {
  type AgentHistoryEntry,
  type AgentSessions,
  AgentsError,
  type AgentView,
  type RunOrigin,
  START_AGENT_TOOL,
  StartAgentArgsSchema,
  type WorkflowSnapshot,
} from '@agent-os/agents';

import { WorkflowsError } from './errors.js';
import { type WorkflowBrief, WorkflowBriefSchema } from './start-workflow.tool.js';

/** One executor of the run's team, as its snapshot holds it. */
export interface WorkflowTeamMember {
  readonly name: string;
  readonly role: string;
  readonly maxRuns: number;
  /** The executor whose report becomes the answer. */
  readonly final: boolean;
}

/**
 * A run of a workflow (design-runtime.md, «Данные для `web`», `WorkflowRunView` of `packages/contracts`)
 * with the agents' views and times as `agents` gives them; `apps/api` turns them into the contract.
 */
export interface WorkflowRun {
  /** The workflow record the run started from, at the version confirmed. */
  readonly origin: RunOrigin;
  readonly brief: WorkflowBrief;
  /** The run's status, model and time are the coordinator's: a run has no state of its own. */
  readonly coordinator: AgentView;
  /** The executors of the snapshot; those outside `steps` were not called. */
  readonly team: WorkflowTeamMember[];
  /** The coordinator's direct children in the order they were created, each with `origin.executor`. */
  readonly steps: AgentView[];
  /** Every start of an executor refused by its `maxRuns`. */
  readonly limitRefusals: { readonly executor: string; readonly at: Date }[];
}

export interface WorkflowRuns {
  get(agentId: string, ownerId: string): Promise<WorkflowRun>;
}

export interface WorkflowRunsOptions {
  readonly sessions: Pick<AgentSessions, 'get' | 'list' | 'history' | 'snapshot'>;
}

/** The `agent` of a `start_agent` call: the executor's name in a refusal the view lists. */
const StartedExecutorSchema = StartAgentArgsSchema.pick({ agent: true });
const HISTORY_PAGE = 500;

function runNotFound(agentId: string, cause?: unknown): WorkflowsError {
  return new WorkflowsError('RUN_NOT_FOUND', `Workflow run ${agentId} is not found`, { cause });
}

function teamOf(snapshot: WorkflowSnapshot): WorkflowTeamMember[] {
  const { executors, finalExecutor } = snapshot.content;
  return executors.map(({ name, role, maxRuns }) => ({
    name,
    role,
    maxRuns,
    final: name === finalExecutor,
  }));
}

/**
 * Reads runs through the agents operations only: a run is the coordinator's session, its team is the
 * workflow snapshot of its task, the brief is its first history entry. A missing agent, another owner's
 * agent and an agent without a workflow snapshot get one and the same `RUN_NOT_FOUND`.
 */
export function createWorkflowRuns(options: WorkflowRunsOptions): WorkflowRuns {
  const { sessions } = options;

  async function asRun<T>(agentId: string, work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (error) {
      if (error instanceof AgentsError && error.code === 'AGENT_NOT_FOUND') {
        throw runNotFound(agentId, error);
      }
      throw error;
    }
  }

  async function briefOf(agentId: string, ownerId: string): Promise<WorkflowBrief> {
    const [first] = await sessions.history({ agentId, ownerId, limit: 1 });
    if (first?.kind !== 'task') {
      throw new Error(`Workflow run ${agentId} has no task entry first in its history`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(first.content.text);
    } catch (error) {
      throw new Error(`Workflow run ${agentId} has a task that is not a JSON brief`, { cause: error });
    }
    const brief = WorkflowBriefSchema.safeParse(parsed);
    if (!brief.success) {
      throw new Error(`Workflow run ${agentId} has a task that is not a brief: ${brief.error.message}`);
    }
    return brief.data;
  }

  /** The coordinator's whole history, page by page. */
  async function historyOf(agentId: string, ownerId: string): Promise<AgentHistoryEntry[]> {
    const entries: AgentHistoryEntry[] = [];
    for (;;) {
      const afterSeq = entries.at(-1)?.seq ?? 0;
      const page = await sessions.history({ agentId, ownerId, afterSeq, limit: HISTORY_PAGE });
      entries.push(...page);
      if (page.length < HISTORY_PAGE) return entries;
    }
  }

  /** The coordinator's `start_agent` results refused with `run_limit`, at the time each was written. */
  async function limitRefusalsOf(agentId: string, ownerId: string): Promise<WorkflowRun['limitRefusals']> {
    const refusals: { executor: string; at: Date }[] = [];
    for (const entry of await historyOf(agentId, ownerId)) {
      if (entry.kind !== 'tool_result') continue;
      const { tool, refusalReason, args } = entry.content;
      if (tool !== START_AGENT_TOOL || refusalReason !== 'run_limit') continue;
      const parsed = StartedExecutorSchema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Workflow run ${agentId} has a run_limit refusal without an executor name`);
      }
      refusals.push({ executor: parsed.data.agent, at: entry.createdAt });
    }
    return refusals;
  }

  return {
    async get(agentId, ownerId) {
      const coordinator = await asRun(agentId, sessions.get(agentId, ownerId));
      const snapshot = await asRun(agentId, sessions.snapshot(agentId, ownerId));
      if (snapshot?.kind !== 'workflow') throw runNotFound(agentId);
      const brief = await briefOf(agentId, ownerId);
      const tree = await sessions.list(coordinator.rootId, ownerId);
      return {
        origin: snapshot.origin,
        brief,
        coordinator,
        team: teamOf(snapshot),
        steps: tree.filter((agent) => agent.parentId === agentId),
        limitRefusals: await limitRefusalsOf(agentId, ownerId),
      };
    },
  };
}
