'use client';

import { useRef, useState } from 'react';
import { ClockIcon, LoaderCircle } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { ScheduleToolAction, ScheduleView } from '@agent-os/contracts';
import { useShellServices } from '@/components/shell/shell-actions';
import { Button } from '@/components/ui/button';
import { useResource } from '@/hooks/use-resource';
import { isNotFound } from '@/lib/admin/admin-errors';
import { describeApiError } from '@/lib/api/api-request';
import { logger } from '@/lib/logger';
import { schedulesApi } from '@/lib/schedules/schedules-api';
import { describeSchedulesError } from '@/lib/schedules/schedules-errors';
import { startTimer } from '@/lib/timer';
import { cn } from 'cn';
import { ScheduleDialog } from './schedule-dialog';
import { ruleLine, zoneLine } from './schedule-parts';

export type ScheduleCardProps = {
  /** The schedule of the call: the first line of its result, `Schedule <id>: <name>`. */
  scheduleId: string;
  name: string;
  /** The call's `args.action`: the result word of a pause or a resume; a delete reads nothing. */
  action: ScheduleToolAction;
  /** The result's second line is `SCHEDULE_ACCESS_DROPPED_LINE`: the change took full access away. */
  accessDropped: boolean;
};

/** The result word that starts the line (MC-1); a create and a change have none. */
const RESULT_WORD: Partial<Record<ScheduleToolAction, 'paused' | 'resumed'>> = {
  pause: 'paused',
  resume: 'resumed',
};

/**
 * CS-01, CS-02 (schedule-card.md): the card under a successful `manage_schedule` call. It shows the schedule as it
 * is now — read on show, read again by «Открыть», replaced by what the dialog saved (chat-scheduling KD-2); from the
 * call it takes only the result word and the note about dropped full access. A 404 reads as «Расписание удалено».
 */
export function ScheduleCard({
  scheduleId,
  name,
  action,
  accessDropped,
}: ScheduleCardProps) {
  const t = useTranslations('schedules');
  const tErrors = useTranslations('errors');
  const format = useFormatter();
  const { announcer } = useShellServices();
  const deletedByCall = action === 'delete';
  const read = useResource(
    // The delete card reads nothing: the schedule is gone (CS-02).
    () =>
      deletedByCall ? Promise.resolve(null) : schedulesApi.get(scheduleId),
    scheduleId,
    'schedules',
  );
  /** The schedule read by «Открыть» or saved by the dialog: newer than the read on show. */
  const [latest, setLatest] = useState<ScheduleView | null>(null);
  const [goneOnOpen, setGoneOnOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [editing, setEditing] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);

  const schedule = latest ?? read.data ?? null;
  const deleted = deletedByCall || goneOnOpen || isNotFound(read.error);
  const shownName = deleted || schedule === null ? name : schedule.name;
  const word = RESULT_WORD[action];
  const line =
    schedule === null
      ? null
      : [
          ...(word === undefined ? [] : [t(`card.${word}`)]),
          ruleLine(t, format, schedule.rule),
          zoneLine(t, schedule.timeZone),
          t(`dialog.access.${schedule.access}`),
        ].join(' · ');
  const deletedId = `schedule-card-${scheduleId}-deleted`;

  async function open(): Promise<void> {
    if (deleted || opening) return;
    setOpening(true);
    const durationMs = startTimer();
    try {
      const fresh = await schedulesApi.get(scheduleId);
      logger.info('schedules: card opened', {
        scheduleId,
        action,
        durationMs: durationMs(),
      });
      setLatest(fresh);
      setEditing(true);
    } catch (cause) {
      logger.warn('schedules: card open refused', {
        scheduleId,
        action,
        durationMs: durationMs(),
        ...describeApiError(cause),
      });
      if (isNotFound(cause)) {
        setGoneOnOpen(true);
        announcer.getState().announce('schedules.card.deleted');
      } else
        toast.error(
          describeSchedulesError(tErrors, cause, { where: 'action' }).text,
        );
    } finally {
      setOpening(false);
    }
  }

  return (
    <div
      role="group"
      aria-label={t('card.group', { name: shownName })}
      className="my-1 flex w-full items-start gap-2 rounded-lg border border-border bg-card p-3"
    >
      <ClockIcon
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            'text-sm leading-5 font-medium wrap-break-word',
            deleted ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {shownName}
        </span>
        {deleted ? (
          <span
            id={deletedId}
            className="text-xs leading-4 text-muted-foreground"
          >
            {t('card.deleted')}
          </span>
        ) : (
          <>
            {line !== null && (
              <span className="text-xs leading-4 wrap-break-word text-muted-foreground">
                {line}
              </span>
            )}
            {accessDropped && (
              <span className="text-sm leading-5 text-foreground">
                {t('card.accessDropped')}
              </span>
            )}
          </>
        )}
      </div>
      <Button
        ref={openRef}
        variant="outline"
        size="sm"
        className="shrink-0 pointer-coarse:h-11 aria-disabled:opacity-50"
        aria-label={t('card.openLabel', { name: shownName })}
        aria-disabled={deleted || opening || undefined}
        aria-describedby={deleted ? deletedId : undefined}
        onClick={() => void open()}
      >
        {opening && (
          <LoaderCircle
            aria-hidden
            className="animate-spin motion-reduce:animate-none"
          />
        )}
        {t('card.open')}
      </Button>
      {latest !== null && (
        <ScheduleDialog
          mode={{ kind: 'edit', schedule: latest }}
          open={editing}
          onOpenChange={setEditing}
          onSaved={setLatest}
          finalFocus={openRef}
        />
      )}
    </div>
  );
}
