import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { threadList } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';

describe('AppSidebar — mobile drawer (S-11, AC-10.2)', () => {
  it('«Меню» opens the «История бесед» dialog focused on «Новый чат»; Esc closes it and focus returns to «Меню»', async () => {
    server.use(http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))));
    const user = userEvent.setup();
    renderWithRuntime({ pathname: '/', width: 375, pointer: 'coarse' });

    expect(screen.queryByRole('dialog', { name: 'История бесед' })).toBeNull();
    const menu = screen.getByRole('button', { name: 'Меню' });

    // A tap in mobile Safari does not focus the button: focus stays on <body> when the drawer opens,
    // so returning focus to «Меню» has to be explicit rather than "the previously focused element".
    fireEvent.click(menu);
    expect(menu).not.toHaveFocus();

    const drawer = await screen.findByRole('dialog', { name: 'История бесед' });
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(within(drawer).getByRole('button', { name: 'Новый чат' })).toHaveFocus());
    expect(within(drawer).getByRole('button', { name: 'Закрыть меню' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'История бесед' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Меню' })).toHaveFocus();
  });
});
