/** Session limits of `identity_settings` (KD-2); the session row stores none of them. */
export interface SessionLimits {
  idleMinutes: number;
  absoluteMinutes: number;
}

/** The two moments a session's lifetime is counted from. */
export interface SessionTimes {
  createdAt: Date;
  lastSeenAt: Date;
}

const MINUTE_MS = 60_000;
/** The last request time is written at most once per this interval (design-identity.md, C3 api). */
const TOUCH_INTERVAL_MS = 5 * MINUTE_MS;

/**
 * DC-2: a session ends after `idleMinutes` without requests or `absoluteMinutes` after sign-in,
 * whichever comes first. Counted on every request, so new limits reach open sessions at once.
 */
export function isSessionExpired(
  times: SessionTimes,
  limits: SessionLimits,
  now: Date,
): boolean {
  const sinceSignIn = now.getTime() - times.createdAt.getTime();
  const sinceLastRequest = now.getTime() - times.lastSeenAt.getTime();
  return (
    sinceSignIn > limits.absoluteMinutes * MINUTE_MS ||
    sinceLastRequest > limits.idleMinutes * MINUTE_MS
  );
}

/** Whether the last request time is old enough to be written again. */
export function needsTouch(lastSeenAt: Date, now: Date): boolean {
  return now.getTime() - lastSeenAt.getTime() >= TOUCH_INTERVAL_MS;
}
