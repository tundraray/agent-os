import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SettingsModule } from '../settings/settings.module';
import { AdminProvidersController } from './admin-providers.controller';
import { AdminRolesController } from './admin-roles.controller';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminUsersController } from './admin-users.controller';
import { AuthController } from './auth.controller';
import { HealthController } from './health.controller';
import { IdentityDirectory } from './identity-directory';
import { IdentitySettings } from './identity-settings';
import {
  DEFAULT_GOOGLE_ISSUER_URL,
  GOOGLE_ISSUER_URL,
} from './identity.tokens';
import { OidcSignIn } from './oidc-sign-in';
import { PasswordSignIn } from './password-sign-in';
import { ProvidersService } from './providers.service';
import { RolesService } from './roles.service';
import { SessionStore } from './session.store';
import { SessionGuard } from './session.guard';
import { SignInService } from './sign-in.service';
import { UsersService } from './users.service';

/**
 * Employees, sign-in and sessions (design-identity.md, C3 api). `SessionGuard` is the global guard
 * of the whole API: every route of every module needs a session unless marked `@Public()` (KD-3).
 */
@Module({
  imports: [SettingsModule],
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
  exports: [IdentityDirectory, IdentitySettings, UsersService],
})
export class IdentityModule {}
