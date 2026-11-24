import { render, screen, waitFor } from '@/test/render';
import { UsersIcon } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { setTestMedia } from '@/test/setup';
import { DataTable, type DataTableRow } from './data-table';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function rowsOf(names: readonly string[]): DataTableRow[] {
  return names.map((name) => ({
    key: name,
    name,
    cells: [name],
    actions: [{ label: 'Убрать', onSelect: vi.fn() }],
  }));
}

function Screen({ names }: { names: readonly string[] }) {
  return (
    <>
      <h1 tabIndex={-1} data-shell-focus="page-title">
        Права
      </h1>
      <DataTable
        caption="Права"
        columns={[{ header: 'Цель' }]}
        state={{
          status: 'ready',
          rows: rowsOf(names),
          empty: {
            Icon: UsersIcon,
            title: 'Прав нет',
            description: 'Добавьте право.',
          },
        }}
      />
    </>
  );
}

// UXRD Accessibility «Строка таблицы ушла», design-admin.md C3 · web.
describe('DataTable', () => {
  it.each([
    {
      left: 'Б',
      before: ['А', 'Б', 'В'],
      reducedMotion: false,
      focused: 'Убрать: В',
    },
    {
      left: 'Б',
      before: ['А', 'Б', 'В'],
      reducedMotion: true,
      focused: 'Убрать: В',
    },
    {
      left: 'Б',
      before: ['А', 'Б'],
      reducedMotion: false,
      focused: 'Убрать: А',
    },
    { left: 'А', before: ['А'], reducedMotion: true, focused: 'h1' },
  ])(
    'after a row leaves, focus goes to the next row, else the previous one, else the page h1 ($left of $before, reduced motion $reducedMotion)',
    async ({ left, before, reducedMotion, focused }) => {
      setTestMedia({ queries: { [REDUCED_MOTION]: reducedMotion } });
      const { rerender } = render(<Screen names={before} />);
      screen.getByRole('button', { name: `Убрать: ${left}` }).focus();

      rerender(<Screen names={before.filter((name) => name !== left)} />);

      const target =
        focused === 'h1'
          ? screen.getByRole('heading', { name: 'Права' })
          : screen.getByRole('button', { name: focused });
      await waitFor(() => expect(target).toHaveFocus());
    },
  );

  // jsdom measures nothing: the cell's wrapper must state the content's width, or the button is clipped to 0 px.
  it('keeps a row action button in a wrapper as wide as its content', () => {
    render(<Screen names={['А']} />);

    const cell = screen
      .getByRole('button', { name: 'Убрать: А' })
      .closest('td');
    expect(cell?.firstElementChild).toHaveClass('min-w-max');
  });
});
