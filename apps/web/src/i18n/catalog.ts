import enAccount from './translations/en/account.json';
import enAdmin from './translations/en/admin.json';
import enAgents from './translations/en/agents.json';
import enAnnounce from './translations/en/announce.json';
import enChat from './translations/en/chat.json';
import enCommon from './translations/en/common.json';
import enErrors from './translations/en/errors.json';
import enFormats from './translations/en/formats.json';
import enLibrary from './translations/en/library.json';
import enLogin from './translations/en/login.json';
import enPages from './translations/en/pages.json';
import enSchedules from './translations/en/schedules.json';
import enShell from './translations/en/shell.json';
import enTools from './translations/en/tools.json';
import enTracker from './translations/en/tracker.json';
import ruAccount from './translations/ru/account.json';
import ruAdmin from './translations/ru/admin.json';
import ruAgents from './translations/ru/agents.json';
import ruAnnounce from './translations/ru/announce.json';
import ruChat from './translations/ru/chat.json';
import ruCommon from './translations/ru/common.json';
import ruErrors from './translations/ru/errors.json';
import ruFormats from './translations/ru/formats.json';
import ruLibrary from './translations/ru/library.json';
import ruLogin from './translations/ru/login.json';
import ruPages from './translations/ru/pages.json';
import ruSchedules from './translations/ru/schedules.json';
import ruShell from './translations/ru/shell.json';
import ruTools from './translations/ru/tools.json';
import ruTracker from './translations/ru/tracker.json';
import type { useTranslations } from 'next-intl';
import type { Locale } from './pick-locale';

/**
 * One entry per screen area; an area is a next-intl namespace. Each language has its folder in `./translations`, with one
 * file per area under the same name: `en/<area>.json` and `ru/<area>.json`. A new area is registered here.
 */
const en = {
  account: enAccount,
  admin: enAdmin,
  agents: enAgents,
  announce: enAnnounce,
  chat: enChat,
  common: enCommon,
  errors: enErrors,
  formats: enFormats,
  library: enLibrary,
  login: enLogin,
  pages: enPages,
  schedules: enSchedules,
  shell: enShell,
  tools: enTools,
  tracker: enTracker,
};

/** The English catalog sets the type, so `tsc` rejects a Russian catalog missing a key. */
export type Messages = typeof en;

/*
 * Translate functions of a namespace, for pure text functions that take one as a parameter; components take
 * `useTranslations(namespace)`.
 */
export type AgentsTranslator = ReturnType<typeof useTranslations<'agents'>>;
export type ChatTranslator = ReturnType<typeof useTranslations<'chat'>>;
export type ErrorsTranslator = ReturnType<typeof useTranslations<'errors'>>;
export type FormatsTranslator = ReturnType<typeof useTranslations<'formats'>>;
export type LibraryTranslator = ReturnType<typeof useTranslations<'library'>>;
export type SchedulesTranslator = ReturnType<
  typeof useTranslations<'schedules'>
>;
export type TrackerTranslator = ReturnType<typeof useTranslations<'tracker'>>;
export type ModelsTranslator = ReturnType<
  typeof useTranslations<'admin.models'>
>;
export type ServersTranslator = ReturnType<
  typeof useTranslations<'admin.servers'>
>;

/** The key set every language shares; code reads it only to check that a key the server sent has a message. */
export const CATALOGUE: Messages = en;

/**
 * A code, reason or name from the server names a message only when the catalogue table holds it
 * (design-web.md, «Отказы сервера»; KD-6). `table` is a part of `CATALOGUE` or of the page's messages.
 */
export const hasMessage = <T extends object>(
  table: T,
  key: string | null | undefined,
): key is Extract<keyof T, string> =>
  typeof key === 'string' && Object.hasOwn(table, key);

const ru: Messages = {
  account: ruAccount,
  admin: ruAdmin,
  agents: ruAgents,
  announce: ruAnnounce,
  chat: ruChat,
  common: ruCommon,
  errors: ruErrors,
  formats: ruFormats,
  library: ruLibrary,
  login: ruLogin,
  pages: ruPages,
  schedules: ruSchedules,
  shell: ruShell,
  tools: ruTools,
  tracker: ruTracker,
};

type MessageTree = { [key: string]: string | MessageTree };

/** `over` laid on `base`, key by key, so a text missing from `over` shows from `base` (NFR-02). */
function overlay(base: MessageTree, over: MessageTree): MessageTree {
  const result: MessageTree = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const under = base[key];
    result[key] =
      typeof value === 'object' && typeof under === 'object'
        ? overlay(under, value)
        : value;
  }
  return result;
}

const RU_OVER_EN = overlay(en, ru);

/** The catalog sent to the browser for `locale`: Russian is laid over English. */
export function catalogOf(locale: Locale): Messages {
  // Same keys as `en` by construction: `overlay` keeps every key of its base.
  return locale === 'ru' ? (RU_OVER_EN as Messages) : en;
}
