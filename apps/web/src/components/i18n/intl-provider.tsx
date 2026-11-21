'use client';

import { useEffect, type ReactNode } from 'react';
import { NextIntlClientProvider, type IntlError } from 'next-intl';
import { formats } from '@/lib/i18n/formats';
import type { Messages } from '@/lib/i18n/messages';
import type { Locale } from '@/lib/i18n/pick-locale';
import { logger } from '@/lib/logger';

type IntlProviderProps = { locale: Locale; messages: Messages; children: ReactNode };

const onError = (error: IntlError): void => {
  logger.error('i18n: message failed', { code: error.code, message: error.message });
};

// The key name is never shown to the employee (NFR-02); the failure is already logged by onError.
const getMessageFallback = (): string => '';

/**
 * The only module that renders `NextIntlClientProvider`: imported from a server component, the
 * package resolves to its server provider, which needs the plugin (design-web.md, KD-1; ADR-0020).
 */
export function IntlProvider({ locale, messages, children }: IntlProviderProps) {
  // Keeps `lang` on <html> in step after a language change; the inline script covers the first paint.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      formats={formats}
      onError={onError}
      getMessageFallback={getMessageFallback}
    >
      {children}
    </NextIntlClientProvider>
  );
}
