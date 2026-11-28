import type { ModelPrice } from '@agent-os/runtime';

/** A tool the gate is asked about: its server, its name and its effective class (access-levels KD-4). */
export interface GateTool {
  readonly server: string;
  readonly tool: string;
  readonly readOnly: boolean;
}

/**
 * The employee's tool rights; the check needs no database once the grants are read. It is asked only of a tool
 * the admin left on: a switched-off one is refused before it.
 */
export type ToolAccess =
  | { readonly kind: 'owner_disabled' }
  | {
      readonly kind: 'allowed';
      readonly allows: (tool: GateTool) => boolean;
    };

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
 * Whether a call of the default embedding model may run (design-core.md, `AccessGate.embedding`): no right and
 * no quota is read. An allowed call carries the model, its input price and the dimensions of its vectors.
 */
export type EmbeddingVerdict =
  | {
      readonly kind: 'allowed';
      readonly model: string;
      readonly inputUsdPerMTok: number;
      readonly dimensions: number;
    }
  | {
      readonly kind: 'refused';
      readonly reason: 'owner_disabled' | 'model_not_configured';
    };

/**
 * Rights, quotas, the model catalogue and the default models as the agents see them (design-access.md,
 * «Пакеты»; ADR-0015; design-core.md KD-5, KD-6). The upper part provides it as `ACCESS_GATE`; the package
 * reads no environment.
 */
export interface AccessGate {
  tools(ownerId: string): Promise<ToolAccess>;
  model(ownerId: string, model: string): Promise<ModelVerdict>;
  /** The id of the default chat model, or `null` while none is chosen. */
  defaultChatModel(): Promise<string | null>;
  /** `ownerId` `null` — the platform's own call, written to the ledger with no owner. */
  embedding(ownerId: string | null): Promise<EmbeddingVerdict>;
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

/**
 * A refused MCP call whose arguments the model got wrong — invalid for the tool's schema or a repeat of the
 * same call (agent-harness design-core.md KD-6): a model's mistake, kept apart from `access_denied`.
 */
export interface ToolCallRefusedEntry {
  readonly kind: 'tool_call_refused';
  readonly actor: string;
  readonly objectType: 'tool';
  /** `<server>/<tool>`. */
  readonly objectId: string;
  readonly outcome: 'rejected';
  readonly reason: 'invalid_arguments' | 'repeated_call';
}

/** A record the agents write to the audit. */
export type AuditRecord = AccessDeniedEntry | ToolCallRefusedEntry;

/** Writes an audit record of a refused call; supplied by the upper part together with the gate. */
export type AccessAudit = (entry: AuditRecord) => Promise<void>;

/** A model or tool call stopped because the owner is disabled or unknown; the call does not start. */
export class OwnerDisabledError extends Error {
  override readonly name = 'OwnerDisabledError';
  readonly code = 'OWNER_DISABLED';

  constructor(readonly ownerId: string) {
    super(`Owner ${ownerId} is disabled or unknown`);
  }
}

/** `completeText` has no model to call: no default chat model is chosen (DC-3); the call does not start. */
export class ModelNotConfiguredError extends Error {
  override readonly name = 'ModelNotConfiguredError';
  readonly reason = 'model_not_configured';

  constructor() {
    super('No default chat model is chosen');
  }
}

/** A model call outside any task refused by the gate for a reason other than a disabled owner; the call does not start. */
export class ModelRefusedError extends Error {
  override readonly name = 'ModelRefusedError';

  constructor(
    readonly reason: ModelRefusalReason,
    message: string,
  ) {
    super(message);
  }
}
