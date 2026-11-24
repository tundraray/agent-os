import { Inject, Injectable } from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  PublicUrlSchema,
  type SignInSettings,
  type UpdateSignInSettingsBody,
} from '@agent-os/contracts';
import {
  SettingsService,
  settingsResponse,
} from '../settings/settings.service';
import { identityError } from './identity.errors';
import { frontendOrigin } from './session-cookie';

const SIGN_IN_SETTINGS = 'sign_in_settings';

/**
 * The sign-in settings of the part, the key `sign_in_settings` of `settings` (KD-2; data-model KD-3): session
 * limits, which the session check reads on every request, and the public address for return URLs.
 */
@Injectable()
export class IdentitySettings {
  constructor(
    private readonly settings: SettingsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** The saved public address, or null: the sign-in reads only this, never the request's address. */
  async savedPublicUrl(): Promise<string | null> {
    return (await this.settings.read(SIGN_IN_SETTINGS)).value.publicUrl;
  }

  /**
   * The public address for an administrator's provider view or change and for the MCP server
   * registration and connect from the panel (KD-3): the saved one, otherwise `FRONTEND_ORIGIN`, which
   * is saved then (a concurrent first save keeps whichever came first). The request's address is never
   * used: behind the web's `/api` forwarding its Host is the API's internal address. 409
   * PUBLIC_URL_REQUIRED when `FRONTEND_ORIGIN` is no valid public address (e.g. `http` on a host other
   * than `localhost`): the administrator sets it in the sign-in settings.
   */
  async publicUrlFor(): Promise<string> {
    const { value } = await this.settings.read(SIGN_IN_SETTINGS);
    if (value.publicUrl !== null) return value.publicUrl;
    const candidate = frontendOrigin();
    if (!PublicUrlSchema.safeParse(candidate).success) {
      this.logger.info('frontend origin is no valid public url', {
        frontendOrigin: candidate,
        outcome: 'rejected',
        reason: 'public_url_required',
      });
      throw identityError('PUBLIC_URL_REQUIRED');
    }
    const saved = await this.settings.replaceIf(SIGN_IN_SETTINGS, value, {
      ...value,
      publicUrl: candidate,
    });
    if (!saved) return (await this.savedPublicUrl()) ?? candidate;
    this.logger.info('public url saved from frontend origin', {
      publicUrl: candidate,
      outcome: 'ok',
    });
    return candidate;
  }

  /** GET /api/admin/settings/sign-in (FR-26). */
  async get(): Promise<SignInSettings> {
    return settingsResponse(await this.settings.read(SIGN_IN_SETTINGS));
  }

  /**
   * PUT /api/admin/settings/sign-in: the body is already checked against the bounds; new limits act
   * from the next request of every session (AC-07.5). `SettingsService` writes `admin_change` on `sign_in_settings`.
   */
  async update(
    actorId: string,
    body: UpdateSignInSettingsBody,
  ): Promise<SignInSettings> {
    const { after } = await this.settings.write(
      SIGN_IN_SETTINGS,
      body,
      actorId,
    );
    return settingsResponse(after);
  }
}
