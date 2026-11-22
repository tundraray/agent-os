import { BUILTIN_ROLE_KEY, CHAT_BUILTIN_KEY } from '@agent-os/contracts';
import { describe, expect, it } from 'vitest';
import { builtinName } from './builtin-name';

describe('builtinName', () => {
  // AC-06.1, AC-06.2, AC-06.4: translates a seeded built-in name and keeps an admin-given one.
  it.each([
    ['a seeded built-in record', { builtinKey: CHAT_BUILTIN_KEY, name: 'Главный чат' }, 'Main chat'],
    ['a renamed built-in record', { builtinKey: CHAT_BUILTIN_KEY, name: 'Чат поддержки' }, 'Чат поддержки'],
    ['the built-in role', { builtinKey: BUILTIN_ROLE_KEY, name: 'Супер-администратор' }, 'Super administrator'],
  ])('%s', (_, named, expected) => {
    expect(builtinName(named, 'en')).toBe(expected);
  });
});
