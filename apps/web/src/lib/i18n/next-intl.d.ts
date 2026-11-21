import type { formats } from './formats';
import type { Messages } from './messages';
import type { Locale } from './pick-locale';

// Types `useTranslations` keys, `useLocale()` and the named formats of `useFormatter` (design-web.md, KD-5).
declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
    Formats: typeof formats;
  }
}
