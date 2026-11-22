"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronRight, ListTodo } from "lucide-react";
import { useTranslations } from "next-intl";
import type { RunTaskListView, RunTaskStatus, RunTaskView } from "@agent-os/contracts";
import { TaskStatus } from "@/components/agents/agent-status";
import { useShellServices } from "@/components/shell/shell-actions";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useResource, type Resource } from "@/hooks/use-resource";
import { cn } from "@/lib/utils";

/** The summary's order (run-task-list.md, part 1); a status without tasks is left out. */
const SUMMARY_ORDER: readonly RunTaskStatus[] = ["running", "waiting", "done", "failed", "cancelled"];

/** Skeleton rows of the loading state and their widths. */
const SKELETON_ROWS = ["w-11/12", "w-3/4", "w-5/6", "w-2/3", "w-4/5", "w-1/2"];

/**
 * A deep agent's task list (`GET /api/agents/:agentId/tasks`), read on open and again on every `tree` note of
 * its conversation (deep-agents KD-6): new items and statuses show without a reload.
 */
export function useRunTasks(agentId: string, threadId: string): Resource<RunTaskListView> {
  const { apiClient, live } = useShellServices();
  const tasks = useResource(() => apiClient.getRunTasks(agentId), agentId, "agents");
  const { reload } = tasks;
  useEffect(
    () =>
      live.onTree((noted) => {
        if (noted === threadId) reload();
      }),
    [live, threadId, reload],
  );
  return tasks;
}

export type RunTaskListProps = {
  tasks: Resource<RunTaskListView>;
  /** «panel» — the diagram panel, always by the narrow rules; «page» — the deep agent page's tab (run-task-list.md, Anatomy). */
  layout: "page" | "panel";
};

/**
 * The task list, variant «План» (design-system run-task-list.md; deep-agents UXRD DA-05, MC-10–MC-14): only the
 * deep agent's own plan items, each with its number, status and text. Read-only: the agent keeps the list.
 */
export function RunTaskList({ tasks, layout }: RunTaskListProps) {
  const t = useTranslations("agents.tasks");
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  if (tasks.status === "loading") return <TaskListSkeleton />;
  if (tasks.status === "error" || tasks.data === undefined) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-foreground text-sm leading-5">{t("loadError")}</p>
        <Button variant="outline" size="sm" className="pointer-coarse:h-11" onClick={tasks.reload}>
          {t("retry")}
        </Button>
      </div>
    );
  }

  const items = tasks.data.tasks;
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
        <ListTodo aria-hidden className="text-muted-foreground size-6" />
        <h3 className="text-foreground text-base leading-6 font-semibold">{t("emptyTitle")}</h3>
        <p className="text-muted-foreground max-w-xs text-sm leading-5">{t("emptyHint")}</p>
      </div>
    );
  }

  const allExpanded = items.every((task) => expanded.has(task.number));
  const toggle = (number: number): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(number)) next.add(number);
      return next;
    });
  const toggleAll = (): void => setExpanded(allExpanded ? new Set() : new Set(items.map((task) => task.number)));
  // The number column is as wide as the longest number (part 3).
  const numberWidth = `${String(Math.max(...items.map((task) => task.number))).length}ch`;

  return (
    <div className="@container flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-muted-foreground text-xs leading-4 font-medium">{summaryOf(t, items)}</p>
        <Button variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={toggleAll}>
          {t(allExpanded ? "collapseAll" : "expandAll")}
        </Button>
      </div>
      <ul aria-label={t("listLabel")} className="divide-border flex flex-col divide-y">
        {items.map((task) => (
          <TaskRow
            key={task.number}
            task={task}
            layout={layout}
            numberWidth={numberWidth}
            expanded={expanded.has(task.number)}
            onToggle={() => toggle(task.number)}
          />
        ))}
      </ul>
    </div>
  );
}

type TasksTranslator = ReturnType<typeof useTranslations<"agents.tasks">>;

/** «В работе: 2 · Ожидают: 1 · Готовы: 3» — only the statuses some item has (MC-10). */
function summaryOf(t: TasksTranslator, items: readonly RunTaskView[]): string {
  return SUMMARY_ORDER.flatMap((status) => {
    const count = items.filter((task) => task.status === status).length;
    return count === 0 ? [] : [t(`summary.${status}`, { count })];
  }).join(" · ");
}

