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
  LastRun,
  ruleLine,
  ScheduleStateBadge,
  useReloadOnAnyTree,
} from './schedule-parts';
import { formatRunTime } from './schedule-rule-field';

/**
 * SH-04 «Расписания»: the employee's schedules in the server's order — active by the next run, then paused, then
 * completed — as link rows, «Две строки» below 768 px. Read on open and again on every `tree` note, so a run's
 * status changes in «Последний запуск» while the page is open.
 */
export function SchedulesScreen() {
  const t = useTranslations('schedules');
  const format = useFormatter();
  const list = useResource(schedulesApi.list, 'schedules', 'schedules');
  useReloadOnAnyTree(list.reload);

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
      schedule.nextRunAt === null
        ? '—'
        : formatRunTime(format, schedule.nextRunAt, schedule.timeZone),
      <LastRun
        key="last"
        run={schedule.lastRun}
        timeZone={schedule.timeZone}
      />,
    ],
  };
}
