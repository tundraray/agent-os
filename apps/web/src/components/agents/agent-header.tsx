"use client";

import { useEffect, useId, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  ThreadsErrorCodeSchema,
  type AgentStatus as AgentStatusValue,
  type RecordSummary,
  type RunOrigin,
} from "@agent-os/contracts";
import { CircleStopIcon, MoreHorizontalIcon, RotateCcwIcon, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { AgentStatus } from "@/components/agents/agent-status";
import { runRecord, useLiveRecord } from "@/components/agents/run-card";
import { useLeaveThenGo } from "@/components/library/use-in-chat";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { isApiRequestError } from "@/lib/api/api-request";
import { useFeed, useFeedSelector } from "@/lib/feed/feed-context";
import type { FeedStore } from "@/lib/feed/feed-store";
import { selectAgent } from "@/lib/feed/to-feed";
import { focusAfterNewChat, focusShellTarget } from "@/lib/focus";
import { describeLibraryError, kindWord } from "@/lib/library/library-errors";
import { agentPath, recordPath } from "@/lib/shell-route";

/** MC-11 and KD-6: the one control of the header, by status (UXRD Screen 3, «Управление по статусу»). */
type Control = {
  label: string;
  Icon: LucideIcon;
  failure: string;
};

const STOP: Control = {
  label: "Остановить",
  Icon: CircleStopIcon,
  failure: "Не удалось остановить агента. Попробуйте ещё раз.",
};

const RESTART: Control = {
  label: "Запустить с нуля",
  Icon: RotateCcwIcon,
  failure: "Не удалось запустить агента с нуля.",
};

const CONTROL_BY_STATUS: Record<AgentStatusValue, Control> = {
  working: STOP,
  awaiting_confirmation: STOP,
  interrupted: STOP,
  completed: RESTART,
  failed: RESTART,
  stopped: RESTART,
};

/** MC-11: the mobile menu's accessible name. */
const MENU_LABEL = "Действия с агентом";

/**
 * The agent a «Запустить с нуля» opened: its header focuses its `h1` once its page has read it. Module
 * state, not component state: the header of the old agent may unmount before the new one renders.
 */
let focusOnAgent: string | null = null;

/**
 * Runs the header's command: success needs nothing more (the store re-reads); a failure — 409
 * `NOT_FINISHED`, `PARENT_FINISHED` and `START_REFUSED` included — shows its notice and re-reads the real
 * status. The store has already logged the failure with its kind, code and `agentId`.
 */
async function runControl(feed: FeedStore, notify: (error: unknown) => void, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    notify(error);
    await feed.load();
  }
}

/**
 * RN-03, MC-17: what «Запустить с нуля» of a library run says and whether it can go. The new start takes
 * the live version; a record gone from the read list cannot start. An unread list says nothing yet.
 */
function restartHint(
  record: RunOrigin | null,
  live: RecordSummary | null | undefined,
): { text: string; blocked: boolean } | null {
  if (record === null || live === undefined) return null;
  if (live === null) return { text: `${kindWord(record.kind, true)} недоступен — запустить с нуля нельзя`, blocked: true };
  return { text: `Пойдёт на версии ${live.version}`, blocked: false };
}

/**
 * AV-01: the agent page's header content in place of HD-03 — the agent's description as `h1`, the status
 * «Метка» and one control button on the right. The button is a single element that changes its label, so
 * focus stays on it after «Остановить» (UXRD, «Порядок фокуса»). Below 768 px the status lives in the
 * meta line and the control in the «⋯» menu. No optimistic status: the header shows what the store read.
 */
export function AgentHeader() {
  const feed = useFeed();
  if (feed === null) throw new Error("AgentHeader must be used inside AgentFeedProvider");

  const router = useRouter();
  const t = useTranslations("errors");
  const agent = useFeedSelector((state) => selectAgent(state.view), null);
  const loadError = useFeedSelector((state) => state.loadError, null);
  // One command at a time: a second press while the first is in flight does nothing.
  const busy = useRef(false);

  const agentId = agent?.agentId ?? null;
  // UXRD «Порядок фокуса»: an opened agent page takes focus like an opened conversation (composer with a
  // fine pointer, `h1` with a coarse one); the agent a «Запустить с нуля» opened always focuses its `h1`.
  useEffect(() => {
    if (agentId === null) return;
    if (agentId === focusOnAgent) {
      focusOnAgent = null;
      focusShellTarget("page-title");
      return;
    }
    focusAfterNewChat();
  }, [agentId]);

  const control = agent === null ? null : CONTROL_BY_STATUS[agent.status];
  const record = agent === null ? null : runRecord(agent);
  const live = useLiveRecord(record?.recordId ?? "");
  const hint = control === RESTART ? restartHint(record, live) : null;
  const hintId = useId();
  const leaveThenGo = useLeaveThenGo();

  /** KD-6 toast; a refused start (409 `START_REFUSED`) says why by MC-16 and offers the record when it is the model. */
  const notifyFailure = (error: unknown): void => {
    if (
      control === RESTART &&
      record !== null &&
      isApiRequestError(error) &&
      error.code === ThreadsErrorCodeSchema.enum.START_REFUSED
    ) {
      const refused = describeLibraryError(t, error, { where: "restart", kind: record.kind, own: live?.mine === true });
      const open = () => leaveThenGo(() => router.push(recordPath(record.recordId)));
      toast.error(refused.text, refused.open ? { action: { label: "Открыть", onClick: open } } : undefined);
      return;
    }
    if (control !== null) toast.error(control.failure);
  };

  const onControl = (): void => {
    if (control === null || busy.current || hint?.blocked === true) return;
    busy.current = true;
    const run =
      control === STOP
        ? () => feed.stop()
        : async () => {
            const { agentId: nextAgentId } = await feed.restart();
            focusOnAgent = nextAgentId;
            router.push(agentPath(nextAgentId));
          };
    void runControl(feed, notifyFailure, run).finally(() => {
      busy.current = false;
    });
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <h1
        tabIndex={-1}
        data-shell-focus="page-title"
        aria-busy={agent === null && loadError === null ? true : undefined}
        className="min-w-0 shrink truncate px-1 text-sm font-medium outline-none"
      >
        {agent !== null && <span title={agent.description}>{agent.description}</span>}
        {agent === null && loadError === null && <Skeleton aria-hidden className="h-4 w-40" />}
      </h1>
      {agent !== null && <AgentStatus variant="label" status={agent.status} className="hidden md:inline-flex" />}
      {control !== null && (
        <>
          {hint !== null && (
            <span id={hintId} className="sr-only">
              {hint.text}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="ml-auto hidden md:inline-flex pointer-coarse:h-11"
            onClick={onControl}
            disabled={hint?.blocked === true}
            title={hint?.text}
            aria-describedby={hint === null ? undefined : hintId}
          >
            <control.Icon aria-hidden />
            {control.label}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-11 shrink-0 md:hidden [&_svg]:size-4.5"
                  aria-label={MENU_LABEL}
                  aria-haspopup="menu"
                />
              }
            >
              <MoreHorizontalIcon aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-45">
              <DropdownMenuItem
                onClick={onControl}
                disabled={hint?.blocked === true}
                className="pointer-coarse:min-h-11"
              >
                <control.Icon aria-hidden />
                <span className="flex min-w-0 flex-col">
                  {control.label}
                  {/* A touch screen has no tooltip: the menu shows the hint under the label. */}
                  {hint !== null && <span className="text-muted-foreground text-xs leading-4">{hint.text}</span>}
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}
