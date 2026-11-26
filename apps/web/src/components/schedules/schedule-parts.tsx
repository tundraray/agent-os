'use client';

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type {
  ScheduleRule,
  ScheduleRunView,
  ScheduleState,
  ScheduleView,
} from '@agent-os/contracts';
import { AgentStatus } from '@/components/agents/agent-status';
import { useShellServices } from '@/components/shell/shell-actions';
import { StateBadge, type StateBadgeState } from '@/components/state-badge';
import type { SchedulesTranslator } from '@/i18n/catalog';
import { formats, type Formatter } from '@/i18n/formats';
import { createCoalescedRunner } from '@/lib/live/coalesced-runner';
import { DAYS, formatRunTime, utcOffset } from './schedule-rule-field';

/** The pieces the schedules list (SH-04) and a schedule's page (SH-05, SH-06) show alike. */

/** Re-reads by `tree` notes no more often than once a second, like the sidebar's counter. */
const REREAD_INTERVAL_MS = 1000;

/**
 * design-schedules «Страницы»: while a schedules screen is open it re-reads on every `tree` note of the
 * employee's stream and on every reconnect; a run changes a conversation, and schedules have no event of their own.
 */
export function useReloadOnAnyTree(reload: () => void): void {
  const { live } = useShellServices();
  const reloadRef = useRef(reload);
  useLayoutEffect(() => {
    reloadRef.current = reload;
  });
  useEffect(() => {
    // `reload` only starts reads; it never rejects, so the runner never hands a rejection on.
    const runner = createCoalescedRunner(
      async () => {
        reloadRef.current();
      },
      { minIntervalMs: REREAD_INTERVAL_MS },
    );
    const request = (): void => {
      void runner.request();
    };
    const unsubscribers = [live.onTree(request), live.onReady(request)];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      runner.cancel();
    };
  }, [live]);
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

/** The schedule's agent by name; `null` is the chat agent. Names are shown as written. */
export function agentName(
  t: SchedulesTranslator,
  schedule: Pick<ScheduleView, 'agent'>,
): string {
  return schedule.agent?.name ?? t('dialog.chatAgent');
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

/**
 * A run's outcome: a started run by its agent status (a `starting` row reads as working), a skip by «Пропущен»
 * with its reason. `reason` is where the reason goes — the history links one of them to the unfinished run.
 */
export function RunOutcome({
  run,
  reason,
}: {
  run: ScheduleRunView;
  reason?: (text: string) => ReactNode;
}) {
  const t = useTranslations('schedules');
  if (run.outcome === 'started')
    return <AgentStatus variant="label" status={run.status ?? 'working'} />;
  const text =
    run.skipReason === null ? null : t(`skipReason.${run.skipReason}`);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1">
      <StateBadge state="skipped">{t('history.skipped')}</StateBadge>
      {text !== null && (
        <span className="text-xs leading-4 text-muted-foreground">
          {'— '}
          {reason === undefined ? text : reason(text)}
        </span>
      )}
    </span>
  );
}

/**
 * SH-04 «Последний запуск»: a started run by its status and, under it, its time in the schedule's zone; a skip
 * by «Пропущен» and, under it, the reason.
 */
export function LastRun({
  run,
  timeZone,
}: {
  run: ScheduleRunView | null;
  timeZone: string;
}) {
  const t = useTranslations('schedules');
  const format = useFormatter();
  // Below 768 px the list has no header: the run is one labelled line of the row's details, «—» without a run.
  const label = <span className="md:hidden">{t('list.lastLabel')}</span>;
  if (run === null)
    return <span className="inline-flex items-center gap-x-1">{label}—</span>;
  const started = run.outcome === 'started';
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1 md:flex-col md:flex-nowrap md:items-start">
      {label}
      {started ? (
        <AgentStatus variant="label" status={run.status ?? 'working'} />
      ) : (
        <StateBadge state="skipped">{t('history.skipped')}</StateBadge>
      )}
      <span className="text-xs leading-4 text-muted-foreground tabular-nums">
        {started
          ? formatRunTime(format, run.dueAt, timeZone)
          : run.skipReason === null
            ? null
            : t(`skipReason.${run.skipReason}`)}
      </span>
    </span>
  );
}
