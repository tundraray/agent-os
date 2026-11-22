import { render, screen, waitFor } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { createShellServices } from '@/lib/threads/shell-services';
import { currentUser } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { ShellServicesContext } from '@/components/shell/shell-actions';
import { LanguageSection } from './language-section';

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh }),
}));

const API = 'http://api.test';

type Row = {
  name: string;
  status: number;
  checked: string;
  language: 'en' | 'ru';
  refreshes: number;
  alert: boolean;
};

// AC-02.1 (client half), DC-2: a confirmed choice redraws the page in the new language; a refused one
// puts the saved language back and says so.
describe('LanguageSection', () => {
  it.each<Row>([
    {
      name: 'the server saves the choice',
      status: 204,
      checked: 'English',
      language: 'en',
      refreshes: 1,
      alert: false,
    },
    {
      name: 'the server refuses the choice',
      status: 500,
      checked: 'Русский',
      language: 'ru',
      refreshes: 0,
      alert: true,
    },
  ])('$name', async ({ status, checked, language, refreshes, alert }) => {
    refresh.mockClear();
    server.use(
      http.put(
        `${API}/api/auth/me/language`,
        () => new HttpResponse(null, { status }),
      ),
    );
    const services = createShellServices();
    services.currentUser.setState({ user: currentUser({ language: 'ru' }) });
    const user = userEvent.setup();
    render(
      <ShellServicesContext.Provider value={services}>
        <LanguageSection currentUser={services.currentUser} />
      </ShellServicesContext.Provider>,
    );

    await user.click(screen.getByRole('radio', { name: 'English' }));

    if (alert) {
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Не удалось сохранить язык: попробуйте ещё раз.',
      );
    } else {
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    }
    expect(screen.getByRole('radio', { name: checked })).toBeChecked();
    expect(refresh).toHaveBeenCalledTimes(refreshes);
    expect(services.currentUser.getState().user?.language).toBe(language);
  });
});
