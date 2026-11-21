import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import {
  isHttpsOrLocalhost,
  type ProviderType,
  type SignInError,
} from '@agent-os/contracts';
import type { Database, DatabaseConnection } from '@agent-os/db';
import * as client from 'openid-client';
import { isUuid } from '../common/is-uuid';
import { APP_LOGGER } from '../logging/app-logger';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens';
import { IdentitySettings } from './identity-settings';
import { GOOGLE_ISSUER_URL } from './identity.tokens';
import { isComplete } from './provider-options';
import {
  consumeLoginRequest,
  deleteExpiredLoginRequests,
  findProvider,
  insertLoginRequest,
} from './providers.repository';

/** How long a sign-in request and its `aos_login` cookie live (Runtime settings). */
export const LOGIN_REQUEST_TTL_MS = 10 * 60 * 1000;

/** Scopes the sign-in asks the provider for (ProviderView.providerData). */
export const SIGN_IN_SCOPES = 'openid email profile';

/** Seconds the issuer may take to answer discovery, the token exchange and its keys. */
const ISSUER_TIMEOUT_SECONDS = 10;

/** The provider's error when the employee cancels at the provider (RFC 6749 §4.1.2.1). */
const ACCESS_DENIED = 'access_denied';

/** The refusals the provider half decides; `no_email` and `account_disabled` are `SignInService`'s. */
type ProviderRefusal = Exclude<SignInError, 'no_email' | 'account_disabled'>;

export type StartedSignIn =
  | { ok: true; authorizationUrl: URL; state: string; loginRequestId: string }
  | { ok: false; reason: 'provider_unavailable'; detail: string };

export type FinishedSignIn =
  | {
      ok: true;
      loginRequestId: string;
      /** As the ID token has it; absent when the token has no email. */
      email: string | undefined;
      name: string | undefined;
      next: string;
    }
  | {
      ok: false;
      loginRequestId: string | undefined;
      reason: ProviderRefusal;
      /** The real cause, for the log only. */
      detail: string;
    };

export interface ReturnFromProvider {
  /** The provider id of the callback path. */
  providerId: string;
  /** The query string of the callback: `code`, `state`, `iss` or `error`. */
  query: URLSearchParams;
  /** The `aos_login` cookie: the `state` this browser started with. */
  loginState: string | undefined;
}

/** An enabled provider with complete settings, as the sign-in uses it. */
interface SignInProvider {
  id: string;
  type: ProviderType;
  version: number;
  issuer: string | undefined;
  clientId: string;
  clientSecret: string;
}

/** The provider when it exists, is enabled and has its settings complete (`isComplete`); otherwise undefined. */
async function findSignInProvider(
  db: Database,
  providerId: string,
): Promise<SignInProvider | undefined> {
  const provider = isUuid(providerId)
    ? await findProvider(db, providerId)
    : undefined;
  if (
    provider === undefined ||
    !provider.enabled ||
    !isComplete(provider.type, provider.options)
  )
    return undefined;
  const { id, type, version, options } = provider;
  return {
    id,
    type,
    version,
    issuer: options.issuer,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
  };
}

// ---------- OIDC ----------

/** The return address registered at the provider (ProviderView.providerData.redirectUri). */
export function redirectUriOf(publicUrl: string, providerId: string): string {
  return `${publicUrl}/api/auth/oauth/${providerId}/callback`;
}

/** `http` is allowed only where the settings check allows it: a development issuer on `localhost`. */
function isLocalHttp(issuer: URL): boolean {
  return issuer.protocol === 'http:' && isHttpsOrLocalhost(issuer);
}

/** The library's error without anything the provider sent: its class, code and own message. */
function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { errorName: typeof error };
  return {
    errorName: error.name,
    errorCode: (error as { code?: unknown }).code,
    errorMessage: error.message,
  };
}

/**
 * The provider half of Flow 1 (KD-1, C3 api): authorization code with PKCE, `state` and `nonce` over
 * `openid-client`; the one-time sign-in request in `identity_login_requests`; the ID token checked by
 * issuer, audience, signature and `nonce`. The client configuration is the only thing kept in memory,
 * per provider and version, so an edit of the provider acts from the next sign-in (AC-03.3).
 */
@Injectable()
export class OidcSignIn {
  private readonly db: Database;
  private readonly logger: Logger;
  /** Per provider id: the configuration of its current version (ADR-0001). */
  private readonly configs = new Map<
    string,
    { version: number; config: Promise<client.Configuration> }
  >();

  constructor(
    @Inject(RUNTIME_DATABASE) database: DatabaseConnection,
    private readonly settings: IdentitySettings,
    @Inject(GOOGLE_ISSUER_URL) private readonly googleIssuer: string,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.db = database.db;
    this.logger = logger.child({ service: 'identity.oidc' });
  }

