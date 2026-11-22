import type { ModelVerdict } from '@agent-os/agents';
import type { CatalogModel } from '@agent-os/contracts';
import type { ModelPrice } from '@agent-os/runtime';
import type { EffectiveAccess } from './effective-access';

export interface ModelVerdictInput {
  /** The employee is enabled. */
  readonly active: boolean;
  /** The model's catalogue row; `undefined` for a model outside the catalogue. An embedding model is not called this way. */
  readonly catalogued: CatalogModel | undefined;
  /** `effectiveAccess` of the employee's grants. */
  readonly access: EffectiveAccess;
  /** The employee's spend on the model this month (`monthOf`). */
  readonly spentUsd: number;
  /** UTC month `YYYY-MM` of `spentUsd`. */
  readonly month: string;
}

/** Catalogue prices as the token ledger takes them: `above` is the long-context tier. */
function priceOf(
  model: Extract<CatalogModel, { purpose: 'chat' }>,
): ModelPrice {
  const { longContext } = model;
  if (longContext === null) return { ...model.prices };
  return {
    ...model.prices,
    above: {
      ...longContext.prices,
      inputTokens: longContext.aboveInputTokens,
    },
  };
}

/**
 * Whether the employee may call the model ("Как AccessGate решает о вызове модели"): enabled,
 * a chat model in the catalogue, allowed and not denied, spend below the quota — in this order. An
 * allowed call carries the catalogue price (KD-3). An embedding model is not connected for a call: it
 * goes through `AccessGate.embedding` (model-providers design-core.md).
 */
export function modelVerdict(input: ModelVerdictInput): ModelVerdict {
  if (!input.active) return { kind: 'refused', reason: 'owner_disabled' };
  if (input.catalogued === undefined || input.catalogued.purpose !== 'chat')
    return { kind: 'refused', reason: 'model_not_connected' };
  const access = input.access.model(input.catalogued.id);
  if (!access.allowed) {
    const reason =
      input.access.allowedModels().length === 0
        ? 'no_models_allowed'
        : 'model_not_allowed';
    return { kind: 'refused', reason };
  }
  if (
    access.quotaUsd !== null &&
    quotaExhausted(input.spentUsd, access.quotaUsd)
  ) {
    return {
      kind: 'refused',
      reason: 'quota_exhausted',
      spentUsd: input.spentUsd,
      quotaUsd: access.quotaUsd,
      month: input.month,
    };
  }
  return { kind: 'allowed', price: priceOf(input.catalogued) };
}

/** DC-8: the quota is used up when the month's spend is not below it; the check and "My access" share it (DC-9). */
export function quotaExhausted(spentUsd: number, quotaUsd: number): boolean {
  return spentUsd >= quotaUsd;
}
