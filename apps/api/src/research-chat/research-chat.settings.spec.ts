import { parseResearchChatSettings } from './research-chat.settings.js';

// Runtime settings of design-chat-entry.md: unset or empty takes the default; an invalid value stops the start
// naming the variable. Risk: a typo silently becomes a zero window, or the error does not say which variable.
describe('parseResearchChatSettings', () => {
  it.each<
    [
      string,
      Record<string, string>,
      { appendGiveUpMs: number; launchRecoveryMs: number },
    ]
  >([
    ['unset', {}, { appendGiveUpMs: 300_000, launchRecoveryMs: 60_000 }],
    [
      'empty',
      { RESEARCH_APPEND_GIVE_UP_MS: '', RESEARCH_LAUNCH_RECOVERY_MS: '' },
      { appendGiveUpMs: 300_000, launchRecoveryMs: 60_000 },
    ],
    [
      'set',
      {
        RESEARCH_APPEND_GIVE_UP_MS: '1500',
        RESEARCH_LAUNCH_RECOVERY_MS: '250',
      },
      { appendGiveUpMs: 1_500, launchRecoveryMs: 250 },
    ],
  ])('takes the values when %s', (_, env, expected) => {
    expect(parseResearchChatSettings((name) => env[name])).toEqual(expected);
  });

  it.each<[string, string]>([
    ['RESEARCH_APPEND_GIVE_UP_MS', 'abc'],
    ['RESEARCH_APPEND_GIVE_UP_MS', '0'],
    ['RESEARCH_APPEND_GIVE_UP_MS', '-5'],
    ['RESEARCH_LAUNCH_RECOVERY_MS', '1.5'],
    ['RESEARCH_LAUNCH_RECOVERY_MS', '60s'],
  ])('stops the start naming %s for "%s"', (variable, value) => {
    const env: Record<string, string> = { [variable]: value };

    expect(() => parseResearchChatSettings((name) => env[name])).toThrow(
      new RegExp(variable),
    );
  });
});
