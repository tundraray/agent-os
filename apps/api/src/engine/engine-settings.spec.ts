import { parseEngineSettings } from './engine-settings.js';

// Risk: an invalid base starts the engine against a wrong address, or the error does not name the variable; the
// engine picks up the chat agent's base variable (a base with the version) and calls `<base>/v1/v1`.
describe('parseEngineSettings - RESEARCH_ANTHROPIC_BASE_URL', () => {
  it.each<[string, Record<string, string>, string]>([
    ['unset', {}, 'https://api.anthropic.com'],
    ['empty', { RESEARCH_ANTHROPIC_BASE_URL: '' }, 'https://api.anthropic.com'],
    [
      'set with a path',
      { RESEARCH_ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080/proxy' },
      'http://127.0.0.1:8080/proxy',
    ],
    [
      'unset while the chat variable ANTHROPIC_BASE_URL is set',
      { ANTHROPIC_BASE_URL: 'http://chat-proxy.local/v1' },
      'https://api.anthropic.com',
    ],
  ])('takes the base when %s', (_, env, expected) => {
    const settings = parseEngineSettings((name) => env[name]);

    expect(settings.anthropicBaseUrl).toBe(expected);
  });

  it.each([['not-a-url'], ['ftp://api.anthropic.com']])(
    'stops the start naming the variable for %s',
    (value) => {
      const env: Record<string, string> = {
        RESEARCH_ANTHROPIC_BASE_URL: value,
      };

      expect(() => parseEngineSettings((name) => env[name])).toThrow(
        /RESEARCH_ANTHROPIC_BASE_URL/,
      );
    },
  );
});
