import { Injectable } from '@nestjs/common';
import type {
  LibrarySettings,
  UpdateLibrarySettingsBody,
} from '@agent-os/contracts';
import {
  SettingsService,
  settingsResponse,
} from '../settings/settings.service';

const LIBRARY_SETTINGS = 'library_settings';

/**
 * The library's settings, the key `library_settings` of `settings` (data-model KD-3): «Максимум шагов» a new agent
 * or deep agent starts with. The editor reads it through `GET /api/library/choices`; a saved record keeps its own
 * value.
 */
@Injectable()
export class LibrarySettingsService {
  constructor(private readonly settings: SettingsService) {}

  /** GET /api/admin/library/settings. */
  async get(): Promise<LibrarySettings> {
    return settingsResponse(await this.settings.read(LIBRARY_SETTINGS));
  }

  /**
   * PUT /api/admin/library/settings: the body is already checked against the bounds. `SettingsService` writes
   * `admin_change` on `library_settings`.
   */
  async update(
    actorId: string,
    body: UpdateLibrarySettingsBody,
  ): Promise<LibrarySettings> {
    const { after } = await this.settings.write(
      LIBRARY_SETTINGS,
      body,
      actorId,
    );
    return settingsResponse(after);
  }
}
