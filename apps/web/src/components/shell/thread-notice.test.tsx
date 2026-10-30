import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ThreadNotice } from './thread-notice';

describe('ThreadNotice — TH-06 / TH-07 (AC-04.3, AC-02.5)', () => {
  it('not-found: «Беседа не найдена» with its reason and «Новый чат»; focus moves to its h1', async () => {
    const user = userEvent.setup();
    const onNewChat = vi.fn();
    render(<ThreadNotice variant="not-found" onNewChat={onNewChat} />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Беседа не найдена' });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(screen.getByText('Возможно, её удалили или ссылка указана неверно.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Новый чат' }));
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it('load-error: «Не удалось загрузить беседу» with «Повторить» and «Новый чат»; focus moves to its h1', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onNewChat = vi.fn();
    render(<ThreadNotice variant="load-error" onRetry={onRetry} onNewChat={onNewChat} />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Не удалось загрузить беседу' });
    expect(heading).toHaveFocus();
    expect(screen.getByText('Проверьте подключение и попробуйте ещё раз.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onNewChat).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Новый чат' }));
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it('deleted (E-8): inline «Беседа удалена» as h2, its reason in an alert describing «Новый чат»; no h1, no «Повторить»', async () => {
    const user = userEvent.setup();
    const onNewChat = vi.fn();
    render(<ThreadNotice variant="deleted" onNewChat={onNewChat} />);

    expect(screen.getByRole('heading', { level: 2, name: 'Беседа удалена' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Её удалили в другой вкладке или окне.');
    const newChat = screen.getByRole('button', { name: 'Новый чат' });
    expect(newChat).toHaveAccessibleDescription('Её удалили в другой вкладке или окне.');
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Перегенерировать' })).toBeNull();

    await user.click(newChat);
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it('deleted (E-8): focus moves to «Новый чат» when it fell out of the hidden composer, and stays put otherwise', () => {
    // The composer held focus and was removed: focus fell back to <body>.
    const first = render(<input aria-label="Сообщение" />);
    screen.getByRole('textbox', { name: 'Сообщение' }).focus();
    first.rerender(<ThreadNotice variant="deleted" onNewChat={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Новый чат' })).toHaveFocus();
    first.unmount();

    // Focus is elsewhere (e.g. in the sidebar): the notice does not take it.
    const second = render(<button type="button">Беседа B</button>);
    screen.getByRole('button', { name: 'Беседа B' }).focus();
    second.rerender(
      <>
        <button type="button">Беседа B</button>
        <ThreadNotice variant="deleted" onNewChat={vi.fn()} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Беседа B' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Новый чат' })).not.toHaveFocus();
  });
});
