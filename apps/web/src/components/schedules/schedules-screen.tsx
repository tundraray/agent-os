'use client';

import { useEffect } from 'react';
import { ClockIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import type { ScheduleView } from '@agent-os/contracts';
import {
  DataTable,
  resourceTableState,
  type DataTableColumn,
  type DataTableRow,
} from '@/components/admin/data-table';
import { PageHeader } from '@/components/shell/page-header';
import { useResource } from '@/hooks/use-resource';
import type { SchedulesTranslator } from '@/i18n/catalog';
import type { Formatter } from '@/i18n/formats';
import { focusShellTarget } from '@/lib/focus';
import { schedulesApi } from '@/lib/schedules/schedules-api';
import { schedulePath } from '@/lib/shell-route';
import {
  agentName,
  ruleLine,
  ScheduleStateBadge,
  useReloadAfterTerm,
  useReloadOnAnyChange,
} from './schedule-parts';
import { formatRunTime } from './schedule-rule-field';

/**
 * SH-04 «Расписания»: the employee's schedules in the server's order — active by the next run, then paused, then
 * completed — as link rows, «Две строки» below 768 px. Read on open, on every live change and shortly after the
 * nearest next term, so a new trigger or a pause the pass made shows while the page is open.
 */
export function SchedulesScreen() {
  const t = useTranslations('schedules');
  const format = useFormatter();
  const list = useResource(schedulesApi.list, 'schedules', 'schedules');
  useReloadOnAnyChange(list.reload);
  useReloadAfterTerm(
    earliestTerm(list.data?.schedules),
    list.data,
    list.reload,
  );

  // UXRD «Порядок фокуса»: after the move to the page, and after a schedule was deleted, focus lands on its h1.
  useEffect(() => {
    focusShellTarget('page-title');
  }, []);

  const columns: readonly DataTableColumn[] = [
    { header: t('list.columns.schedule'), shrinks: true },
    { header: t('list.columns.state') },
    { header: t('list.columns.next') },
    { header: t('list.columns.last') },
  ];
  const state = resourceTableState(list, t('list.loadFailed'), (data) => ({
    rows: data.schedules.map((schedule) => rowOf(schedule, t, format)),
    empty: {
      Icon: ClockIcon,
      title: t('list.emptyTitle'),
      description: t('list.emptyHint'),
    },
  }));

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title={t('list.title')} />
      <div className="mx-auto w-full max-w-(--thread-max-width) px-4 py-4 md:py-6">
        <DataTable
          caption={t('list.title')}
          columns={columns}
          state={state}
          twoLines
        />
      </div>
    </div>
  );
}

/** The nearest next term among the shown schedules; `undefined` when none has one. */
function earliestTerm(
  schedules: readonly ScheduleView[] | undefined,
): string | undefined {
  const terms = (schedules ?? []).flatMap((schedule) =>
    schedule.nextRunAt === null ? [] : [schedule.nextRunAt],
  );
  return terms.length === 0
    ? undefined
    : terms.reduce((earliest, term) =>
        Date.parse(term) < Date.parse(earliest) ? term : earliest,
      );
}

function rowOf(
  schedule: ScheduleView,
  t: SchedulesTranslator,
  format: Formatter,
): DataTableRow {
  const details = [
    ruleLine(t, format, schedule.rule),
    schedule.timeZone,
    agentName(t, schedule),
  ].join(' · ');
  const at = (time: string | null | undefined): string =>
    time == null ? '—' : formatRunTime(format, time, schedule.timeZone);
  return {
    key: schedule.id,
    name: schedule.name,
    href: schedulePath(schedule.id),
    cells: [
      <span key="schedule" className="flex min-w-0 flex-col py-1">
        <span className="truncate" title={schedule.name}>
          {schedule.name}
        </span>
        <span
          className="truncate text-xs leading-4 text-muted-foreground"
          title={details}
        >
          {details}
        </span>
      </span>,
      <ScheduleStateBadge key="state" state={schedule.state} />,
      <Labelled key="next" label={t('list.nextLabel')}>
        {at(schedule.nextRunAt)}
      </Labelled>,
      <Labelled key="last" label={t('list.lastLabel')}>
        {at(schedule.lastRun?.dueAt)}
      </Labelled>,
    ],
  };
}

/** Below 768 px the list has no header, so a time carries its column's label there. */
function Labelled({ label, children }: { label: string; children: string }) {
  return (
    <span className="tabular-nums">
      <span className="md:hidden">{label} </span>
      {children}
    </span>
  );
}
