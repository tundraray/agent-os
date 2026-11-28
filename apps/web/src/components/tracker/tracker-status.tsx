'use client';

import {
  ChartPieIcon,
  ChevronDownIcon,
  LoaderCircleIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleIcon,
  CircleSlashIcon,
  ContrastIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  TrackerTaskStatusSchema,
  type TrackerTaskStatus,
} from '@agent-os/contracts';
import { FadeSlot } from '@/components/agents/agent-status';
import { buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** The statuses from the start of the work to its end: the order of the menu and of the list's filter. */
export const TRACKER_STATUSES = TrackerTaskStatusSchema.options;

/** Hover time before the «Иконка» variant shows its label (tracker-status.md, States). */
const ICON_HINT_DELAY_MS = 500;

type StatusLook = { Icon: LucideIcon; tone: string };

/**
 * tracker-status.md, States: one circle per status, told apart by its fill or sign. The icon set has no circle
 * filled by a half or by three quarters: «В работе» takes `Contrast`, «На проверке» the pie with a quarter out.
 */
const STATUS_LOOK: Record<TrackerTaskStatus, StatusLook> = {
  todo: { Icon: CircleIcon, tone: 'text-muted-foreground' },
  in_progress: { Icon: ContrastIcon, tone: 'text-info' },
  in_review: { Icon: ChartPieIcon, tone: 'text-success' },
  needs_decision: { Icon: CircleHelpIcon, tone: 'text-approval' },
  done: { Icon: CircleCheckIcon, tone: 'text-success' },
  cancelled: { Icon: CircleSlashIcon, tone: 'text-muted-foreground' },
};

const toneTransition =
  'transition-colors duration-(--duration-fast) motion-reduce:transition-none';

/** The status's icon in its fixed slot, cross-fading on a change; decorative. */
export function TrackerStatusGlyph({ status }: { status: TrackerTaskStatus }) {
  const { Icon, tone } = STATUS_LOOK[status];
  return (
    <FadeSlot swapKey={status} className={cn(tone, toneTransition)}>
      <Icon aria-hidden className="size-3.5" />
    </FadeSlot>
  );
}

/**
 * Variant «Иконка» (a row of the tracker's list): the icon alone, its label as the delayed hover hint. Decorative:
 * the row's link says the status in its name.
 */
export function TrackerStatusIcon({ status }: { status: TrackerTaskStatus }) {
  const t = useTranslations('tracker.status');
  return (
    <Tooltip>
      <TooltipTrigger
        delay={ICON_HINT_DELAY_MS}
        render={
          <span aria-hidden className="inline-flex h-5 shrink-0 items-center" />
        }
      >
        <TrackerStatusGlyph status={status} />
      </TooltipTrigger>
      <TooltipContent>{t(status)}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Variant «Выбор» (the task's header): a `ghost` `sm` menu button «Статус: {метка}» with the six statuses as
 * radio items. `saving` — the new status stands on the button, the chevron turns into a spinner and the button is
 * unavailable. Picking the current status does nothing.
 */
export function TrackerStatusSelect({
  status,
  saving,
  onSelect,
}: {
  status: TrackerTaskStatus;
  saving: boolean;
  onSelect: (status: TrackerTaskStatus) => void;
}) {
  const t = useTranslations('tracker');
  const label = t(`status.${status}`);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={saving}
        aria-label={t('task.statusButton', { status: label })}
        className={buttonVariants({
          variant: 'ghost',
          size: 'sm',
          className: cn(
            'shrink-0 pointer-coarse:h-11',
            STATUS_LOOK[status].tone,
          ),
        })}
      >
        <TrackerStatusGlyph status={status} />
        <span>{label}</span>
        {saving ? (
          <LoaderCircleIcon
            aria-hidden
            className="animate-spin text-muted-foreground motion-reduce:animate-none"
          />
        ) : (
          <ChevronDownIcon aria-hidden className="text-muted-foreground" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-48">
        <DropdownMenuRadioGroup
          value={status}
          onValueChange={(next) => {
            const picked = TRACKER_STATUSES.find((value) => value === next);
            if (picked !== undefined && picked !== status) onSelect(picked);
          }}
        >
          {TRACKER_STATUSES.map((value) => (
            <DropdownMenuRadioItem
              key={value}
              value={value}
              className="pointer-coarse:min-h-11"
            >
              <TrackerStatusGlyph status={value} />
              {t(`status.${value}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
