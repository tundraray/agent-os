'use client';

import { useEffect, useId, useState } from 'react';
import { ArrowUpRight, ChevronRight, ListTodo } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type {
  AgentTasksView,
  DelegationStatus,
  DelegationView,
  SessionTaskView,
} from '@agent-os/contracts';
import {
  DelegationStatusGlyph,
  TaskStatusGlyph,
} from '@/components/agents/agent-status';
import { useShellServices } from '@/components/shell/shell-actions';
import { ShellLink } from '@/components/shell/shell-link';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useResource, type Resource } from '@/hooks/use-resource';
import { agentPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';

/** Skeleton rows of the loading state and their widths. */
const SKELETON_ROWS = ['w-11/12', 'w-3/4', 'w-5/6', 'w-2/3', 'w-4/5', 'w-1/2'];

/** The list of a session that has none yet: a conversation before its root is known. */
const NO_TASKS: AgentTasksView = { tasks: [], delegations: [] };

/** The summary's order of statuses (run-task-list.md, part 5). */
const SUMMARY_ORDER: readonly DelegationStatus[] = [
  'running',
  'completed',
  'failed',
  'cancelled',
];

/** The widest subagent column (run-task-list.md, part 6: «до 160 px»). */
const SUBAGENT_COLUMN_MAX = '10rem';

/**
 * A session's tasks and delegations (`GET /api/agents/:agentId/tasks`), read on open and again on every `tree` note
 * of its conversation (deep-agents design-task-list.md, KD-5): new rows and statuses show without a reload. A null
 * `agentId` — the session is not known yet — reads as an empty list without a request.
 */
export function useAgentTasks(
  agentId: string | null,
  threadId: string | null,
): Resource<AgentTasksView> {
  const { apiClient, live } = useShellServices();
  const tasks = useResource(
    () =>
      agentId === null
        ? Promise.resolve(NO_TASKS)
        : apiClient.getAgentTasks(agentId),
    agentId ?? '',
    'agents',
  );
  const { reload } = tasks;
  useEffect(
    () =>
      live.onTree((noted) => {
        if (agentId !== null && noted === threadId) reload();
      }),
    [live, agentId, threadId, reload],
  );
  return tasks;
}

/**
 * «panel» — the diagram panel: the conversation's tasks only, always by the narrow rules (run-task-list.md,
 * Anatomy); «page» — the deep agent page's tab: its tasks and, under them, its delegations (deep-agents UXRD DA-05,
 * DA-09). `awaitingAgents` — the subagents waiting for a decision, from the agent tree: the route's row lacks it.
 */
export type SessionTaskListProps = { tasks: Resource<AgentTasksView> } & (
  { layout: 'panel' } | { layout: 'page'; awaitingAgents: ReadonlySet<string> }
);

/**
 * The task list (design-system run-task-list.md; deep-agents UXRD KD-4, KD-8, MC-10–MC-14): variant «Задачи» — one
 * session's tasks by number, each with its status, subject and owner, the description on expand; on the page,
 * variant «Поручения» under it. Read-only: the agent keeps the list, the employee asks the chat to change it.
 */
export function SessionTaskList(props: SessionTaskListProps) {
  const { tasks } = props;
  const t = useTranslations('agents.tasks');

  if (tasks.status === 'loading') return <TaskListSkeleton />;
  if (tasks.status === 'error' || tasks.data === undefined) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-foreground text-sm leading-5">{t('loadError')}</p>
        <Button
          variant="outline"
          size="sm"
          className="pointer-coarse:h-11"
          onClick={tasks.reload}
        >
          {t('retry')}
        </Button>
      </div>
    );
  }

  const items = tasks.data.tasks;
  const delegations = props.layout === 'page' ? tasks.data.delegations : [];
  if (items.length === 0 && delegations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
        <ListTodo aria-hidden className="text-muted-foreground size-6" />
        <h3 className="text-foreground text-base leading-6 font-semibold">
          {t('emptyTitle')}
        </h3>
        <p className="text-muted-foreground max-w-xs text-sm leading-5">
          {t('emptyHint')}
        </p>
      </div>
    );
  }

  const wide = props.layout === 'page';
  return (
    <div className="@container flex flex-col">
      {items.length > 0 && <TaskRows items={items} wide={wide} />}
      {props.layout === 'page' && delegations.length > 0 && (
        <DelegationSection
          delegations={delegations}
          awaitingAgents={props.awaitingAgents}
        />
      )}
    </div>
  );
}

