import type {
  TrackerTaskStatus,
  TrackerTaskSummary,
} from '@agent-os/contracts';

/** UXRD KD-2: the open statuses, what waits for the employee first. */
const OPEN_GROUPS: readonly TrackerTaskStatus[] = [
  'needs_decision',
  'in_review',
  'in_progress',
  'todo',
];

export type TaskGroup = {
  status: TrackerTaskStatus;
  tasks: TrackerTaskSummary[];
};

/**
 * The open tasks by group (task-tracker KD-3): the groups in the order of UXRD KD-2, no empty group, and inside a
 * group the server's order — recently changed first.
 */
export function groupOpenTasks(
  tasks: readonly TrackerTaskSummary[],
): TaskGroup[] {
  return OPEN_GROUPS.map((status) => ({
    status,
    tasks: tasks.filter((task) => task.status === status),
  })).filter((group) => group.tasks.length > 0);
}
