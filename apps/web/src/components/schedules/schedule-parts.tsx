'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import type { ScheduleRule, ScheduleState } from '@agent-os/contracts';
import { StateBadge, type StateBadgeState } from '@/components/state-badge';
import type { SchedulesTranslator } from '@/i18n/catalog';
import { formats, type Formatter } from '@/i18n/formats';
import { DAYS, formatRunTime, utcOffset } from './schedule-rule-field';

/** The pieces the schedules list (SH-04) and a schedule's page (SH-05, SH-06) show alike. */

/** How long after a term the screen re-reads: the pass has handled the term by then. */
const AFTER_TERM_MS = 5000;
/** How often a screen whose term is already past re-reads until the pass moves it. */
const OVERDUE_REREAD_MS = 30_000;
/** The longest delay `setTimeout` keeps; a later term is armed again by a later read or reload. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Re-reads shortly after the term `nextRunAt` passes: the pass may change a schedule without touching any
 * conversation (it pauses one whose conversation is deleted, or a send is refused), and then no live change comes.
 * `read` is the value the term came from: each new read arms the timer again from its own term.
 */
export function useReloadAfterTerm(
  nextRunAt: string | null | undefined,
  read: unknown,
  reload: () => void,
): void {
  const reloadRef = useRef(reload);
  useLayoutEffect(() => {
    reloadRef.current = reload;
  });
  useEffect(() => {
    if (nextRunAt == null) return;
    const dueIn = Date.parse(nextRunAt) - Date.now();
    const delay = dueIn > 0 ? dueIn + AFTER_TERM_MS : OVERDUE_REREAD_MS;
    if (delay > MAX_TIMER_MS) return;
    const timer = setTimeout(() => reloadRef.current(), delay);
    return () => clearTimeout(timer);
  }, [nextRunAt, read]);
}

/** A wall-clock `HH:MM` as the interface writes a time: «09:00». */
function wallTime(format: Formatter, time: string): string {
  return format.dateTime(new Date(`1970-01-01T${time}:00Z`), {
    ...formats.dateTime.time,
    timeZone: 'UTC',
  });
}

const WORKDAYS = [1, 2, 3, 4, 5];

/** schedule-rule.md, Content Rules: the rule in one line, its date and time as the schedule's zone has them. */
export function ruleLine(
  t: SchedulesTranslator,
  format: Formatter,
  rule: ScheduleRule,
): string {
  switch (rule.kind) {
    case 'once':
      // The date and time are already the zone's wall clock: read in UTC they are shown unchanged.
      return t('ruleLine.once', {
        at: formatRunTime(format, `${rule.date}T${rule.time}:00Z`, 'UTC'),
      });
    case 'daily':
      return t('ruleLine.daily', { time: wallTime(format, rule.time) });
    case 'weekdays': {
      const time = wallTime(format, rule.time);
      if (rule.days.length === DAYS.length)
        return t('ruleLine.daily', { time });
      if (
        rule.days.length === WORKDAYS.length &&
        WORKDAYS.every((day) => rule.days.includes(day))
      )
        return t('ruleLine.workdays', { time });
      const days = DAYS.filter(([day]) => rule.days.includes(day))
        .map(([, key]) => t(`rule.dayShort.${key}`))
        .join(', ');
      return t('ruleLine.days', { days, time });
    }
    case 'every_hours':
      return t('ruleLine.hours', { count: rule.hours });
  }
}

/** «Europe/Moscow (UTC+3)»: the zone every time of the schedule is shown in. */
export function zoneLine(t: SchedulesTranslator, timeZone: string): string {
  return t('ruleLine.zone', { zone: timeZone, offset: utcOffset(timeZone) });
}

/** state-badge «Состояние»: «Активно» — Хорошо, «На паузе» — Выключено, «Выполнено» — Нейтрально. */
const STATE_LOOK: Record<ScheduleState, StateBadgeState> = {
  active: 'ok',
  paused: 'off',
  completed: 'neutral',
};

export function ScheduleStateBadge({ state }: { state: ScheduleState }) {
  const t = useTranslations('schedules');
  return (
    <StateBadge state={STATE_LOOK[state]}>{t(`state.${state}`)}</StateBadge>
  );
}
