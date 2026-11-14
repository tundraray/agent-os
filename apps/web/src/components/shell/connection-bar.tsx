"use client";

import { CloudOff } from "lucide-react";
import { useStore } from "zustand";

import type { LiveStore } from "@/lib/live/live-store";

/**
 * CN-01: a 32 px strip under the header while the stream is `lost`. It appears and leaves without
 * animation and announces nothing itself — `LiveStore` speaks through the `Announcer`.
 */
export function ConnectionBar({ live }: { live: LiveStore }) {
  const lost = useStore(live, (state) => state.connection === "lost");
  if (!lost) return null;
  return (
    <div className="bg-muted text-foreground flex h-8 w-full shrink-0 items-center gap-2 px-4 text-sm">
      <CloudOff aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 truncate">Нет связи с сервером. Переподключаемся…</span>
    </div>
  );
}
