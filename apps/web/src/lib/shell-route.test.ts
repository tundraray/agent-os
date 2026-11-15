import { describe, expect, it } from 'vitest';
import { agentPath, parseShellRoute, threadPath } from './shell-route';

describe('lib/shell-route', () => {
  it.each([
    { pathname: '/chat/abc', expected: { kind: 'chat', threadId: 'abc' } },
    { pathname: '/chat/a%2Fb', expected: { kind: 'chat', threadId: 'a/b' } },
    { pathname: '/chat/%E0', expected: { kind: 'chat', threadId: '%E0' } },
    { pathname: '/', expected: { kind: 'chat' } },
    { pathname: '/foo', expected: { kind: 'chat' } },
    { pathname: '/chat/', expected: { kind: 'chat' } },
    { pathname: '/chat/a/b', expected: { kind: 'chat' } },
    { pathname: null, expected: { kind: 'chat' } },
    { pathname: '/agents', expected: { kind: 'agents' } },
    { pathname: '/agents/a1', expected: { kind: 'agent', agentId: 'a1' } },
    { pathname: '/agents/a%2F1', expected: { kind: 'agent', agentId: 'a/1' } },
    { pathname: '/agents/a1/x', expected: { kind: 'chat' } },
    { pathname: '/agents/a/b', expected: { kind: 'chat' } },
    { pathname: '/agents/', expected: { kind: 'chat' } },
  ])('shell routes parse into chat, agents list and agent pages: $pathname', ({ pathname, expected }) => {
    expect(parseShellRoute(pathname)).toEqual(expected);
  });

  it.each([
    { id: 'abc', path: '/chat/abc' },
    { id: 'a/b', path: '/chat/a%2Fb' },
    { id: 'с пробелом', path: '/chat/%D1%81%20%D0%BF%D1%80%D0%BE%D0%B1%D0%B5%D0%BB%D0%BE%D0%BC' },
    { id: '%', path: '/chat/%25' },
    { id: '?#&', path: '/chat/%3F%23%26' },
    { id: '0b6f3c2e-8f4a-4d1b-9c7e-2a5d6e8f1b3c', path: '/chat/0b6f3c2e-8f4a-4d1b-9c7e-2a5d6e8f1b3c' },
  ])('builds $path for thread id "$id" and parses it back to the same id', ({ id, path }) => {
    expect(threadPath(id)).toBe(path);
    expect(parseShellRoute(threadPath(id))).toEqual({ kind: 'chat', threadId: id });
  });

  it.each([
    { id: 'a1', path: '/agents/a1' },
    { id: 'a/b', path: '/agents/a%2Fb' },
  ])('builds $path for agent id "$id" and parses it back to the same id', ({ id, path }) => {
    expect(agentPath(id)).toBe(path);
    expect(parseShellRoute(agentPath(id))).toEqual({ kind: 'agent', agentId: id });
  });
});
