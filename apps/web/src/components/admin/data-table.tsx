'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { CircleXIcon, LoaderCircleIcon, MoreHorizontalIcon, RotateCwIcon, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { StateBadge } from '@/components/state-badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ResourceStatus } from '@/hooks/use-resource';
import { focusShellTarget } from '@/lib/focus';
import { cn } from '@/lib/utils';

/** Matches `--duration-fast`, the collapse of a row that left. */
const LEAVE_MS = 150;
const SKELETON_WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/6', 'w-2/5', 'w-3/5'] as const;
const FOCUSABLE = 'a[href], button:not(:disabled)';

export type DataTableColumn = {
  header: string;
  /** `end` for numbers and money: right-aligned, tabular digits. */
  align?: 'start' | 'end';
  /**
   * A column of long text: it gives way to the others down to 160 px, and its cells truncate (the cell brings
   * its own `truncate` and `title`). The other columns keep the width of their content, so a narrow area scrolls
   * the table inside its block. By default only the first column shrinks.
   */
  shrinks?: boolean;
};

export type DataTableAction = {
  label: string;
  onSelect: () => void;
  /** The action is in progress: its control shows a spinner and the row's actions are unavailable. */
  pending?: boolean;
  /** Unavailable while another action of the screen runs; in the «⋯» menu only this item is unavailable. */
  disabled?: boolean;
};

export type DataTableRow = {
  /** Stable across reads: a row whose key disappears is the row that left. */
  key: string;
  /** The record's name: actions are named «{действие}: {запись}», nested rows start with «в {запись}:». */
  name: string;
  /** One cell per column, in column order. */
  cells: readonly ReactNode[];
  /** Link row: the first cell links to the record, and the link covers the whole row. */
  href?: string;
  /** Row with actions: buttons or the «⋯» menu at the right end (`DataTableProps.actionsAs`). */
  actions?: readonly DataTableAction[];
  /** Parts of the record shown under it, always expanded. */
  nested?: ReadonlyArray<{ key: string; cells: readonly ReactNode[] }>;
  /** The last action on the row failed: the text is shown under the row. */
  error?: ReactNode;
  /** The outcome of an action that stays visible after the answer, such as a connection check (data-table «Итог действия»). */
  result?: DataTableResult;
};

/**
 * The line under a row with an action's outcome. `text` is the visible text (with `ok`, the time next to the badge);
 * `announcement` is what screen readers hear politely when the line appears or changes.
 */
export type DataTableResult =
  | { state: 'pending'; text: string; announcement: string }
  | { state: 'ok'; badge: string; text: string; announcement: string }
  | { state: 'failed'; text: string; announcement: string };

export type DataTableEmpty = { Icon: LucideIcon; title: string; description?: string };

/** Partial: passed while the list has a next page. */
export type DataTableMore = {
  onLoadMore: () => void;
  loading: boolean;
  /** The next page failed: the text and «Повторить» stand in place of «Показать ещё». */
  error?: string;
};

export type DataTableState =
  | { status: 'loading' }
  | { status: 'error'; message: string; onRetry: () => void }
  | {
      status: 'ready';
      /** In the server's order; the table never sorts. */
      rows: readonly DataTableRow[];
      /** Left out by a table that always has a row. */
      empty?: DataTableEmpty;
      /** Set while a search or filter is applied: an empty result reads this line under the header. */
      noMatches?: string;
      more?: DataTableMore;
    };

type ReadyState = Extract<DataTableState, { status: 'ready' }>;

/**
 * A read as the table's state: the load error with «Повторить», Loading until the data are there, then
 * `toReady(data)`. Without `toReady` — a placeholder that is replaced once the data arrive — it never reads ready.
 */
export function resourceTableState<T>(
  resource: { status: ResourceStatus; data: T | undefined; reload: () => void },
  loadFailedText: string,
  toReady?: (data: T) => Omit<ReadyState, 'status'>,
): DataTableState {
  if (resource.status === 'error') return { status: 'error', message: loadFailedText, onRetry: resource.reload };
  if (resource.status === 'loading' || resource.data === undefined || toReady === undefined) return { status: 'loading' };
  return { status: 'ready', ...toReady(resource.data) };
}

