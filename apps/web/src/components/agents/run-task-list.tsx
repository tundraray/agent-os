"use client";

import { useEffect, useId, useState } from "react";
import { ChevronRight, ListTodo } from "lucide-react";
import { useTranslations } from "next-intl";
import type { RunTaskListView, RunTaskView } from "@agent-os/contracts";
import { TaskStatusGlyph } from "@/components/agents/agent-status";
import { useShellServices } from "@/components/shell/shell-actions";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useResource, type Resource } from "@/hooks/use-resource";
import { cn } from "@/lib/utils";

/** Skeleton rows of the loading state and their widths. */
const SKELETON_ROWS = ["w-11/12", "w-3/4", "w-5/6", "w-2/3", "w-4/5", "w-1/2"];

/** The list of a session that has none yet: a conversation before its root is known. */
const NO_TASKS: RunTaskListView = { tasks: [] };

/**
 * A session's task list (`GET /api/agents/:agentId/tasks`), read on open and again on every `tree` note of its
 * conversation (deep-agents design-task-list.md, KD-5): new tasks and statuses show without a reload. A null
 * `agentId` — the session is not known yet — reads as an empty list without a request.
 */
export function useRunTasks(agentId: string | null, threadId: string | null): Resource<RunTaskListView> {
  const { apiClient, live } = useShellServices();
  const tasks = useResource(
    () => (agentId === null ? Promise.resolve(NO_TASKS) : apiClient.getRunTasks(agentId)),
    agentId ?? "",
    "agents",
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

export type RunTaskListProps = {
  tasks: Resource<RunTaskListView>;
  /** «panel» — the diagram panel, always by the narrow rules; «page» — the deep agent page's tab (run-task-list.md, Anatomy). */
  layout: "page" | "panel";
};

/**
 * The task list, variant «Задачи» (design-system run-task-list.md; deep-agents UXRD KD-4, MC-11, MC-12, MC-14):
 * one session's tasks by number, each with its status, subject and owner, the description on expand. Read-only:
 * the agent keeps the list, the employee asks the chat to change it.
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

  const toggle = (id: number): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // The number column is as wide as the longest number (part 1).
  const numberWidth = `${String(Math.max(...items.map((task) => task.id))).length}ch`;
  const completed = new Set(items.filter((task) => task.status === "completed").map((task) => task.id));

  return (
    <ul
      aria-label={t("listLabel")}
      className="@container divide-border flex flex-col divide-y"
      style={{ ["--task-number-width" as string]: numberWidth }}
    >
      {items.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          waitsFor={task.blockedBy.filter((id) => !completed.has(id))}
          wide={layout === "page"}
          expanded={expanded.has(task.id)}
          onToggle={() => toggle(task.id)}
        />
      ))}
    </ul>
  );
}

type TaskRowProps = {
  task: RunTaskView;
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
  const t = useTranslations("agents.tasks");
  const tAgents = useTranslations("agents");
  const descriptionId = useId();
  const status = tAgents(`taskStatus.${task.status}`);
  const details = [
    status,
    ...(task.status === "in_progress" && task.activeForm !== null ? [task.activeForm] : []),
    ...(waitsFor.length > 0 ? [t("waitsFor", { numbers: waitsFor.join(", ") })] : []),
  ];

  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={descriptionId}
        aria-label={t("rowButton", { number: task.id, subject: task.subject, status })}
        onClick={onToggle}
        className={cn(
          "hover:bg-accent focus-visible:ring-ring grid w-full grid-cols-[1rem_var(--task-number-width)_minmax(0,1fr)_1.5rem] items-center gap-x-2 px-1 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset pointer-coarse:min-h-11",
          wide && "@[35rem]:grid-cols-[1rem_var(--task-number-width)_minmax(0,1fr)_fit-content(12.5rem)_1.5rem]",
        )}
      >
        <TaskStatusGlyph status={task.status} />
        <span className="text-muted-foreground text-right font-mono text-xs leading-5 tabular-nums">{task.id}</span>
        <span
          className={cn(
            "min-w-0 truncate text-sm leading-5",
            task.status === "completed" ? "text-muted-foreground" : "text-foreground",
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
            "col-start-4 row-start-1 flex size-6 items-center justify-center justify-self-end",
            wide && "@[35rem]:col-start-5",
          )}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "text-muted-foreground size-3.5 transition-transform duration-150 motion-reduce:transition-none",
              expanded && "rotate-90",
            )}
          />
        </span>
        <span
          className={cn(
            "text-muted-foreground col-start-3 row-start-2 min-w-0 text-xs leading-5",
            wide && "@[35rem]:col-end-5",
            expanded ? "wrap-break-word" : "truncate",
          )}
        >
          {task.owner !== null && (
            <span className={cn(wide && "@[35rem]:hidden")}>{`${task.owner} · `}</span>
          )}
          {details.join(" · ")}
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

/** Loading: six 32 px rows of different widths (run-task-list.md, States). */
function TaskListSkeleton() {
  const t = useTranslations("agents.tasks");
  return (
    <div role="status" aria-label={t("loading")} className="flex flex-col">
      {SKELETON_ROWS.map((width) => (
        <div key={width} className="flex h-8 items-center">
          <Skeleton className={cn("h-4 motion-reduce:animate-none", width)} />
        </div>
      ))}
    </div>
  );
}
