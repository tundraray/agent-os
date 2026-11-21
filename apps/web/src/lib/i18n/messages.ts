import enAccount from '@/messages/en/account.json';
import enAnnounce from '@/messages/en/announce.json';
import enCommon from '@/messages/en/common.json';
import enFormats from '@/messages/en/formats.json';
import enLogin from '@/messages/en/login.json';
import ruAccount from '@/messages/ru/account.json';
import ruAnnounce from '@/messages/ru/announce.json';
import ruCommon from '@/messages/ru/common.json';
import ruFormats from '@/messages/ru/formats.json';
import ruLogin from '@/messages/ru/login.json';
import type { Locale } from './pick-locale';

/** One entry per screen area; an area is a next-intl namespace. A new area file is registered here. */
const en = {
  account: enAccount,
  announce: enAnnounce,
  common: enCommon,
  formats: enFormats,
  login: enLogin,
};

/** The English catalog sets the type, so `tsc` rejects a Russian catalog missing a key. */
export type Messages = typeof en;

const ru: Messages = {
  account: ruAccount,
  announce: ruAnnounce,
  common: ruCommon,
  formats: ruFormats,
  login: ruLogin,
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
