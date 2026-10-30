import { describe, expect, it } from 'vitest';
import { parseRouteThreadId, threadPath } from './route-thread-id';

describe('lib/threads/route-thread-id', () => {
  it.each([
    { pathname: '/chat/abc', expected: 'abc' },
    { pathname: '/chat/a%2Fb', expected: 'a/b' },
    { pathname: '/chat/%E0', expected: '%E0' },
    { pathname: '/', expected: undefined },
    { pathname: '/foo', expected: undefined },
    { pathname: '/chat/', expected: undefined },
    { pathname: '/chat/a/b', expected: undefined },
    { pathname: null, expected: undefined },
  ])('parses $pathname as $expected', ({ pathname, expected }) => {
    expect(parseRouteThreadId(pathname)).toBe(expected);
  });

  it.each([
    { id: 'abc', path: '/chat/abc' },
    { id: 'a/b', path: '/chat/a%2Fb' },
    { id: 'с пробелом', path: '/chat/%D1%81%20%D0%BF%D1%80%D0%BE%D0%B1%D0%B5%D0%BB%D0%BE%D0%BC' },
    { id: '%', path: '/chat/%25' },
    { id: '?#&', path: '/chat/%3F%23%26' },
    { id: '0b6f3c2e-8f4a-4d1b-9c7e-2a5d6e8f1b3c', path: '/chat/0b6f3c2e-8f4a-4d1b-9c7e-2a5d6e8f1b3c' },
  ])('builds $path for id "$id" and parses it back to the same id', ({ id, path }) => {
    expect(threadPath(id)).toBe(path);
    expect(parseRouteThreadId(threadPath(id))).toBe(id);
  });
});
