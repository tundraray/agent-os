import type { Database } from '@agent-os/db';
import type { Runtime, Task } from '@agent-os/runtime';
import { z } from 'zod';

import { agentStatus } from '../../agent-view.js';
import { sessions } from '../../store/sessions.repository.js';
import type { OutsideAgentTool } from '../tool.js';

/** The task operations the built-in tools use. */
export type BuiltinTasks = Pick<Runtime['tasks'], 'listTree' | 'stop'>;

/**
 * The descendants of `agentId` in a tree listed in creation order: a parent is always created before
 * its child, so one pass collects the whole subtree.
 */
export function descendantsOf(tree: readonly Task[], agentId: string): Task[] {
  const subtree = new Set([agentId]);
  const descendants: Task[] = [];
  for (const task of tree) {
    if (task.parentId !== null && subtree.has(task.parentId)) {
      subtree.add(task.taskId);
      descendants.push(task);
    }
  }
  return descendants;
}

const ListAgentsArgsSchema = z.object({});
type ListAgentsArgs = z.infer<typeof ListAgentsArgsSchema>;

export interface ListAgentsDeps {
  readonly tasks: BuiltinTasks;
  readonly database: Database;
}

/** `list_agents` (design-agents.md, «Инструменты»): the caller's descendants — id, description, definition, model, status. */
export function createListAgentsTool(deps: ListAgentsDeps): OutsideAgentTool<ListAgentsArgs> {
  return {
    name: 'list_agents',
    title: 'Показать агентов',
    description:
      'A snapshot of the agents you started and the agents they started: id, description, definition, model and status. ' +
      'Use it to answer a question about the agents, never to wait for them: their reports arrive on their own as messages.',
    argsSchema: ListAgentsArgsSchema,
    mode: 'outside',
    async execute({ caller }) {
      const tree = await deps.tasks.listTree(caller.rootId, caller.ownerId);
      const descendants = descendantsOf(tree, caller.agentId);
      const sessionsById = await sessions.getMany(
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
            definition: session.definition,
            model: session.model,
            status: agentStatus({
              taskStatus: task.status,
              waitReason: task.waitReason,
              pendingInterruptWithoutText: false,
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
