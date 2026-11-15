import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/components/theme-provider';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { apiBaseUrl } from '@/lib/config';
import { createShellServices } from '@/lib/threads/shell-services';
import { currentUser } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { setTestMedia } from '@/test/setup';
import { ShellServicesContext } from './shell-actions';
import { UserMenu } from './user-menu';

function Harness({ location }: { location: Pick<Location, 'assign'> }) {
  const [services] = useState(() => createShellServices({ location }));
  return (
    <ShellServicesContext.Provider value={services}>
      <UserMenu />
    </ShellServicesContext.Provider>
  );
}

/** The `RootLayout` theme configuration (DD «Тема, шрифт, токены»); `assign` stands in for the page navigation. */
function renderUserMenu(assign: (url: string) => void = vi.fn()) {
  return render(
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem enableColorScheme disableTransitionOnChange>
      <TooltipProvider>
        <SidebarProvider>
          <Harness location={{ assign }} />
        </SidebarProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

const MENU_BUTTON = 'Меню пользователя Аня Смирнова';

const isDark = (): boolean => document.documentElement.classList.contains('dark');

async function chooseTheme(user: ReturnType<typeof userEvent.setup>, label: string): Promise<void> {
  await user.click(await screen.findByRole('button', { name: MENU_BUTTON }));
  const menu = await screen.findByRole('menu');
  await user.click(within(menu).getByRole('menuitemradio', { name: label }));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.style.colorScheme = '';
});

describe('UserMenu — theme (TM-01, AC-09.1, AC-12.1)', () => {
  it('«Тёмная» puts `dark` on <html>; «Системная» follows prefers-color-scheme', async () => {
    setTestMedia({ colorScheme: 'dark' });
    const user = userEvent.setup();
    renderUserMenu();

    await chooseTheme(user, 'Светлая');
    await waitFor(() => expect(isDark()).toBe(false));

    await chooseTheme(user, 'Тёмная');
    await waitFor(() => expect(isDark()).toBe(true));
    expect(screen.getByRole('button', { name: MENU_BUTTON })).toHaveFocus();

    await chooseTheme(user, 'Светлая');
    await waitFor(() => expect(isDark()).toBe(false));

    // The OS prefers dark: «Системная» must switch <html> back to dark, then track the OS setting.
    await chooseTheme(user, 'Системная');
    await waitFor(() => expect(isDark()).toBe(true));

    setTestMedia({ colorScheme: 'light' });
    await waitFor(() => expect(isDark()).toBe(false));
  });
});

describe('UserMenu — the signed-in employee (UM-01, AC-01.2, MC-6)', () => {
  it("menu shows the employee's name and email, «Мой доступ» and «Выйти», no dev-mode caption; «Выйти» signs out and opens the login page", async () => {
    const steps: string[] = [];
    server.use(
      http.post(`${apiBaseUrl}/api/auth/sign-out`, () => {
        steps.push('sign-out');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderUserMenu((url) => steps.push(`assign ${url}`));

    const trigger = await screen.findByRole('button', { name: MENU_BUTTON });
    expect(within(trigger).getByText('АС')).toBeInTheDocument();

    await user.click(trigger);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Аня Смирнова')).toBeInTheDocument();
    expect(within(menu).getByText('anya@corp.example')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Мой доступ' })).toHaveAttribute('href', '/account');
    expect(within(menu).queryByText(/разработки/)).toBeNull();

    await user.click(within(menu).getByRole('menuitem', { name: 'Выйти' }));
    await waitFor(() => expect(steps).toEqual(['sign-out', 'assign /login?reason=signed_out']));
  });

  it('without a name the block shows the email up to «@»', async () => {
    server.use(http.get(`${apiBaseUrl}/api/auth/me`, () => HttpResponse.json(currentUser({ name: '' }))));
    renderUserMenu();

    expect(await screen.findByRole('button', { name: 'Меню пользователя anya' })).toBeInTheDocument();
  });
});
