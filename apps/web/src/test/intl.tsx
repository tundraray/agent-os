import type { ReactNode } from 'react';
import { createFormatter, createTranslator, NextIntlClientProvider, type NamespaceKeys, type NestedKeyOf } from 'next-intl';
import { formats } from '@/i18n/formats';
import { catalogOf, type Messages } from '@/i18n/catalog';
import type { Locale } from '@/i18n/pick-locale';

/** Component tests render in Russian, so their queries keep matching the visible Russian text (design-web.md, KD-7). */
const TEST_LOCALE = 'ru';
const TEST_MESSAGES = catalogOf(TEST_LOCALE);
/** Same zone as `TZ` in vitest.config.ts: dates format identically in Node and through next-intl. */
const TEST_TIME_ZONE = 'Europe/Berlin';

/** The interface-language provider every rendered component needs, with the Russian catalog. */
export function TestIntlProvider({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale={TEST_LOCALE} messages={TEST_MESSAGES} timeZone={TEST_TIME_ZONE} formats={formats}>
      {children}
    </NextIntlClientProvider>
  );
}

/** The translate function a pure text function receives as a parameter, over the same Russian catalog. */
export function testTranslator<Namespace extends NamespaceKeys<Messages, NestedKeyOf<Messages>>>(namespace: Namespace) {
  return createTranslator({ locale: TEST_LOCALE, messages: TEST_MESSAGES, namespace });
}

/** The formatter a pure format function receives as a parameter, in the test zone with the shared formats. */
export function testFormatter(locale: Locale = TEST_LOCALE) {
  return createFormatter({ locale, timeZone: TEST_TIME_ZONE, formats });
}