  /**
   * Stores a sign-in request and builds the provider's authorization URL; the expired requests go
   * first. The return address is the saved public address only: without one the provider is
   * unavailable, never an address taken from this anonymous request.
   */
  async start(providerId: string, next: string): Promise<StartedSignIn> {
    const provider = await findSignInProvider(this.db, providerId);
    if (provider === undefined)
      return {
        ok: false,
        reason: 'provider_unavailable',
        detail: 'not_enabled',
      };
    const publicUrl = await this.settings.savedPublicUrl();
    if (publicUrl === null)
      return {
        ok: false,
        reason: 'provider_unavailable',
        detail: 'public_url_unset',
      };
    const config = await this.configOf(provider);
    if (config === undefined)
      return {
        ok: false,
        reason: 'provider_unavailable',
        detail: 'discovery_failed',
      };
    const state = client.randomState();
    const nonce = client.randomNonce();
    const codeVerifier = client.randomPKCECodeVerifier();
    const expired = await deleteExpiredLoginRequests(this.db);
    if (expired > 0)
      this.logger.debug('expired sign-in requests deleted', {
        count: expired,
      });
    const loginRequestId = await insertLoginRequest(this.db, {
      state,
      providerId,
      nonce,
      codeVerifier,
      next,
      expiresAt: new Date(Date.now() + LOGIN_REQUEST_TTL_MS),
    });
    const authorizationUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUriOf(publicUrl, providerId),
      scope: SIGN_IN_SCOPES,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { ok: true, authorizationUrl, state, loginRequestId };
  }

  /**
   * Consumes the sign-in request of the returned `state` first, so no answer is accepted twice, then
   * checks it against the browser's cookie, its expiry and the provider, and exchanges the code.
   */
  async finish(callback: ReturnFromProvider): Promise<FinishedSignIn> {
    const state = callback.query.get('state');
    const loginRequest =
      state === null ? undefined : await consumeLoginRequest(this.db, state);
    const refuse = (
      reason: ProviderRefusal,
      detail: string,
    ): FinishedSignIn => ({
      ok: false,
      loginRequestId: loginRequest?.id,
      reason,
      detail,
    });
    if (loginRequest === undefined)
      return refuse('failed', 'request_not_found');
    if (loginRequest.providerId !== callback.providerId)
      return refuse('failed', 'provider_mismatch');
    if (callback.loginState !== loginRequest.state)
      return refuse('failed', 'state_mismatch');
    if (loginRequest.expiresAt.getTime() <= Date.now())
      return refuse('failed', 'request_expired');
    const provider = await findSignInProvider(this.db, loginRequest.providerId);
    if (provider === undefined)
      return refuse('provider_unavailable', 'not_enabled');
    const providerError = callback.query.get('error');
    if (providerError !== null)
      return providerError === ACCESS_DENIED
        ? refuse('cancelled', 'access_denied')
        : refuse('failed', 'provider_error');
    const publicUrl = await this.settings.savedPublicUrl();
    if (publicUrl === null)
      return refuse('provider_unavailable', 'public_url_unset');
    const config = await this.configOf(provider);
    if (config === undefined)
      return refuse('provider_unavailable', 'discovery_failed');
    const currentUrl = new URL(redirectUriOf(publicUrl, provider.id));
    currentUrl.search = callback.query.toString();
    let claims: client.IDToken | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: loginRequest.codeVerifier,
        expectedState: loginRequest.state,
        expectedNonce: loginRequest.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch (error) {
      this.logger.warn('provider code exchange failed', {
        providerId: provider.id,
        loginRequestId: loginRequest.id,
        outcome: 'failed',
        ...describeError(error),
      });
      return refuse('failed', 'token_check_failed');
    }
    return {
      ok: true,
      loginRequestId: loginRequest.id,
      email: typeof claims?.email === 'string' ? claims.email : undefined,
      name: typeof claims?.name === 'string' ? claims.name : undefined,
      next: loginRequest.next,
    };
  }

  /**
   * The client configuration of the provider's current version, discovered once per version; a failed
   * discovery is not kept, so the next sign-in tries again. Undefined when discovery fails.
   */
  private async configOf(
    provider: SignInProvider,
  ): Promise<client.Configuration | undefined> {
    let cached = this.configs.get(provider.id);
    if (cached?.version !== provider.version) {
      cached = { version: provider.version, config: this.discover(provider) };
      this.configs.set(provider.id, cached);
    }
    try {
      return await cached.config;
    } catch (error) {
      if (this.configs.get(provider.id) === cached)
        this.configs.delete(provider.id);
      this.logger.warn('provider discovery failed', {
        providerId: provider.id,
        version: provider.version,
        outcome: 'failed',
        ...describeError(error),
      });
      return undefined;
    }
  }

  private async discover(
    provider: SignInProvider,
  ): Promise<client.Configuration> {
    const startedAt = Date.now();
    const issuerUrl =
      provider.type === 'google' ? this.googleIssuer : provider.issuer;
    if (issuerUrl === undefined) throw new Error('the provider has no issuer');
    const issuer = new URL(issuerUrl);
    const config = await client.discovery(
      issuer,
      provider.clientId,
      undefined,
      client.ClientSecretBasic(provider.clientSecret),
      {
        execute: isLocalHttp(issuer) ? [client.allowInsecureRequests] : [],
        timeout: ISSUER_TIMEOUT_SECONDS,
      },
    );
    this.logger.info('provider configuration discovered', {
      providerId: provider.id,
      version: provider.version,
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
    return config;
  }
}
