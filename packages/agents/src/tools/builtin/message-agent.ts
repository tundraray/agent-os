import { AgentMessageKindSchema } from '@agent-os/contracts';
import { z } from 'zod';

import { messagePayload } from '../../step/continuation.js';
import type { InCommitAgentTool } from '../tool.js';
import { gateTarget } from '../tool-gate.js';
import { type BuiltinTasks, descendantsOf } from './list-agents.js';

const MessageAgentArgsSchema = z.object({
  agentId: z.string().min(1).describe('Id of an agent you started, or of one it started'),
  message: z.string().min(1).describe('The text of the message'),
});
type MessageAgentArgs = z.infer<typeof MessageAgentArgsSchema>;

/**
 * `message_agent` in the commit transaction (design-agents.md, «Инструменты»): the target is only a
 * descendant of the caller (`unknown_agent` otherwise); the message goes with `revive`, so a finished
 * descendant continues. A message to a stopped agent carries the `resume` mark (plan Notes 5).
 */
export function createMessageAgentTool(deps: {
  readonly tasks: BuiltinTasks;
}): InCommitAgentTool<MessageAgentArgs> {
  return {
    name: 'message_agent',
    title: 'Написать агенту',
    argLabels: { agentId: 'Агент', message: 'Сообщение' },
    description:
      'Send a message to an agent you started (or one it started). A finished agent continues its work with the message.',
    argsSchema: MessageAgentArgsSchema,
    mode: 'in_commit',
    async execute({ args, caller, effects }) {
      const tree = await deps.tasks.listTree(caller.rootId, caller.ownerId);
      const target = descendantsOf(tree, caller.agentId).find((task) => task.taskId === args.agentId);
      const gate = gateTarget({ isDescendant: target !== undefined });
      if (gate.kind === 'refused' || target === undefined) {
        return { kind: 'refused', reason: 'unknown_agent' };
      }
      const targetParent = tree.find((task) => task.taskId === target.parentId) ?? null;
      await effects.enqueue({
        recipientId: target.taskId,
        kind: AgentMessageKindSchema.enum.agent_message,
        sender: caller.agentId,
        payload: { ...messagePayload(args.message, target, targetParent), fromAgentId: caller.agentId },
        revive: true,
      });
      return { kind: 'done', outcome: 'success', text: `Message delivered to agent ${target.taskId}.` };
    },
  };
}
