"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { AgentStatus as AgentStatusValue } from "@agent-os/contracts";
import { CircleStopIcon, MoreHorizontalIcon, RotateCcwIcon, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { AgentStatus } from "@/components/agents/agent-status";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useFeed, useFeedSelector } from "@/lib/feed/feed-context";
import type { FeedStore } from "@/lib/feed/feed-store";
import type { FeedView } from "@/lib/feed/to-feed";
import { focusShellTarget } from "@/lib/focus";
import { agentPath } from "@/lib/shell-route";

type AgentView = Extract<FeedView, { kind: "agent" }>["agent"];

const selectAgent = (view: FeedView | null): AgentView | null => (view?.kind === "agent" ? view.agent : null);

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
 * `NOT_FINISHED` and `PARENT_FINISHED` included — shows the KD-6 toast and re-reads the real status.
 * The store has already logged the failure with its kind, code and `agentId`.
 */
async function runControl(feed: FeedStore, control: Control, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch {
    toast.error(control.failure);
    await feed.refresh();
  }
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
  const agent = useFeedSelector((state) => selectAgent(state.view), null);
  const loadError = useFeedSelector((state) => state.loadError, null);
  // One command at a time: a second press while the first is in flight does nothing.
  const busy = useRef(false);

  const agentId = agent?.agentId ?? null;
  useEffect(() => {
    if (agentId === null || agentId !== focusOnAgent) return;
    focusOnAgent = null;
    focusShellTarget("page-title");
  }, [agentId]);

  const control = agent === null ? null : CONTROL_BY_STATUS[agent.status];

  const onControl = (): void => {
    if (control === null || busy.current) return;
    busy.current = true;
    const run =
      control === STOP
        ? () => feed.stop()
        : async () => {
            const { agentId: nextAgentId } = await feed.restart();
            focusOnAgent = nextAgentId;
            router.push(agentPath(nextAgentId));
          };
    void runControl(feed, control, run).finally(() => {
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
          <Button
            variant="outline"
            size="sm"
            className="ml-auto hidden md:inline-flex pointer-coarse:h-11"
            onClick={onControl}
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
              <DropdownMenuItem onClick={onControl} className="pointer-coarse:min-h-11">
                <control.Icon aria-hidden />
                {control.label}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}
