/**
 * The check before every model and tool call of an agent (design-identity.md KD-4, Contract «Проверка
 * перед вызовом агента»): resolves for an active employee; for a disabled or unknown owner rejects with
 * {@link OwnerDisabledError}, and the call does not start. The upper part supplies it to `createAgents`.
 */
export interface OwnerGate {
  check(ownerId: string): Promise<void>;
}

/** The code of the gate's rejection. */
export const OWNER_DISABLED = 'OWNER_DISABLED';

/** The gate's rejection: the owner is disabled or unknown. */
export class OwnerDisabledError extends Error {
  override readonly name = 'OwnerDisabledError';
  readonly code = OWNER_DISABLED;

  constructor(readonly ownerId: string) {
    super(`Owner ${ownerId} is disabled or unknown`);
  }
}

export function isOwnerDisabled(error: unknown): error is OwnerDisabledError {
  return error instanceof OwnerDisabledError;
}
