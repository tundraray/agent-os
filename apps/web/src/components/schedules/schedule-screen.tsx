'use client';

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { HistoryIcon, LoaderCircle } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { ScheduleRunView, ScheduleView } from '@agent-os/contracts';
import { FormWarning } from '@/components/admin/admin-form';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import {
  ActionsMenu,
  DataTable,
  resourceTableState,
  type DataTableColumn,
  type DataTableRow,
} from '@/components/admin/data-table';
import { PageHeader } from '@/components/shell/page-header';
import { ShellLink } from '@/components/shell/shell-link';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { StateBadge } from '@/components/state-badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  usePagedResource,
  useResource,
  type PagedResource,
} from '@/hooks/use-resource';
import type { SchedulesTranslator } from '@/i18n/catalog';
import type { Formatter } from '@/i18n/formats';
import { isNotFound } from '@/lib/admin/admin-errors';
import { describeApiError } from '@/lib/api/api-request';
import { focusShellTarget } from '@/lib/focus';
import { logger } from '@/lib/logger';
import { schedulesApi } from '@/lib/schedules/schedules-api';
import { describeSchedulesError } from '@/lib/schedules/schedules-errors';
import { schedulesPath, threadPath } from '@/lib/shell-route';
import { startTimer } from '@/lib/timer';
import { ScheduleDialog } from './schedule-dialog';
import {
  agentName,
  ruleLine,
  RunOutcome,
  ScheduleStateBadge,
  useReloadOnAnyTree,
  zoneLine,
} from './schedule-parts';
import { formatRunTime } from './schedule-rule-field';

/** Rows of the settings skeleton (SH-05, Loading). */
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5] as const;

/** A run still going: pausing does not stop it (MC-9). */
const UNFINISHED = new Set(['working', 'awaiting_confirmation']);

type Action = 'pause' | 'resume' | 'run';

/**
 * The schedule page `/schedules/<id>` (UXRD Screen 3): SH-05 header, actions and settings, SH-06 history. Both are
 * read on open, after every own change and on every `tree` note (design-schedules «Страницы»); a `tree` note leaves
 * the history alone once «Показать ещё» has added a page. Any 404 — a foreign,
 * deleted or missing schedule — is SH-08, which names nothing of the schedule.
 */
export function ScheduleScreen({ id }: { id: string }) {
  const schedule = useResource(() => schedulesApi.get(id), id, 'schedules');
  const runs = usePagedResource(
    (cursor) =>
      schedulesApi
        .runs(id, cursor)
        .then((page) => ({ items: page.runs, nextCursor: page.nextCursor })),
    id,
    'schedules',
  );
  const { reload: reloadSchedule } = schedule;
  const { reload: reloadRuns, loadedMore } = runs;
  const reload = useCallback(() => {
    reloadSchedule();
    reloadRuns();
  }, [reloadSchedule, reloadRuns]);
  // A `tree` note comes often while any conversation runs: it must not drop the pages loaded by «Показать ещё».
  const reloadOnTree = useCallback(() => {
    reloadSchedule();
    if (!loadedMore) reloadRuns();
  }, [reloadSchedule, reloadRuns, loadedMore]);
  useReloadOnAnyTree(reloadOnTree);

  if (isNotFound(schedule.error))
    return <ThreadNotice variant="schedule-not-found" />;
  if (schedule.status === 'error')
    return (
      <ThreadNotice variant="schedule-load-error" onRetry={schedule.reload} />
    );
  if (schedule.data === undefined) return <ScheduleSkeleton />;
  return (
    <SchedulePage schedule={schedule.data} runs={runs} onChanged={reload} />
  );
}

