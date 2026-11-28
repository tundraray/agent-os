'use client';

import {
  useEffect,
  useId,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ListChecksIcon, LoaderCircle, PlusIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  THREAD_TITLE_MAX_LENGTH,
  type TrackerTaskStatus,
  type TrackerTaskSummary,
} from '@agent-os/contracts';
import { CAPTION } from '@/components/admin/admin-form';
import { LoadError } from '@/components/admin/data-table';
import { ConversationStateLabel } from '@/components/agents/agent-status';
import { PageHeader } from '@/components/shell/page-header';
import { useShellServices } from '@/components/shell/shell-actions';
import { ShellLink } from '@/components/shell/shell-link';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useReloadOnAnyChange } from '@/hooks/use-reload-on-any-change';
import { useResource } from '@/hooks/use-resource';
import { formatListTime } from '@/i18n/formats';
import { describeApiError } from '@/lib/api/api-request';
import { focusShellTarget } from '@/lib/focus';
import { logger } from '@/lib/logger';
import { trackerTaskPath } from '@/lib/shell-route';
import { startTimer } from '@/lib/timer';
import { trackerApi } from '@/lib/tracker/tracker-api';
import { describeTrackerError } from '@/lib/tracker/tracker-errors';
import { cn } from '@/lib/utils';
import { groupOpenTasks } from './task-groups';
import {
  TRACKER_STATUSES,
  TrackerStatusGlyph,
  TrackerStatusIcon,
} from './tracker-status';

/** The filter's value: «Открытые» or one status (UXRD TT-02). */
type Filter = 'open' | TrackerTaskStatus;

const SKELETON_WIDTHS = ['w-3/5', 'w-2/5', 'w-1/2', 'w-3/4', 'w-1/3', 'w-2/3'];

/**
 * TT-02 – TT-04 «Задачи»: the employee's tasks, the open ones by group, one status alone when the filter names it.
 * The filter lives while the page is open, so a return shows «Открытые» (KD-3). Read on open, after a new task and
 * on any conversation's state, row or deletion (KD-2): an agent's report changes a task through its conversation.
 */
export function TasksScreen() {
  const t = useTranslations('tracker');
  const [filter, setFilter] = useState<Filter>('open');
  const list = useResource(
    () => trackerApi.list(filter === 'open' ? null : filter),
    `tracker:${filter}`,
    'tracker',
  );
  useReloadOnAnyChange(list.reload);

  // UXRD «Порядок фокуса»: after the move to the page, and after a task was deleted, focus lands on its h1.
  useEffect(() => {
    focusShellTarget('page-title');
  }, []);

  /** DC-W1: a new task shows in «К выполнению» of «Открытые»; another filter switches there and reads with it. */
  const onCreated = (): void => {
    if (filter === 'open') list.reload();
    else setFilter('open');
  };

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title={t('list.title')}>
        <FilterSelect value={filter} onChange={setFilter} />
      </PageHeader>
      <div className="@container mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-4 md:py-6">
        <NewTaskField onCreated={onCreated} />
        {list.status === 'error' ? (
          <LoadError message={t('list.loadFailed')} onRetry={list.reload} />
        ) : list.data === undefined ? (
          <ListSkeleton />
        ) : (
          <TaskList filter={filter} tasks={list.data.tasks} />
        )}
      </div>
    </div>
  );
}

/** TT-02: «Показать» — «Открытые», then the six statuses with their icons. */
function FilterSelect({
  value,
  onChange,
}: {
  value: Filter;
  onChange: (filter: Filter) => void;
}) {
  const t = useTranslations('tracker');
  const items: { value: Filter; label: string }[] = [
    { value: 'open', label: t('list.open') },
    ...TRACKER_STATUSES.map((status) => ({
      value: status,
      label: t(`status.${status}`),
    })),
  ];
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const picked = items.find((item) => item.value === next);
        if (picked !== undefined) onChange(picked.value);
      }}
      items={items}
    >
      <SelectTrigger
        size="sm"
        aria-label={t('list.filter')}
        className="w-full pointer-coarse:h-11 md:w-48"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem
            key={item.value}
            value={item.value}
            className="pointer-coarse:min-h-11"
          >
            {item.value === 'open' ? (
              <ListChecksIcon aria-hidden className="text-muted-foreground" />
            ) : (
              <TrackerStatusGlyph status={item.value} />
            )}
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * TT-04: Enter creates a task with the typed title; an empty field creates nothing, Esc clears it. While the
 * request runs the field is read-only, not disabled, so focus stays in it; a refusal keeps the text.
 */
