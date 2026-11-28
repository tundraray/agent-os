import { render, screen, waitFor } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { ThemeId } from '@agent-os/contracts';
import { ShellServicesContext } from '@/components/shell/shell-actions';
import { createShellServices } from '@/lib/threads/shell-services';
import { currentUser } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { ThemeSection } from './theme-section';

const API = 'http://api.test';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.cookie = 'aos_theme=; path=/; max-age=0';
});

type Row = {
  name: string;
  status: number;
  checked: string;
  page: ThemeId;
  stored: ThemeId | null;
  alert: boolean;
};

// Theming AC-08.3, DD §Acceptance Criteria FR-08: the check follows the profile, not the page («Как в организации»
// while the own theme is empty); a saved choice reaches the store; a refused one returns the page and the check to
// the saved theme and shows MC-6.
describe('ThemeSection', () => {
  it.each<Row>([
    {
      name: 'the server saves Nord',
      status: 204,
      checked: 'Nord',
      page: 'nord',
      stored: 'nord',
      alert: false,
    },
    {
      name: 'the server refuses Nord',
      status: 500,
      checked: 'Как в организации',
      page: 'petrol',
      stored: null,
      alert: true,
    },
  ])('$name', async ({ status, checked, page, stored, alert }) => {
    server.use(
      http.put(
        `${API}/api/auth/me/theme`,
        () => new HttpResponse(null, { status }),
      ),
    );
    document.documentElement.setAttribute('data-theme', 'petrol');
    const services = createShellServices();
    services.currentUser.setState({
      user: currentUser({ theme: null, organizationTheme: 'petrol' }),
    });
    const user = userEvent.setup();
    render(
      <ShellServicesContext.Provider value={services}>
        <ThemeSection currentUser={services.currentUser} />
      </ShellServicesContext.Provider>,
    );

    expect(
      screen.getByRole('radio', { name: 'Как в организации' }),
    ).toBeChecked();

    await user.click(screen.getByRole('radio', { name: 'Nord' }));

    if (alert) {
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Не удалось сохранить тему: попробуйте ещё раз.',
      );
    } else {
      await waitFor(() =>
        expect(services.currentUser.getState().user?.theme).toBe('nord'),
      );
    }
    expect(screen.getByRole('radio', { name: checked })).toBeChecked();
    expect(document.documentElement.getAttribute('data-theme')).toBe(page);
    expect(document.cookie).toContain(`aos_theme=${page}`);
    expect(services.currentUser.getState().user?.theme).toBe(stored);
  });
});
