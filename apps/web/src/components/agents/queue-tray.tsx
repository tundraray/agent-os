"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon, ClockIcon, InfoIcon } from "lucide-react";
import { useShellServices } from "@/components/shell/shell-actions";
import type { Tray, TrayEntry } from "@/lib/feed/to-feed";
import { cn } from "@/lib/utils";

/** UXRD MC-21, verbatim. */
const TEXT = {
  region: "Ждут доставки",
  more: (n: number) => `и ещё ${n}`,
  blocked: "Ждём вашего решения по запросу выше — сообщения уйдут после него.",
  toDecision: "К запросу",
  announce: "Сообщение ждёт доставки",
} as const;

const SOURCE_LABEL: Record<TrayEntry["source"], string> = {
  user: "Вы",
  report: "Отчёт",
  parent: "Агент",
};

/** message-queue.md, Variants: three entries are shown, the rest fold into «и ещё {N}». */
const VISIBLE_ENTRIES = 3;

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** «К запросу»: scrolls the feed to the decision card and moves focus onto it (message-queue.md, Focus). */
function focusDecision(decisionId: string): void {
  const card = document.querySelector<HTMLElement>(`[data-decision-id="${CSS.escape(decisionId)}"]`);
  if (card === null) return;
  card.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  card.focus({ preventScroll: true });
}

const countUser = (entries: readonly TrayEntry[]): number => entries.filter((e) => e.source === "user").length;

/**
 * Speaks MC-21 once per new message of the employee, through the shell's only polite region. The count
 * (not the ids) decides: an optimistic entry swapped for its queued copy keeps the count and stays silent,
 * entries present at mount (a reload) and deliveries are not announced.
 */
function useAnnounceNewEntries(entries: readonly TrayEntry[]): void {
  const { announcer } = useShellServices();
  const userCount = countUser(entries);
  const previous = useRef(userCount);
  useEffect(() => {
    if (userCount > previous.current) announcer.getState().announce(TEXT.announce);
    previous.current = userCount;
  }, [announcer, userCount]);
}

export type QueueTrayProps = {
  /** `trayEntries` of the feed: the entries, «Заблокирован решением» and the decision «К запросу» leads to. */
  tray: Tray;
};

/**
 * The queue tray above the composer (message-queue.md, UXRD CV-04, MC-21): what was accepted and the
 * agent or the chat has not received yet. An empty tray renders nothing and takes no space.
 */
export function QueueTray({ tray }: QueueTrayProps) {
  const { entries, blocked, decisionId } = tray;
  useAnnounceNewEntries(entries);
  // Entries present at first render (a reload, a re-read) do not animate; only later ones open.
  const [initialIds] = useState(() => new Set(entries.map((entry) => entry.id)));

  if (entries.length === 0) return null;

  const visible = entries.slice(0, VISIBLE_ENTRIES);
  const hidden = entries.length - visible.length;

  return (
    <section
      aria-label={TEXT.region}
      data-slot="queue-tray"
      data-state={blocked ? "blocked" : "queued"}
      className="bg-muted mb-2 flex w-full min-w-0 flex-col gap-1 rounded-lg border px-3 py-2"
    >
      <p className="text-muted-foreground flex h-4 items-center gap-1.5 text-xs leading-4 font-medium tabular-nums">
        <ClockIcon aria-hidden className="size-3.5 shrink-0" />
        {`${TEXT.region} · ${entries.length}`}
      </p>
      <ul className="flex flex-col">
        {visible.map((entry) => (
          <li
            key={entry.id}
            className={cn(
              "grid grid-rows-[1fr]",
              !initialIds.has(entry.id) &&
                "transition-[grid-template-rows] duration-(--duration-fast) starting:grid-rows-[0fr] motion-reduce:transition-none",
            )}
          >
            <div className="flex min-h-0 min-w-0 items-baseline gap-2 overflow-hidden py-0.5">
              <span className="text-muted-foreground w-20 shrink-0 text-xs leading-4 font-medium">
                {SOURCE_LABEL[entry.source]}
              </span>
              <span className="text-foreground line-clamp-2 min-w-0 flex-1 text-sm leading-5 break-words">
                {entry.text}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="text-muted-foreground pl-22 text-xs leading-4 font-medium tabular-nums">{TEXT.more(hidden)}</p>
      )}
      {blocked && (
        <p className="text-foreground flex items-start gap-1.5 text-sm leading-5">
          <InfoIcon aria-hidden className="text-info mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">
            {TEXT.blocked}
            {decisionId !== null && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => focusDecision(decisionId)}
                  className="text-primary focus-visible:ring-ring inline-flex items-center gap-0.5 rounded-sm align-baseline outline-none hover:underline focus-visible:ring-2 pointer-coarse:h-11"
                >
                  {TEXT.toDecision}
                  <ArrowUpIcon aria-hidden className="size-3.5" />
                </button>
              </>
            )}
          </span>
        </p>
      )}
    </section>
  );
}
