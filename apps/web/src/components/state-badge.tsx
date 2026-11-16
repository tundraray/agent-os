import { CircleCheck, KeyRound, type LucideIcon } from "lucide-react";
import { cn } from "cn";

/** States of the «Состояние» variant (design-system state-badge): `ok` «Хорошо», `action` «Нужно действие». */
export type StateBadgeState = "ok" | "action";

const STATES: Record<StateBadgeState, { icon: LucideIcon; className: string }> = {
  ok: { icon: CircleCheck, className: "text-success" },
  action: { icon: KeyRound, className: "text-warning" },
};

/** A short, non-interactive state label next to a record; the icon is decorative, the word carries the state. */
export function StateBadge({ state, children }: { state: StateBadgeState; children: string }) {
  const { icon: Icon, className } = STATES[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs leading-4 font-medium transition-colors duration-150 motion-reduce:transition-none",
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {children}
    </span>
  );
}
