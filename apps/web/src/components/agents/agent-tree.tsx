'use client';

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import type { AgentListNode, AgentNode } from '@agent-os/contracts';
import { ChevronDownIcon, ChevronRightIcon, RotateCwIcon } from 'lucide-react';
import { AgentStatus } from '@/components/agents/agent-status';
import { runRecord } from '@/components/agents/run-card';
import { RecordLabel } from '@/components/library/record-label';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatModel } from '@/lib/agents/format';
import { builtinName } from '@/i18n/builtin-name';
import { formatListTime } from '@/i18n/formats';
import { isDeepAgentRun } from '@/lib/feed/to-feed';
import { focusShellTarget } from '@/lib/focus';
import { agentPath, recordPath, threadPath } from '@/lib/shell-route';
import type { Locale } from '@/i18n/pick-locale';
import { cn } from '@/lib/utils';

/** The level indent stops growing after the fourth level (agent-tree.md, Anatomy). */
const MAX_INDENT_LEVEL = 4;
const INDENT_PX = 16;
/** A removed row collapses for this long before it leaves the DOM (`--duration-fast`). */
const LEAVE_MS = 150;

/**
 * One row grid for both layouts, switched by the container query at 720 px of the main area:
 * narrow — toggle and two 20 px lines (status icon and description; record · model · time · conversation);
 * wide — a 32 px row of columns MC-4 with «Из библиотеки» after «Агент» (RN-02). The height never depends
 * on the status (Invariant 4).
 */
const ROW_GRID =
  'grid grid-cols-[1.5rem_minmax(0,1fr)] grid-rows-[1.25rem_1.25rem] content-center items-center gap-x-2 ' +
  '@min-[720px]:grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,12rem)_10rem_4.5rem_7.5rem_minmax(0,10rem)] @min-[720px]:grid-rows-[2rem] @min-[720px]:gap-x-3';
const ROW_HEIGHT = 'h-10 @min-[720px]:h-8 pointer-coarse:min-h-11';

/** Opens a row over 150 ms when it is inserted, and collapses it while it leaves. */
const ROW_MOTION =
  'grid transition-[grid-template-rows] duration-(--duration-fast) motion-reduce:transition-none';

/** The rich-text tag of words only a screen reader hears. */
const srOnly = (chunks: ReactNode) => <span className="sr-only">{chunks}</span>;

const SKELETON_WIDTHS = [
  '62%',
  '48%',
  '71%',
  '55%',
  '40%',
  '66%',
  '52%',
  '45%',
] as const;

type AnyAgentNode = AgentNode | AgentListNode;

/** The row text: the task; for a deep agent's run — the record's name in `locale` and the deep agent's task. */
function rowDescription(node: AnyAgentNode, locale: Locale): string {
  if (!isDeepAgentRun(node)) return node.description;
  const name = builtinName(
    { builtinKey: node.origin?.builtinKey ?? null, name: node.name },
    locale,
  );
  return node.description === '' ? name : `${name} · ${node.description}`;
}

