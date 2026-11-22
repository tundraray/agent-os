import type { AgentToolResultsRepository } from '@agent-os/db';

import type { Sessions } from '../../store/sessions';
import type { AgentTool } from '../tool';
import { type BuiltinTasks, createListAgentsTool } from './list-agents';
import { createMessageAgentTool } from './message-agent';
import { createStartAgentTool, type StartAgentDeps } from './start-agent';
import { createStopAgentTool } from './stop-agent';
import { createToolResultTools } from './tool-result-tools';

export interface SystemToolsDeps extends StartAgentDeps {
  readonly tasks: BuiltinTasks;
  /** `list_agents` reads the sessions of the caller's descendants; the reading tools, the stored results. */
  readonly sessions: Sessions;
  readonly toolResultRows: AgentToolResultsRepository;
}

/**
 * The system tools — the ones agents run the platform itself with (design-agents.md, «Инструменты»):
 * `start_agent`, `message_agent`, `list_agents`, `stop_agent`, and `read_tool_result`, `search_tool_result`
 * of every session (tool-result-reading R-2). The task-list tools are made by `createTaskListTools`; a deep agent's
 * tools live in `deep/`. `SystemToolsRegistration` registers them all in the tools library.
 */
export function createSystemTools(deps: SystemToolsDeps): AgentTool[] {
  return [
    createStartAgentTool(deps),
    createMessageAgentTool(deps),
    createListAgentsTool(deps),
    createStopAgentTool(deps),
    ...createToolResultTools(deps),
  ];
}