type DataTableProps = {
  /** The table's name for screen readers (a hidden caption); Loading's `status` reads it too. */
  caption: string;
  /** May be empty only while loading, when the screen is not known yet. */
  columns: readonly DataTableColumn[];
  state: DataTableState;
  /** Up to two actions read as buttons; the screen picks the «⋯» menu where the UXRD draws one. */
  actionsAs?: 'buttons' | 'menu';
};

type Leaving = { row: DataTableRow; afterKey: string | null };

/** Where focus goes when a row left: the next remaining row, else the previous one, else the page `h1`. */
type Departure = { nextKey: string | null; previousKey: string | null };

type Shown = { rows: readonly DataTableRow[]; leaving: readonly Leaving[]; departure: Departure | null };

/** Not ready: neither a departure from it nor to it is a row leaving. */
const NO_ROWS: readonly DataTableRow[] = [];

const prefersReducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The rows of `before` missing from `after`, each placed after the nearest earlier row that stays. */
function rowsThatLeft(before: readonly DataTableRow[], after: readonly DataTableRow[]): Leaving[] {
  const staying = new Set(after.map((row) => row.key));
  const left: Leaving[] = [];
  let afterKey: string | null = null;
  for (const row of before) {
    if (staying.has(row.key)) afterKey = row.key;
    else left.push({ row, afterKey });
  }
  return left;
}

function departureOf(before: readonly DataTableRow[], after: readonly DataTableRow[], first: Leaving): Departure {
  const staying = new Set(after.map((row) => row.key));
  const index = before.findIndex((row) => row.key === first.row.key);
  const nextKey = before.slice(index + 1).find((row) => staying.has(row.key))?.key ?? null;
  return { nextKey, previousKey: first.afterKey };
}

function nextShown(shown: Shown, rows: readonly DataTableRow[]): Shown {
  if (shown.rows === NO_ROWS || rows === NO_ROWS) return { rows, leaving: [], departure: null };
  const left = rowsThatLeft(shown.rows, rows);
  // A row that is back while it still collapses is shown once, as the row it is now.
  const back = new Set(rows.map((row) => row.key));
  const stillLeaving = shown.leaving.some((entry) => back.has(entry.row.key))
    ? shown.leaving.filter((entry) => !back.has(entry.row.key))
    : shown.leaving;
  if (left.length === 0) return { ...shown, rows, leaving: stillLeaving };
  const leaving = prefersReducedMotion() ? [] : [...stillLeaving, ...left];
  return { rows, leaving, departure: departureOf(shown.rows, rows, left[0]) };
}

/** The rows in display order, with the rows that are collapsing still in their places. */
function displayRows(shown: Shown): Array<{ row: DataTableRow; leaving: boolean }> {
  const display = shown.rows.map((row) => ({ row, leaving: false }));
  for (const { row, afterKey } of shown.leaving) {
    const index = afterKey === null ? -1 : display.findIndex((entry) => entry.row.key === afterKey);
    display.splice(index + 1, 0, { row, leaving: true });
  }
  return display;
}

/**
 * UXRD Accessibility «Строка таблицы ушла»: when focus was in the row that left or fell to `body`, it moves to the
 * first target of the next row, else of the previous one, else to the page `h1`.
 */
function moveFocusAfterDeparture(body: HTMLElement | null, { nextKey, previousKey }: Departure): void {
  const active = document.activeElement;
  const lost = active === null || active === document.body || active.closest('tr[data-leaving]') !== null;
  if (!lost) return;
  for (const key of [nextKey, previousKey]) {
    if (key === null || body === null) continue;
    const groupRows = Array.from(body.querySelectorAll<HTMLElement>('tr[data-row-key]:not([data-leaving])'));
    const target = groupRows
      .filter((tr) => tr.dataset.rowKey === key)
      .map((tr) => tr.querySelector<HTMLElement>(FOCUSABLE))
      .find((element) => element !== null);
    if (target !== undefined) {
      target.focus();
      return;
    }
  }
  focusShellTarget('page-title');
}

/**
 * design-system data-table on shadcn `table` at the panel's compact density (design-admin.md, KD-5, KD-6): rows
 * of 32 px, cells padded 12 px, Data text, technical names in Mono. Rows keep the server's order.
 */
