import { z } from 'zod';

import { descendantsOf } from '../../task-tree';
import type { OutsideAgentTool } from '../tool';
import type { BuiltinTasks } from './list-agents';

const StopAgentArgsSchema = z.object({
  agentId: z
    .string()
    .min(1)
    .describe('Id of an agent you started, or of one it started'),
});
type StopAgentArgs = z.infer<typeof StopAgentArgsSchema>;

/**
 * `stop_agent` (design-agents.md, «Инструменты»): stops a descendant of the caller and its own
 * descendants through `tasks.stop`; any other target is refused with `unknown_agent`.
 */
export function createStopAgentTool(deps: {
  readonly tasks: BuiltinTasks;
}): OutsideAgentTool<StopAgentArgs> {
  return {
    name: 'stop_agent',
    description:
      'Stop an agent you started (or one it started) together with the agents it started.',
    argsSchema: StopAgentArgsSchema,
    mode: 'outside',
    async execute({ args, caller }) {
      const tree = await deps.tasks.listTree(caller.rootId, caller.ownerId);
      const isDescendant = descendantsOf(tree, caller.agentId).some(
        (task) => task.taskId === args.agentId,
      );
      if (!isDescendant) return { kind: 'refused', reason: 'unknown_agent' };
      const stopped = await deps.tasks.stop(args.agentId, caller.ownerId);
      return {
        kind: 'done',
        outcome: 'success',
        text:
          stopped.length === 0
            ? `Agent ${args.agentId} had already finished.`
            : JSON.stringify({ stopped }),
      };
    },
  };
}
