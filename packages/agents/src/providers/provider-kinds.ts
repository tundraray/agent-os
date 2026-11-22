import type { ModelProviderKind } from '@agent-os/contracts';

/** What a provider kind is, apart from its wire format (that lives in its adapter). */
export interface ProviderKindFacts {
  /** The address requests go to when the provider sets none. */
  readonly defaultBaseUrl: string;
  /** Without a key the provider is `key_missing`; an OpenAI-compatible server may run without one. */
  readonly keyRequired: boolean;
  /** Whether the kind serves embedding models. */
  readonly embeddings: boolean;
}

/** The one place of the facts of each kind (design-core.md, ModelProviderView; KD-3). */
export const PROVIDER_KINDS: Readonly<
  Record<ModelProviderKind, ProviderKindFacts>
> = {
  anthropic: {
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    keyRequired: true,
    embeddings: false,
  },
  gemini: {
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyRequired: true,
    embeddings: true,
  },
  openai_compatible: {
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyRequired: false,
    embeddings: true,
  },
};
