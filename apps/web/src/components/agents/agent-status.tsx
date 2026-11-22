"use client";

import { useState, type ReactNode } from "react";
import type { AgentStatus as AgentStatusValue, DelegationStatus, SessionTaskStatus } from "@agent-os/contracts";
import { useFormatter, useTranslations } from "next-intl";
import {
  CircleCheckIcon,
  CircleIcon,
  CircleDashedIcon,
  CirclePauseIcon,
  CircleStopIcon,
  CircleXIcon,
  HandIcon,
  LoaderCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatListTime } from "@/lib/i18n/formats";
import { cn } from "@/lib/utils";

/** One turn of a working icon (foundations, Motion: «вращение 1 с на оборот»). */
const SPIN_PERIOD_MS = 1000;
/** Hover time before the «Иконка» variant shows its label (agent-status.md, States). */
const ICON_HINT_DELAY_MS = 500;

type StatusLook = { Icon: LucideIcon; tone: string };

/** Icons and colour roles (agent-status.md, States); the MC-3 labels are `agents.status.{status}`. */
const STATUS_LOOK: Record<AgentStatusValue, StatusLook> = {
  working: { Icon: LoaderCircleIcon, tone: "text-info" },
  awaiting_confirmation: { Icon: HandIcon, tone: "text-approval" },
  interrupted: { Icon: CirclePauseIcon, tone: "text-muted-foreground" },
  completed: { Icon: CircleCheckIcon, tone: "text-success" },
  failed: { Icon: CircleXIcon, tone: "text-destructive" },
  stopped: { Icon: CircleStopIcon, tone: "text-muted-foreground" },
};

/** Task statuses take the agent statuses' icons and colours (agent-status.md, «Статусы задачи»); MC-11 labels — `agents.taskStatus.{status}`. */
const TASK_STATUS_LOOK: Record<SessionTaskStatus, StatusLook> = {
  pending: { Icon: CircleIcon, tone: "text-muted-foreground" },
  in_progress: STATUS_LOOK.working,
  completed: STATUS_LOOK.completed,
};

/** Delegation statuses (agent-status.md, «Статусы поручения»); MC-11 labels — `agents.delegationStatus.{status}`. */
const DELEGATION_STATUS_LOOK: Record<DelegationStatus, StatusLook> = {
  running: STATUS_LOOK.working,
  completed: STATUS_LOOK.completed,
  failed: STATUS_LOOK.failed,
  cancelled: STATUS_LOOK.stopped,
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
 * The agent status of agent-status.md: «Метка», «Иконка» and «Строка события» (icon, event text and time);
 * only a long event text wraps.
 */
export function AgentStatus(props: AgentStatusProps) {
  const { status, className } = props;
  const format = useFormatter();
  const t = useTranslations("agents");
  const look = STATUS_LOOK[status];
  const label = t(`status.${status}`);

  if (props.variant !== "event") {
    return (
      <StatusView variant={props.variant} look={look} label={label} status={status} spinning={status === "working"} className={className} />
    );
  }

  return (
    <p
      data-slot="agent-status-event"
      data-status={status}
      title={props.hint ?? undefined}
      className={cn("text-muted-foreground flex min-h-5 min-w-0 items-start gap-1 py-0.5 text-xs leading-4", className)}
    >
      <ToneGlyph look={look} status={status} spinning={status === "working"} />
      {/* The status text is never truncated: a long source wraps to a second line (foundations, «Длина текста»). */}
      <span className="min-w-0 wrap-break-word">{props.text}</span>
      <span aria-hidden className="shrink-0">
        ·
      </span>
      <time dateTime={props.at} className="shrink-0 tabular-nums">
        {formatListTime(format, props.at)}
      </time>
    </p>
  );
}

/**
 * A task's status icon (agent-status.md, «Статусы задачи»): decorative, because the task row says its status in
 * words (run-task-list.md, Accessibility); the MC-11 words are `agents.taskStatus.{status}`.
 */
export function TaskStatusGlyph({ status }: { status: SessionTaskStatus }) {
  return <ToneGlyph look={TASK_STATUS_LOOK[status]} status={status} spinning={status === "in_progress"} />;
}

/**
 * A delegation's status icon (agent-status.md, «Статусы поручения»), decorative like the task's. A running
 * delegation whose subagent waits for a decision shows the agent's «Ждёт подтверждения» instead.
 */
export function DelegationStatusGlyph({ status, awaiting }: { status: DelegationStatus; awaiting: boolean }) {
  if (awaiting) return <ToneGlyph look={STATUS_LOOK.awaiting_confirmation} status="awaiting_confirmation" spinning={false} />;
  return <ToneGlyph look={DELEGATION_STATUS_LOOK[status]} status={status} spinning={status === "running"} />;
}

const toneTransition = "transition-colors duration-(--duration-fast) motion-reduce:transition-none";

function ToneGlyph({ look, status, spinning }: { look: StatusLook; status: string; spinning: boolean }) {
  return (
    <FadeSlot swapKey={status} className={cn(look.tone, toneTransition)}>
      <StatusGlyph Icon={look.Icon} spinning={spinning} />
    </FadeSlot>
  );
}

type StatusViewProps = {
  variant: "label" | "icon";
  look: StatusLook;
  label: string;
  status: string;
  spinning: boolean;
  className?: string;
};

/**
 * «Метка» (icon and label) and «Иконка» (icon only, label as the accessible name and a delayed hint). A status
 * change never changes the height, so it never moves its neighbours.
 */
function StatusView({ variant, look, label, status, spinning, className }: StatusViewProps) {
  const glyph = <ToneGlyph look={look} status={status} spinning={spinning} />;

  if (variant === "icon") {
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

  return (
    <span
      data-slot="agent-status"
      data-status={status}
      className={cn("inline-flex h-5 items-center gap-1 text-xs leading-4 whitespace-nowrap", className)}
    >
      {glyph}
      <span className={cn(look.tone, toneTransition)}>{label}</span>
    </span>
  );
}
