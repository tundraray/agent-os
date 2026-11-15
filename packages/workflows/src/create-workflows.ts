import type { Agents, AgentSessions } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';

import { createWorkflowRuns, type WorkflowRuns } from './runs.js';
import { SHIPPED_TEMPLATES } from './shipped-templates.js';
import { createStartWorkflowTool } from './start-workflow.tool.js';
import { parseTemplates, toDefinitions, type WorkflowTemplateHeader } from './template.js';

/** The part of `agents` the workflows package uses. */
export interface WorkflowsAgents {
  readonly definitions: Pick<Agents['definitions'], 'register'>;
  readonly tools: Pick<Agents['tools'], 'register'>;
  readonly sessions: Pick<AgentSessions, 'get' | 'list' | 'history'>;
}

export interface WorkflowsOptions {
  readonly agents: WorkflowsAgents;
  readonly logger: Logger;
  /** Raw template data; the shipped templates by default (`apps/api` does not pass it). */
  readonly templates?: readonly unknown[];
}

/** The workflows package (design-workflows.md, Contract «Сборка»): no settings, no background work. */
export interface Workflows {
  readonly templates: { list(): WorkflowTemplateHeader[] };
  readonly runs: WorkflowRuns;
}

/**
 * Parses the templates and registers their definitions and the `start_workflow` tool in `agents`.
 * Called after `createAgents` and before `agents.start()`; a bad template throws before anything is
 * registered, so the start stops (DC-1).
 */
export function createWorkflows(options: WorkflowsOptions): Workflows {
  const { agents } = options;
  const logger = options.logger.child({ component: 'workflows' });
  const templates = parseTemplates(options.templates ?? SHIPPED_TEMPLATES);
  const tool = createStartWorkflowTool({ templates, logger });

  for (const template of templates) {
    for (const definition of toDefinitions(template)) agents.definitions.register(definition);
  }
  agents.tools.register(tool);
  logger.info('workflow templates parsed', { templates: templates.map((template) => template.name) });

  const headers: WorkflowTemplateHeader[] = templates.map(({ name, title, description }) => ({
    name,
    title,
    description,
  }));
  return {
    templates: { list: () => headers.map((header) => ({ ...header })) },
    runs: createWorkflowRuns({ sessions: agents.sessions, templates: headers }),
  };
}
