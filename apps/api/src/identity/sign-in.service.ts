import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import { UserStatusSchema, type SignInError } from '@agent-os/contracts';
import type { Database, DatabaseConnection } from '@agent-os/db';
import { AuditLog, SYSTEM_ACTOR } from '../audit/audit-log';
import { APP_LOGGER } from '../logging/app-logger';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens';
import { normalizeIdentifier } from './identity-input';
import { identityError } from './identity.errors';
import { OidcSignIn, type ReturnFromProvider } from './oidc-sign-in';
import { PasswordSignIn } from './password-sign-in';
import { openSession, type OpenedSession } from './session.store';
import {
  markSignedIn,
  upsertProviderUser,
  type UserRow,
} from './users.repository';

/** How the employee signed in; written to the audit and the log. */
type SignInMethod = 'password' | 'provider';

/** One sign-in attempt: what the audit and the log say about it besides the outcome. */
interface Attempt {
  method: SignInMethod;
  startedAt: number;
  /** Set for a provider sign-in. */
  providerId?: string;
  loginRequestId?: string;
}

/** A refused sign-in: its real reason goes to the audit and the log, never to the client. */
interface Rejection {
  attempt: Attempt;
  reason: string;
  user: UserRow | undefined;
  /** The cause behind a provider reason, for the log only. */
  detail?: string;
}

export type ProviderStart =
  | { ok: true; authorizationUrl: URL; state: string }
  | { ok: false; reason: 'provider_unavailable' };

export type ProviderSignIn =
  | { ok: true; token: string; next: string }
  | { ok: false; reason: SignInError };

/**
 * Where every way of signing in meets (C3 api): refuses a disabled provider, a provider answer
 * without an email and a disabled employee, finds the employee by email or creates one without
 * roles, opens the session, records the sign-in time, and writes the attempt to the audit with its
 * real reason (FR-11).
 */
@Injectable()
export class SignInService {
  private readonly db: Database;

  constructor(
    @Inject(RUNTIME_DATABASE) database: DatabaseConnection,
    private readonly passwordSignIn: PasswordSignIn,
    private readonly oidcSignIn: OidcSignIn,
    private readonly auditLog: AuditLog,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {
    this.db = database.db;
  }

  /**
   * Flow 2: 401 INVALID_CREDENTIALS for an unknown login and a wrong password alike (AC-01.3);
   * 401 ACCOUNT_DISABLED only after the right password of a disabled employee (Invariant 2).
   */
  async signInWithPassword(
    login: string,
    password: string,
  ): Promise<OpenedSession> {
    const attempt: Attempt = { method: 'password', startedAt: Date.now() };
    const check = await this.passwordSignIn.check(login, password);
    if (!check.ok) {
      await this.reject({ attempt, reason: check.reason, user: check.user });
      throw identityError('INVALID_CREDENTIALS');
    }
    const opened = await this.openFor(check.user, attempt);
    if (opened === undefined) throw identityError('ACCOUNT_DISABLED');
    return opened;
  }

  /** Flow 1, start: a disabled or unknown provider is refused with `provider_unavailable` (AC-03.2). */
  async startWithProvider(
    providerId: string,
    next: string,
  ): Promise<ProviderStart> {
    const attempt: Attempt = {
      method: 'provider',
      startedAt: Date.now(),
      providerId,
    };
    const started = await this.oidcSignIn.start(providerId, next);
    if (!started.ok) {
      await this.reject({
        attempt,
        reason: started.reason,
        user: undefined,
        detail: started.detail,
      });
      return { ok: false, reason: started.reason };
    }
    this.logger.info('provider sign-in started', {
      method: attempt.method,
      providerId,
      loginRequestId: started.loginRequestId,
      outcome: 'ok',
      durationMs: Date.now() - attempt.startedAt,
    });
    return {
      ok: true,
      authorizationUrl: started.authorizationUrl,
      state: started.state,
    };
  }

  /**
   * Flow 1, return: the employee with the ID token's email ignoring case, or a new one without roles
   * (JIT, AC-04.1, AC-04.2, AC-06.1); every refusal carries its reason (Failure handling, AC-11.3).
   */
  async signInWithProvider(
    callback: ReturnFromProvider,
  ): Promise<ProviderSignIn> {
    const attempt: Attempt = {
      method: 'provider',
      startedAt: Date.now(),
      providerId: callback.providerId,
    };
    const finished = await this.oidcSignIn.finish(callback);
    attempt.loginRequestId = finished.loginRequestId;
    if (!finished.ok) {
      await this.reject({
        attempt,
        reason: finished.reason,
        user: undefined,
        detail: finished.detail,
      });
      return { ok: false, reason: finished.reason };
    }
    const email = normalizeIdentifier(finished.email ?? '');
    if (email === '') {
      await this.reject({ attempt, reason: 'no_email', user: undefined });
      return { ok: false, reason: 'no_email' };
    }
    const user = await upsertProviderUser(this.db, {
      email,
      name: finished.name,
    });
    const opened = await this.openFor(user, attempt);
    if (opened === undefined) return { ok: false, reason: 'account_disabled' };
    return { ok: true, token: opened.token, next: finished.next };
  }

  /** The session of an active employee; undefined, with the refusal written, for a disabled one. */
  private async openFor(
    user: UserRow,
    attempt: Attempt,
  ): Promise<OpenedSession | undefined> {
    if (user.status === UserStatusSchema.enum.disabled) {
      await this.reject({ attempt, reason: 'account_disabled', user });
      return undefined;
    }
    const opened = await this.db.transaction(async (tx) => {
      const session = await openSession(tx, user.id);
      await markSignedIn(tx, user.id);
      await this.auditLog.record(tx, {
        kind: 'sign_in',
        actor: user.id,
        objectType: 'user',
        objectId: user.id,
        after: auditMethod(attempt),
        outcome: 'ok',
      });
      return session;
    });
    this.logger.info('sign-in accepted', {
      ...logAttempt(attempt),
      userId: user.id,
      sessionId: opened.sessionId,
      outcome: 'ok',
    });
    return opened;
  }

  private async reject({
    attempt,
    reason,
    user,
    detail,
  }: Rejection): Promise<void> {
    await this.auditLog.record(null, {
      kind: 'sign_in_rejected',
      actor: user?.id ?? SYSTEM_ACTOR,
      objectType: user === undefined ? undefined : 'user',
      objectId: user?.id,
      after: auditMethod(attempt),
      outcome: 'rejected',
      reason,
    });
    this.logger.info('sign-in rejected', {
      ...logAttempt(attempt),
      userId: user?.id ?? null,
      outcome: 'rejected',
      reason,
      ...(detail === undefined ? {} : { detail }),
    });
  }
}

/** The way of signing in as the audit keeps it: the method and, for a provider, which one. */
function auditMethod({ method, providerId }: Attempt) {
  return providerId === undefined ? { method } : { method, providerId };
}

function logAttempt({
  method,
  providerId,
  loginRequestId,
  startedAt,
}: Attempt) {
  return {
    method,
    providerId: providerId ?? null,
    loginRequestId: loginRequestId ?? null,
    durationMs: Date.now() - startedAt,
  };
}