/** Variant «Задачи», parts 1–3: the rows by number, each opening its description. */
function TaskRows({
  items,
  wide,
}: {
  items: readonly SessionTaskView[];
  wide: boolean;
}) {
  const t = useTranslations('agents.tasks');
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const toggle = (id: number): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // The number column is as wide as the longest number (part 1).
  const numberWidth = `${String(Math.max(...items.map((task) => task.id))).length}ch`;
  const completed = new Set(
    items.filter((task) => task.status === 'completed').map((task) => task.id),
  );

  return (
    <ul
      aria-label={t('listLabel')}
      className="divide-border flex flex-col divide-y"
      style={{ ['--task-number-width' as string]: numberWidth }}
    >
      {items.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          waitsFor={task.blockedBy.filter((id) => !completed.has(id))}
          wide={wide}
          expanded={expanded.has(task.id)}
          onToggle={() => toggle(task.id)}
        />
      ))}
    </ul>
  );
}

type TaskRowProps = {
  task: SessionTaskView;
  /** The blockers not completed yet: «ждёт {номера}». */
  waitsFor: readonly number[];
  /** The page from 560 px puts the owner on the first line; the panel and a narrower page — on the second. */
  wide: boolean;
  expanded: boolean;
  onToggle: () => void;
};

/**
 * One task (run-task-list.md, parts 1–3): status icon, number, subject and owner, then the status in words with
 * the in-progress text or the tasks it waits for. The whole row is the expand button, so a click anywhere on it
 * and Enter or Space open the description.
 */
function TaskRow({ task, waitsFor, wide, expanded, onToggle }: TaskRowProps) {
  const t = useTranslations('agents.tasks');
  const tAgents = useTranslations('agents');
  const descriptionId = useId();
  const status = tAgents(`taskStatus.${task.status}`);
  const details = [
    status,
    ...(task.status === 'in_progress' && task.activeForm !== null
      ? [task.activeForm]
      : []),
    ...(waitsFor.length > 0
      ? [t('waitsFor', { numbers: waitsFor.join(', ') })]
      : []),
  ];

  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={descriptionId}
        aria-label={t('rowButton', {
          number: task.id,
          subject: task.subject,
          status,
        })}
        onClick={onToggle}
        className={cn(
          'hover:bg-accent focus-visible:ring-ring grid w-full grid-cols-[1rem_var(--task-number-width)_minmax(0,1fr)_1.5rem] items-center gap-x-2 px-1 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset pointer-coarse:min-h-11',
          wide &&
            '@[35rem]:grid-cols-[1rem_var(--task-number-width)_minmax(0,1fr)_fit-content(12.5rem)_1.5rem]',
        )}
      >
        <TaskStatusGlyph status={task.status} />
        <span className="text-muted-foreground text-right font-mono text-xs leading-5 tabular-nums">
          {task.id}
        </span>
        <span
          className={cn(
            'min-w-0 truncate text-sm leading-5',
            task.status === 'completed'
              ? 'text-muted-foreground'
              : 'text-foreground',
          )}
        >
          {task.subject}
        </span>
        {wide && task.owner !== null && (
          <span className="text-muted-foreground hidden min-w-0 truncate text-sm leading-5 @[35rem]:col-start-4 @[35rem]:row-start-1 @[35rem]:block">
            {task.owner}
          </span>
        )}
        <span
          className={cn(
            'col-start-4 row-start-1 flex size-6 items-center justify-center justify-self-end',
            wide && '@[35rem]:col-start-5',
          )}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              'text-muted-foreground size-3.5 transition-transform duration-150 motion-reduce:transition-none',
              expanded && 'rotate-90',
            )}
          />
        </span>
        <span
          className={cn(
            'text-muted-foreground col-start-3 row-start-2 min-w-0 text-xs leading-5',
            wide && '@[35rem]:col-end-5',
            expanded ? 'wrap-break-word' : 'truncate',
          )}
        >
          {task.owner !== null && (
            <span
              className={cn(wide && '@[35rem]:hidden')}
            >{`${task.owner} · `}</span>
          )}
          {details.join(' · ')}
        </span>
      </button>
      <div
        id={descriptionId}
        hidden={!expanded}
        className="text-foreground pr-1 pb-2 pl-[calc(1rem+var(--task-number-width)+1.25rem)] text-sm leading-5 wrap-break-word whitespace-pre-wrap"
      >
        {expanded && task.description}
      </div>
    </li>
  );
}

type DelegationSectionProps = {
  delegations: readonly DelegationView[];
  awaitingAgents: ReadonlySet<string>;
};

/**
 * Variant «Поручения», parts 4–7 (deep-agents UXRD DA-09): the heading with the count, the summary of non-zero
 * statuses, then one row per subagent or list item in the route's order.
 */
