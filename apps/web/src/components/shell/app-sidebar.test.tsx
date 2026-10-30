import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, onTestFinished } from 'vitest';
import { threadList, threadSummary } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';

/** Length of the emulated drawer exit animation. */
const EXIT_ANIMATION_MS = 100;

/**
 * jsdom has no Web Animations, so base-ui unmounts a closed drawer at once. A browser keeps it mounted for the
 * exit transition and returns focus (`finalFocus`) only after it ends — later than the frame in which the shell
 * focuses its target. Every element here reports one finite animation that finishes after EXIT_ANIMATION_MS.
 */
function emulateExitAnimation(): void {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [
      {
        finished: new Promise((resolve) => setTimeout(resolve, EXIT_ANIMATION_MS)),
        effect: { getTiming: () => ({ duration: EXIT_ANIMATION_MS, iterations: 1 }) },
        pending: false,
        playState: 'finished',
      },
    ],
  });
  onTestFinished(() => {
    Reflect.deleteProperty(Element.prototype, 'getAnimations');
  });
}

/** Lets the emulated exit animation end, so the drawer's return focus has run. */
const afterExitAnimation = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, EXIT_ANIMATION_MS * 2));

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

  // AC-10.3: "When в шторке выбрана беседа, the system shall закрыть шторку, открыть беседу, фокус — на h1 шапки."
  it('a thread picked in the drawer closes it and focuses the page h1, not «Меню»', async () => {
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([threadSummary({ id: 'b', title: 'Беседа B' })]))),
    );
    const user = userEvent.setup();
    renderWithRuntime({ pathname: '/', width: 375, pointer: 'coarse' });

    fireEvent.click(screen.getByRole('button', { name: 'Меню' }));
    const drawer = await screen.findByRole('dialog', { name: 'История бесед' });
    const link = await within(drawer).findByRole('link', { name: 'Беседа B' });
    // The router is a spy: keep jsdom from following the href.
    link.addEventListener('click', (event) => event.preventDefault());

    emulateExitAnimation();
    await user.click(link);

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'История бесед' })).toBeNull());
    await afterExitAnimation();
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });

  // UXRD 7.4: SB-03 «Новый чат» with a coarse pointer focuses HD-03; the drawer must not pull focus back to «Меню».
  it('SB-03 «Новый чат» in the drawer closes it and focuses the page h1, not «Меню»', async () => {
    server.use(http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))));
    const user = userEvent.setup();
    renderWithRuntime({ pathname: '/', width: 375, pointer: 'coarse' });

    fireEvent.click(screen.getByRole('button', { name: 'Меню' }));
    const drawer = await screen.findByRole('dialog', { name: 'История бесед' });

    emulateExitAnimation();
    await user.click(within(drawer).getByRole('button', { name: 'Новый чат' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'История бесед' })).toBeNull());
    await afterExitAnimation();
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });
});
