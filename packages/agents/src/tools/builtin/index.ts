import type { Database } from '@agent-os/db';

import type { AgentTool } from '../tool.js';
import { type BuiltinTasks, createListAgentsTool } from './list-agents.js';
import { createMessageAgentTool } from './message-agent.js';
import { createStartAgentTool } from './start-agent.js';
import type { StartChildDeps } from './start-child.js';
import { createStopAgentTool } from './stop-agent.js';

export { describeStartAgent } from './start-agent.js';
export { createStartChild, type StartChildDeps } from './start-child.js';

export interface BuiltinToolsDeps extends StartChildDeps {
  readonly tasks: BuiltinTasks;
  readonly database: Database;
}

/**
 * The package's built-in tools (design-agents.md, «Инструменты»): `start_agent`, `message_agent`,
 * `list_agents`, `stop_agent`. The composition root hands them to the tool registry together with
 * {@link describeStartAgent}.
 */
export function createBuiltinTools(deps: BuiltinToolsDeps): AgentTool[] {
  return [
    createStartAgentTool(deps),
    createMessageAgentTool(deps),
    createListAgentsTool(deps),
    createStopAgentTool(deps),
  ];
}
