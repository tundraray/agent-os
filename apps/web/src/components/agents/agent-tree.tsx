"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
} from "react";
import Link from "next/link";
import type { AgentListNode, AgentNode } from "@agent-os/contracts";
import { ChevronDownIcon, ChevronRightIcon, RotateCwIcon } from "lucide-react";
import { AgentStatus } from "@/components/agents/agent-status";
import { UNTITLED_THREAD_TITLE } from "@/components/shell/thread-history-item";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatModel, formatTime } from "@/lib/agents/format";
import { focusShellTarget } from "@/lib/focus";
import { agentPath, threadPath } from "@/lib/shell-route";
import { cn } from "@/lib/utils";

/** The level indent stops growing after the fourth level (agent-tree.md, Anatomy). */
const MAX_INDENT_LEVEL = 4;
const INDENT_PX = 16;
/** A removed row collapses for this long before it leaves the DOM (`--duration-fast`). */
const LEAVE_MS = 150;

/**
 * One row grid for both layouts, switched by the container query at 720 px of the main area:
 * narrow — toggle and two 20 px lines (status icon and description; model · time · conversation);
 * wide — a 32 px row of columns MC-4. The height never depends on the status (Invariant 4).
 */
const ROW_GRID =
  "grid grid-cols-[1.5rem_minmax(0,1fr)] grid-rows-[1.25rem_1.25rem] content-center items-center gap-x-2 " +
  "@min-[720px]:grid-cols-[1.5rem_minmax(0,1fr)_10rem_4.5rem_7.5rem_minmax(0,10rem)] @min-[720px]:grid-rows-[2rem] @min-[720px]:gap-x-3";
const ROW_HEIGHT = "h-10 @min-[720px]:h-8 pointer-coarse:min-h-11";

/** Opens a row over 150 ms when it is inserted, and collapses it while it leaves. */
const ROW_MOTION =
  "grid transition-[grid-template-rows] duration-(--duration-fast) motion-reduce:transition-none";

const SKELETON_WIDTHS = ["62%", "48%", "71%", "55%", "40%", "66%", "52%", "45%"] as const;

type AnyAgentNode = AgentNode | AgentListNode;

/** The row text: the task; for a workflow run — the template name and the coordinator's task. */
function rowDescription(node: AnyAgentNode): string {
  if (node.template === undefined) return node.description;
  return node.description === "" ? node.template.title : `${node.template.title} · ${node.description}`;
}

function collectIds(nodes: readonly AnyAgentNode[], into: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    into.add(node.agentId);
    collectIds(node.children, into);
  }
  return into;
}

const indentStyle = (level: number) => ({
  paddingInlineStart: `calc(0.5rem + ${Math.min(level, MAX_INDENT_LEVEL) * INDENT_PX}px)`,
});

type RowContext = {
  expanded: ReadonlySet<string>;
  onToggle: (agentId: string) => void;
  /** Rows present when the tree mounted do not open with motion; later ones do. */
  initialIds: ReadonlySet<string>;
};

type AgentRowProps = RowContext & {
  node: AnyAgentNode;
  level: number;
  /** The conversation link, only for the top rows. */
  thread?: { threadId: string; title: string | null };
  leaving?: boolean;
};

