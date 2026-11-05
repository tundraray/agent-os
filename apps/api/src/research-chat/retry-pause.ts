/** The pause stops doubling at 2^4 = 16 × `RUNTIME_POLL_MS`, like the runtime's worker loops (KD-4). */
const MAX_DOUBLINGS = 4;

/**
 * Pause before the next attempt to write an answer after `failures` consecutive failed writes (at least one): starts
 * at the runtime poll period and doubles up to 16 times it (design-chat-entry.md, KD-4). The give-up window
 * `RESEARCH_APPEND_GIVE_UP_MS`, not this pause, decides when the launch fails.
 */
export function retryPauseMs(pollMs: number, failures: number): number {
  return pollMs * 2 ** Math.min(Math.max(failures - 1, 0), MAX_DOUBLINGS);
}
