import type { ModelProviderKind, ModelProviderState } from '@agent-os/contracts';

import { PROVIDER_KINDS } from './provider-kinds.js';

/** A provider's readiness: its state, or `missing` when no provider of that name is registered. */
export type ProviderReadiness = ModelProviderState | 'missing';

/** What readiness reads of a provider row or connection. */
export interface ProviderReadinessInput {
  readonly kind: ModelProviderKind;
  readonly enabled: boolean;
  readonly apiKey: string | null;
}

/**
 * design-core.md, Terms «Готовность провайдера»: the first condition that holds, in the order `missing`,
 * `disabled`, `key_missing`, `ready` — so a disabled provider without a key is `disabled`.
 */
export function providerReadiness(provider: ProviderReadinessInput | null): ProviderReadiness {
  return provider === null ? 'missing' : providerState(provider);
}

/** The state of a registered provider: `providerReadiness` past `missing`. */
export function providerState(provider: ProviderReadinessInput): ModelProviderState {
  if (!provider.enabled) return 'disabled';
  if (PROVIDER_KINDS[provider.kind].keyRequired && provider.apiKey === null) return 'key_missing';
  return 'ready';
}
