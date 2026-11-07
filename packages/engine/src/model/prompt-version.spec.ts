import { promptVersion } from './prompt-version.js';

// AC-01.6, DC-2 (the rule half), KD-2: the prompt version of a transcript is the first 12 hexadecimal characters of
// SHA-256 of the role's prompt template. Defects caught: a version of another length, alphabet or hash (which the
// `research_llm_transcripts` check rejects, or which would not match the recorded one).

describe('promptVersion', () => {
  it.each([
    ['the empty template', '', 'e3b0c44298fc'],
    ['a plain template', 'abc', 'ba7816bf8f01'],
  ])('returns the first 12 hex characters of SHA-256 of %s', (_, template, expected) => {
    expect(promptVersion(template)).toBe(expected);
  });
});
