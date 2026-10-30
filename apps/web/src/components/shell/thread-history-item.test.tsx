import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ThreadListEntry } from '@/lib/threads/group-threads-by-date';
import { ThreadHistoryItem } from './thread-history-item';

type User = ReturnType<typeof userEvent.setup>;

const entry = (title: string | undefined): ThreadListEntry => ({
  id: 'a',
  remoteId: 'a',
  title,
  activityAt: 0,
  isRunning: false,
});

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <ul>{children}</ul>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function renderItem(title: string | undefined) {
  const onRename = vi.fn<(title: string) => void>();
  render(
    <ThreadHistoryItem
      entry={entry(title)}
      isActive={false}
      titlePending={false}
      onRename={onRename}
      onRequestDelete={vi.fn()}
    />,
    { wrapper: Wrapper },
  );
  return { onRename };
}

/** «⋯» → «Переименовать»; resolves with the focused title field. */
async function startRename(user: User, title: string): Promise<HTMLInputElement> {
  const trigger = screen.getByRole('button', { name: `Действия с беседой «${title}»` });
  await user.click(trigger);
  const menu = await screen.findByRole('menu');
  await user.click(within(menu).getByRole('menuitem', { name: 'Переименовать' }));
  const field = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Название беседы' });
  await waitFor(() => expect(field).toHaveFocus());
  return field;
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations');
});

describe('ThreadHistoryItem — «⋯» menu (SB-07)', () => {
  it('the «⋯» button names the thread, announces a menu and offers «Переименовать» and «Удалить»', async () => {
    const user = userEvent.setup();
    renderItem('План релиза');

    const trigger = screen.getByRole('button', { name: 'Действия с беседой «План релиза»' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await user.click(trigger);

    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Переименовать',
      'Удалить',
    ]);
  });
});

describe('ThreadHistoryItem — rename field (SB-08, AC-05.1–05.3, FR-15)', () => {
  it('Enter saves the trimmed title once, closes the field and returns focus to the thread link', async () => {
    const user = userEvent.setup();
    const { onRename } = renderItem('План релиза');

    const field = await startRename(user, 'План релиза');
    expect(field).toHaveValue('План релиза');
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe('План релиза'.length);
    await user.clear(field);
    await user.type(field, '  Отчёт Q3  {Enter}');

    expect(onRename).toHaveBeenCalledExactlyOnceWith('Отчёт Q3');
    expect(screen.queryByRole('textbox', { name: 'Название беседы' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('link', { name: 'План релиза' })).toHaveFocus());
  });

  it('focuses the field before the menu popup finishes a long exit animation', async () => {
    // jsdom has no Web Animations; base-ui waits for what getAnimations reports before finishing a close.
    // The exit animation is long against the wait below, so focusing only after it ends fails the wait,
    // and the animation clock is the only reference: no tight wall-clock bound that load could trip.
    let animationFinished = false;
    const slowExit = {
      effect: { getTiming: () => ({ duration: 4000, iterations: 1 }) },
      finished: new Promise<void>((resolve) =>
        setTimeout(() => {
          animationFinished = true;
          resolve();
        }, 4000),
      ),
      pending: false,
      playState: 'running',
    };
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: () => [slowExit] });
    const user = userEvent.setup();
    renderItem('План релиза');

    await user.click(screen.getByRole('button', { name: 'Действия с беседой «План релиза»' }));
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Переименовать' }));

    const field = await screen.findByRole('textbox', { name: 'Название беседы' }, { timeout: 2500 });
    await waitFor(() => expect(field).toHaveFocus(), { timeout: 2500 });
    expect(animationFinished).toBe(false);
  });

  it('Esc cancels without saving and returns focus to the thread link', async () => {
    const user = userEvent.setup();
    const { onRename } = renderItem('План релиза');

    const field = await startRename(user, 'План релиза');
    await user.clear(field);
    await user.type(field, 'Другое{Escape}');

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Название беседы' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('link', { name: 'План релиза' })).toHaveFocus());
  });

  it('empty + Enter keeps the field open with aria-invalid and «Введите название», without onRename', async () => {
    const user = userEvent.setup();
    const { onRename } = renderItem('План релиза');

    const field = await startRename(user, 'План релиза');
    await user.clear(field);
    await user.type(field, '   {Enter}');

    expect(onRename).not.toHaveBeenCalled();
    expect(field).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Введите название');
    expect(screen.getByText('Введите название')).toBeVisible();

    await user.type(field, 'x');

    expect(field).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText('Введите название')).toBeNull();
  });

  it('Enter on the unchanged title closes the field without onRename', async () => {
    const user = userEvent.setup();
    const { onRename } = renderItem('План релиза');

    const field = await startRename(user, 'План релиза');
    await user.type(field, '{End}  {Enter}');

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Название беседы' })).toBeNull();
  });

  it('leaving the field saves a valid changed title', async () => {
    const user = userEvent.setup();
    const { onRename } = renderItem('План релиза');

    const field = await startRename(user, 'План релиза');
    await user.clear(field);
    await user.type(field, 'Отчёт Q3');
    await user.click(document.body);

    expect(onRename).toHaveBeenCalledExactlyOnceWith('Отчёт Q3');
    expect(screen.queryByRole('textbox', { name: 'Название беседы' })).toBeNull();
  });

  it('accepts at most 200 characters and blocks global shortcuts inside the field', async () => {
    const user = userEvent.setup();
    renderItem('План релиза');

    const field = await startRename(user, 'План релиза');
    expect(field).toHaveAttribute('maxLength', '200');
    expect(field.closest('[data-shortcuts-blocked]')).not.toBeNull();
    await user.clear(field);
    await user.type(field, 'я'.repeat(201));

    expect(field).toHaveValue('я'.repeat(200));
  });
});

describe('ThreadHistoryItem — title (AC-01.6, D-06)', () => {
  it('a thread without a title reads «Новая беседа» and opens the field with it', async () => {
    const user = userEvent.setup();
    renderItem(undefined);

    expect(screen.getByRole('link', { name: 'Новая беседа' })).toHaveAttribute('href', '/chat/a');
    const field = await startRename(user, 'Новая беседа');

    expect(field).toHaveValue('Новая беседа');
  });

  it('a truncated title shows the full title in a tooltip on hover', async () => {
    const LONG_TITLE = 'Очень длинное название беседы, которое не помещается в строку сайдбара';
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
    const user = userEvent.setup();
    renderItem(LONG_TITLE);

    await user.hover(screen.getByRole('link', { name: LONG_TITLE }));

    const tooltip = await screen.findByText(LONG_TITLE, { selector: '[data-slot="tooltip-content"]' }, { timeout: 2000 });
    expect(tooltip).toBeVisible();
  });

  it('a title that fits shows no tooltip on hover', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
    const user = userEvent.setup();
    renderItem('Отчёт');

    await user.hover(screen.getByRole('link', { name: 'Отчёт' }));
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  });
});
