import { type AgentSessions, AgentsError, type AgentView } from '@agent-os/agents';

import { WorkflowsError } from './errors.js';
import { type WorkflowBrief, WorkflowBriefSchema } from './start-workflow.tool.js';
import type { WorkflowTemplateHeader } from './template.js';

/** What the web shows in the step card and on the run page (design-workflows.md, WorkflowRunView). */
export interface WorkflowRunView {
  /** The coordinator's id; it is the run's id. */
  readonly agentId: string;
  readonly template: { readonly name: string; readonly title: string };
  readonly brief: WorkflowBrief;
  /** The run's status, model and time are the coordinator's: a run has no state of its own. */
  readonly coordinator: AgentView;
  /** The coordinator's direct children in the order they were created. */
  readonly steps: AgentView[];
}

export interface WorkflowRuns {
  get(agentId: string, ownerId: string): Promise<WorkflowRunView>;
}

export interface WorkflowRunsOptions {
  readonly sessions: Pick<AgentSessions, 'get' | 'list' | 'history'>;
  readonly templates: readonly WorkflowTemplateHeader[];
}

function runNotFound(agentId: string, cause?: unknown): WorkflowsError {
  return new WorkflowsError('RUN_NOT_FOUND', `Workflow run ${agentId} is not found`, { cause });
}

/**
 * Reads runs through the agents operations only (KD-3: a run is the coordinator's session, the brief is
 * its first history entry). A missing agent, another owner's agent and an agent that is not a template's
 * coordinator get one and the same `RUN_NOT_FOUND`.
 */
export function createWorkflowRuns(options: WorkflowRunsOptions): WorkflowRuns {
  const { sessions } = options;
  const templates = new Map(options.templates.map((template) => [template.name, template]));

  async function coordinatorOf(agentId: string, ownerId: string): Promise<AgentView> {
    try {
      return await sessions.get(agentId, ownerId);
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

  return {
    async get(agentId, ownerId) {
      const coordinator = await coordinatorOf(agentId, ownerId);
      const template = templates.get(coordinator.definition);
      if (template === undefined) throw runNotFound(agentId);
      const brief = await briefOf(agentId, ownerId);
      const tree = await sessions.list(coordinator.rootId, ownerId);
      return {
        agentId,
        template: { name: template.name, title: template.title },
        brief,
        coordinator,
        steps: tree.filter((agent) => agent.parentId === agentId),
      };
    },
  };
}
