import { firstMessageFits, prologueInputFits } from './process-code.js';

// DC-19 (design-agent-core.md, «Формы результата и код процесса»): the prologue's input is at most 64 KiB — the limit of
// a runtime checkpoint — and its first message at most `firstMessageMaxBytes` of the form, both in UTF-8 bytes; either
// over its limit is `prologue_oversize` before any model call and before the input is written. Pure checks, no doubles.
// Defects caught: an input over 64 KiB that passes (it would be written and reach the model); a limit off by one; the
// first message measured in characters, so a Cyrillic message within the character count but over the bytes passes.

const MAX_BYTES = 1_000;
/** A string input whose JSON takes `bytes` bytes: its two quotes and ASCII characters. */
const inputOf = (bytes: number) => 'x'.repeat(bytes - 2);

describe('вход и первое сообщение пролога против пределов', () => {
  it.each<[string, () => boolean, boolean]>([
    ['an input of exactly 64 KiB passes', () => prologueInputFits(inputOf(65_536)), true],
    ['an input one byte over 64 KiB is prologue_oversize', () => prologueInputFits(inputOf(65_537)), false],
    ['an object input over 64 KiB is prologue_oversize', () => prologueInputFits({ claim: 'x'.repeat(65_536) }), false],
    ['a first message of exactly firstMessageMaxBytes passes', () => firstMessageFits('x'.repeat(MAX_BYTES), MAX_BYTES), true],
    ['a first message one byte over is prologue_oversize', () => firstMessageFits('x'.repeat(MAX_BYTES + 1), MAX_BYTES), false],
    [
      'a Cyrillic first message of fewer characters than the limit but more bytes is prologue_oversize',
      () => firstMessageFits('ж'.repeat(501), MAX_BYTES),
      false,
    ],
  ])('%s', (_case, check, fits) => {
    expect(check()).toBe(fits);
  });
});
