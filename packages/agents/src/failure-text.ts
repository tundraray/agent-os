import { createSecretMasker } from '@agent-os/common';

/** The longest failure text the model reads (data-model/design-runtime.md, KD-6); the log keeps it whole. */
const FAILURE_TEXT_MAX_CHARS = 1_000;

/** Redacts every secret the process remembers (provider keys, employee MCP tokens) at the time of the call. */
const maskSecrets = createSecretMasker([]);

/**
 * A failure's text as the model reads it — a subagent's failure, a tool that threw: masked, then cut to
 * {@link FAILURE_TEXT_MAX_CHARS} (masking first, so a cut never leaves part of a secret unmasked).
 */
export function failureTextOf(message: string): string {
  return maskSecrets(message).slice(0, FAILURE_TEXT_MAX_CHARS);
}
