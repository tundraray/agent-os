import type { ConversationState } from '@agent-os/contracts';

/** The states of conversations in the order they need the employee (AC-10.2). */
const ORDER: readonly ConversationState[] = [
  'waiting_for_you',
  'failed',
  'new_answer',
  'working',
];

/**
 * The state of a task's row in the list (task-tracker design-server.md, KD-6): of the states of its live
 * conversations, the one that needs the employee first; `null` — every one is read and idle, or none is live.
 */
export function taskState(
  states: readonly (ConversationState | null)[],
): ConversationState | null {
  return ORDER.find((state) => states.includes(state)) ?? null;
}
