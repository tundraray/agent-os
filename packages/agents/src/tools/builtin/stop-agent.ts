import { z } from 'zod';

import type { OutsideAgentTool } from '../tool.js';
import { gateTarget } from '../tool-gate.js';
import { type BuiltinTasks, descendantsOf } from './list-agents.js';

const StopAgentArgsSchema = z.object({
  agentId: z.string().min(1).describe('Id of an agent you started, or of one it started'),
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
    title: 'Остановить агента',
    argLabels: { agentId: 'Агент' },
    description: 'Stop an agent you started (or one it started) together with the agents it started.',
    argsSchema: StopAgentArgsSchema,
    mode: 'outside',
    async execute({ args, caller }) {
      const tree = await deps.tasks.listTree(caller.rootId, caller.ownerId);
      const isDescendant = descendantsOf(tree, caller.agentId).some(
        (task) => task.taskId === args.agentId,
      );
      const gate = gateTarget({ isDescendant });
      if (gate.kind === 'refused') return gate;
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
