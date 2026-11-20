import { describe, expect, it } from 'vitest';
import {
  adminKnowledgePath,
  adminLibraryTabPath,
  adminNewPath,
  adminPath,
  adminRecordPath,
  agentPath,
  knowledgePath,
  parseShellRoute,
  recordPath,
  threadPath,
} from './shell-route';

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

  // KD-1: the employee's library pages; `new/agent` and `new/workflow` are parsed before a record id.
  const libraryList = { kind: 'library', page: { kind: 'list' } };
  it.each([
    { pathname: '/library', expected: libraryList },
    { pathname: '/library/r1', expected: { kind: 'library', page: { kind: 'record', id: 'r1' } } },
    { pathname: '/library/r%2F1', expected: { kind: 'library', page: { kind: 'record', id: 'r/1' } } },
    { pathname: '/library/new/agent', expected: { kind: 'library', page: { kind: 'new', recordKind: 'agent' } } },
    { pathname: '/library/new/workflow', expected: { kind: 'library', page: { kind: 'new', recordKind: 'workflow' } } },
    { pathname: '/library/new/other', expected: libraryList },
    // Self-learning KD-2: a workflow's knowledge is parsed before a single record id, otherwise it opens the list.
    { pathname: '/library/abc/knowledge', expected: { kind: 'library', page: { kind: 'knowledge', id: 'abc' } } },
    { pathname: '/library/a%2Fb/knowledge', expected: { kind: 'library', page: { kind: 'knowledge', id: 'a/b' } } },
    { pathname: '/library/knowledge', expected: { kind: 'library', page: { kind: 'record', id: 'knowledge' } } },
    { pathname: '/library/abc/knowledge/x', expected: libraryList },
    { pathname: '/library/abc/knowledge/', expected: libraryList },
    { pathname: '/library/', expected: libraryList },
    { pathname: '/libraryx', expected: { kind: 'chat' } },
  ])('library addresses open the list, a record or a new record: $pathname', ({ pathname, expected }) => {
    expect(parseShellRoute(pathname)).toEqual(expected);
  });

  const usersList = { kind: 'admin', section: 'users', page: { kind: 'list' } };
  it.each([
    { pathname: '/admin', expected: usersList },
    { pathname: '/admin/users/u1', expected: { kind: 'admin', section: 'users', page: { kind: 'record', key: 'u1' } } },
    { pathname: '/admin/sign-in/new', expected: { kind: 'admin', section: 'sign-in', page: { kind: 'new' } } },
    { pathname: '/admin/register-server', expected: { kind: 'admin', section: 'servers', page: { kind: 'new' } } },
    { pathname: '/admin/servers/new', expected: { kind: 'admin', section: 'servers', page: { kind: 'record', key: 'new' } } },
    { pathname: '/admin/servers/my%20srv%2F1', expected: { kind: 'admin', section: 'servers', page: { kind: 'record', key: 'my srv/1' } } },
    { pathname: '/admin/models/x', expected: usersList },
    { pathname: '/admin/users/a/b', expected: usersList },
    { pathname: '/admin/unknown', expected: usersList },
    { pathname: '/administrator', expected: { kind: 'chat' } },
  ])(
    'panel addresses: a record and a new-record address open their section and page, /admin/servers/new is the server named new while /admin/register-server is the form, /admin and unknown addresses under it open «Сотрудники», keys are percent-decoded: $pathname',
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

  // KD-1, DC-6: the panel's «Агенты и workflow» keeps its tab and its new-record kind in the path, so a reload and
  // «Назад» return the same tab; `shared`, `bans` and `new/…` are parsed before a record id.
  const libraryTab = (tab: string) => ({ kind: 'admin', section: 'library', page: { kind: 'list', tab } });
  it.each([
    { pathname: '/admin/library', expected: libraryTab('system') },
    { pathname: '/admin/library/shared', expected: libraryTab('shared') },
    { pathname: '/admin/library/bans', expected: libraryTab('bans') },
    { pathname: '/admin/library/new/agent', expected: { kind: 'admin', section: 'library', page: { kind: 'new', recordKind: 'agent' } } },
    { pathname: '/admin/library/new/workflow', expected: { kind: 'admin', section: 'library', page: { kind: 'new', recordKind: 'workflow' } } },
    { pathname: '/admin/library/r%2F1', expected: { kind: 'admin', section: 'library', page: { kind: 'record', key: 'r/1' } } },
    { pathname: '/admin/library/new/other', expected: usersList },
    // Self-learning KD-2: a workflow's knowledge is parsed after the tabs and `new/…`, before a single record key.
    { pathname: '/admin/library/abc/knowledge', expected: { kind: 'admin', section: 'library', page: { kind: 'knowledge', key: 'abc' } } },
    { pathname: '/admin/library/a%2Fb/knowledge', expected: { kind: 'admin', section: 'library', page: { kind: 'knowledge', key: 'a/b' } } },
    { pathname: '/admin/library/knowledge', expected: { kind: 'admin', section: 'library', page: { kind: 'record', key: 'knowledge' } } },
    { pathname: '/admin/library/abc/knowledge/x', expected: usersList },
    { pathname: '/admin/library/abc/knowledge/', expected: usersList },
    { pathname: '/admin/users/abc/knowledge', expected: usersList },
  ])('panel library addresses open a tab, a new record or a record: $pathname', ({ pathname, expected }) => {
    expect(parseShellRoute(pathname)).toEqual(expected);
  });

  it('encodes a record id and a tab into an address that parses back to the same page', () => {
    expect(recordPath('a/b')).toBe('/library/a%2Fb');
    expect(parseShellRoute(recordPath('a/b'))).toEqual({ kind: 'library', page: { kind: 'record', id: 'a/b' } });
    expect(adminLibraryTabPath('bans')).toBe('/admin/library/bans');
    expect(parseShellRoute(adminLibraryTabPath('bans'))).toEqual(libraryTab('bans'));
    expect(knowledgePath('a/b')).toBe('/library/a%2Fb/knowledge');
    expect(adminKnowledgePath('a/b')).toBe('/admin/library/a%2Fb/knowledge');
  });

});
