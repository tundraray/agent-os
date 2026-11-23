import type { Logger } from '@agent-os/common';
import type {
  SettingsService,
  StoredSettings,
} from '../settings/settings.service';
import { IdentitySettings } from './identity-settings';

const readSettings = vi.fn<SettingsService['read']>();
const replaceIf = vi.fn<SettingsService['replaceIf']>();

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

const LIMITS = { idleMinutes: 60, absoluteMinutes: 720 };

function stored(publicUrl: string | null): StoredSettings<'sign_in_settings'> {
  return {
    value: { publicUrl, ...LIMITS },
    updatedAt: null,
    updatedBy: null,
  };
}

// KD-3, Flow 3: behind the web's /api forwarding the request's Host is the API's internal address,
// so the fallback public address is FRONTEND_ORIGIN, saved once, and only when it is a valid one.
// data-model DC-8: a first save that lost to a concurrent one answers with the address the other request stored.
describe('public address without a saved one: the saved one wins, a valid FRONTEND_ORIGIN is returned and saved, a save lost to another request returns the stored address, http on another host is refused and nothing is saved', () => {
  const settings = new IdentitySettings(
    { read: readSettings, replaceIf } as unknown as SettingsService,
    logger,
  );

  afterEach(() => {
    vi.unstubAllEnvs();
    replaceIf.mockReset();
  });

  it.each<{
    saved: string | null;
    frontendOrigin: string;
    /** The address a concurrent request stored first: this request's replace writes nothing. */
    savedByOther?: string;
    expected: string;
    savedNow?: string;
  }>([
    {
      saved: 'https://aos.example.com',
      frontendOrigin: 'https://web.example.com',
      expected: 'https://aos.example.com',
    },
    {
      saved: null,
      frontendOrigin: 'https://aos.example.com',
      expected: 'https://aos.example.com',
      savedNow: 'https://aos.example.com',
    },
    {
      saved: null,
      frontendOrigin: 'https://aos.example.com',
      savedByOther: 'https://first.example.com',
      expected: 'https://first.example.com',
      savedNow: 'https://aos.example.com',
    },
  ])(
    'saved $saved, FRONTEND_ORIGIN $frontendOrigin, saved by another request $savedByOther -> $expected',
    async ({ saved, frontendOrigin, savedByOther, expected, savedNow }) => {
      vi.stubEnv('FRONTEND_ORIGIN', frontendOrigin);
      readSettings
        .mockResolvedValueOnce(stored(saved))
        .mockResolvedValue(stored(savedByOther ?? saved));
      replaceIf.mockResolvedValue(savedByOther === undefined);

      await expect(settings.publicUrlFor()).resolves.toBe(expected);

      if (savedNow === undefined) expect(replaceIf).not.toHaveBeenCalled();
      else
        expect(replaceIf).toHaveBeenCalledWith(
          'sign_in_settings',
          { publicUrl: null, ...LIMITS },
          { publicUrl: savedNow, ...LIMITS },
        );
    },
  );

  it('refuses http on a host other than localhost with PUBLIC_URL_REQUIRED and saves nothing', async () => {
    vi.stubEnv('FRONTEND_ORIGIN', 'http://aos.example.com');
    readSettings.mockResolvedValue(stored(null));

    await expect(settings.publicUrlFor()).rejects.toMatchObject({
      status: 409,
      response: { errorCode: 'PUBLIC_URL_REQUIRED' },
    });
    expect(replaceIf).not.toHaveBeenCalled();
  });
});
