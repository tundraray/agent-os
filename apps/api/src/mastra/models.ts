/**
 * Models are addressed as "<provider>/<model>" strings and resolved by Mastra's model router,
 * which supports Anthropic, OpenAI and many other providers. Each provider reads its key from
 * the standard env var (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, ...).
 */
export type ModelId = `${string}/${string}`;

export const DEFAULT_MODEL: ModelId = 'anthropic/claude-opus-5-5';

/**
 * Model of the research mode and decision turns, whatever the chat model is (design-chat-entry.md, KD-9): it accepts a
 * forced tool call with thinking off, while `DEFAULT_MODEL` silently turns both back into `auto` and thinking. A
 * constant, not a setting: the forced call does not hold on every model.
 */
export const RESEARCH_TURN_MODEL: ModelId = 'anthropic/claude-haiku-5-5';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORT_ORDER: readonly ReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export function parseModelId(value: string | undefined): ModelId {
  if (!value) return DEFAULT_MODEL;
  if (!/^[\w.-]+\/.+$/.test(value)) {
    throw new Error(
      `Invalid model id "${value}": expected "<provider>/<model>", e.g. ${DEFAULT_MODEL}`,
    );
  }
  return value as ModelId;
}

/**
 * Provider-specific options. Keys are provider ids, so options for providers other than the
 * one in use are ignored.
 */
export function providerOptionsFor(effort: ReasoningEffort) {
  return {
    // Adaptive thinking with a readable summary streamed to the UI; effort set explicitly
    // because Claude Opus 5.5 defaults to "medium".
    // Automatic prompt caching: request-level cache_control caches the longest cacheable
    // prefix (system + conversation so far), so each new turn re-reads history from cache.
    // Prefixes below the model's minimum cacheable length are silently not cached.
    anthropic: {
      thinking: { type: 'adaptive', display: 'summarized' } as const,
      effort,
      cacheControl: { type: 'ephemeral' } as const,
    },
    // OpenAI reasoning models top out at "high".
    openai: {
      reasoningEffort: effort === 'xhigh' || effort === 'max' ? 'high' : effort,
    },
  };
}

/** `RESEARCH_TURN_MODEL` turns thinking off only at an effort up to `high` (KD-9, Runtime settings). */
const RESEARCH_TURN_MAX_EFFORT: ReasoningEffort = 'high';

/**
 * The agent's provider options for a research mode or decision turn: the whole object of `providerOptionsFor`
 * (prompt caching and the rest kept), with Anthropic thinking off — Anthropic refuses a forced tool together with
 * thinking — and the effort capped at `high` (KD-1, KD-9).
 */
export function researchTurnProviderOptions(effort: ReasoningEffort) {
  const capped =
    EFFORT_ORDER.indexOf(effort) >
    EFFORT_ORDER.indexOf(RESEARCH_TURN_MAX_EFFORT)
      ? RESEARCH_TURN_MAX_EFFORT
      : effort;
  const options = providerOptionsFor(capped);
  return {
    ...options,
    anthropic: {
      ...options.anthropic,
      thinking: { type: 'disabled' } as const,
    },
  };
}
