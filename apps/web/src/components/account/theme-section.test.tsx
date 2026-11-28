import { render, screen, waitFor } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ShellServicesContext } from '@/components/shell/shell-actions';
import { createShellServices } from '@/lib/threads/shell-services';
import { ThemeSection } from './theme-section';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.cookie = 'aos_theme=; path=/; max-age=0';
});

// Theming AC-06.1, AC-03.1: the card of the current theme is checked; a choice repaints the page through the
// attribute, is kept in the cookie and is announced (MC-7).
describe('ThemeSection', () => {
  it('checks the current theme; choosing Nord sets the attribute, writes the cookie and announces it', async () => {
    document.documentElement.setAttribute('data-theme', 'petrol');
    const services = createShellServices();
    const user = userEvent.setup();
    render(
      <ShellServicesContext.Provider value={services}>
        <ThemeSection />
      </ShellServicesContext.Provider>,
    );

    expect(screen.getByRole('radio', { name: 'Петроль' })).toBeChecked();

    await user.click(screen.getByRole('radio', { name: 'Nord' }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('nord');
    expect(document.cookie).toContain('aos_theme=nord');
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Nord' })).toBeChecked(),
    );
    expect(services.announcer.getState().queue.at(-1)?.announcement).toEqual({
      key: 'account.theme.announced',
      values: { theme: 'Nord' },
    });
  });
});
