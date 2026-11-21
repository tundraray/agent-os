export const LOCALES = ['en', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];

/** Written and removed only by the API; the Next server reads it (design-web.md, Contract Definitions). */
export const LOCALE_COOKIE = 'aos_locale';

export type LocaleSource = 'cookie' | 'browser' | 'default';
export type LocalePick = { locale: Locale; source: LocaleSource };

const isLocale = (value: string | undefined): value is Locale => LOCALES.some((locale) => locale === value);

/** The first `en*` or `ru*` entry of an `Accept-Language` list by quality, earlier entries winning ties. */
function browserLocale(acceptLanguage: string): Locale | undefined {
  const entries = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
      const quality = q === undefined ? 1 : Number(q.slice(2));
      return { language: tag.trim().toLowerCase().split('-')[0], quality: Number.isNaN(quality) ? 0 : quality, index };
    })
    .filter((entry) => entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { language } of entries) if (isLocale(language)) return language;
  return undefined;
}

/**
 * The interface language of a document request (design-web.md, KD-2): the employee's choice copied
 * into the cookie, else the browser's list, else English. Anything outside the closed set is ignored.
 */
export function pickLocale(cookieValue: string | undefined, acceptLanguage: string | null): LocalePick {
  if (isLocale(cookieValue)) return { locale: cookieValue, source: 'cookie' };
  const fromBrowser = acceptLanguage ? browserLocale(acceptLanguage) : undefined;
  if (fromBrowser) return { locale: fromBrowser, source: 'browser' };
  return { locale: 'en', source: 'default' };
}
