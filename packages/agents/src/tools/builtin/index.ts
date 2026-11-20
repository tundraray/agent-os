import type { Database } from '@agent-os/db';

import type { AgentTool } from '../tool.js';
import { type BuiltinTasks, createListAgentsTool } from './list-agents.js';
import { createMessageAgentTool } from './message-agent.js';
import { createStartAgentTool, type StartAgentDeps } from './start-agent.js';
import { createStopAgentTool } from './stop-agent.js';
import { createToolResultTools } from './tool-result-tools.js';

export { createStartChild } from './start-child.js';

export interface BuiltinToolsDeps extends StartAgentDeps {
  readonly tasks: BuiltinTasks;
  /** `list_agents` reads the sessions of the caller's descendants; the reading tools, the stored results. */
  readonly database: Database;
}

/**
 * The package's built-in tools (design-agents.md, «Инструменты»): `start_agent`, `message_agent`,
 * `list_agents`, `stop_agent`, and `read_tool_result`, `search_tool_result` of every session
 * (tool-result-reading R-2). The composition root hands them to the tool registry.
 */
export function createBuiltinTools(deps: BuiltinToolsDeps): AgentTool[] {
  return [
    createStartAgentTool(deps),
    createMessageAgentTool(deps),
    createListAgentsTool(deps),
    createStopAgentTool(deps),
    ...createToolResultTools(deps),
  ];
}
