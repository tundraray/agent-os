'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { Button } from '@/components/ui/button';
import { useReloadOnAnyChange } from '@/hooks/use-reload-on-any-change';
import { useResource } from '@/hooks/use-resource';
import type { SchedulesTranslator } from '@/i18n/catalog';
import type { Formatter } from '@/i18n/formats';
import { focusShellTarget } from '@/lib/focus';
import { schedulesApi } from '@/lib/schedules/schedules-api';
import { schedulePath, threadPath } from '@/lib/shell-route';
import { ruleLine, useReloadAfterTerm } from './schedule-parts';
import { ScheduleDialog } from './schedule-dialog';
import { formatRunTime } from './schedule-rule-field';

/**
 * SH-04 «Расписания» (chat-scheduling SP-01, SP-03): the employee's schedules in the server's order — active by the
 * next run, then paused, then completed. A row is the name and one line, the same at every width; it opens the
 * schedule's conversation, and «Подробнее» its page. Read on open, on every live change and shortly after the
 * nearest next term, so a new trigger or a pause the pass made shows while the page is open.
 */
export function SchedulesScreen() {
  const t = useTranslations('schedules');
  const format = useFormatter();
  const router = useRouter();
  const list = useResource(schedulesApi.list, 'schedules', 'schedules');
  const [creating, setCreating] = useState(false);
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
    { header: t('list.columns.schedule') },
  ];
  const state = resourceTableState(list, t('list.loadFailed'), (data) => ({
    rows: data.schedules.map((schedule) => ({
      ...rowOf(schedule, t, format),
      actions: [
        {
          label: t('list.details'),
          onSelect: () => router.push(schedulePath(schedule.id)),
        },
      ],
    })),
    empty: {
      Icon: ClockIcon,
      title: t('list.emptyTitle'),
      description: t('list.emptyHint'),
    },
  }));

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title={t('list.title')}>
        <Button
          size="sm"
          className="w-full pointer-coarse:h-11 md:w-auto"
          onClick={() => setCreating(true)}
        >
          {t('list.create')}
        </Button>
      </PageHeader>
      <div className="mx-auto w-full max-w-(--thread-max-width) px-4 py-4 md:py-6">
        <DataTable caption={t('list.title')} columns={columns} state={state} />
      </div>
      <ScheduleDialog
        mode={{ kind: 'create' }}
        open={creating}
        onOpenChange={setCreating}
        onSaved={list.reload}
      />
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

/**
 * SP-03: where a row leads — the schedule's conversation, else the last run's (a «новая беседа» schedule), else the
 * schedule's page when there is no conversation yet or it is deleted (AC-09.3 – AC-09.5).
 */
function rowHref(schedule: ScheduleView): string {
  if (schedule.conversation !== null && !schedule.conversation.deleted)
    return threadPath(schedule.conversation.id);
  const lastConversation = schedule.lastRun?.conversationId ?? null;
  return lastConversation === null
    ? schedulePath(schedule.id)
    : threadPath(lastConversation);
}

/** MC-3: «{следующее срабатывание или состояние} · {правило} · {доступ}», the time in the schedule's zone. */
function rowOf(
  schedule: ScheduleView,
  t: SchedulesTranslator,
  format: Formatter,
): Omit<DataTableRow, 'actions'> {
  const when =
    schedule.state === 'active' && schedule.nextRunAt !== null
      ? formatRunTime(format, schedule.nextRunAt, schedule.timeZone)
      : t(`state.${schedule.state}`);
  const line = [
    when,
    ruleLine(t, format, schedule.rule),
    t(`dialog.access.${schedule.access}`),
  ].join(' · ');
  return {
    key: schedule.id,
    name: schedule.name,
    href: rowHref(schedule),
    cells: [
      // The table's cells do not wrap; this one does, so the access level at the line's end stays in view at 360 px.
      <span
        key="schedule"
        className="flex min-w-0 flex-col py-1 whitespace-normal"
      >
        <span className="wrap-break-word">{schedule.name}</span>
        {/* The link reads «{название}, {вторая строка}» (UXRD Accessibility, SP-03). */}
        <span className="sr-only">, </span>
        <span className="text-xs leading-4 wrap-break-word text-muted-foreground">
          {line}
        </span>
      </span>,
    ],
  };
}