function SchedulePage({
  schedule,
  runs,
  onChanged,
}: {
  schedule: ScheduleView;
  runs: PagedResource<ScheduleRunView>;
  onChanged: () => void;
}) {
  const t = useTranslations('schedules');
  const tErrors = useTranslations('errors');
  const format = useFormatter();
  const router = useRouter();
  const [busy, setBusy] = useState<Action | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const scheduleId = schedule.id;

  // UXRD «Порядок фокуса»: once the schedule is on screen, focus lands on its title.
  useEffect(() => {
    focusShellTarget('page-title');
  }, [scheduleId]);

  const tThread = useTranslations('shell.thread');
  const conversationTitle = titleOf(schedule, tThread('untitled'));
  const conversationGone =
    schedule.pausedBecause === 'conversation_deleted' &&
    schedule.target === 'this_conversation';
  const completed = schedule.state === 'completed';

  /** One action at a time; the page reads the schedule and its history again whatever the answer. */
  async function act<T>(
    action: Action,
    request: () => Promise<T>,
    done: (value: T) => void,
  ): Promise<void> {
    if (busy !== null) return;
    setBusy(action);
    const durationMs = startTimer();
    const fields = () => ({ scheduleId, durationMs: durationMs() });
    try {
      const value = await request();
      logger.info(`schedules: ${action}`, fields());
      done(value);
    } catch (cause) {
      logger.warn(`schedules: ${action} refused`, {
        ...fields(),
        ...describeApiError(cause),
      });
      toast.error(
        describeSchedulesError(tErrors, cause, { where: 'action' }).text,
      );
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  const pause = (): void =>
    void act(
      'pause',
      () => schedulesApi.pause(scheduleId),
      (saved) =>
        toast.success(
          saved.lastRun?.status != null && UNFINISHED.has(saved.lastRun.status)
            ? t('notices.pausedRunning')
            : t('notices.paused'),
        ),
    );
  const resume = (): void =>
    void act(
      'resume',
      () => schedulesApi.resume(scheduleId),
      (saved) =>
        toast.success(
          t('notices.resumed', {
            at:
              saved.nextRunAt === null
                ? '—'
                : formatRunTime(format, saved.nextRunAt, saved.timeZone),
          }),
        ),
    );
  const run = (): void =>
    void act(
      'run',
      () => schedulesApi.run(scheduleId),
      (outcome) => {
        const conversationId = outcome.conversationId;
        if (outcome.outcome === 'started' && conversationId !== null) {
          toast.success(t('notices.started'), {
            action: {
              label: t('notices.openConversation'),
              onClick: () => router.push(threadPath(conversationId)),
            },
          });
          return;
        }
        toast.warning(
          t('notices.notStarted', {
            reason:
              outcome.skipReason === null
                ? '—'
                : t(`skipReason.${outcome.skipReason}`),
          }),
        );
      },
    );

  async function remove(): Promise<void> {
    const durationMs = startTimer();
    const fields = () => ({ scheduleId, durationMs: durationMs() });
    try {
      await schedulesApi.remove(scheduleId);
    } catch (cause) {
      logger.warn('schedules: delete refused', {
        ...fields(),
        ...describeApiError(cause),
      });
      throw cause;
    }
    logger.info('schedules: deleted', fields());
    toast.success(t('notices.deleted'));
    router.push(schedulesPath());
  }

  const editButton = (
    <Button
      variant="outline"
      size="sm"
      className="pointer-coarse:h-11"
      onClick={() => setEditing(true)}
    >
      {t('page.edit')}
    </Button>
  );

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title={schedule.name}
        parent={{ title: t('list.title'), href: schedulesPath() }}
        badge={<ScheduleStateBadge state={schedule.state} />}
      >
        {editButton}
        {!completed && (
          <ActionButton
            busy={busy}
            action={schedule.state === 'paused' ? 'resume' : 'pause'}
            disabled={schedule.state === 'paused' && conversationGone}
            onClick={schedule.state === 'paused' ? resume : pause}
          >
            {schedule.state === 'paused' ? t('page.resume') : t('page.pause')}
          </ActionButton>
        )}
        {!completed && (
          <ActionButton busy={busy} action="run" onClick={run}>
            {t('page.runNow')}
          </ActionButton>
        )}
        <ActionsMenu
          name={schedule.name}
          actions={[
            { label: t('page.delete'), onSelect: () => setDeleting(true) },
          ]}
        />
      </PageHeader>
      <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-6 px-4 py-4 md:py-6">
        {conversationGone && schedule.conversation !== null && (
          <FormWarning>
            <p>{t('page.pausedDeleted', { title: conversationTitle })}</p>
            <div className="mt-2">{editButton}</div>
          </FormWarning>
        )}
        <Settings schedule={schedule} />
        <History schedule={schedule} runs={runs} />
      </div>
      <ScheduleDialog
        mode={{ kind: 'edit', schedule }}
        open={editing}
        onOpenChange={setEditing}
        onSaved={onChanged}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('deleteDialog.title')}
        body={t('deleteDialog.body', { name: schedule.name })}
        confirmLabel={t('deleteDialog.confirm')}
        onConfirm={remove}
        refusalText={(cause) =>
          describeSchedulesError(tErrors, cause, { where: 'action' }).text
        }
      />
    </div>
  );
}

