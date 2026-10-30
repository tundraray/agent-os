import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ThemeProvider } from '@/components/theme-provider';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { setTestMedia } from '@/test/setup';
import { UserMenu } from './user-menu';

/** The `RootLayout` theme configuration (DD «Тема, шрифт, токены»). */
function renderUserMenu() {
  return render(
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem enableColorScheme disableTransitionOnChange>
      <TooltipProvider>
        <SidebarProvider>
          <UserMenu />
        </SidebarProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

const isDark = (): boolean => document.documentElement.classList.contains('dark');

async function chooseTheme(user: ReturnType<typeof userEvent.setup>, label: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Меню пользователя dev-user' }));
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
    expect(screen.getByRole('button', { name: 'Меню пользователя dev-user' })).toHaveFocus();

    await chooseTheme(user, 'Светлая');
    await waitFor(() => expect(isDark()).toBe(false));

    // The OS prefers dark: «Системная» must switch <html> back to dark, then track the OS setting.
    await chooseTheme(user, 'Системная');
    await waitFor(() => expect(isDark()).toBe(true));

    setTestMedia({ colorScheme: 'light' });
    await waitFor(() => expect(isDark()).toBe(false));
  });
});

describe('UserMenu — composition (SB-11, AC-09.4)', () => {
  it('shows «dev-user», «Режим разработки» and the «Тема» group only — no «Выйти»/«Настройки»', async () => {
    const user = userEvent.setup();
    renderUserMenu();

    const trigger = screen.getByRole('button', { name: 'Меню пользователя dev-user' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(within(trigger).getByText('DU')).toBeInTheDocument();

    await user.click(trigger);
    const menu = await screen.findByRole('menu');

    expect(within(menu).getByText('dev-user')).toBeInTheDocument();
    expect(within(menu).getByText('Режим разработки')).toBeInTheDocument();
    const themeGroup = within(menu).getByRole('group', { name: 'Тема' });
    expect(within(themeGroup).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      'Светлая',
      'Тёмная',
      'Системная',
    ]);
    expect(within(themeGroup).getByRole('menuitemradio', { name: 'Системная' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(menu).queryAllByRole('menuitem')).toHaveLength(0);
    expect(within(menu).queryByText(/Выйти|Настройки|Аккаунт/)).toBeNull();
  });
});
