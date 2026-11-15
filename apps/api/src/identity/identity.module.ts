import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { AdminProvidersController } from './admin-providers.controller.js';
import { AdminRolesController } from './admin-roles.controller.js';
import { AdminSettingsController } from './admin-settings.controller.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AuthController } from './auth.controller.js';
import { HealthController } from './health.controller.js';
import { IdentityDirectory } from './identity-directory.js';
import { IdentitySettings } from './identity-settings.js';
import {
  DEFAULT_GOOGLE_ISSUER_URL,
  GOOGLE_ISSUER_URL,
} from './identity.tokens.js';
import { OidcSignIn } from './oidc-sign-in.js';
import { PasswordSignIn } from './password-sign-in.js';
import { ProvidersService } from './providers.service.js';
import { RolesService } from './roles.service.js';
import { SessionStore } from './session.store.js';
import { SessionGuard } from './session.guard.js';
import { SignInService } from './sign-in.service.js';
import { UsersService } from './users.service.js';

/**
 * Employees, sign-in and sessions (design-identity.md, C3 api). `SessionGuard` is the global guard
 * of the whole API: every route of every module needs a session unless marked `@Public()` (KD-3).
 */
@Module({
  imports: [RuntimeModule],
  controllers: [
    AuthController,
    HealthController,
    AdminUsersController,
    AdminRolesController,
    AdminProvidersController,
    AdminSettingsController,
  ],
  providers: [
    IdentityDirectory,
    IdentitySettings,
    OidcSignIn,
    PasswordSignIn,
    ProvidersService,
    RolesService,
    SessionStore,
    SignInService,
    UsersService,
    { provide: GOOGLE_ISSUER_URL, useValue: DEFAULT_GOOGLE_ISSUER_URL },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [IdentityDirectory, IdentitySettings],
})
export class IdentityModule {}
