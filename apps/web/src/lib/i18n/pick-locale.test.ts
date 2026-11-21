import { describe, expect, it } from 'vitest';
import { pickLocale, type LocalePick } from './pick-locale';

// UC-1 (AC-02.3, AC-03.1, AC-03.2, DC-4).
describe('picks the interface language from the cookie, then the browser list, then English', () => {
  it.each<[string, string | undefined, string | null, LocalePick]>([
    ['the cookie over an English browser', 'ru', 'en-US,en;q=0.9', { locale: 'ru', source: 'cookie' }],
    ['the first supported browser language', undefined, 'de, ru;q=0.8', { locale: 'ru', source: 'browser' }],
    ['a regional English variant', undefined, 'en-GB', { locale: 'en', source: 'browser' }],
    ['English when the browser has no supported language', undefined, 'fr', { locale: 'en', source: 'default' }],
    ['the browser when the cookie is junk', 'de', 'ru-RU,ru;q=0.9', { locale: 'ru', source: 'browser' }],
    ['English without a header', undefined, null, { locale: 'en', source: 'default' }],
    ['the higher quality over the earlier entry', undefined, 'en;q=0.5, ru', { locale: 'ru', source: 'browser' }],
  ])('picks %s', (_, cookie, acceptLanguage, expected) => {
    expect(pickLocale(cookie, acceptLanguage)).toEqual(expected);
  });
});
