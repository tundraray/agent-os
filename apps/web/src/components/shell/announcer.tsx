"use client";

import { useTranslations } from "next-intl";
import { useStore } from "zustand";

import type { AnnouncerStore } from "@/lib/live/announcer-store";

/**
 * The shell's only polite live region (design-web.md, «Доступность»). The region itself stays mounted;
 * the inner node is replaced on every `announce`, so a repeated phrase is spoken again. The store holds a
 * key with values; the phrase is translated here, in the page's language (KD-5).
 */
export function Announcer({ announcer }: { announcer: AnnouncerStore }) {
  const t = useTranslations();
  const message = useStore(announcer, (state) => state.message);
  const seq = useStore(announcer, (state) => state.seq);
  return (
    <div role="status" aria-live="polite" className="sr-only">
      <span key={seq}>{message === null ? "" : t(message.key, message.values)}</span>
    </div>
  );
}