/**
 * An action of the header. While any action runs it is unavailable only to the pointer (`aria-disabled`), so the
 * focused button keeps focus — «Пауза» and «Возобновить» swap in the same button (UXRD «Порядок фокуса»).
 */
function ActionButton({
  busy,
  action,
  disabled = false,
  onClick,
  children,
}: {
  busy: Action | null;
  action: Action;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="pointer-coarse:h-11 aria-disabled:opacity-50"
      disabled={disabled}
      aria-disabled={busy !== null || undefined}
      onClick={busy === null ? onClick : undefined}
    >
      {busy === action && (
        <LoaderCircle
          aria-hidden
          className="animate-spin motion-reduce:animate-none"
        />
      )}
      {children}
    </Button>
  );
}

/** The title of the conversation the schedule was created in; an untitled one reads as the list names it. */
const titleOf = (schedule: ScheduleView, untitled: string): string => {
  const title = schedule.conversation?.title.trim() ?? '';
  return title === '' ? untitled : title;
};

/** SH-05 pairs (MC-8): the label over the value below 640 px, at its left from 640 px. */
function Settings({ schedule }: { schedule: ScheduleView }) {
  const t = useTranslations('schedules');
  const format = useFormatter();
  const tThread = useTranslations('shell.thread');
  const conversation = schedule.conversation;
  const conversationTitle = titleOf(schedule, tThread('untitled'));
  const conversationLink = (chunks: ReactNode) =>
    conversation === null ? (
      chunks
    ) : (
      <ShellLink
        href={threadPath(conversation.id)}
        className="rounded-sm text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {chunks}
      </ShellLink>
    );
  const day = format.dateTime(new Date(schedule.createdAt), {
    day: 'numeric',
    month: 'short',
    timeZone: schedule.timeZone,
  });

  const target =
    schedule.target === 'new_conversation'
      ? t('dialog.newConversation')
      : conversation === null || conversation.deleted
        ? t('dialog.namedConversation', { title: conversationTitle })
        : t.rich('page.replyTo', {
            title: conversationTitle,
            link: conversationLink,
          });
  const created =
    conversation === null
      ? day
      : conversation.deleted
        ? t('page.createdDeleted', { day })
        : t.rich('page.createdIn', {
            day,
            title: conversationTitle,
            link: conversationLink,
          });

  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm leading-5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-y-2">
      <Pair label={t('page.instruction')}>
        <span className="whitespace-pre-wrap wrap-break-word">
          {schedule.instruction}
        </span>
      </Pair>
      <Pair label={t('page.agent')}>
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="wrap-break-word">{agentName(t, schedule)}</span>
          {schedule.agent?.available === false && (
            <StateBadge state="off">{t('page.agentUnavailable')}</StateBadge>
          )}
        </span>
      </Pair>
      <Pair label={t('page.when')}>
        {ruleLine(t, format, schedule.rule)}
        {' · '}
        {zoneLine(t, schedule.timeZone)}
      </Pair>
      <Pair label={t('page.next')}>
        <span className="tabular-nums">
          {schedule.nextRunAt === null
            ? '—'
            : formatRunTime(format, schedule.nextRunAt, schedule.timeZone)}
        </span>
      </Pair>
      <Pair label={t('page.target')}>{target}</Pair>
      <Pair label={t('page.created')}>{created}</Pair>
    </dl>
  );
}

