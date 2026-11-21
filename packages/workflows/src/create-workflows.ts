import { type Agents, type AgentSessions, START_WORKFLOW_TOOL } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';

import { createWorkflowRuns, type WorkflowRuns } from './runs';
import { createStartWorkflowTool } from './start-workflow.tool';

/** The part of `agents` the workflows package uses. */
export interface WorkflowsAgents {
  readonly tools: Pick<Agents['tools'], 'register'>;
  readonly sessions: Pick<AgentSessions, 'get' | 'list' | 'history' | 'snapshot'>;
  readonly resolveStart: Agents['resolveStart'];
  readonly auditStartRefusal: Agents['auditStartRefusal'];
  readonly rootMayStart: Agents['rootMayStart'];
}

export interface WorkflowsOptions {
  readonly agents: WorkflowsAgents;
  readonly logger: Logger;
}

/** The workflows package (design-runtime.md, KD-5): the brief, `start_workflow` and the run view. */
export interface Workflows {
  readonly runs: WorkflowRuns;
}

/**
 * Registers the `start_workflow` tool in `agents`. Called after `createAgents` and before
 * `agents.start()`; workflows themselves are records of the library, read at each start.
 */
export function createWorkflows(options: WorkflowsOptions): Workflows {
  const { agents } = options;
  const logger = options.logger.child({ component: 'workflows' });
  agents.tools.register(createStartWorkflowTool({ agents, logger }));
  logger.info('workflows registered', { tools: [START_WORKFLOW_TOOL] });
  return { runs: createWorkflowRuns({ sessions: agents.sessions }) };
}
