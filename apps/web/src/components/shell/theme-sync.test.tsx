import { render, waitFor } from '@/test/render';
import { afterEach, describe, expect, it } from 'vitest';
import { createShellServices } from '@/lib/threads/shell-services';
import { currentUser } from '@/test/fixtures';
import { ThemeSync } from './theme-sync';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.cookie = 'aos_theme=; path=/; max-age=0';
});

// Theming AC-07.2, AC-08.4 (KD-4): the page was painted from a stale cookie; the first read of the employee with
// another effective theme puts it on the page and renews the cookie.
describe('ThemeSync', () => {
  it.each([
    {
      name: 'own theme changed elsewhere',
      theme: 'nord',
      org: 'graphite',
      expected: 'nord',
    },
    {
      name: 'organisation theme changed',
      theme: null,
      org: 'petrol',
      expected: 'petrol',
    },
  ] as const)('$name', async ({ theme, org, expected }) => {
    document.documentElement.setAttribute('data-theme', 'graphite');
    const services = createShellServices();
    render(<ThemeSync currentUser={services.currentUser} />);

    services.currentUser.setState({
      user: currentUser({ theme, organizationTheme: org }),
    });

    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe(
        expected,
      ),
    );
    expect(document.cookie).toContain(`aos_theme=${expected}`);
  });
});