export function DataTable({ caption, columns, state, actionsAs = 'buttons' }: DataTableProps) {
  const rows = state.status === 'ready' ? state.rows : NO_ROWS;
  const [shown, setShown] = useState<Shown>({ rows, leaving: [], departure: null });
  if (shown.rows !== rows) setShown(nextShown(shown, rows));

  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const { departure, leaving } = shown;

  useLayoutEffect(() => {
    if (departure !== null) moveFocusAfterDeparture(bodyRef.current, departure);
  }, [departure]);

  useEffect(() => {
    if (leaving.length === 0) return;
    const timer = window.setTimeout(() => setShown((current) => ({ ...current, leaving: [] })), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  if (state.status === 'loading') return <LoadingTable caption={caption} columns={columns} />;
  if (state.status === 'error') return <LoadError message={state.message} onRetry={state.onRetry} />;
  if (state.rows.length === 0 && state.noMatches === undefined && state.empty !== undefined) {
    return <EmptyTable {...state.empty} />;
  }

  const hasActions = state.rows.some((row) => row.actions !== undefined && row.actions.length > 0);
  const columnCount = columns.length + (hasActions ? 1 : 0);
  // A result line is as wide as the visible block (`100cqw`), so it wraps there instead of scrolling with the table.
  const hasResult = [...state.rows, ...leaving.map((entry) => entry.row)].some((row) => row.result !== undefined);

  return (
    <div className={cn('flex flex-col', hasResult && '@container')}>
      {/* `mb-px`: the table's scroll container would cut the last row's 3 px focus ring by its last pixel. */}
      <Table className="mb-px text-data text-foreground">
        <TableCaption className="sr-only">{caption}</TableCaption>
        <HeaderRow columns={columns} withActions={hasActions} />
        <TableBody ref={bodyRef}>
          {state.rows.length === 0 ? (
            <TableRow className="h-8 hover:bg-transparent pointer-coarse:h-11">
              <TableCell colSpan={columnCount} className="px-3 text-muted-foreground">
                {state.noMatches}
              </TableCell>
            </TableRow>
          ) : (
            displayRows(shown).map(({ row, leaving: isLeaving }) => (
              <RowGroup
                key={row.key}
                row={row}
                columns={columns}
                withActions={hasActions}
                actionsAs={actionsAs}
                leaving={isLeaving}
              />
            ))
          )}
        </TableBody>
      </Table>
      {state.more !== undefined && <LoadMore {...state.more} />}
    </div>
  );
}

const headClass = 'h-8 px-3 text-xs leading-4 font-medium text-muted-foreground';
const cellClass = 'px-3 py-0 align-middle';

const alignClass = (column: DataTableColumn | undefined): string | undefined =>
  column?.align === 'end' ? 'text-right tabular-nums' : undefined;

const shrinks = (columns: readonly DataTableColumn[], index: number): boolean => columns[index]?.shrinks ?? index === 0;

function HeaderRow({ columns, withActions }: { columns: readonly DataTableColumn[]; withActions: boolean }) {
  return (
    <TableHeader>
      <TableRow className="border-border hover:bg-transparent">
        {columns.map((column) => (
          <TableHead key={column.header} scope="col" className={cn(headClass, column.align === 'end' && 'text-right')}>
            {column.header}
          </TableHead>
        ))}
        {withActions && <td />}
      </TableRow>
    </TableHeader>
  );
}

type RowGroupProps = {
  row: DataTableRow;
  columns: readonly DataTableColumn[];
  withActions: boolean;
  actionsAs: 'buttons' | 'menu';
  leaving: boolean;
};

type CollapsibleProps = {
  children: ReactNode;
  /** The cell may get narrower than its content, down to 160 px; otherwise it is never narrower than its content. */
  shrinks?: boolean;
  className?: string;
};

/**
 * Cell content that collapses with its row: a 150 ms height and fade, instant under reduced motion. The clipping
 * `overflow-hidden` gives the content a zero minimum width, so the wrapper states the cell's width itself; a cell
 * that keeps its content's width clips only while its row leaves, which leaves a button's focus ring whole.
 */
function Collapsible({ children, shrinks = false, className }: CollapsibleProps) {
  return (
    <div
      className={cn(
        'grid grid-rows-[1fr] transition-[grid-template-rows,opacity] duration-(--duration-fast) group-data-leaving/row:grid-rows-[0fr] group-data-leaving/row:opacity-0 motion-reduce:transition-none',
        shrinks ? 'min-w-40' : 'min-w-max',
      )}
    >
      <div className={cn('min-h-0', shrinks ? 'overflow-hidden' : 'group-data-leaving/row:overflow-hidden', className)}>
        {children}
      </div>
    </div>
  );
}

/** A record's row, its nested rows and its action error; they leave together. */
function RowGroup({ row, columns, withActions, actionsAs, leaving }: RowGroupProps) {
  const t = useTranslations('admin.table');
  const interactive = row.href !== undefined || (row.actions !== undefined && row.actions.length > 0);
  const groupProps = {
    'data-row-key': row.key,
    'data-leaving': leaving ? '' : undefined,
    'aria-hidden': leaving ? true : undefined,
    inert: leaving,
  };
  const rowClass =
    'group/row h-8 border-border transition-[height] duration-(--duration-fast) hover:bg-transparent data-leaving:h-0 motion-reduce:transition-none pointer-coarse:h-11 pointer-coarse:data-leaving:h-0';
  const columnCount = columns.length + (withActions ? 1 : 0);
  const lineUnder = row.result !== undefined || row.error !== undefined;
  const followed = (row.nested?.length ?? 0) > 0 || lineUnder;

  return (
    <>
      <TableRow
        {...groupProps}
        className={cn(rowClass, interactive && 'hover:bg-accent', row.href !== undefined && 'relative', followed && 'border-b-0')}
      >
        {row.cells.map((cell, index) => (
          <TableCell key={columns[index]?.header ?? index} className={cn(cellClass, alignClass(columns[index]))}>
            <Collapsible shrinks={shrinks(columns, index)}>
              {index === 0 && row.href !== undefined ? <RowLink href={row.href}>{cell}</RowLink> : cell}
            </Collapsible>
          </TableCell>
        ))}
        {withActions && (
          <TableCell className={cn(cellClass, 'w-px text-right')}>
            <Collapsible className="relative z-10 flex justify-end gap-2">
              <RowActions name={row.name} actions={row.actions ?? []} actionsAs={actionsAs} />
            </Collapsible>
          </TableCell>
        )}
      </TableRow>
      {row.nested?.map((nested, nestedIndex) => (
        <TableRow
          key={nested.key}
          {...groupProps}
          className={cn(
            rowClass,
            (nestedIndex < (row.nested?.length ?? 0) - 1 || lineUnder) && 'border-b-0',
          )}
        >
          {nested.cells.map((cell, index) => (
            <TableCell
              key={columns[index]?.header ?? index}
              className={cn(cellClass, alignClass(columns[index]), index === 0 && 'pl-9')}
            >
              <Collapsible shrinks={shrinks(columns, index)}>
                {index === 0 && <span className="sr-only">{t('nestedIn', { parent: row.name })}</span>}
                {cell}
              </Collapsible>
            </TableCell>
          ))}
          {withActions && <TableCell className={cellClass} />}
        </TableRow>
      ))}
      {row.result !== undefined && (
        <TableRow {...groupProps} className={cn('border-border hover:bg-transparent', row.error !== undefined && 'border-b-0')}>
          <TableCell colSpan={columnCount} className="p-0 whitespace-normal">
            <ResultLine result={row.result} />
          </TableCell>
        </TableRow>
      )}
      {row.error !== undefined && (
        <TableRow {...groupProps} className="border-border hover:bg-transparent">
          <TableCell colSpan={columnCount} className="px-3 pb-1.5 whitespace-normal">
            <Collapsible shrinks>
              <p role="alert" className="text-xs leading-4 font-medium text-destructive">
                {row.error}
              </p>
            </Collapsible>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * data-table «Итог действия»: a Caption line under the row. It sticks to the visible block's left edge at the block's
 * width, so it wraps instead of scrolling with a wide table; the region `status` announces start and outcome politely.
 */
function ResultLine({ result }: { result: DataTableResult }) {
  return (
    <div className="sticky left-0 w-[100cqw] px-3 pb-1.5">
      <Collapsible shrinks>
        <span role="status" className="sr-only">
          {result.announcement}
        </span>
        <p
          aria-hidden
          className={cn(
            'flex items-start gap-1 text-xs leading-4 font-medium',
            result.state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {result.state === 'pending' && (
            <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
          )}
          {result.state === 'failed' && <CircleXIcon aria-hidden className="size-3.5 shrink-0" />}
          {result.state === 'ok' && <StateBadge state="ok">{result.badge}</StateBadge>}
          <span className="min-w-0 break-words">{result.text}</span>
        </p>
      </Collapsible>
    </div>
  );
}

/** Link row: the link sits in the first cell and its `::after` covers the row, so the whole row opens the record. */
function RowLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="outline-none after:absolute after:inset-0 after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
    >
      {children}
    </Link>
  );
}

function RowActions({
  name,
  actions,
  actionsAs,
}: {
  name: string;
  actions: readonly DataTableAction[];
  actionsAs: 'buttons' | 'menu';
}) {
  const t = useTranslations('admin.table');
  if (actions.length === 0) return null;
  if (actionsAs === 'menu') return <ActionsMenu name={name} actions={actions} />;

  const busy = actions.some((action) => action.pending === true);
  return actions.map((action) => (
    <Button
      key={action.label}
      variant="outline"
      size="sm"
      className="pointer-coarse:h-11"
      aria-label={t('action', { action: action.label, record: name })}
      disabled={busy || action.disabled === true}
      onClick={action.onSelect}
    >
      {action.pending === true && <Spinner />}
      {action.label}
    </Button>
  ));
}

/** The «⋯» menu of a record's actions: in a table row and in a record page's header. */
export function ActionsMenu({ name, actions }: { name: string; actions: readonly DataTableAction[] }) {
  const t = useTranslations('admin.table');
  const busy = actions.some((action) => action.pending === true);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={busy}
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="pointer-coarse:size-11"
            aria-label={t('menu', { record: name })}
            aria-haspopup="menu"
          />
        }
      >
        {busy ? <Spinner /> : <MoreHorizontalIcon aria-hidden />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-40">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            disabled={action.disabled === true}
            onClick={action.onSelect}
            className="pointer-coarse:min-h-11"
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Spinner() {
  return <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:animate-none" />;
}

/** Loading: the header and six skeleton rows of different widths; screen readers hear the table's name. */
function LoadingTable({ caption, columns }: { caption: string; columns: readonly DataTableColumn[] }) {
  const count = Math.max(columns.length, 1);
  return (
    <div role="status" aria-label={caption}>
      <Table aria-hidden className="text-data">
        {columns.length > 0 && <HeaderRow columns={columns} withActions={false} />}
        <TableBody>
          {SKELETON_WIDTHS.map((width) => (
            <TableRow key={width} className="h-8 border-border hover:bg-transparent pointer-coarse:h-11">
              {Array.from({ length: count }, (_, index) => (
                <TableCell key={index} className={cellClass}>
                  <Skeleton className={cn('h-3 motion-reduce:animate-none', width)} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="status" className="flex flex-col items-center gap-3 py-8 text-sm leading-5 text-foreground">
      <p>{message}</p>
      <RetryButton onClick={onRetry} />
    </div>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations('admin.table');
  return (
    <Button variant="outline" size="sm" className="pointer-coarse:h-11" onClick={onClick}>
      <RotateCwIcon aria-hidden />
      {t('retry')}
    </Button>
  );
}

/** Empty: no header; the icon, then the screen's two lines. Its action is the screen's main button in the header. */
function EmptyTable({ Icon, title, description }: DataTableEmpty) {
  return (
    <div className="flex flex-col items-center gap-1 py-12 text-center">
      <Icon aria-hidden className="mb-2 size-6 text-muted-foreground" />
      <p className="text-sm leading-5 font-medium text-foreground">{title}</p>
      {description !== undefined && <p className="text-xs leading-4 text-muted-foreground">{description}</p>}
    </div>
  );
}

function LoadMore({ onLoadMore, loading, error }: DataTableMore) {
  const t = useTranslations('admin.table');
  if (error !== undefined) {
    return (
      <div className="flex flex-col items-center gap-2 py-2">
        <p role="alert" className="text-xs leading-4 font-medium text-destructive">
          {error}
        </p>
        <RetryButton onClick={onLoadMore} />
      </div>
    );
  }
  return (
    <div className="flex justify-center py-2">
      <Button variant="ghost" size="sm" className="pointer-coarse:h-11" disabled={loading} onClick={onLoadMore}>
        {loading && <Spinner />}
        {t('loadMore')}
      </Button>
    </div>
  );
}
