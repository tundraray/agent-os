import { BUILTIN_ROLE_KEY, CHAT_BUILTIN_KEY } from '@agent-os/contracts';
import { describe, expect, it } from 'vitest';
import { builtinName, builtinRoleName } from './builtin-name';

describe('builtinName', () => {
  // AC-06.1, AC-06.2, AC-06.4: translates a seeded built-in name and keeps an admin-given one.
  it.each([
    [
      'a seeded built-in record',
      { builtinKey: CHAT_BUILTIN_KEY, name: 'Главный чат' },
      'Main chat',
    ],
    [
      'a renamed built-in record',
      { builtinKey: CHAT_BUILTIN_KEY, name: 'Чат поддержки' },
      'Чат поддержки',
    ],
    [
      'the built-in role',
      { builtinKey: BUILTIN_ROLE_KEY, name: 'Супер-администратор' },
      'Super administrator',
    ],
  ])('%s', (_, named, expected) => {
    expect(builtinName(named, 'en')).toBe(expected);
  });
});

describe('builtinRoleName', () => {
  // access-levels AC-38.2: both built-in roles are named in the page's language by their name alone.
  it.each([
    ['«Супер-администратор»', 'Супер-администратор', 'Super administrator'],
    ['«Все сотрудники»', 'Все сотрудники', 'All employees'],
    ['a role an administrator named', 'SRE', 'SRE'],
  ])('%s', (_, name, expected) => {
    expect(builtinRoleName(name, 'en')).toBe(expected);
  });
});
