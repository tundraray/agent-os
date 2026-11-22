import { isSecretFieldName } from '@agent-os/common';
import { AuditEventsRepository } from '@agent-os/db';
import { Injectable } from '@nestjs/common';

/** A JSON object of `before`/`after`; secret and password fields in it are masked before the write. */
type AuditState = Record<string, unknown> | null;

export interface AuditEntry {
  /** Identity kinds: sign_in, sign_in_rejected, sign_out, password_changed, password_reset, admin_change, access_denied; other parts add their own. */
  kind: string;
  /** Employee id, or `system` for a change no employee made. */
  actor: string;
  objectType?: string;
  objectId?: string;
  before?: AuditState;
  after?: AuditState;
  outcome: string;
  reason?: string;
}

/** Audit actor of a change no employee made (operator command, rejected sign-in of an unknown login). */
export const SYSTEM_ACTOR = 'system';

/**
 * Stands in for the password in `before`/`after` of an audit entry: the field name makes `AuditLog`
 * write `password_changed`, and the value never is the password.
 */
export const PASSWORD_SET = 'set';

const PASSWORD_CHANGED = 'password_changed';
const SECRET_CHANGED = 'secret_changed';

/** Replaces the value of every field with a secret name, at any depth, with a mark of the change. */
function mask(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mask);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (!isSecretFieldName(key)) return [key, mask(item)];
      return [key, key.toLowerCase().includes('password') ? PASSWORD_CHANGED : SECRET_CHANGED];
    }),
  );
}

/**
 * Writes `app.audit_events` right after a change (design-identity.md KD-7): masks secrets, then
 * inserts; inside a caller's transaction the insert joins it. Code outside Nest builds it with `new`.
 */
@Injectable()
export class AuditLog {
  constructor(private readonly events: AuditEventsRepository) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.events.insert({
      ...entry,
      before: mask(entry.before ?? null),
      after: mask(entry.after ?? null),
    });
  }
}
