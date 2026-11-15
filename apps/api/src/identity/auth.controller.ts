import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import {
  PasswordSignInBodySchema,
  ProviderTypeSchema,
  type CurrentUser,
  type PasswordSignInBody,
  type ProviderButtonList,
} from '@agent-os/contracts';
import {
  identityProviders,
  identityUsers,
  type Database,
  type DatabaseConnection,
} from '@agent-os/db';
import { asc, eq, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { AuditLog } from '../audit/audit-log.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens.js';
import type { AuthedRequest } from './auth-user.js';
import { Public } from './public.decorator.js';
import {
  clearSessionCookie,
  readSessionToken,
  setSessionCookie,
} from './session-cookie.js';
import { SessionStore } from './session.store.js';
import { SignInService } from './sign-in.service.js';

/** Sign-in and session routes for the web (design-identity.md, Contract «Вход и сеанс»). */
@Controller('auth')
export class AuthController {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(
    @Inject(RUNTIME_DATABASE) database: DatabaseConnection,
    private readonly signIn: SignInService,
    private readonly sessions: SessionStore,
    private readonly auditLog: AuditLog,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.db = database.db;
    this.logger = logger.child({ service: 'identity.auth' });
  }

  /** The enabled providers in creation order (`created_at`, then `id`). */
  @Public()
  @Get('providers')
  async providers(): Promise<ProviderButtonList> {
    const rows = await this.db
      .select({
        id: identityProviders.id,
        name: identityProviders.name,
        type: identityProviders.type,
      })
      .from(identityProviders)
      .where(eq(identityProviders.enabled, true))
      .orderBy(asc(identityProviders.createdAt), asc(identityProviders.id));
    return rows.map((row) => ({
      ...row,
      type: ProviderTypeSchema.parse(row.type),
    }));
  }

  /** Flow 2: 204 and the session cookie; the refusals come from `SignInService`. */
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
  async me(@Req() req: AuthedRequest): Promise<CurrentUser> {
    const { id, email, name, isAdmin } = req.user;
    const [row] = await this.db
      .select({
        hasPassword: sql<boolean>`${identityUsers.passwordHash} is not null`,
      })
      .from(identityUsers)
      .where(eq(identityUsers.id, id));
    return { id, email, name, isAdmin, hasPassword: row?.hasPassword === true };
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
