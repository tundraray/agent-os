import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ThreadGroup, ThreadListEntry } from '@/lib/threads/group-threads-by-date';
import { ThreadHistoryItem } from './thread-history-item';
import { ThreadHistoryListView, type ThreadHistoryListViewProps } from './thread-history-list';

const entry = (id: string, title: string | undefined, overrides: Partial<ThreadListEntry> = {}): ThreadListEntry => ({
  id,
  remoteId: id,
  title,
  activityAt: 0,
  isRunning: false,
  ...overrides,
});

const GROUPS: readonly ThreadGroup[] = [
  { key: 'today', label: 'Сегодня', entries: [entry('a', 'План релиза'), entry('b', 'Отчёт')] },
  { key: 'yesterday', label: 'Вчера', entries: [entry('c', 'Заметки')] },
  { key: 'older', label: 'Старше', entries: [entry('d', 'Архив')] },
];

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <nav aria-label="История бесед">{children}</nav>
      </SidebarProvider>
    </TooltipProvider>
  );
}

const renderItem: ThreadHistoryListViewProps['renderItem'] = (item, onRequestDelete) => (
  <ThreadHistoryItem
    key={item.id}
    entry={item}
    isActive={false}
    titlePending={false}
    onRename={vi.fn()}
    onRequestDelete={onRequestDelete}
  />
);

/** All pages loaded: SB-10 is not rendered. */
const NO_MORE_PAGES: ThreadHistoryListViewProps['pagination'] = {
  hasMore: false,
  isLoadingMore: false,
  loadMoreFailed: false,
  onLoadMore: () => {},
};

function renderView(
  props: Pick<ThreadHistoryListViewProps, 'state'> &
    Partial<Pick<ThreadHistoryListViewProps, 'pagination'>> & { activeThreadId?: string },
): void {
  const renderActiveItem: ThreadHistoryListViewProps['renderItem'] = (item, onRequestDelete) => (
    <ThreadHistoryItem
      key={item.id}
      entry={item}
      isActive={item.id === props.activeThreadId}
      titlePending={false}
      onRename={vi.fn()}
      onRequestDelete={onRequestDelete}
    />
  );
  render(
    <ThreadHistoryListView
      state={props.state}
      pagination={props.pagination ?? NO_MORE_PAGES}
      renderItem={renderActiveItem}
      openThreadId={props.activeThreadId}
      onDelete={vi.fn()}
    />,
    { wrapper: Wrapper },
  );
}

