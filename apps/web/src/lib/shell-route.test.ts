import { describe, expect, it } from 'vitest';
import { adminNewPath, adminPath, adminRecordPath, agentPath, parseShellRoute, threadPath } from './shell-route';

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
    { pathname: '/account', expected: { kind: 'account' } },
    { pathname: '/account/x', expected: { kind: 'chat' } },
  ])('shell routes parse into chat, agents list, agent pages and «Мой доступ»: $pathname', ({ pathname, expected }) => {
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

  const usersList = { kind: 'admin', section: 'users', page: { kind: 'list' } };
  it.each([
    { pathname: '/admin', expected: usersList },
    { pathname: '/admin/', expected: usersList },
    { pathname: '/admin/users', expected: usersList },
    { pathname: '/admin/users/u1', expected: { kind: 'admin', section: 'users', page: { kind: 'record', key: 'u1' } } },
    { pathname: '/admin/roles', expected: { kind: 'admin', section: 'roles', page: { kind: 'list' } } },
    { pathname: '/admin/roles/r1', expected: { kind: 'admin', section: 'roles', page: { kind: 'record', key: 'r1' } } },
    { pathname: '/admin/sign-in', expected: { kind: 'admin', section: 'sign-in', page: { kind: 'list' } } },
    { pathname: '/admin/sign-in/new', expected: { kind: 'admin', section: 'sign-in', page: { kind: 'new' } } },
    { pathname: '/admin/sign-in/p1', expected: { kind: 'admin', section: 'sign-in', page: { kind: 'record', key: 'p1' } } },
    { pathname: '/admin/servers', expected: { kind: 'admin', section: 'servers', page: { kind: 'list' } } },
    { pathname: '/admin/register-server', expected: { kind: 'admin', section: 'servers', page: { kind: 'new' } } },
    { pathname: '/admin/servers/new', expected: { kind: 'admin', section: 'servers', page: { kind: 'record', key: 'new' } } },
    { pathname: '/admin/servers/my%20srv%2F1', expected: { kind: 'admin', section: 'servers', page: { kind: 'record', key: 'my srv/1' } } },
    { pathname: '/admin/models', expected: { kind: 'admin', section: 'models', page: { kind: 'list' } } },
    { pathname: '/admin/models/x', expected: usersList },
    { pathname: '/admin/users/a/b', expected: usersList },
    { pathname: '/admin/unknown', expected: usersList },
    { pathname: '/administrator', expected: { kind: 'chat' } },
  ])(
    'panel addresses: every address of C3 opens its section and page, /admin/servers/new is the server named new while /admin/register-server is the form, /admin and unknown addresses under it open «Сотрудники», keys are percent-decoded: $pathname',
    ({ pathname, expected }) => {
      expect(parseShellRoute(pathname)).toEqual(expected);
    },
  );

  it('builds panel addresses that parse back to the same section and page', () => {
    expect(adminPath('roles')).toBe('/admin/roles');
    expect(adminRecordPath('servers', 'my srv/1')).toBe('/admin/servers/my%20srv%2F1');
    expect(parseShellRoute(adminRecordPath('servers', 'new'))).toEqual({
      kind: 'admin',
      section: 'servers',
      page: { kind: 'record', key: 'new' },
    });
    expect(adminNewPath('sign-in')).toBe('/admin/sign-in/new');
    expect(adminNewPath('servers')).toBe('/admin/register-server');
  });
});
