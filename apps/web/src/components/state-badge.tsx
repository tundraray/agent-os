import {
  Ban,
  Circle,
  CircleArrowDown,
  CircleCheck,
  CircleMinus,
  CircleX,
  Info,
  KeyRound,
  type LucideIcon,
} from 'lucide-react';
import { cn } from 'cn';

/**
 * States of the «Состояние» variant (design-system state-badge): `ok` «Хорошо», `action` «Нужно действие»,
 * `closed` «Закрыто», `off` «Выключено», `neutral` «Нейтрально», `worse` «Хуже», `info` «Сведения»,
 * `failed` «Не прошло».
 */
export type StateBadgeState =
  'ok' | 'action' | 'closed' | 'off' | 'neutral' | 'worse' | 'info' | 'failed';

const STATES: Record<StateBadgeState, { icon: LucideIcon; className: string }> =
  {
    ok: { icon: CircleCheck, className: 'text-success' },
    action: { icon: KeyRound, className: 'text-warning' },
    closed: { icon: Ban, className: 'text-destructive' },
    off: { icon: CircleMinus, className: 'text-muted-foreground' },
    neutral: { icon: Circle, className: 'text-muted-foreground' },
    worse: { icon: CircleArrowDown, className: 'text-warning' },
    info: { icon: Info, className: 'text-info' },
    failed: { icon: CircleX, className: 'text-destructive' },
  };

export type StateBadgeProps = { children: string } & (
  | { state: StateBadgeState; variant?: 'state' }
  /** «Источник»: where a record came from or who sees it (локальная, только вы, пишет ответ) — a bordered word without an icon. */
  | { variant: 'source'; state?: never }
);

/** A short, non-interactive label next to a record; the icon is decorative, the word carries the state. */
export function StateBadge(props: StateBadgeProps) {
  if (props.variant === 'source') {
    return (
      <span className="inline-flex items-center rounded-sm border border-border px-1.5 py-0.5 text-xs leading-4 font-medium text-muted-foreground">
        {props.children}
      </span>
    );
  }
  const { icon: Icon, className } = STATES[props.state];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs leading-4 font-medium transition-colors duration-150 motion-reduce:transition-none',
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {props.children}
    </span>
  );
}