type TaskRowProps = {
  task: RunTaskView;
  layout: RunTaskListProps["layout"];
  numberWidth: string;
  expanded: boolean;
  onToggle: () => void;
};

/**
 * One row: status icon, number, text truncated at the end and who does it — for a plan item «свой пункт». The
 * whole row is the expand button, so a click anywhere on it and Enter or Space open the details. From 720 px of
 * the page the row is one line; in a narrower area and always in the panel «кто делает» goes under the text.
 */
function TaskRow({ task, layout, numberWidth, expanded, onToggle }: TaskRowProps) {
  const t = useTranslations("agents.tasks");
  const tAgents = useTranslations("agents");
  const detailsId = useId();
  const wide = layout === "page";

  return (
    <li style={{ ["--task-number-width" as string]: numberWidth }}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-label={t("rowButton", { number: task.number, text: task.text, status: tAgents(`taskStatus.${task.status}`) })}
        onClick={onToggle}
        className={cn(
          "hover:bg-accent focus-visible:ring-ring grid w-full grid-cols-[1rem_var(--task-number-width)_minmax(0,1fr)_1.5rem] items-center gap-x-2 px-1 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset pointer-coarse:min-h-11",
          wide && "@[45rem]:grid-cols-[1rem_var(--task-number-width)_minmax(0,1fr)_minmax(0,12.5rem)_1.5rem] @[45rem]:min-h-8",
        )}
      >
        <TaskStatus status={task.status} variant="icon" />
        <span className="text-muted-foreground text-right font-mono text-xs leading-5 tabular-nums">{task.number}</span>
        <span className="text-foreground min-w-0 truncate text-sm leading-5">{task.text}</span>
        <span
          className={cn(
            "text-muted-foreground col-start-3 row-start-2 truncate text-sm leading-5",
            wide && "@[45rem]:col-start-4 @[45rem]:row-start-1",
          )}
        >
          {t("ownItem")}
        </span>
        <span
          className={cn(
            "col-start-4 row-start-1 flex size-6 items-center justify-center justify-self-end",
            wide && "@[45rem]:col-start-5",
          )}
        >
          <ChevronRight
            aria-hidden
            className={cn("text-muted-foreground size-3.5 transition-transform duration-150 motion-reduce:transition-none", expanded && "rotate-90")}
          />
        </span>
      </button>
      <div id={detailsId} hidden={!expanded} className="@container pb-2 pl-[calc(1rem+var(--task-number-width)+1.25rem)]">
        {expanded && <TaskDetails task={task} />}
      </div>
    </li>
  );
}

/** «подпись — значение» like the record definition: the label in a 120 px column from 560 px, above the value below it. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 @[35rem]:grid-cols-[7.5rem_minmax(0,1fr)] @[35rem]:gap-x-4">
      <dt className="text-muted-foreground text-xs leading-4 font-medium @[35rem]:pt-0.5">{label}</dt>
      <dd className="text-foreground min-w-0 text-sm leading-5">{children}</dd>
    </div>
  );
}

/** The details of a plan item: its status, its whole text and who keeps it (variant «План»: no assignee, no result). */
function TaskDetails({ task }: { task: RunTaskView }) {
  const t = useTranslations("agents.tasks.details");
  return (
    <dl className="flex flex-col gap-1">
      <DetailRow label={t("status")}>
        <TaskStatus status={task.status} variant="label" />
      </DetailRow>
      <DetailRow label={t("task")}>
        <span className="break-words whitespace-pre-wrap">{task.text}</span>
      </DetailRow>
      <DetailRow label={t("who")}>{t("ownItem")}</DetailRow>
    </dl>
  );
}

/** Loading: the summary and six 32 px rows of different widths (run-task-list.md, States). */
function TaskListSkeleton() {
  const t = useTranslations("agents.tasks");
  return (
    <div role="status" aria-label={t("loading")} className="flex flex-col gap-2">
      <Skeleton className="h-4 w-1/2 motion-reduce:animate-none" />
      {SKELETON_ROWS.map((width) => (
        <div key={width} className="flex h-8 items-center">
          <Skeleton className={cn("h-4 motion-reduce:animate-none", width)} />
        </div>
      ))}
    </div>
  );
}
