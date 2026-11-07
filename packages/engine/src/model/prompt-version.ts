import { createHash } from 'node:crypto';

const PROMPT_VERSION_LENGTH = 12;

/**
 * The prompt version of a model call (KD-2): the first 12 hexadecimal characters of SHA-256 of the role's prompt
 * template as it lies in the configuration, before the question is substituted. Any edit of the template gives a new
 * version even when the process `version` was not bumped; ProcessConfig carries no version field for it (ADR-0005).
 */
export function promptVersion(template: string): string {
  return createHash('sha256').update(template).digest('hex').slice(0, PROMPT_VERSION_LENGTH);
}
