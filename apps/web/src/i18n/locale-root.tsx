import type { ReactNode } from 'react';
import { cookies, headers } from 'next/headers';
import { after } from 'next/server';
import { LOCALE_COOKIE } from '@agent-os/contracts';
import { IntlProvider } from './intl-provider';
import { catalogOf } from './catalog';
import { pickLocale } from './pick-locale';
import { logger } from '@/lib/logger';

/**
 * Picks the interface language of the request and hands it to the client provider (design-web.md, KD-2).
 * Reads request data, so it sits inside the root layout's <Suspense>. Imports nothing from next-intl.
 */
export async function LocaleRoot({ children }: { children: ReactNode }) {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  const { locale, source } = pickLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerList.get('accept-language'),
  );
  // The logger stamps the current time, which a runtime prefetch prerender refuses during render.
  after(() => logger.debug('i18n: locale picked', { locale, source }));
  return (
    <>
      {/* `locale` is from the closed set `en` | `ru`, never request text: the static `lang="en"` is fixed before paint. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `document.documentElement.lang=${JSON.stringify(locale)};`,
        }}
      />
      <IntlProvider locale={locale} messages={catalogOf(locale)}>
        {children}
      </IntlProvider>
    </>
  );
}