function collectIds(
  nodes: readonly AnyAgentNode[],
  into: Set<string> = new Set(),
): Set<string> {
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

function AgentRow({
  node,
  level,
  thread,
  leaving = false,
  expanded,
  onToggle,
  initialIds,
}: AgentRowProps) {
  const childListId = useId();
  const format = useFormatter();
  const locale = useLocale();
  const t = useTranslations('agents');
  const tShell = useTranslations('shell');
  const description = rowDescription(node, locale);
  const hasChildren = node.children.length > 0;
  const open = hasChildren && expanded.has(node.agentId);
  const appeared = !initialIds.has(node.agentId);
  const conversationTitle =
    thread === undefined ? null : (thread.title ?? tShell('thread.untitled'));
  const origin = runRecord(node);
  const record =
    origin === null ? null : { ...origin, name: builtinName(origin, locale) };

  return (
    <li
      data-agent-top={thread === undefined ? undefined : node.agentId}
      data-leaving={leaving ? '' : undefined}
      inert={leaving}
      className={cn(
        ROW_MOTION,
        leaving ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
        appeared && 'starting:grid-rows-[0fr]',
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          data-agent-row={node.agentId}
          style={indentStyle(level)}
          className={cn(
            ROW_GRID,
            ROW_HEIGHT,
            'hover:bg-accent relative border-b pr-2',
          )}
        >
          {hasChildren ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={childListId}
              aria-label={t('tree.toggle', {
                open: open ? 'yes' : 'no',
                description,
              })}
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
            <AgentStatus
              variant="icon"
              status={node.status}
              className="relative z-10 shrink-0 @min-[720px]:hidden"
            />
            <Link
              href={agentPath(node.agentId)}
              data-agent-link=""
              title={description}
              className="text-foreground focus-visible:after:ring-ring min-w-0 truncate text-sm leading-5 outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-inset"
            >
              {description}
            </Link>
          </div>

          <AgentStatus
            variant="label"
            status={node.status}
            className="hidden @min-[720px]:order-2 @min-[720px]:inline-flex"
          />

          {/* Wide: «Из библиотеки» (order 1) stands before the status and the meta cells (order 2); narrow: it opens the meta line. */}
          <div className="text-muted-foreground col-start-2 flex min-w-0 items-center gap-1 text-[13px] leading-[18px] @min-[720px]:contents">
            {record !== null ? (
              <>
                {/* One 20 px line: a source or badge that would wrap is clipped, the row height stays. */}
                <span className="relative z-10 flex h-5 min-w-0 shrink items-start overflow-hidden @min-[720px]:order-1">
                  <RecordLabel
                    origin={record}
                    variant="under"
                    href={recordPath(record.recordId)}
                  />
                </span>
                <span aria-hidden className="shrink-0 @min-[720px]:hidden">
                  ·
                </span>
              </>
            ) : (
              <span
                aria-hidden
                className="hidden @min-[720px]:order-1 @min-[720px]:block"
              />
            )}
            <span className="shrink-0 truncate @min-[720px]:order-2">
              {t.rich('tree.model', {
                model: formatModel(node.model),
                hidden: srOnly,
              })}
            </span>
            <span aria-hidden className="shrink-0 @min-[720px]:hidden">
              ·
            </span>
            <span className="shrink-0 tabular-nums @min-[720px]:order-2">
              {t.rich('tree.started', {
                at: formatListTime(format, node.createdAt),
                time: (chunks) => (
                  <time dateTime={node.createdAt}>{chunks}</time>
                ),
                hidden: srOnly,
              })}
            </span>
            {thread !== undefined && conversationTitle !== null ? (
              <>
                <span aria-hidden className="shrink-0 @min-[720px]:hidden">
                  ·
                </span>
                <Link
                  href={threadPath(thread.threadId)}
                  title={conversationTitle}
                  className="hover:text-foreground focus-visible:ring-ring relative z-10 min-w-0 truncate rounded-sm outline-none hover:underline focus-visible:ring-2 @min-[720px]:order-2"
                >
                  {t.rich('tree.chat', {
                    title: conversationTitle,
                    hidden: srOnly,
                  })}
                </Link>
              </>
            ) : (
              <span
                aria-hidden
                className="hidden @min-[720px]:order-2 @min-[720px]:block"
              />
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
  const [tracked, setTracked] = useState<{
    agents: readonly AgentListNode[];
    leaving: readonly Leaving[];
  }>({
    agents,
    leaving: [],
  });

  let current = tracked;
  if (tracked.agents !== agents) {
    const ids = new Set(agents.map((agent) => agent.agentId));
    const removed = tracked.agents.flatMap((node, index): Leaving[] =>
      ids.has(node.agentId)
        ? []
        : [
            {
              node,
              after: index === 0 ? null : tracked.agents[index - 1].agentId,
            },
          ],
    );
    current = {
      agents,
      leaving: [
        ...tracked.leaving.filter((entry) => !ids.has(entry.node.agentId)),
        ...removed,
      ],
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
    const at =
      entry.after === null
        ? -1
        : rows.findIndex((row) => row.node.agentId === entry.after);
    rows.splice(at + 1, 0, { node: entry.node, leaving: true });
  }
  return { rows, leaving: current.leaving };
}

/**
 * Moves focus off a removed row (UXRD «Порядок фокуса»): to the next row, else the previous one,
 * else the page `h1`.
 */
function moveFocusFromLeaving(
  root: HTMLElement,
  leavingItem: HTMLElement,
): void {
  // Rows inside a collapsed subtree (`hidden` list) or another leaving item are not «the next row».
  const rows = Array.from(
    root.querySelectorAll<HTMLElement>('[data-agent-row]'),
  ).filter((row) => row.closest('[data-leaving], [hidden]') === null);
  const next = rows.find(
    (row) =>
      (leavingItem.compareDocumentPosition(row) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
      0,
  );
  const previous = rows
    .filter(
      (row) =>
        (leavingItem.compareDocumentPosition(row) &
          Node.DOCUMENT_POSITION_PRECEDING) !==
        0,
    )
    .at(-1);
  const target = (next ?? previous)?.querySelector<HTMLElement>(
    '[data-agent-link]',
  );
  if (target !== undefined && target !== null) target.focus();
  else focusShellTarget('page-title');
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
export function AgentTree({
  agents,
  expanded,
  onToggle,
  hasMore,
  loadingMore,
  loadMoreFailed,
  onLoadMore,
}: AgentTreeProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [initialIds] = useState(() => collectIds(agents));
  const { rows, leaving } = useRowsWithLeaving(agents);
  /** The top row holding focus; kept when focus is lost to the page, cleared when it moves elsewhere. */
  const focusedTop = useRef<string | null>(null);

  const trackFocus = (event: FocusEvent<HTMLDivElement>) => {
    focusedTop.current =
      event.target.closest<HTMLElement>('[data-agent-top]')?.dataset.agentTop ??
      null;
  };
  const forgetFocus = (event: FocusEvent<HTMLDivElement>) => {
    const to = event.relatedTarget;
    if (to instanceof Node && !event.currentTarget.contains(to))
      focusedTop.current = null;
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    const focused = focusedTop.current;
    if (root === null || focused === null) return;
    if (!leaving.some((entry) => entry.node.agentId === focused)) return;
    const item = root.querySelector<HTMLElement>(
      `[data-agent-top="${CSS.escape(focused)}"]`,
    );
    if (item === null) return;
    focusedTop.current = null;
    moveFocusFromLeaving(root, item);
  }, [leaving]);

  const context: RowContext = { expanded, onToggle, initialIds };

  return (
    <div
      ref={rootRef}
      onFocus={trackFocus}
      onBlur={forgetFocus}
      className="w-full max-w-[75rem]"
    >
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
        <NextPage
          loadingMore={loadingMore}
          loadMoreFailed={loadMoreFailed}
          onLoadMore={onLoadMore}
        />
      )}
    </div>
  );
}

/** Column header MC-4: wide layout only, hidden from assistive technology (agent-tree.md). */
function ColumnHeader() {
  const t = useTranslations('agents.tree.columns');
  return (
    <div
      aria-hidden
      className={cn(
        ROW_GRID,
        'text-muted-foreground hidden h-8 border-b px-2 text-xs leading-4 font-medium @min-[720px]:grid',
      )}
    >
      <span className="col-span-2">{t('agent')}</span>
      <span>{t('record')}</span>
      <span>{t('status')}</span>
      <span>{t('model')}</span>
      <span>{t('started')}</span>
      <span>{t('chat')}</span>
    </div>
  );
}

/** Partial: «Показать ещё» (`ghost`, `sm`), its loading rows, or MC-6 with «Повторить». */
function NextPage({
  loadingMore,
  loadMoreFailed,
  onLoadMore,
}: Pick<AgentTreeProps, 'loadingMore' | 'loadMoreFailed' | 'onLoadMore'>) {
  const t = useTranslations('agents.list');
  if (loadingMore) return <AgentTreeSkeleton rows={3} header={false} />;
  if (loadMoreFailed) {
    return (
      <div className="flex flex-col items-start gap-2 px-2 py-3 text-sm leading-5">
        <p role="alert">{t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={onLoadMore}>
          <RotateCwIcon aria-hidden />
          {t('retry')}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex justify-center py-3">
      <Button
        variant="ghost"
        size="sm"
        onClick={onLoadMore}
        className="pointer-coarse:h-11"
      >
        {t('showMore')}
      </Button>
    </div>
  );
}

/** Loading: the column header and skeleton rows of 32 px with different widths (agent-tree.md). */
export function AgentTreeSkeleton({
  rows = SKELETON_WIDTHS.length,
  header = true,
}: {
  rows?: number;
  header?: boolean;
}) {
  const t = useTranslations('agents.list');
  return (
    <div
      role="status"
      aria-label={t('loading')}
      className="w-full max-w-[75rem]"
    >
      <span className="sr-only">{t('loading')}</span>
      {header && <ColumnHeader />}
      {SKELETON_WIDTHS.slice(0, rows).map((width) => (
        <div
          key={width}
          aria-hidden
          className="flex h-8 items-center border-b px-2"
        >
          <Skeleton
            className="h-4 motion-reduce:animate-none"
            style={{ width }}
          />
        </div>
      ))}
    </div>
  );
}
