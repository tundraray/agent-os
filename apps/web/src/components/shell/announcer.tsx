'use client';

import {
  useMessages,
  useTranslations,
  type TranslationValues,
} from 'next-intl';
import { useStore } from 'zustand';

import { builtinToolLabels } from '@/i18n/builtin-name';
import type { Messages } from '@/i18n/catalog';
import type {
  AnnouncementValues,
  AnnouncerStore,
} from '@/lib/live/announcer-store';

/** Values ready for `t`: a built-in tool reads by its catalogue title, or by its name when the catalogue lacks it. */
function resolveValues(
  tools: Messages['tools'],
  values: AnnouncementValues | undefined,
): TranslationValues | undefined {
  if (values === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      typeof value === 'object' && value !== null && 'builtinTool' in value
        ? (builtinToolLabels(tools, value.builtinTool)?.title ??
          value.builtinTool)
        : value,
    ]),
  );
}

/**
 * The shell's only polite live region (design-web.md, «Доступность»). The region itself stays mounted; every
 * `announce` adds its own node, so phrases announced together are read in turn and a repeated phrase is spoken
 * again. The store holds keys with values; each phrase is translated here, in the page's language (KD-5).
 */
export function Announcer({ announcer }: { announcer: AnnouncerStore }) {
  const t = useTranslations();
  const { tools } = useMessages();
  const queue = useStore(announcer, (state) => state.queue);
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {queue.map(({ seq, announcement }) => (
        <span key={seq} className="block">
          {t(announcement.key, resolveValues(tools, announcement.values))}
        </span>
      ))}
    </div>
  );
}