function NewTaskField({ onCreated }: { onCreated: () => void }) {
  const t = useTranslations('tracker.list');
  const tErrors = useTranslations('errors');
  const { announcer } = useShellServices();
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  const errorId = useId();

  async function create(): Promise<void> {
    const trimmed = title.trim();
    if (creating || trimmed === '') return;
    setCreating(true);
    setError(null);
    const durationMs = startTimer();
    try {
      const task = await trackerApi.create({ title: trimmed, description: '' });
      logger.info('tracker: task created', {
        taskId: task.id,
        durationMs: durationMs(),
      });
      setTitle('');
      announcer
        .getState()
        .announce('tracker.list.created', { title: task.title });
      onCreated();
    } catch (cause) {
      logger.warn('tracker: create refused', {
        durationMs: durationMs(),
        ...describeApiError(cause),
      });
      setError(describeTrackerError(tErrors, cause, { where: 'create' }).text);
    } finally {
      setCreating(false);
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setTitle('');
      setError(null);
      return;
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void create();
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="relative flex items-center">
        <PlusIcon
          aria-hidden
          className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground"
        />
        <Input
          aria-label={t('newTask')}
          placeholder={t('newTask')}
          maxLength={THREAD_TITLE_MAX_LENGTH}
          value={title}
          readOnly={creating}
          aria-busy={creating || undefined}
          aria-invalid={error !== null || undefined}
          aria-describedby={error === null ? undefined : errorId}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-9 pr-9 pl-8 pointer-coarse:h-11"
        />
        {creating && (
          <LoaderCircle
            aria-hidden
            className="absolute right-2.5 size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
          />
        )}
      </div>
      {error !== null && (
        <p id={errorId} className={cn(CAPTION, 'text-destructive')}>
          {error}
        </p>
      )}
    </div>
  );
}

/** TT-03, tracker-list.md: «По группам» for «Открытые», «Один статус» for a status, or the empty state. */
function TaskList({
  filter,
  tasks,
}: {
  filter: Filter;
  tasks: readonly TrackerTaskSummary[];
}) {
  const t = useTranslations('tracker');
  if (tasks.length === 0)
    return filter === 'open' ? (
      <EmptyList
        title={t('list.emptyOpenTitle')}
        hint={t('list.emptyOpenHint')}
      />
    ) : (
      <EmptyList
        title={t('list.emptyStatus', { status: t(`status.${filter}`) })}
      />
    );
  if (filter !== 'open')
    return <TaskRows label={t(`status.${filter}`)} tasks={tasks} />;
  return (
    <div className="flex flex-col gap-4">
      {groupOpenTasks(tasks).map((group) => (
        <section key={group.status} className="flex flex-col gap-1">
          <h2 className="text-xs leading-4 font-medium text-muted-foreground tabular-nums">
            {t('list.group', {
              status: t(`status.${group.status}`),
              count: group.tasks.length,
            })}
          </h2>
          <TaskRows tasks={group.tasks} />
        </section>
      ))}
    </div>
  );
}

function TaskRows({
  label,
  tasks,
}: {
  /** The list's name when no group heading names it. */
  label?: string;
  tasks: readonly TrackerTaskSummary[];
}) {
  return (
    <ul aria-label={label} className="flex flex-col">
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </ul>
  );
}

/**
 * One row: status, title, the conversations' state, the time of the last change. From 768 px of the list's width
 * in columns, below in two lines («Узкий»). The link's name is «{название}, {статус}, {состояние}, изменена {время}»,
 * told in hidden text; the visible parts are decorative.
 */
function TaskRow({ task }: { task: TrackerTaskSummary }) {
  const t = useTranslations('tracker');
  const tThread = useTranslations('shell.thread');
  const format = useFormatter();
  const time = formatListTime(format, task.updatedAt);
  const statusLabel = t(`status.${task.status}`);
  const closed = task.status === 'done' || task.status === 'cancelled';
  const stateLabel =
    task.state === null ? null : tThread(`state.${task.state}`);
  const narrowLine = [statusLabel, stateLabel, time]
    .filter((part) => part !== null)
    .join(' · ');

  return (
    <li className="border-b border-border">
      <ShellLink
        href={trackerTaskPath(task.id)}
        className="flex min-h-13 items-center gap-2 rounded-sm px-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @3xl:min-h-9 pointer-coarse:@3xl:min-h-11"
      >
        <span className="sr-only">
          {task.title}, {statusLabel}
          {task.state !== null && tThread(`stateMark.${task.state}`)}
          {t('list.changed', { time })}
        </span>
        <TrackerStatusIcon status={task.status} />
        <span aria-hidden className="flex min-w-0 flex-1 flex-col">
          <span
            title={task.title}
            className={cn(
              'truncate text-sm leading-5',
              closed ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {task.title}
          </span>
          <span className="truncate text-xs leading-4 text-muted-foreground @3xl:hidden">
            {narrowLine}
          </span>
        </span>
        <span className="hidden w-32 shrink-0 @3xl:flex">
          {task.state !== null && stateLabel !== null && (
            <ConversationStateLabel state={task.state} label={stateLabel} />
          )}
        </span>
        <span
          aria-hidden
          className="hidden w-24 shrink-0 text-right text-xs leading-4 text-muted-foreground tabular-nums @3xl:block"
        >
          {time}
        </span>
      </ShellLink>
    </li>
  );
}

/** tracker-list.md «Empty»: the icon, the line and the hint at the centre of the area. */
function EmptyList({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 py-12 text-center">
      <ListChecksIcon
        aria-hidden
        className="mb-2 size-6 text-muted-foreground"
      />
      <p className="text-sm leading-5 text-foreground">{title}</p>
      {hint !== undefined && (
        <p className="text-xs leading-4 text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/** tracker-list.md «Loading»: a heading skeleton and six rows of different widths. */
function ListSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-2">
      <Skeleton aria-hidden className="h-3 w-32" />
      {SKELETON_WIDTHS.map((width) => (
        <Skeleton key={width} aria-hidden className={cn('h-5', width)} />
      ))}
    </div>
  );
}
