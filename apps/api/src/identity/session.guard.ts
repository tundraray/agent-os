import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LOGGER, type Logger } from '@agent-os/common';
import { UserStatusSchema } from '@agent-os/contracts';
import type { Request } from 'express';
import { AuditLog } from '../audit/audit-log';
import { IS_ADMIN_ONLY } from './admin-only.decorator';
import type { AuthedRequest, AuthUser } from './auth-user';
import { identityError } from './identity.errors';
import { IS_PUBLIC } from './public.decorator';
import { frontendOrigin, readSessionToken } from './session-cookie';
import {
  ENDED_BY_BLOCK,
  type FoundSession,
  SessionStore,
} from './session.store';

/**
 * Methods that change state: they must come from the web's origin (DC-3), with or without the cookie —
 * a cross-site form posting to the open sign-in would otherwise sign the victim into another account.
 */
const CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The one global check of the API (KD-3, ADR-0012, Flow 3): every changing request needs the web's
 * `Origin`, open routes included; a route without `@Public()` needs a live session, whose employee goes
 * to `req.user`; a route with `@AdminOnly()` needs the admin right. Only the cookie names the employee.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  private readonly logger: Logger;
  private readonly allowedOrigin = frontendOrigin();

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionStore,
    private readonly auditLog: AuditLog,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'identity.session-guard' });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const route = routeOf(req);
    if (
      CHANGING_METHODS.has(req.method) &&
      req.headers.origin !== this.allowedOrigin
    ) {
      this.logger.debug('request refused', {
        route,
        reason: 'origin_rejected',
        origin: req.headers.origin ?? null,
      });
      throw identityError('ORIGIN_REJECTED');
    }
    if (this.marked(context, IS_PUBLIC)) return true;

    req.user = await this.userOf(readSessionToken(req), route);
    if (this.marked(context, IS_ADMIN_ONLY) && !req.user.isAdmin) {
      await this.auditLog.record({
        kind: 'access_denied',
        actor: req.user.id,
        objectType: 'route',
        objectId: route,
        outcome: 'rejected',
        reason: 'admin_required',
      });
      this.logger.info('admin route refused', {
        route,
        userId: req.user.id,
        sessionId: req.user.sessionId,
      });
      throw identityError('ADMIN_REQUIRED');
    }
    return true;
  }

  /** The employee of a live session, or 401: AUTH_REQUIRED, or ACCOUNT_DISABLED for a blocked one. */
  private async userOf(
    token: string | undefined,
    route: string,
  ): Promise<AuthUser> {
    const session =
      token === undefined ? undefined : await this.sessions.find(token);
    const refusal = session === undefined ? 'no_session' : refusalOf(session);
    if (session === undefined || refusal !== undefined) {
      this.logger.debug('session check refused', {
        route,
        reason: refusal,
        sessionId: session?.sessionId ?? null,
        userId: session?.user.id ?? null,
      });
      throw identityError(
        refusal === ENDED_BY_BLOCK ? 'ACCOUNT_DISABLED' : 'AUTH_REQUIRED',
      );
    }
    await this.sessions.touch(session);
    const {
      id,
      email,
      name,
      isAdmin,
      trainOwn,
      trainAny,
      hasPassword,
      language,
      theme,
      notificationLevel,
    } = session.user;
    return {
      id,
      email,
      name,
      isAdmin,
      trainOwn,
      trainAny,
      hasPassword,
      language,
      theme,
      notificationLevel,
      sessionId: session.sessionId,
    };
  }

  private marked(context: ExecutionContext, key: string): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(key, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}

/**
 * Why a found session does not let the request in, or undefined when it does — the one place of the
 * session's state. A blocked employee hears ACCOUNT_DISABLED until the session's own limit passes; a
 * session ended by a block whose employee was enabled again stays dead and answers AUTH_REQUIRED
 * (Invariant 1, DC-9). A disabled employee never passes, whatever his session row says.
 */
function refusalOf(session: FoundSession): string | undefined {
  if (session.expired) return 'expired';
  const disabled = session.user.status === UserStatusSchema.enum.disabled;
  if (disabled) return ENDED_BY_BLOCK;
  if (session.endedReason !== null) return 'ended';
  return undefined;
}

/** Method and path without the query, for the log and the audit. */
function routeOf(req: Request): string {
  return `${req.method} ${req.originalUrl.split('?')[0]}`;
}
