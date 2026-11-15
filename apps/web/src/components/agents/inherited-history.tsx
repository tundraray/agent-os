"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { HistoryEntry } from "@agent-os/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useShellServices } from "@/components/shell/shell-actions";
import { inheritedHistoryCaption } from "@/lib/agents/format";
import { logger } from "@/lib/logger";
import type { ThreadsApiClient } from "@/lib/threads/threads-api-client";
import { describeThreadsError } from "@/lib/threads/threads-api-error";
import { cn } from "@/lib/utils";

/** A message of the parent's history as the block shows it. */
type InheritedMessage = { seq: number; side: "sent" | "answer"; caption: string | null; text: string };

type Read = { status: "loading" } | { status: "ready"; messages: InheritedMessage[] } | { status: "failed" };

/**
 * The entries that read as messages: what was sent to the parent and what it answered. Tool calls,
 * events and model-only entries stay out, as in the feed (design-web.md, «Что сотрудник видит»).
 */
function toMessage(entry: HistoryEntry): InheritedMessage | null {
  switch (entry.kind) {
    case "task":
      return { seq: entry.seq, side: "sent", caption: "Задание", text: entry.content.text };
    case "user_message":
    case "agent_message":
      return { seq: entry.seq, side: "sent", caption: null, text: entry.content.text };
    case "model_answer":
      return entry.content.text.trim() === ""
        ? null
        : { seq: entry.seq, side: "answer", caption: null, text: entry.content.text };
    case "child_report":
      return { seq: entry.seq, side: "answer", caption: "Отчёт", text: entry.content.text ?? entry.content.description };
    default:
      return null;
  }
}

/** Every page of the inherited history: a full page names where the next one starts. */
async function readInherited(api: ThreadsApiClient, agentId: string): Promise<InheritedMessage[]> {
  const messages: InheritedMessage[] = [];
  let afterSeq: number | null = 0;
  while (afterSeq !== null) {
    const page = await api.getInherited(agentId, afterSeq);
    for (const entry of page.entries) {
      const message = toMessage(entry);
      if (message !== null) messages.push(message);
    }
    afterSeq = page.nextAfterSeq;
  }
  return messages;
}

/**
 * AV-05: a fork's page opens with the parent's history before the fork, collapsed (MC-9). The history is
 * read once, when the block appears, so its caption carries the count; a failed read leaves the block
 * collapsed with the caption without a count (design-web.md, Flow 3).
 */
export function InheritedHistory({ agentId }: { agentId: string }) {
  const { apiClient } = useShellServices();
  const [read, setRead] = useState<Read>({ status: "loading" });
  const [open, setOpen] = useState(false);
  const panelId = useId();
  // A remount under StrictMode keeps the ref: the history is still read once.
  const requested = useRef<string | null>(null);

  useEffect(() => {
    if (requested.current === agentId) return;
    requested.current = agentId;
    readInherited(apiClient, agentId).then(
      (messages) => setRead({ status: "ready", messages }),
      (error: unknown) => {
        logger.warn("inherited history read failed", { ...describeThreadsError(error), agentId });
        setRead({ status: "failed" });
      },
    );
  }, [apiClient, agentId]);

  if (read.status !== "ready") {
    return (
      <p data-slot="inherited-history" className="text-muted-foreground flex h-8 items-center gap-1 text-xs leading-4 font-medium">
        <ChevronRightIcon aria-hidden className="size-3.5" />
        {inheritedHistoryCaption(null)}
      </p>
    );
  }

  return (
    <div data-slot="inherited-history" className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-8 items-center gap-1 self-start rounded-md text-xs leading-4 font-medium outline-none focus-visible:ring-2 pointer-coarse:h-11"
      >
        <ChevronRightIcon aria-hidden className={cn("size-3.5", open && "rotate-90")} />
        {inheritedHistoryCaption(read.messages.length)}
      </button>
      {open && (
        <ol
          id={panelId}
          className="border-border mt-2 flex flex-col gap-3 border-s ps-3 text-sm leading-relaxed"
        >
          {read.messages.map((message) => (
            <li
              key={message.seq}
              className={cn("flex min-w-0 flex-col gap-1", message.side === "sent" && "items-end")}
            >
              {message.caption !== null && (
                <span className="text-muted-foreground text-xs leading-4 font-medium">{message.caption}</span>
              )}
              <p
                className={cn(
                  "text-foreground whitespace-pre-wrap wrap-break-word",
                  message.side === "sent" && "bg-muted max-w-[85%] rounded-(--composer-radius) px-4 py-2",
                )}
              >
                {message.text}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
