import { createAnthropic } from '@ai-sdk/anthropic';
import type { EngineSettings } from './engine-settings.js';

const ANTHROPIC_PREFIX = 'anthropic/';

/** The Messages model `@ai-sdk/anthropic` builds; a `RoleModel` of the engine. */
type AnthropicModel = ReturnType<ReturnType<typeof createAnthropic>>;

/**
 * The `resolveModel` port (`ResolveModel` of `@agent-os/engine`) of `apps/api` (design-engine.md, KD-7): an Anthropic Messages client from
 * `@ai-sdk/anthropic` on the unversioned base plus `/v1`, and the model by its id without the `anthropic/` prefix.
 * Not a Mastra model config with `url` — that sends the call to the OpenAI-compatible `/chat/completions` (S1) — and
 * not a string id, which Mastra resolves against the chat agent's versioned base variable. Building a model touches no network;
 * an id of another provider throws, so `createEngine` refuses the configuration naming its role.
 */
export function createResolveModel(
  settings: EngineSettings,
): (modelId: string) => AnthropicModel {
  const anthropic = createAnthropic({
    baseURL: `${settings.anthropicBaseUrl.replace(/\/+$/, '')}/v1`,
    apiKey: settings.anthropicApiKey,
  });
  return (modelId: string) => {
    if (!modelId.startsWith(ANTHROPIC_PREFIX)) {
      throw new Error(
        `model ${modelId} is not an Anthropic model: the engine resolves only ${ANTHROPIC_PREFIX}… ids`,
      );
    }
    return anthropic(modelId.slice(ANTHROPIC_PREFIX.length));
  };
}
