import enAccount from '@/messages/en/account.json';
import enAgents from '@/messages/en/agents.json';
import enAnnounce from '@/messages/en/announce.json';
import enChat from '@/messages/en/chat.json';
import enCommon from '@/messages/en/common.json';
import enErrors from '@/messages/en/errors.json';
import enFormats from '@/messages/en/formats.json';
import enLibrary from '@/messages/en/library.json';
import enLogin from '@/messages/en/login.json';
import enPages from '@/messages/en/pages.json';
import enShell from '@/messages/en/shell.json';
import enTools from '@/messages/en/tools.json';
import ruAccount from '@/messages/ru/account.json';
import ruAgents from '@/messages/ru/agents.json';
import ruAnnounce from '@/messages/ru/announce.json';
import ruChat from '@/messages/ru/chat.json';
import ruCommon from '@/messages/ru/common.json';
import ruErrors from '@/messages/ru/errors.json';
import ruFormats from '@/messages/ru/formats.json';
import ruLibrary from '@/messages/ru/library.json';
import ruLogin from '@/messages/ru/login.json';
import ruPages from '@/messages/ru/pages.json';
import ruShell from '@/messages/ru/shell.json';
import ruTools from '@/messages/ru/tools.json';
import type { useTranslations } from 'next-intl';
import type { Locale } from './pick-locale';

/** One entry per screen area; an area is a next-intl namespace. A new area file is registered here. */
const en = {
  account: enAccount,
  agents: enAgents,
  announce: enAnnounce,
  chat: enChat,
  common: enCommon,
  errors: enErrors,
  formats: enFormats,
  library: enLibrary,
  login: enLogin,
  pages: enPages,
  shell: enShell,
  tools: enTools,
};

/** The English catalog sets the type, so `tsc` rejects a Russian catalog missing a key. */
export type Messages = typeof en;

/** The translate function of the conversation area, for text functions that take it as a parameter. */
export type ChatTranslator = ReturnType<typeof useTranslations<'chat'>>;

/** The translate function of the library area, for its text functions. */
export type LibraryTranslator = ReturnType<typeof useTranslations<'library'>>;

const ru: Messages = {
  account: ruAccount,
  agents: ruAgents,
  announce: ruAnnounce,
  chat: ruChat,
  common: ruCommon,
  errors: ruErrors,
  formats: ruFormats,
  library: ruLibrary,
  login: ruLogin,
  pages: ruPages,
  shell: ruShell,
  tools: ruTools,
};

type MessageTree = { [key: string]: string | MessageTree };

/** `over` laid on `base`, key by key, so a text missing from `over` shows from `base` (NFR-02). */
function overlay(base: MessageTree, over: MessageTree): MessageTree {
  const result: MessageTree = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const under = base[key];
    result[key] = typeof value === 'object' && typeof under === 'object' ? overlay(under, value) : value;
  }
  return result;
}

const RU_OVER_EN = overlay(en, ru);

/** The catalog sent to the browser for `locale`: Russian is laid over English. */
export function messagesOf(locale: Locale): Messages {
  // Same keys as `en` by construction: `overlay` keeps every key of its base.
  return locale === 'ru' ? (RU_OVER_EN as Messages) : en;
}
