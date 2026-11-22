import { AgentMessageKindSchema, TaskStatusSchema, WaitReasonSchema } from '@agent-os/contracts';
import { retryingTransaction } from '@agent-os/runtime';
import type { z } from 'zod';

import { AgentsError } from '../errors';
import { messagePayload } from '../resume';
import { sessions } from '../store/sessions.repository';
import type { AgentSessions } from './agent-sessions';
import {
  type AgentSessionsDeps,
  agentTask,
  asAgent,
  ConfirmationPayloadSchema,
  createLogged,
  parentOf,
} from './operation-support';

const { waiting, stopped } = TaskStatusSchema.enum;
const { user_message: userMessage, interrupt } = AgentMessageKindSchema.enum;

/**
 * The operations that change a live agent or its conversation: a message, an interrupt, a stop, the decision
 * of a confirmation, and the root session's place, title and deletion.
 */
export function createControlOperations(
  deps: AgentSessionsDeps,
): Pick<
  AgentSessions,
  | 'send'
  | 'interrupt'
  | 'stop'
  | 'resolveConfirmation'
  | 'touchRoot'
  | 'renameRoot'
  | 'titleRootIfEmpty'
  | 'deleteRoot'
> {
  const { database, runtime, registry, logger } = deps;
  const logged = createLogged(logger);

  /** The edited arguments parsed by the tool's schema; `INVALID_ARGUMENTS` unless the tool allows the edit. */
  function editedArgs(payload: z.infer<typeof ConfirmationPayloadSchema>, args: unknown): unknown {
    // An MCP tool never allows an edit; nor does any tool of this part.
    const tool = payload.server === null ? registry.toolOf(payload.tool) : undefined;
    if (tool?.confirmation?.editableArgs !== true) {
      throw new AgentsError('INVALID_ARGUMENTS', `Tool ${payload.tool} does not allow editing its arguments`);
    }
    const parsed = tool.argsSchema.safeParse(args);
    if (!parsed.success) {
      throw new AgentsError('INVALID_ARGUMENTS', `Arguments of ${payload.tool} rejected by its schema`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  return {
    send({ agentId, ownerId, text, record }) {
      return logged(
        'send',
        { agentId, ownerId, recordId: record?.id ?? null },
        async () => {
          const target = await agentTask(runtime, agentId, ownerId);
          // Notes 5: a message to a stopped agent carries the `resume` mark; the window between this
          // read and the write is a known low risk.
          const parent = target.status === stopped ? await parentOf(runtime, target, ownerId) : null;
          const { messageId } = await asAgent(
            runtime.inbox.enqueue({
              recipientId: agentId,
              ownerId,
              kind: userMessage,
              sender: ownerId,
              payload: {
                ...messagePayload(text, target, parent),
                ...(record === undefined ? {} : { record }),
              },
              revive: true,
            }),
          );
          return { messageId };
        },
        ({ messageId }) => ({ messageId }),
      );
    },

    interrupt({ agentId, ownerId }) {
      return logged(
        'interrupt',
        { agentId, ownerId },
        async () => {
          const task = await agentTask(runtime, agentId, ownerId);
          // A free agent (waiting for messages) has no work to cut off: `not_active`, nothing changes (Flow 4).
          if (task.status === waiting && task.waitReason === WaitReasonSchema.enum.messages) return 'not_active';
          // KD-3: the `interrupt` message makes the agent's next step close its calls and wait.
          return asAgent(
            runtime.tasks.interrupt(agentId, ownerId, {
              kind: interrupt,
              sender: ownerId,
              payload: {},
              revive: false,
            }),
          );
        },
        (outcome) => ({ outcome }),
      );
    },

    stop({ agentId, ownerId }) {
      return logged(
        'stop',
        { agentId, ownerId },
        async () => {
          await agentTask(runtime, agentId, ownerId);
          // Flow 7: `tasks.stop` and nothing else; `history` shows the stop records.
          return asAgent(runtime.tasks.stop(agentId, ownerId));
        },
        (stoppedIds) => ({ stoppedIds }),
      );
    },

    resolveConfirmation({ decisionId, ownerId, approve, args }) {
      return logged(
        'resolveConfirmation',
        { decisionId, ownerId, approve, withArgs: args !== undefined },
        async () => {
          // The edit is checked only against an open request of this owner. For any other one
          // `decisions.resolve` answers `already_resolved` (resolved or cancelled) or
          // `DECISION_NOT_FOUND` (missing or another owner's) and writes nothing.
          const decision =
            args === undefined ? undefined : await runtime.decisions.get(decisionId, ownerId);
          const edited =
            decision?.status === 'open'
              ? { args: editedArgs(ConfirmationPayloadSchema.parse(decision.payload), args) }
              : {};
          // The tool step reads `{ approve, args? }` and the call id from the request's payload.
          return runtime.decisions.resolve(decisionId, ownerId, { approve, ...edited });
        },
        (outcome) => ({ outcome }),
      );
    },

    touchRoot(rootId, ownerId) {
      return logged('touchRoot', { rootId, ownerId }, () => sessions.touchRoot(database, rootId, ownerId));
    },

    renameRoot(rootId, ownerId, title) {
      return logged(
        'renameRoot',
        { rootId, ownerId },
        () => sessions.renameRoot(database, rootId, ownerId, title),
        (renamed) => ({ found: renamed !== undefined }),
      );
    },

    titleRootIfEmpty(rootId, ownerId, title) {
      return logged(
        'titleRootIfEmpty',
        { rootId, ownerId },
        () => sessions.titleRootIfEmpty(database, rootId, ownerId, title),
        (written) => ({ written }),
      );
    },

    deleteRoot(rootId, ownerId) {
      return logged('deleteRoot', { rootId, ownerId }, () =>
        asAgent(
          // Retried as a whole on a deadlock: `deleteTree` does not retry in the caller's transaction.
          // The task rows are locked first (inside `deleteTree`), the session row after, as a step's commit does.
          retryingTransaction(database, logger, 'sessions.deleteRoot', async (tx) => {
            await runtime.tasks.deleteTree(rootId, ownerId, tx);
            await sessions.markDeleted(tx, rootId);
          }),
        ),
      );
    },
  };
}
