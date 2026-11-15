import { describe, expect, it } from 'vitest';
import { nextPath } from './next-path.js';

// AC-04.5 (next): the redirect after sign-in goes to `{FRONTEND_ORIGIN}{next}`, so anything but a web
// path would be an open redirect to a foreign host.
describe('next keeps a web path with one leading slash, anything else becomes /', () => {
  it.each([
    { next: '/chat/x?y=1', expected: '/chat/x?y=1' },
    { next: '/', expected: '/' },
    { next: '//evil.example', expected: '/' },
    { next: 'https://evil.example', expected: '/' },
    { next: '', expected: '/' },
    { next: undefined, expected: '/' },
    { next: '\\evil', expected: '/' },
    { next: '/\\evil.example', expected: '/' },
    { next: '/\t/evil.example', expected: '/' },
    { next: ['/a', '/b'], expected: '/' },
  ])('$next -> $expected', ({ next, expected }) => {
    expect(nextPath(next)).toBe(expected);
  });
});
