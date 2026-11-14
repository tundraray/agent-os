"use client";

import { useStore } from "zustand";

import type { AnnouncerStore } from "@/lib/live/announcer-store";

/**
 * The shell's only polite live region (design-web.md, «Доступность»). The region itself stays mounted;
 * the inner node is replaced on every `announce`, so a repeated phrase is spoken again.
 */
export function Announcer({ announcer }: { announcer: AnnouncerStore }) {
  const text = useStore(announcer, (state) => state.text);
  const seq = useStore(announcer, (state) => state.seq);
  return (
    <div role="status" aria-live="polite" className="sr-only">
      <span key={seq}>{text}</span>
    </div>
  );
}
