import { TRAINER_TASK_TYPE } from '@agent-os/contracts';
import type { LiveTaskIdentity, TaskControl } from '@agent-os/runtime';

import { agentOwner } from '../agent/agent-owner';

/**
 * Whether the task is in a training tree — its root is a `trainer` task (self-learning design-training.md KD-3):
 * a root by its own type, any other task by one read of its root's type. The root never changes, so the answer
 * is the same on creation and after a restart.
 */
export async function inTrainingTree(
  tasks: Pick<TaskControl, 'get'>,
  task: Pick<LiveTaskIdentity, 'taskId' | 'rootId' | 'ownerId' | 'type'>,
): Promise<boolean> {
  const rootType =
    task.taskId === task.rootId
      ? task.type
      : (await tasks.get(task.rootId, agentOwner(task))).type;
  return rootType === TRAINER_TASK_TYPE;
}
