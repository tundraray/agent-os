import { describe, expect, it, vi } from 'vitest';
import { redirectToLogin } from './session-redirect';

// DC-13: the 401 code picks the login reason, and `next` brings the employee back to the same page
describe('lib/auth/session-redirect: redirectToLogin', () => {
  it.each([
    {
      code: 'AUTH_REQUIRED',
      pathname: '/chat/t-1',
      search: '',
      to: '/login?reason=expired&next=%2Fchat%2Ft-1',
    },
    {
      code: 'ACCOUNT_DISABLED',
      pathname: '/agents/a-1',
      search: '?tab=run',
      to: '/login?reason=disabled&next=%2Fagents%2Fa-1%3Ftab%3Drun',
    },
    { code: undefined, pathname: '/', search: '', to: '/login?reason=expired&next=%2F' },
    { code: 'SOMETHING_ELSE', pathname: '/account', search: '', to: '/login?reason=expired&next=%2Faccount' },
  ])('401 $code on $pathname$search → $to', ({ code, pathname, search, to }) => {
    const assign = vi.fn<(url: string) => void>();

    redirectToLogin(code, { pathname, search, assign });

    expect(assign).toHaveBeenCalledExactlyOnceWith(to);
  });
});