function Pair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-2 text-muted-foreground first:pt-0 sm:pt-0">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  );
}

/** SH-06: the runs, latest term first, 20 at a time; a run's status changes while the page is open, unannounced. */
function History({
  schedule,
  runs,
}: {
  schedule: ScheduleView;
  runs: PagedResource<ScheduleRunView>;
}) {
  const t = useTranslations('schedules');
  const format = useFormatter();
  const headingId = useId();
  const columns: readonly DataTableColumn[] = [
    { header: t('history.columns.time') },
    { header: t('history.columns.outcome'), shrinks: true },
    { header: t('history.columns.conversation') },
  ];
  const state = resourceTableState(
    { ...runs, data: runs.items },
    t('history.loadFailed'),
    (items) => ({
      rows: items.map((run) => runRow(run, schedule.timeZone, t, format)),
      empty: {
        Icon: HistoryIcon,
        title: t('history.emptyTitle'),
        description:
          schedule.nextRunAt === null
            ? undefined
            : t('history.emptyFirst', {
                at: formatRunTime(
                  format,
                  schedule.nextRunAt,
                  schedule.timeZone,
                ),
              }),
      },
      more:
        runs.nextCursor === null
          ? undefined
          : {
              onLoadMore: runs.loadMore,
              loading: runs.loadingMore,
              error:
                runs.loadMoreError === undefined
                  ? undefined
                  : t('history.loadFailed'),
            },
    }),
  );

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-sm leading-5 font-medium">
        {t('history.title')}
      </h2>
      <DataTable
        caption={t('history.title')}
        columns={columns}
        state={state}
        twoLines
      />
    </section>
  );
}

const LINK_CLASS =
  'rounded-sm underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:py-3';

function runRow(
  run: ScheduleRunView,
  timeZone: string,
  t: SchedulesTranslator,
  format: Formatter,
): DataTableRow {
  const at = formatRunTime(format, run.dueAt, timeZone);
  const conversationId = run.conversationId;
  // A skip because the previous run is unfinished links its reason to that run's conversation (UXRD Error Flows).
  const reason =
    run.skipReason === 'previous_run_unfinished' && conversationId !== null
      ? (text: string) => (
          <ShellLink href={threadPath(conversationId)} className={LINK_CLASS}>
            {text}
          </ShellLink>
        )
      : undefined;
  return {
    key: run.id,
    name: at,
    cells: [
      <span key="time" className="tabular-nums">
        {at}
      </span>,
      <span key="outcome" className="inline-flex flex-wrap items-center gap-2">
        <RunOutcome run={run} reason={reason} />
        {run.manual && (
          <StateBadge variant="source">{t('history.manual')}</StateBadge>
        )}
      </span>,
      run.outcome === 'started' && conversationId !== null ? (
        <ShellLink
          key="conversation"
          href={threadPath(conversationId)}
          aria-label={t('history.openLabel', { at })}
          className={LINK_CLASS}
        >
          {t('history.open')}
        </ShellLink>
      ) : (
        ''
      ),
    ],
  };
}

/** SH-05 Loading: the settings pairs and the history table as skeletons. */
function ScheduleSkeleton() {
  return (
    <div
      aria-busy
      className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-6 px-4 py-4 md:py-6"
    >
      <div aria-hidden className="flex flex-col gap-3">
        {SKELETON_ROWS.map((row) => (
          <div key={row} className="flex gap-4">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ))}
      </div>
      <div aria-hidden className="flex flex-col gap-2">
        <Skeleton className="h-4 w-40" />
        {SKELETON_ROWS.map((row) => (
          <Skeleton key={row} className="h-6 w-full" />
        ))}
      </div>
    </div>
  );
}
