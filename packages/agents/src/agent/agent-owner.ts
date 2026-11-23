/**
 * The owner of an agent's task. Only the platform's own work runs without an owner (data-model design-schema.md
 * KD-4); an agent always runs for an employee, so a task without one is a broken invariant, not a case to handle.
 */
export function agentOwner(task: {
  readonly taskId: string;
  readonly ownerId: string | null;
}): string {
  if (task.ownerId === null) {
    throw new Error(`Agent task ${task.taskId} has no owner`);
  }
  return task.ownerId;
}
