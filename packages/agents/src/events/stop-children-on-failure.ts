import type { Logger } from '@agent-os/common';
import { RuntimeEventTypeSchema, TaskStatusSchema } from '@agent-os/contracts';
import type { EventConsumer, Runtime } from '@agent-os/runtime';

import { sessions } from '../store/sessions.repository.js';

/** `schemaVersion` of the runtime's events (`RUNTIME_EVENT_SCHEMA_VERSION` in `packages/runtime/src/event-log.ts`). */
const RUNTIME_EVENT_SCHEMA_VERSION = 1;

const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  TaskStatusSchema.enum.completed,
  TaskStatusSchema.enum.failed,
  TaskStatusSchema.enum.stopped,
]);

export interface StopChildrenOnFailureDeps {
  readonly tasks: Pick<Runtime['tasks'], 'listTree' | 'stop'>;
  readonly logger: Logger;
}

/**
 * The consumer of `task.failed` (design-agents.md, Flow 2 Failure handling): a failed agent whose
 * children still work stops each unfinished child — and with it the child's subtree — by the same
 * `tasks.stop` as Flow 7. The owner comes from the agent's session (plan Notes 4): the runtime event
 * does not carry it; a task without a session is not an agent and is skipped.
 */
export function createStopChildrenOnFailure(deps: StopChildrenOnFailureDeps): EventConsumer {
  const logger = deps.logger.child({ consumer: 'agents.stop-children-on-failure' });

  return {
    name: 'agents.stop-children-on-failure',
    eventTypes: [RuntimeEventTypeSchema.enum['task.failed']],
    schemaVersions: [RUNTIME_EVENT_SCHEMA_VERSION],
    async handle(tx, event) {
      if (event.taskId === null) return;
      const agentId = event.taskId;
      const session = await sessions.get(tx, agentId);
      if (session === undefined) return;

      const tree = await deps.tasks.listTree(event.rootId, session.ownerId);
      const children = tree.filter(
        (task) => task.parentId === agentId && !FINISHED_STATUSES.has(task.status),
      );
      const stopped: string[] = [];
      for (const child of children) {
        // `tasks.stop` runs its own transactions, not the delivery's, and is repeatable (a finished
        // child gives `[]`), so a repeated delivery is safe and no external system is called.
        stopped.push(...(await deps.tasks.stop(child.taskId, session.ownerId)));
      }
      logger.info('children of a failed agent stopped', {
        agentId,
        rootId: event.rootId,
        ownerId: session.ownerId,
        children: children.length,
        stoppedIds: stopped,
      });
    },
  };
}