function DelegationSection({
  delegations,
  awaitingAgents,
}: DelegationSectionProps) {
  const t = useTranslations('agents.delegations');
  const summary = SUMMARY_ORDER.map((status) => ({
    status,
    count: delegations.filter((delegation) => delegation.status === status)
      .length,
  }))
    .filter(({ count }) => count > 0)
    .map(({ status, count }) => t(`summary.${status}`, { count }))
    .join(' · ');
  // The subagent column is as wide as the longest name, up to 160 px (part 6).
  const longestName = Math.max(
    ...delegations.map((delegation) => delegation.subagent.length),
  );
  const subagentWidth = `min(${SUBAGENT_COLUMN_MAX}, ${longestName + 1}ch)`;

  return (
    <section className="flex flex-col pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-1 pb-1">
        <h3 className="text-foreground text-base leading-6 font-semibold">
          {t('title', { count: delegations.length })}
        </h3>
        <p className="text-muted-foreground text-xs leading-5">{summary}</p>
      </div>
      <ul
        aria-label={t('listLabel')}
        className="divide-border flex flex-col divide-y"
        style={{ ['--subagent-width' as string]: subagentWidth }}
      >
        {delegations.map((delegation, index) => (
          <DelegationRow
            // A delegation has no id of its own: the route's order is stable, and a subagent runs one item.
            key={`${delegation.agentId}-${index}`}
            delegation={delegation}
            awaiting={
              delegation.status === 'running' &&
              awaitingAgents.has(delegation.agentId)
            }
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * One delegation (run-task-list.md, parts 6–7): status icon, subagent, item and «задача {N}», then the status in
 * words with the start of the answer or the failure's reason. The whole row links to the subagent's page; under
 * 560 px «задача {N}» opens the second line.
 */
function DelegationRow({
  delegation,
  awaiting,
}: {
  delegation: DelegationView;
  awaiting: boolean;
}) {
  const t = useTranslations('agents.delegations');
  const tAgents = useTranslations('agents');
  const status = awaiting
    ? tAgents('status.awaiting_confirmation')
    : tAgents(`delegationStatus.${delegation.status}`);
  const outcome =
    delegation.status === 'completed'
      ? delegation.answer
      : delegation.status === 'failed'
        ? delegation.reason
        : null;
  const taskLabel =
    delegation.taskId === null
      ? null
      : t('task', { number: delegation.taskId });

  return (
    <li>
      <ShellLink
        href={agentPath(delegation.agentId)}
        aria-label={t('rowLabel', {
          subagent: delegation.subagent,
          item: delegation.item,
          status,
        })}
        className="hover:bg-accent focus-visible:ring-ring grid w-full grid-cols-[1rem_var(--subagent-width)_minmax(0,1fr)_1.5rem] items-center gap-x-2 px-1 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset pointer-coarse:min-h-11 @[35rem]:grid-cols-[1rem_var(--subagent-width)_minmax(0,1fr)_fit-content(8rem)_1.5rem]"
      >
        <DelegationStatusGlyph status={delegation.status} awaiting={awaiting} />
        <span className="text-foreground min-w-0 truncate text-sm leading-5 font-medium">
          {delegation.subagent}
        </span>
        <span className="text-foreground min-w-0 truncate text-sm leading-5">
          {delegation.item}
        </span>
        {taskLabel !== null && (
          <span className="text-muted-foreground hidden text-xs leading-5 whitespace-nowrap @[35rem]:col-start-4 @[35rem]:row-start-1 @[35rem]:block">
            {taskLabel}
          </span>
        )}
        <span className="col-start-4 row-start-1 flex size-6 items-center justify-center justify-self-end @[35rem]:col-start-5">
          <ArrowUpRight
            aria-hidden
            className="text-muted-foreground size-3.5"
          />
        </span>
        <span
          className={cn(
            'text-muted-foreground col-start-3 row-start-2 min-w-0 text-xs leading-5 @[35rem]:col-end-5',
            delegation.status === 'completed'
              ? 'line-clamp-2 wrap-break-word'
              : 'truncate',
          )}
        >
          {taskLabel !== null && (
            <span className="@[35rem]:hidden">{`${taskLabel} · `}</span>
          )}
          {outcome === null ? status : `${status} · ${outcome}`}
        </span>
      </ShellLink>
    </li>
  );
}

/** Loading: six 32 px rows of different widths (run-task-list.md, States). */
function TaskListSkeleton() {
  const t = useTranslations('agents.tasks');
  return (
    <div role="status" aria-label={t('loading')} className="flex flex-col">
      {SKELETON_ROWS.map((width) => (
        <div key={width} className="flex h-8 items-center">
          <Skeleton className={cn('h-4 motion-reduce:animate-none', width)} />
        </div>
      ))}
    </div>
  );
}
