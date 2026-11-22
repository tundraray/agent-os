import type { Task } from '@agent-os/runtime';

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
