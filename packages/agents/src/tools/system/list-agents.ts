import type { Database } from '@agent-os/db';
import type { TaskControl } from '@agent-os/runtime';
import { z } from 'zod';

import { agentStatus } from '../../agent-view';
import type { Sessions } from '../../store/sessions';
import { descendantsOf } from '../../task-tree';
import type { OutsideAgentTool } from '../tool';

/** The task operations the built-in tools use. */
export type BuiltinTasks = Pick<TaskControl, 'listTree' | 'stop'>;

const ListAgentsArgsSchema = z.object({});
type ListAgentsArgs = z.infer<typeof ListAgentsArgsSchema>;

export interface ListAgentsDeps {
  readonly tasks: BuiltinTasks;
  readonly database: Database;
  readonly sessions: Sessions;
}

/** `list_agents` (design-agents.md, «Инструменты»): the caller's descendants — id, description, name, model, status. */
export function createListAgentsTool(deps: ListAgentsDeps): OutsideAgentTool<ListAgentsArgs> {
  return {
    name: 'list_agents',
    description:
      'A snapshot of the agents you started and the agents they started: id, description, name, model and status. ' +
      'Use it to answer a question about the agents, never to wait for them: their reports arrive on their own as messages.',
    argsSchema: ListAgentsArgsSchema,
    mode: 'outside',
    async execute({ caller }) {
      const tree = await deps.tasks.listTree(caller.rootId, caller.ownerId);
      const descendants = descendantsOf(tree, caller.agentId);
      const sessionsById = await deps.sessions.getMany(
        deps.database,
        descendants.map((task) => task.taskId),
      );
      const agents = descendants.flatMap((task) => {
        const session = sessionsById.get(task.taskId);
        if (session === undefined) return [];
        return [
          {
            agentId: task.taskId,
            description: session.description,
            name: session.name,
            model: session.model,
            status: agentStatus({
              taskStatus: task.status,
              waitReason: task.waitReason,
              pendingInterrupt: false,
              sessionInterrupted: session.interrupted,
            }),
          },
        ];
      });
      return agents.length === 0
        ? { kind: 'done', outcome: 'empty', text: 'You have started no agents.' }
        : { kind: 'done', outcome: 'success', text: JSON.stringify(agents) };
    },
  };
}
