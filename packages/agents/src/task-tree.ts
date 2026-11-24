import { QUESTION_TASK_TYPE, type Task } from '@agent-os/runtime';

/** A question to a human (data-model/design-runtime.md, KD-3): a task of the tree that is not an agent. */
export function isQuestion(task: Pick<Task, 'type'>): boolean {
  return task.type === QUESTION_TASK_TYPE;
}

/**
 * The agent tasks of a tree: every reader of a tree that shows or counts agents skips the questions
 * (data-model/design-runtime.md, «Пропуск вопросов»).
 */
export function agentTasksOf(tree: readonly Task[]): Task[] {
  return tree.filter((task) => !isQuestion(task));
}

/** A question of `agentId` waits for the employee (data-model/design-runtime.md, «Статус агента»). */
export function hasOpenQuestion(
  tree: readonly Task[],
  agentId: string,
): boolean {
  return tree.some(
    (task) =>
      task.parentId === agentId &&
      isQuestion(task) &&
      task.status === 'waiting',
  );
}

/**
 * The agent descendants of `agentId` in a tree listed in creation order: a parent is always created
 * before its child, so one pass collects the whole subtree. A question is a leaf, so skipping it
 * loses no agent.
 */
export function descendantsOf(tree: readonly Task[], agentId: string): Task[] {
  const subtree = new Set([agentId]);
  const descendants: Task[] = [];
  for (const task of agentTasksOf(tree)) {
    if (task.parentId !== null && subtree.has(task.parentId)) {
      subtree.add(task.taskId);
      descendants.push(task);
    }
  }
  return descendants;
}
