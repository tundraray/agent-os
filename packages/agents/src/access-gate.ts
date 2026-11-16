import type { ModelPrice } from '@agent-os/runtime';

/** The employee's tool rights; the pair check needs no database once the grants are read. */
export type ToolAccess =
  | { readonly kind: 'owner_disabled' }
  | { readonly kind: 'allowed'; readonly allows: (server: string, tool: string) => boolean };

/** Why a model call is refused (design-access.md, «Как AccessGate решает о вызове модели»). */
export type ModelRefusalReason =
  | 'owner_disabled'
  | 'quota_exhausted'
  | 'model_not_connected'
  | 'model_not_allowed'
  | 'no_models_allowed';

/** Whether the employee may call the model now: an allowed call carries the catalogue price. */
export type ModelVerdict =
  | { readonly kind: 'allowed'; readonly price: ModelPrice }
  | {
      readonly kind: 'refused';
      readonly reason: ModelRefusalReason;
      /** Set for `quota_exhausted`: the month's spend, the quota and the UTC month `YYYY-MM`. */
      readonly spentUsd?: number;
      readonly quotaUsd?: number;
      readonly month?: string;
    };

/**
 * Rights, quotas and the model catalogue as the agents see them (design-access.md, «Пакеты»; ADR-0015).
 * The upper part supplies it to `createAgents`; the package reads no environment.
 */
export interface AccessGate {
  tools(ownerId: string): Promise<ToolAccess>;
  model(ownerId: string, model: string): Promise<ModelVerdict>;
}

/** A refused tool or model call in the shape of the API audit log's `access_denied` record. */
export interface AccessDeniedEntry {
  readonly kind: 'access_denied';
  readonly actor: string;
  readonly objectType: 'tool' | 'model';
  /** `<server>/<tool>` for a tool, the model id for a model. */
  readonly objectId: string;
  readonly outcome: 'rejected';
  readonly reason: string;
}

/** Writes an `access_denied` record; supplied by the upper part together with the gate. */
export type AccessAudit = (entry: AccessDeniedEntry) => Promise<void>;

/** A model or tool call stopped because the owner is disabled or unknown; the call does not start. */
export class OwnerDisabledError extends Error {
  override readonly name = 'OwnerDisabledError';
  readonly code = 'OWNER_DISABLED';

  constructor(readonly ownerId: string) {
    super(`Owner ${ownerId} is disabled or unknown`);
  }
}