/** The list with an optimistic delete: a confirmed thread leaves the groups, as the runtime's list does. */
function DeletableList({ onDelete }: { onDelete: (entry: ThreadListEntry) => void }) {
  const [groups, setGroups] = useState(GROUPS);
  return (
    <ThreadHistoryListView
      state={{ kind: 'ready', groups }}
      pagination={NO_MORE_PAGES}
      renderItem={renderItem}
      openThreadId={undefined}
      onDelete={(deleted) => {
        onDelete(deleted);
        setGroups((current) =>
          current
            .map((group) => ({ ...group, entries: group.entries.filter((item) => item.id !== deleted.id) }))
            .filter((group) => group.entries.length > 0),
        );
      }}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ThreadHistoryListView — SB-09 states (AC-12.1, AC-01.1–01.5)', () => {
  it('Loading: announces «Загружаем беседы…» in role="status" and shows no thread links', () => {
    renderView({ state: { kind: 'loading' } });

    expect(screen.getByRole('status', { name: 'Загружаем беседы…' })).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Empty: shows «Пока нет бесед» with the hint and no headings', () => {
    renderView({ state: { kind: 'ready', groups: [] } });

    expect(screen.getByText('Пока нет бесед')).toBeInTheDocument();
    expect(screen.getByText('Начните новый чат — он появится здесь.')).toBeInTheDocument();
    expect(screen.queryAllByRole('heading')).toEqual([]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('Error: the text is in role="alert", «Повторить» sits outside it and calls onRetry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn<() => void>();
    renderView({ state: { kind: 'error', onRetry } });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Не удалось загрузить беседы');
    const retry = screen.getByRole('button', { name: 'Повторить' });
    expect(alert).not.toContainElement(retry);

    await user.click(retry);

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('Ready: groups render as h2 headings in order with thread links; only the active one has aria-current="page"', () => {
    renderView({ state: { kind: 'ready', groups: GROUPS }, activeThreadId: 'b' });

    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Сегодня',
      'Вчера',
      'Старше',
    ]);
    const today = screen.getByRole('list', { name: 'Сегодня' });
    expect(within(today).getAllByRole('link').map((link) => link.textContent)).toEqual(['План релиза', 'Отчёт']);

    const active = screen.getByRole('link', { name: 'Отчёт' });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(active).toHaveAttribute('href', '/chat/b');
    expect(screen.getByRole('link', { name: 'План релиза' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Архив' })).toHaveAttribute('href', '/chat/d');
  });
});

describe('ThreadHistoryListView — SB-10 next page (AC-19.1)', () => {
  it('Error: «Не удалось загрузить ещё беседы» in role="alert", «Повторить» calls onLoadMore, loaded threads stay', async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn<ThreadHistoryListViewProps['pagination']['onLoadMore']>();
    renderView({
      state: { kind: 'ready', groups: GROUPS },
      pagination: { hasMore: true, isLoadingMore: false, loadMoreFailed: true, onLoadMore },
    });
    const loadedTitles = ['План релиза', 'Отчёт', 'Заметки', 'Архив'];
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(loadedTitles);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Не удалось загрузить ещё беседы');
    expect(screen.queryByRole('button', { name: 'Показать ещё беседы' })).toBeNull();
    const retry = screen.getByRole('button', { name: 'Повторить' });
    expect(alert).not.toContainElement(retry);

    await user.click(retry);

    expect(onLoadMore).toHaveBeenCalledExactlyOnceWith('pointer');
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(loadedTitles);
  });
});

describe('ThreadHistoryListView — keyboard (AC-22.2)', () => {
  it('↑/↓ move focus between thread links across group boundaries; Home/End jump to the first/last link', async () => {
    const user = userEvent.setup();
    renderView({ state: { kind: 'ready', groups: GROUPS } });
    const link = (name: string) => screen.getByRole('link', { name });

    link('Отчёт').focus();
    await user.keyboard('{ArrowDown}');
    expect(link('Заметки')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(link('Архив')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(link('Архив')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(link('Заметки')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(link('Отчёт')).toHaveFocus();
    await user.keyboard('{End}');
    expect(link('Архив')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(link('План релиза')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(link('План релиза')).toHaveFocus();
  });
});

describe('ThreadHistoryListView — deleting a thread that is not open (AC-06.3)', () => {
  it.each([
    { name: 'moves focus to the next link, across group boundaries', id: 'b', title: 'Отчёт', focused: 'Заметки' },
    { name: 'from the last link falls back to the previous one', id: 'd', title: 'Архив', focused: 'Заметки' },
  ])('«⋯» → «Удалить» → «Удалить» deletes the thread and $name', async ({ id, title, focused }) => {
    const user = userEvent.setup();
    const onDelete = vi.fn<(entry: ThreadListEntry) => void>();
    render(<DeletableList onDelete={onDelete} />, { wrapper: Wrapper });

    await user.click(screen.getByRole('button', { name: `Действия с беседой «${title}»` }));
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Удалить' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Удалить беседу?' });
    await user.click(within(dialog).getByRole('button', { name: 'Удалить' }));

    expect(onDelete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id, title }));
    expect(screen.queryByRole('link', { name: title })).toBeNull();
    await waitFor(() => expect(screen.getByRole('link', { name: focused })).toHaveFocus());
  });
});
