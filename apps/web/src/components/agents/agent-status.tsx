"use client";

import { useState, type ReactNode } from "react";
import type { AgentStatus as AgentStatusValue } from "@agent-os/contracts";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CirclePauseIcon,
  CircleStopIcon,
  CircleXIcon,
  HandIcon,
  LoaderCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AGENT_STATUS_LABEL, formatTime } from "@/lib/agents/format";
import { cn } from "@/lib/utils";

/** One turn of a working icon (foundations, Motion: «вращение 1 с на оборот»). */
const SPIN_PERIOD_MS = 1000;
/** Hover time before the «Иконка» variant shows its label (agent-status.md, States). */
const ICON_HINT_DELAY_MS = 500;

type StatusLook = { Icon: LucideIcon; tone: string };

/** Icons and colour roles (agent-status.md, States); the MC-3 labels are `AGENT_STATUS_LABEL`. */
const STATUS_LOOK: Record<AgentStatusValue, StatusLook> = {
  working: { Icon: LoaderCircleIcon, tone: "text-info" },
  awaiting_confirmation: { Icon: HandIcon, tone: "text-approval" },
  interrupted: { Icon: CirclePauseIcon, tone: "text-muted-foreground" },
  completed: { Icon: CircleCheckIcon, tone: "text-success" },
  failed: { Icon: CircleXIcon, tone: "text-destructive" },
  stopped: { Icon: CircleStopIcon, tone: "text-muted-foreground" },
};

/** The icon and colour role of a status, for blocks that show the same state (a running or waiting tool call). */
export function agentStatusGlyph(status: AgentStatusValue): StatusLook {
  return STATUS_LOOK[status];
}

/**
 * Starts every spinner at the phase the page clock is in, so all working icons on screen turn together
 * whenever each of them mounted. A ref callback, not a style prop: the server has another clock.
 */
function alignSpinPhase(element: SVGSVGElement | null): void {
  if (element === null) return;
  element.style.animationDelay = `-${Math.round(performance.now() % SPIN_PERIOD_MS)}ms`;
}

/**
 * The status icon in its fixed 16 px slot. Spinning icons share one phase; under reduced motion a static
 * `CircleDashed` replaces the spin. Exported for the tool-call block, which spins the same way.
 */
export function StatusGlyph({ Icon, spinning }: { Icon: LucideIcon; spinning: boolean }) {
  if (!spinning) return <Icon aria-hidden className="size-3.5" />;
  return (
    <>
      <Icon
        aria-hidden
        ref={alignSpinPhase}
        className="size-3.5 animate-spin motion-reduce:hidden"
      />
      <CircleDashedIcon aria-hidden className="hidden size-3.5 motion-reduce:block" />
    </>
  );
}

/**
 * Cross-fades the slot content when the key changes after mount (150 ms, foundations: «Смена статуса»);
 * the first render does not fade, and reduced motion swaps at once.
 */
export function FadeSlot({ swapKey, className, children }: { swapKey: string; className?: string; children: ReactNode }) {
  const [shown, setShown] = useState({ key: swapKey, changed: false });
  if (shown.key !== swapKey) setShown({ key: swapKey, changed: true });
  return (
    <span
      key={swapKey}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center",
        shown.changed && "animate-in fade-in-0 duration-(--duration-fast) motion-reduce:animate-none",
        className,
      )}
    >
      {children}
    </span>
  );
}

type AgentStatusBaseProps = { status: AgentStatusValue; className?: string };

export type AgentStatusProps =
  | (AgentStatusBaseProps & { variant: "label" })
  | (AgentStatusBaseProps & { variant: "icon" })
  | (AgentStatusBaseProps & {
      variant: "event";
      /** The MC-14 event text, without the time. */
      text: string;
      /** ISO time of the event. */
      at: string;
      /** A failure code the text does not name (KD-6): shown as the line's hint. */
      hint?: string | null;
    });

/**
 * The agent status of agent-status.md: «Метка» (icon and label), «Иконка» (icon only, label as the
 * accessible name and a delayed hint) and «Строка события» (icon, event text and time). Every variant has
 * a fixed height, so a status change never moves its neighbours.
 */
export function AgentStatus(props: AgentStatusProps) {
  const { status, className } = props;
  const { Icon, tone } = STATUS_LOOK[status];
  const label = AGENT_STATUS_LABEL[status];
  const glyph = (
    <FadeSlot swapKey={status} className={cn(tone, "transition-colors duration-(--duration-fast) motion-reduce:transition-none")}>
      <StatusGlyph Icon={Icon} spinning={status === "working"} />
    </FadeSlot>
  );

  if (props.variant === "icon") {
    return (
      <Tooltip>
        <TooltipTrigger
          delay={ICON_HINT_DELAY_MS}
          render={
            <span
              role="img"
              aria-label={label}
              data-slot="agent-status"
              data-status={status}
              className={cn("inline-flex h-5 items-center", className)}
            />
          }
        >
          {glyph}
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );
  }

  if (props.variant === "label") {
    return (
      <span
        data-slot="agent-status"
        data-status={status}
        className={cn("inline-flex h-5 items-center gap-1 text-xs leading-4 whitespace-nowrap", className)}
      >
        {glyph}
        <span className={cn(tone, "transition-colors duration-(--duration-fast) motion-reduce:transition-none")}>
          {label}
        </span>
      </span>
    );
  }

  return (
    <p
      data-slot="agent-status-event"
      data-status={status}
      title={props.hint ?? undefined}
      className={cn("text-muted-foreground flex h-5 min-w-0 items-center gap-1 text-xs leading-4", className)}
    >
      {glyph}
      <span className="min-w-0 truncate">{props.text}</span>
      <span aria-hidden className="shrink-0">
        ·
      </span>
      <time dateTime={props.at} className="shrink-0 tabular-nums">
        {formatTime(props.at)}
      </time>
    </p>
  );
}
