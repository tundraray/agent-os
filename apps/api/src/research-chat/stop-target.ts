import type { LaunchState } from './launch-state.js';

/** States in which a research runs and a stop cancels it: the button, the agent and the legacy turn alike (KD-4). */
export const STOPPABLE_STATES: ReadonlySet<LaunchState> = new Set([
  'running',
  'answer_pending',
]);

/** A launch of the caller's thread as the target choice reads it. */
interface StopCandidate {
  readonly launchKey: string;
  readonly state: LaunchState;
}

/** The launch the agent's stop goes to, or why there is none. */
export type StopTarget<T> =
  | { readonly kind: 'stop'; readonly launch: T }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'nothing_to_stop' }
  | { readonly kind: 'ambiguous'; readonly running: readonly T[] };

/**
 * Which research the agent's `stopResearch` stops (design-lifecycle.md, «Какой ресерч останавливает агент», DC-10).
 * `launches` are the launches of the caller's thread. A named `launchKey` is that launch in any state — the stop then
 * returns a launch that is not running as it is — or `not_found` when the thread has no such launch. Without a key
 * the code, not the model, decides: the one launch that runs, `nothing_to_stop` when none runs, and `ambiguous` with
 * the running ones when several run.
 */
export function stopTarget<T extends StopCandidate>(
  launches: readonly T[],
  launchKey: string | undefined,
): StopTarget<T> {
  if (launchKey !== undefined) {
    const named = launches.find((launch) => launch.launchKey === launchKey);
    return named === undefined || named.state === 'discarded'
      ? { kind: 'not_found' }
      : { kind: 'stop', launch: named };
  }
  const running = launches.filter((launch) =>
    STOPPABLE_STATES.has(launch.state),
  );
  const [only, ...more] = running;
  if (only === undefined) return { kind: 'nothing_to_stop' };
  return more.length === 0
    ? { kind: 'stop', launch: only }
    : { kind: 'ambiguous', running };
}
