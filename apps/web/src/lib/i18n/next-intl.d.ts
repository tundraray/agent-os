import type { Messages } from './messages';
import type { Locale } from './pick-locale';

// Types `useTranslations` keys and `useLocale()` from the catalogs (design-web.md, KD-5).
declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
