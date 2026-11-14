"use client";

import type { AgentStatus as AgentStatusValue, HistoryEvent } from "@agent-os/contracts";
import { ArchiveIcon, HistoryIcon, type LucideIcon } from "lucide-react";
import { AgentStatus, StatusGlyph } from "@/components/agents/agent-status";
import { failureReasonText, formatTime } from "@/lib/agents/format";
import type { EventPartData } from "@/lib/feed/to-feed";

type StatusEvent = Exclude<HistoryEvent, "continued" | "compacted">;

/** The status an event leaves the agent in: the icon and colour of its line. */
const EVENT_STATUS: Record<StatusEvent, AgentStatusValue> = {
  interrupted: "interrupted",
  stopped: "stopped",
  stopped_with_parent: "stopped",
  failed: "failed",
};

/** MC-14 texts of the events that carry no reason. */
const EVENT_TEXT: Record<Exclude<HistoryEvent, "failed">, string> = {
  interrupted: "Прервано вами",
  stopped: "Остановлен вами",
  stopped_with_parent: "Остановлен вместе с родителем",
  continued: "Продолжен с историей",
  compacted: "История сжата для модели",
};

/**
 * Lines that mark a moment rather than a status: a static muted icon, so a past «Продолжен с историей»
 * does not spin in the feed after the agent has finished.
 */
const MARK_ICON: Record<"continued" | "compacted", LucideIcon> = {
  continued: HistoryIcon,
  compacted: ArchiveIcon,
};

/**
 * A status change without a model reply (UXRD MC-14): `AgentStatus` «Строка события». A failure reason
 * MC-14 does not name reads «Сбой: ошибка платформы» with its code as the hint (KD-6).
 */
export function EventLine({ data }: { data: EventPartData }) {
  const { event, reason, createdAt } = data;

  if (event === "continued" || event === "compacted") {
    return (
      <p
        data-slot="agent-status-event"
        className="text-muted-foreground flex h-5 min-w-0 items-center gap-1 text-xs leading-4"
      >
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          <StatusGlyph Icon={MARK_ICON[event]} spinning={false} />
        </span>
        <span className="min-w-0 truncate">{EVENT_TEXT[event]}</span>
        <span aria-hidden className="shrink-0">
          ·
        </span>
        <time dateTime={createdAt} className="shrink-0 tabular-nums">
          {formatTime(createdAt)}
        </time>
      </p>
    );
  }

  if (event === "failed") {
    const { text, hint } = failureReasonText(reason);
    return <AgentStatus variant="event" status="failed" text={`Сбой: ${text}`} at={createdAt} hint={hint} />;
  }

  return <AgentStatus variant="event" status={EVENT_STATUS[event]} text={EVENT_TEXT[event]} at={createdAt} />;
}
