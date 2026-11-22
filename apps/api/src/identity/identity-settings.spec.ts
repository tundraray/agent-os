import type { Logger } from '@agent-os/common';
import type { DatabaseConnection } from '@agent-os/db';
import type { AuditLog } from '../audit/audit-log.repository';
import { IdentitySettings } from './identity-settings';
import {
  readSettings,
  savePublicUrlIfUnset,
  type SettingsRow,
} from './settings.repository';

vi.mock('./settings.repository');

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

function settingsRow(publicUrl: string | null): SettingsRow {
  return {
    publicUrl,
    idleMinutes: 60,
    absoluteMinutes: 720,
    updatedAt: null,
  };
}

// KD-3, Flow 3: behind the web's /api forwarding the request's Host is the API's internal address,
// so the fallback public address is FRONTEND_ORIGIN, saved once, and only when it is a valid one.
describe('public address without a saved one: the saved one wins, a valid FRONTEND_ORIGIN is returned and saved, http on another host is refused and nothing is saved', () => {
  const settings = new IdentitySettings(
    { db: {} } as DatabaseConnection,
    {} as AuditLog,
    logger,
  );

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(savePublicUrlIfUnset).mockReset();
  });

  it.each([
    {
      saved: 'https://aos.example.com',
      frontendOrigin: 'https://web.example.com',
      expected: 'https://aos.example.com',
      savedNow: undefined,
    },
    {
      saved: null,
      frontendOrigin: 'https://aos.example.com',
      expected: 'https://aos.example.com',
      savedNow: 'https://aos.example.com',
    },
  ])(
    'saved $saved, FRONTEND_ORIGIN $frontendOrigin -> $expected',
    async ({ saved, frontendOrigin, expected, savedNow }) => {
      vi.stubEnv('FRONTEND_ORIGIN', frontendOrigin);
      vi.mocked(readSettings).mockResolvedValue(settingsRow(saved));
      vi.mocked(savePublicUrlIfUnset).mockResolvedValue(true);

      await expect(settings.publicUrlFor()).resolves.toBe(expected);

      if (savedNow === undefined)
        expect(savePublicUrlIfUnset).not.toHaveBeenCalled();
      else
        expect(savePublicUrlIfUnset).toHaveBeenCalledWith(
          expect.anything(),
          savedNow,
        );
    },
  );

  it('refuses http on a host other than localhost with PUBLIC_URL_REQUIRED and saves nothing', async () => {
    vi.stubEnv('FRONTEND_ORIGIN', 'http://aos.example.com');
    vi.mocked(readSettings).mockResolvedValue(settingsRow(null));

    await expect(settings.publicUrlFor()).rejects.toMatchObject({
      status: 409,
      response: { errorCode: 'PUBLIC_URL_REQUIRED' },
    });
    expect(savePublicUrlIfUnset).not.toHaveBeenCalled();
  });
});
