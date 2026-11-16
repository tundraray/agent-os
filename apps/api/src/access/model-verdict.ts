import type { EffectiveAccess } from './effective-access.js';

export interface ModelVerdictInput {
  /** The employee is enabled. */
  readonly active: boolean;
  /** The model has a catalogue row. */
  readonly catalogued: boolean;
  readonly model: string;
  /** `effectiveAccess` of the employee's grants. */
  readonly access: EffectiveAccess;
  /** The employee's spend on the model this month (`monthOf`). */
  readonly spentUsd: number;
  /** UTC month `YYYY-MM` of `spentUsd`. */
  readonly month: string;
}

export type ModelVerdict =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'owner_disabled'
        | 'model_not_connected'
        | 'no_models_allowed'
        | 'model_not_allowed';
    }
  | {
      readonly kind: 'refused';
      readonly reason: 'quota_exhausted';
      readonly spentUsd: number;
      readonly quotaUsd: number;
      readonly month: string;
    };

/**
 * Whether the employee may call the model ("Как AccessGate решает о вызове модели"): enabled,
 * in the catalogue, allowed and not denied, spend below the quota — in this order. The price is
 * added by the caller (`AccessService`).
 */
export function modelVerdict(input: ModelVerdictInput): ModelVerdict {
  if (!input.active) return { kind: 'refused', reason: 'owner_disabled' };
  if (!input.catalogued)
    return { kind: 'refused', reason: 'model_not_connected' };
  const access = input.access.model(input.model);
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
  return { kind: 'allowed' };
}

/** DC-8: the quota is used up when the month's spend is not below it; the check and "My access" share it (DC-9). */
export function quotaExhausted(spentUsd: number, quotaUsd: number): boolean {
  return spentUsd >= quotaUsd;
}
