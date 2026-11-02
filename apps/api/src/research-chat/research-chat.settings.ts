/** Settings of the chat-entry part (design-chat-entry.md, Runtime settings) the assembly point reads from its environment. */
export interface ResearchChatSettings {
  /** `RESEARCH_APPEND_GIVE_UP_MS`: how long after the first failed answer write the loop keeps trying (KD-4, DC-4). */
  readonly appendGiveUpMs: number;
  /** `RESEARCH_LAUNCH_RECOVERY_MS`: after how long the delivery loop finishes a row left in `launching` (KD-3). */
  readonly launchRecoveryMs: number;
}

const APPEND_GIVE_UP_VARIABLE = 'RESEARCH_APPEND_GIVE_UP_MS';
const LAUNCH_RECOVERY_VARIABLE = 'RESEARCH_LAUNCH_RECOVERY_MS';

/**
 * Parses the settings from `read` (the assembly point's environment). An empty or unset variable takes its default;
 * a value that is not a positive whole number of milliseconds throws naming the variable, so the start stops.
 */
export function parseResearchChatSettings(
  read: (name: string) => string | undefined,
): ResearchChatSettings {
  return {
    appendGiveUpMs: milliseconds(APPEND_GIVE_UP_VARIABLE, read, 300_000),
    launchRecoveryMs: milliseconds(LAUNCH_RECOVERY_VARIABLE, read, 60_000),
  };
}

function milliseconds(
  variable: string,
  read: (name: string) => string | undefined,
  fallback: number,
): number {
  const value = read(variable);
  if (value === undefined || value === '') return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${variable} must be a positive whole number of milliseconds, got "${value}"`,
    );
  }
  return parsed;
}
