import { isSecretFieldName } from '@agent-os/common';
import { auditEvents, type Database } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';

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
 * Writes `app.audit_events` right after a change (design-identity.md KD-7,
 * repository-over-transaction.md): inside the caller's transaction when given, otherwise with its own
 * insert. A plain class over the database client, so code outside Nest builds it too.
 */
export class AuditLog {
  constructor(private readonly db: Database) {}

  async record(tx: RuntimeTx | null, entry: AuditEntry): Promise<void> {
    await (tx ?? this.db).insert(auditEvents).values({
      ...entry,
      before: mask(entry.before ?? null),
      after: mask(entry.after ?? null),
    });
  }
}
