import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import { UserStatusSchema } from '@agent-os/contracts';
import type { Database, DatabaseConnection } from '@agent-os/db';
import { AuditLog } from '../audit/audit-log.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens.js';
import { identityError } from './identity.errors.js';
import { PasswordSignIn } from './password-sign-in.js';
import { SessionStore, type OpenedSession } from './session.store.js';
import { markSignedIn, type UserRow } from './users.repository.js';
import { SYSTEM_ACTOR } from './users.service.js';

/** How the employee signed in; written to the audit and the log. */
type SignInMethod = 'password';

/** A refused sign-in: its real reason goes to the audit and the log, never to the client. */
interface Rejection {
  method: SignInMethod;
  reason: string;
  user: UserRow | undefined;
  startedAt: number;
}

/**
 * Where every way of signing in meets (C3 api): refuses a disabled employee, opens the session,
 * records the sign-in time, and writes the attempt to the audit with its real reason (FR-11).
 */
@Injectable()
export class SignInService {
  private readonly db: Database;

  constructor(
    @Inject(RUNTIME_DATABASE) database: DatabaseConnection,
    private readonly passwordSignIn: PasswordSignIn,
    private readonly sessions: SessionStore,
    private readonly auditLog: AuditLog,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {
    this.db = database.db;
  }

  /**
   * Flow 2: 401 INVALID_CREDENTIALS for an unknown login and a wrong password alike (AC-01.3);
   * 401 ACCOUNT_DISABLED only after the right password of a disabled employee (Invariant 2).
   */
  async signInWithPassword(login: string, password: string): Promise<OpenedSession> {
    const method: SignInMethod = 'password';
    const startedAt = Date.now();
    const check = await this.passwordSignIn.check(login, password);
    if (!check.ok) {
      await this.reject({ method, reason: check.reason, user: check.user, startedAt });
      throw identityError('INVALID_CREDENTIALS');
    }
    return this.openFor(check.user, method, startedAt);
  }

  private async openFor(user: UserRow, method: SignInMethod, startedAt: number): Promise<OpenedSession> {
    if (user.status === UserStatusSchema.enum.disabled) {
      await this.reject({ method, reason: 'account_disabled', user, startedAt });
      throw identityError('ACCOUNT_DISABLED');
    }
    const opened = await this.db.transaction(async (tx) => {
      const session = await this.sessions.open(user.id, tx);
      await markSignedIn(tx, user.id);
      await this.auditLog.record(tx, {
        kind: 'sign_in',
        actor: user.id,
        objectType: 'user',
        objectId: user.id,
        after: { method },
        outcome: 'ok',
      });
      return session;
    });
    this.logger.info('sign-in accepted', {
      method,
      userId: user.id,
      sessionId: opened.sessionId,
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
    return opened;
  }

  private async reject({ method, reason, user, startedAt }: Rejection): Promise<void> {
    await this.auditLog.record(null, {
      kind: 'sign_in_rejected',
      actor: user?.id ?? SYSTEM_ACTOR,
      objectType: user === undefined ? undefined : 'user',
      objectId: user?.id,
      after: { method },
      outcome: 'rejected',
      reason,
    });
    this.logger.info('sign-in rejected', {
      method,
      userId: user?.id ?? null,
      outcome: 'rejected',
      reason,
      durationMs: Date.now() - startedAt,
    });
  }
}
