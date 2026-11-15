import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import {
  nextPath,
  PasswordChangeBodySchema,
  PasswordSignInBodySchema,
  type CurrentUser,
  type PasswordChangeBody,
  type PasswordSignInBody,
  type ProviderButtonList,
  type SignInError,
} from '@agent-os/contracts';
import type { CookieOptions, Request, Response } from 'express';
import { AuditLog } from '../audit/audit-log.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import type { AuthedRequest } from './auth-user.js';
import { LOGIN_REQUEST_TTL_MS } from './oidc-sign-in.js';
import { ProvidersService } from './providers.service.js';
import { Public } from './public.decorator.js';
import {
  clearSessionCookie,
  cookieOptions,
  frontendOrigin,
  readCookie,
  readSessionToken,
  setSessionCookie,
} from './session-cookie.js';
import { SessionStore } from './session.store.js';
import { SignInService } from './sign-in.service.js';
import { UsersService } from './users.service.js';

/** Binds a provider sign-in to the browser that started it: its value is the request's `state` (DC-4). */
const LOGIN_COOKIE = 'aos_login';

/** The `aos_login` cookie: the options of every API cookie, living as long as the sign-in request. */
function loginCookieOptions(): CookieOptions {
  return { ...cookieOptions(), maxAge: LOGIN_REQUEST_TTL_MS };
}

/** The web's login page with the refusal reason (`uxrd.md` MC-3). */
function loginPageUrl(reason: SignInError, providerId: string): string {
  const query = new URLSearchParams({ error: reason, provider: providerId });
  return `${frontendOrigin()}/login?${query.toString()}`;
}

/** Sign-in and session routes for the web (design-identity.md, Contract «Вход и сеанс»). */
@Controller('auth')
export class AuthController {
  private readonly logger: Logger;

  constructor(
    private readonly signIn: SignInService,
    private readonly providers: ProvidersService,
    private readonly sessions: SessionStore,
    private readonly users: UsersService,
    private readonly auditLog: AuditLog,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'identity.auth' });
  }

  /** The enabled providers in creation order (`created_at`, then `id`). */
  @Public()
  @Get('providers')
  providerButtons(): Promise<ProviderButtonList> {
    return this.providers.buttons();
  }

  /** Flow 1, start: 302 to the provider with the `aos_login` cookie, or to the login page. */
  @Public()
  @Get('sign-in/:providerId')
  async startProviderSignIn(
    @Param('providerId') providerId: string,
    @Query('next') next: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const started = await this.signIn.startWithProvider(
      providerId,
      nextPath(next),
    );
    if (!started.ok) {
      res.redirect(302, loginPageUrl(started.reason, providerId));
      return;
    }
    res.cookie(LOGIN_COOKIE, started.state, loginCookieOptions());
    res.redirect(302, started.authorizationUrl.href);
  }

  /** Flow 1, return: 302 to `{FRONTEND_ORIGIN}{next}` with the session cookie, or to the login page with the reason. */
  @Public()
  @Get('oauth/:providerId/callback')
  async providerCallback(
    @Param('providerId') providerId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const signedIn = await this.signIn.signInWithProvider({
      providerId,
      query: new URL(req.originalUrl, 'http://callback.invalid').searchParams,
      loginState: readCookie(req, LOGIN_COOKIE),
    });
    res.clearCookie(LOGIN_COOKIE, loginCookieOptions());
    if (!signedIn.ok) {
      res.redirect(302, loginPageUrl(signedIn.reason, providerId));
      return;
    }
    setSessionCookie(res, signedIn.token);
    res.redirect(302, `${frontendOrigin()}${signedIn.next}`);
  }

  /**
   * Flow 2: 204 and the session cookie; the refusals come from `SignInService`. Open, yet `SessionGuard`
   * still refuses it without the web's `Origin` (403 ORIGIN_REJECTED), so no foreign page signs anyone in.
   */
  @Public()
  @Post('password')
  @HttpCode(204)
  async password(
    @Body(new ZodValidationPipe(PasswordSignInBodySchema))
    body: PasswordSignInBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const opened = await this.signIn.signInWithPassword(
      body.login,
      body.password,
    );
    setSessionCookie(res, opened.token);
  }

  @Get('me')
  me(@Req() req: AuthedRequest): CurrentUser {
    const { id, email, name, isAdmin, hasPassword } = req.user;
    return { id, email, name, isAdmin, hasPassword };
  }

  /** 204; the employee's other sessions stay (KD-5). 400 VALIDATION_FAILED with `reason`. */
  @Post('password/change')
  @HttpCode(204)
  changePassword(
    @Body(new ZodValidationPipe(PasswordChangeBodySchema))
    body: PasswordChangeBody,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    return this.users.changeOwnPassword(req.user.id, body);
  }

  /** 204 always; a live cookie's session row is deleted and `sign_out` written to the audit. */
  @Public()
  @Post('sign-out')
  @HttpCode(204)
  async signOut(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = readSessionToken(req);
    clearSessionCookie(res);
    const session =
      token === undefined ? undefined : await this.sessions.find(token);
    if (session === undefined) return;
    await this.sessions.end(session.sessionId);
    await this.auditLog.record(null, {
      kind: 'sign_out',
      actor: session.user.id,
      objectType: 'user',
      objectId: session.user.id,
      outcome: 'ok',
    });
    this.logger.info('signed out', {
      userId: session.user.id,
      sessionId: session.sessionId,
      outcome: 'ok',
    });
  }
}
