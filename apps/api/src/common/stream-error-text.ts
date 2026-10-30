/**
 * The single source of the error texts a client sees, in the live chat stream
 * and in the thread history. Raw error messages never reach the client.
 */
export const AGENT_ERROR_TEXT = 'Agent error';

/** Client-facing text of a stream error: the provider status code when known, otherwise `Agent error`. */
export function toStreamErrorText(error: unknown): string {
  if (error instanceof Error && 'statusCode' in error) {
    return `Model provider error (${String(error.statusCode)})`;
  }
  return AGENT_ERROR_TEXT;
}