function AgentRow({ node, level, thread, leaving = false, expanded, onToggle, initialIds }: AgentRowProps) {
  const childListId = useId();
  const description = rowDescription(node);
  const hasChildren = node.children.length > 0;
  const open = hasChildren && expanded.has(node.agentId);
  const appeared = !initialIds.has(node.agentId);
  const conversationTitle = thread === undefined ? null : (thread.title ?? UNTITLED_THREAD_TITLE);

  return (
    <li
      data-agent-top={thread === undefined ? undefined : node.agentId}
      data-leaving={leaving ? "" : undefined}
      inert={leaving}
      className={cn(
        ROW_MOTION,
        leaving ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        appeared && "starting:grid-rows-[0fr]",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          data-agent-row={node.agentId}
          style={indentStyle(level)}
          className={cn(ROW_GRID, ROW_HEIGHT, "hover:bg-accent relative border-b pr-2")}
        >
          {hasChildren ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={childListId}
              aria-label={`${open ? "Скрыть" : "Показать"} вложенных: ${description}`}
              onClick={() => onToggle(node.agentId)}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring relative z-10 inline-flex size-6 items-center justify-center self-center rounded-md outline-none focus-visible:ring-2 pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5"
            >
              {open ? (
                <ChevronDownIcon aria-hidden className="size-3.5" />
              ) : (
                <ChevronRightIcon aria-hidden className="size-3.5" />
              )}
            </button>
          ) : (
            <span aria-hidden className="size-6" />
          )}

          <div className="flex min-w-0 items-center gap-1.5">
            <AgentStatus variant="icon" status={node.status} className="relative z-10 shrink-0 @min-[720px]:hidden" />
            <Link
              href={agentPath(node.agentId)}
              data-agent-link=""
              title={description}
              className="text-foreground focus-visible:after:ring-ring min-w-0 truncate text-sm leading-5 outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-inset"
            >
              {description}
            </Link>
          </div>

          <AgentStatus variant="label" status={node.status} className="hidden @min-[720px]:inline-flex" />

          <div className="text-muted-foreground col-start-2 flex min-w-0 items-center gap-1 text-[13px] leading-[18px] @min-[720px]:contents">
            <span className="shrink-0 truncate">
              <span className="sr-only">модель </span>
              {formatModel(node.model)}
            </span>
            <span aria-hidden className="shrink-0 @min-[720px]:hidden">
              ·
            </span>
            <span className="shrink-0 tabular-nums">
              <span className="sr-only">запущен </span>
              <time dateTime={node.createdAt}>{formatTime(node.createdAt)}</time>
            </span>
            {thread !== undefined && conversationTitle !== null ? (
              <>
                <span aria-hidden className="shrink-0 @min-[720px]:hidden">
                  ·
                </span>
                <Link
                  href={threadPath(thread.threadId)}
                  title={conversationTitle}
                  className="hover:text-foreground focus-visible:ring-ring relative z-10 min-w-0 truncate rounded-sm outline-none hover:underline focus-visible:ring-2"
                >
                  <span className="sr-only">беседа </span>
                  {conversationTitle}
                </Link>
              </>
            ) : (
              <span aria-hidden className="hidden @min-[720px]:block" />
            )}
          </div>
        </div>

        {hasChildren && (
          <ul id={childListId} hidden={!open}>
            {node.children.map((child) => (
              <AgentRow
                key={child.agentId}
                node={child}
                level={level + 1}
                expanded={expanded}
                onToggle={onToggle}
                initialIds={initialIds}
              />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

type Leaving = { node: AgentListNode; after: string | null };

/**
 * Keeps removed top rows (a conversation deleted with its agents) in place for 150 ms so they collapse
 * instead of vanishing; returns the rows to draw, in the API's order.
 */
function useRowsWithLeaving(agents: readonly AgentListNode[]): {
  rows: { node: AgentListNode; leaving: boolean }[];
  leaving: readonly Leaving[];
} {
  const [tracked, setTracked] = useState<{ agents: readonly AgentListNode[]; leaving: readonly Leaving[] }>({
    agents,
    leaving: [],
  });

  let current = tracked;
  if (tracked.agents !== agents) {
    const ids = new Set(agents.map((agent) => agent.agentId));
    const removed = tracked.agents.flatMap((node, index): Leaving[] =>
      ids.has(node.agentId) ? [] : [{ node, after: index === 0 ? null : tracked.agents[index - 1].agentId }],
    );
    current = {
      agents,
      leaving: [...tracked.leaving.filter((entry) => !ids.has(entry.node.agentId)), ...removed],
    };
    setTracked(current);
  }

  useEffect(() => {
    if (tracked.leaving.length === 0) return;
    const done = new Set(tracked.leaving.map((entry) => entry.node.agentId));
    const timer = setTimeout(() => {
      setTracked((state) => ({
        ...state,
        leaving: state.leaving.filter((entry) => !done.has(entry.node.agentId)),
      }));
    }, LEAVE_MS);
    return () => clearTimeout(timer);
  }, [tracked.leaving]);

  const rows = agents.map((node) => ({ node, leaving: false }));
  for (const entry of current.leaving) {
    const at = entry.after === null ? -1 : rows.findIndex((row) => row.node.agentId === entry.after);
    rows.splice(at + 1, 0, { node: entry.node, leaving: true });
  }
  return { rows, leaving: current.leaving };
}

/**
 * Moves focus off a removed row (UXRD «Порядок фокуса»): to the next row, else the previous one,
 * else the page `h1`.
 */
function moveFocusFromLeaving(root: HTMLElement, leavingItem: HTMLElement): void {
  // Rows inside a collapsed subtree (`hidden` list) or another leaving item are not «the next row».
  const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-agent-row]")).filter(
    (row) => row.closest("[data-leaving], [hidden]") === null,
  );
  const next = rows.find(
    (row) => (leavingItem.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
  const previous = rows
    .filter((row) => (leavingItem.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING) !== 0)
    .at(-1);
  const target = (next ?? previous)?.querySelector<HTMLElement>("[data-agent-link]");
  if (target !== undefined && target !== null) target.focus();
  else focusShellTarget("page-title");
}

export type AgentTreeProps = {
  /** Top agents of the loaded pages, in the API's order (newest first). */
  agents: readonly AgentListNode[];
  expanded: ReadonlySet<string>;
  onToggle: (agentId: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreFailed: boolean;
  onLoadMore: () => void;
};

/**
 * The agent tree of agent-tree.md: nested lists, columns MC-4 or two lines by the 720 px container query
 * of the nearest `@container` ancestor, expansion with MC-7, and «Показать ещё» (MC-6) under the last row.
 */
export function AgentTree({ agents, expanded, onToggle, hasMore, loadingMore, loadMoreFailed, onLoadMore }: AgentTreeProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [initialIds] = useState(() => collectIds(agents));
  const { rows, leaving } = useRowsWithLeaving(agents);
  /** The top row holding focus; kept when focus is lost to the page, cleared when it moves elsewhere. */
  const focusedTop = useRef<string | null>(null);

  const trackFocus = (event: FocusEvent<HTMLDivElement>) => {
    focusedTop.current =
      event.target.closest<HTMLElement>("[data-agent-top]")?.dataset.agentTop ?? null;
  };
  const forgetFocus = (event: FocusEvent<HTMLDivElement>) => {
    const to = event.relatedTarget;
    if (to instanceof Node && !event.currentTarget.contains(to)) focusedTop.current = null;
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    const focused = focusedTop.current;
    if (root === null || focused === null) return;
    if (!leaving.some((entry) => entry.node.agentId === focused)) return;
    const item = root.querySelector<HTMLElement>(`[data-agent-top="${CSS.escape(focused)}"]`);
    if (item === null) return;
    focusedTop.current = null;
    moveFocusFromLeaving(root, item);
  }, [leaving]);

  const context: RowContext = { expanded, onToggle, initialIds };

  return (
    <div ref={rootRef} onFocus={trackFocus} onBlur={forgetFocus} className="w-full max-w-[75rem]">
      <ColumnHeader />
      <ul>
        {rows.map(({ node, leaving: isLeaving }) => (
          <AgentRow
            key={node.agentId}
            node={node}
            level={0}
            thread={{ threadId: node.threadId, title: node.threadTitle }}
            leaving={isLeaving}
            {...context}
          />
        ))}
      </ul>
      {hasMore && (
        <NextPage loadingMore={loadingMore} loadMoreFailed={loadMoreFailed} onLoadMore={onLoadMore} />
      )}
    </div>
  );
}

/** Column header MC-4: wide layout only, hidden from assistive technology (agent-tree.md). */
function ColumnHeader() {
  return (
    <div
      aria-hidden
      className={cn(
        ROW_GRID,
        "text-muted-foreground hidden h-8 border-b px-2 text-xs leading-4 font-medium @min-[720px]:grid",
      )}
    >
      <span className="col-span-2">Агент</span>
      <span>Статус</span>
      <span>Модель</span>
      <span>Запущен</span>
      <span>Беседа</span>
    </div>
  );
}

/** Partial: «Показать ещё» (`ghost`, `sm`), its loading rows, or MC-6 with «Повторить». */
function NextPage({
  loadingMore,
  loadMoreFailed,
  onLoadMore,
}: Pick<AgentTreeProps, "loadingMore" | "loadMoreFailed" | "onLoadMore">) {
  if (loadingMore) return <AgentTreeSkeleton rows={3} header={false} />;
  if (loadMoreFailed) {
    return (
      <div className="flex flex-col items-start gap-2 px-2 py-3 text-sm leading-5">
        <p role="alert">Не удалось загрузить агентов</p>
        <Button variant="outline" size="sm" onClick={onLoadMore}>
          <RotateCwIcon aria-hidden />
          Повторить
        </Button>
      </div>
    );
  }
  return (
    <div className="flex justify-center py-3">
      <Button variant="ghost" size="sm" onClick={onLoadMore} className="pointer-coarse:h-11">
        Показать ещё
      </Button>
    </div>
  );
}

/** Loading: the column header and skeleton rows of 32 px with different widths (agent-tree.md). */
export function AgentTreeSkeleton({ rows = SKELETON_WIDTHS.length, header = true }: { rows?: number; header?: boolean }) {
  return (
    <div role="status" aria-label="Загружаем агентов…" className="w-full max-w-[75rem]">
      <span className="sr-only">Загружаем агентов…</span>
      {header && <ColumnHeader />}
      {SKELETON_WIDTHS.slice(0, rows).map((width) => (
        <div key={width} aria-hidden className="flex h-8 items-center border-b px-2">
          <Skeleton className="h-4 motion-reduce:animate-none" style={{ width }} />
        </div>
      ))}
    </div>
  );
}
