import { rememberSecret } from '@agent-os/common';
import { maskSentryEvent } from './sentry-mask.js';

// Obviously fake keys; remembered after the mask was created at import, as a key set while the server runs.
const OLD_KEY = 'fake-provider-key-old-0001';
const NEW_KEY = 'fake-provider-key-new-0002';
rememberSecret(OLD_KEY);
rememberSecret(NEW_KEY);

// AC-11.1 (Sentry half, KD-7): a Sentry event carries neither the replaced nor the later-set key; query params are cut as before.
describe('maskSentryEvent masks exception texts', () => {
  it.each([
    [
      'a key remembered after the mask was created',
      `call failed: key ${NEW_KEY}`,
      'call failed: key [redacted]',
    ],
    [
      'the replaced key',
      `stale ${OLD_KEY} rejected`,
      'stale [redacted] rejected',
    ],
    [
      'a failed query with a key in its params',
      `Failed query: select 1\nparams: ${NEW_KEY}`,
      'Failed query: select 1',
    ],
    ['a text without secrets', 'plain error', 'plain error'],
  ])('%s', (_case, value, expected) => {
    const event = maskSentryEvent({ exception: { values: [{ value }] } });
    expect(event.exception.values[0]?.value).toBe(expected);
  });
});
