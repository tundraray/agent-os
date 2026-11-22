import type { Database } from '@agent-os/db';

import { auditStartRefusal, resolveStart } from '../../start/resolve-start';
import type { AgentTool } from '../tool';
import { rootMayStartRecord } from '../tool-gate';
import { type BuiltinTasks, createListAgentsTool } from './list-agents';
import { createMessageAgentTool } from './message-agent';
import { createStartAgentTool, type StartAgentDeps } from './start-agent';
import { createStartDeepAgentTool } from './start-deep-agent';
import { createStopAgentTool } from './stop-agent';
import { createToolResultTools } from './tool-result-tools';

export { createStartChild } from './start-child';

export interface BuiltinToolsDeps extends StartAgentDeps {
  readonly tasks: BuiltinTasks;
  /** `list_agents` reads the sessions of the caller's descendants; the reading tools, the stored results. */
  readonly database: Database;
}

/**
 * The package's built-in tools (design-agents.md, «Инструменты»): `start_agent`, `message_agent`,
 * `list_agents`, `stop_agent`, the root's `start_deep_agent` (deep-agents KD-2), and `read_tool_result`,
 * `search_tool_result` of every session (tool-result-reading R-2). The composition root hands them to the
 * tool registry.
 */
export function createBuiltinTools(deps: BuiltinToolsDeps): AgentTool[] {
  return [
    createStartAgentTool(deps),
    createStartDeepAgentTool({
      resolveStart: (request) => resolveStart(request, deps),
      auditStartRefusal: (refusal) => auditStartRefusal(deps.audit, refusal),
      rootMayStart: async (ownerId, recordId) =>
        rootMayStartRecord(await deps.library.listVisible(ownerId), 'deep_agent', recordId),
      logger: deps.logger,
    }),
    createMessageAgentTool(deps),
    createListAgentsTool(deps),
    createStopAgentTool(deps),
    ...createToolResultTools(deps),
  ];
}
