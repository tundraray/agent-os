import { render, screen } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { ProviderButtonList } from '@agent-os/contracts';
import { server } from '@/test/msw-server';
import { LoginForm, type LoginFormProps } from './login-form';

const API = 'http://api.test';
const GOOGLE_ID = '11111111-1111-4111-8111-111111111111';
const OKTA_ID = '22222222-2222-4222-8222-222222222222';
const PROVIDERS: ProviderButtonList = [
  { id: GOOGLE_ID, name: 'Google', type: 'google' },
  { id: OKTA_ID, name: 'Okta', type: 'oidc' },
];

function serveProviders(list: ProviderButtonList): void {
  server.use(
    http.get(`${API}/api/auth/providers`, () => HttpResponse.json(list)),
  );
}

describe('login page: form only without providers, divider and buttons with them, one reason for any bad credential with the password cleared, and the reason of the query shown above the form', () => {
  it('shows only the form without providers (AC-01.1, AC-32.3)', async () => {
    serveProviders([]);
    render(<LoginForm />);

    expect(
      await screen.findByRole('button', { name: 'Войти' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Забыли пароль — обратитесь к администратору Agent OS.'),
    ).toBeInTheDocument();
    // Wait for the provider request to settle before asserting the absence of its buttons.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('или')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it.each([
    { next: '/chat/abc?x=1', expectedNext: '/chat/abc?x=1' },
    { next: '//evil.example', expectedNext: '/' },
    { next: 'https://evil.example', expectedNext: '/' },
    { next: '/\t/evil.example', expectedNext: '/' },
    { next: '/\n/evil.example', expectedNext: '/' },
  ])(
    'adds the divider and one button per provider in answer order, next $next → $expectedNext',
    async ({ next, expectedNext }) => {
      serveProviders(PROVIDERS);
      render(<LoginForm next={next} />);

      const links = await screen.findAllByRole('link');
      expect(screen.getByText('или')).toBeInTheDocument();
      expect(links.map((link) => link.textContent)).toEqual([
        'Войти через Google',
        'Войти через Okta',
      ]);
      const query = new URLSearchParams({ next: expectedNext }).toString();
      expect(links[0]).toHaveAttribute(
        'href',
        `/api/auth/sign-in/${GOOGLE_ID}?${query}`,
      );
    },
  );

  it('gives one reason for a bad credential, keeps the login, clears the password and focuses it (AC-01.3)', async () => {
    serveProviders([]);
    server.use(
      http.post(`${API}/api/auth/password`, () =>
        HttpResponse.json(
          {
            statusCode: 401,
            message: 'Invalid credentials',
            errorCode: 'INVALID_CREDENTIALS',
          },
          { status: 401 },
        ),
      ),
    );
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText('Логин'), 'anya');
    await user.type(screen.getByLabelText('Пароль'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Неверный логин или пароль.',
    );
    expect(screen.getByLabelText('Логин')).toHaveValue('anya');
    const password = screen.getByLabelText('Пароль');
    expect(password).toHaveValue('');
    expect(password).toHaveFocus();
  });

  it('stops an empty field with a field error and sends no request', async () => {
    serveProviders([]);
    let signInRequests = 0;
    server.use(
      http.post(`${API}/api/auth/password`, () => {
        signInRequests += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText('Логин'), 'anya');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByText('Введите пароль')).toBeInTheDocument();
    expect(screen.getByLabelText('Пароль')).toHaveFocus();
    expect(signInRequests).toBe(0);
  });

  it.each<{ query: LoginFormProps; text: string }>([
    { query: { reason: 'expired' }, text: 'Сеанс закончился. Войдите снова.' },
    { query: { reason: 'signed_out' }, text: 'Вы вышли из Agent OS.' },
    {
      query: { reason: 'disabled' },
      text: 'Ваша учётная запись отключена. Обратитесь к администратору Agent OS.',
    },
    {
      query: { error: 'cancelled', provider: GOOGLE_ID },
      text: 'Вход отменён. Попробуйте ещё раз.',
    },
    {
      query: { error: 'failed', provider: OKTA_ID },
      text: 'Не удалось войти через Okta. Попробуйте ещё раз или обратитесь к администратору Agent OS.',
    },
    {
      query: { error: 'no_email', provider: GOOGLE_ID },
      text: 'Google не сообщил вашу почту, поэтому войти нельзя. Войдите другим способом или обратитесь к администратору Agent OS.',
    },
    {
      query: { error: 'account_disabled', provider: GOOGLE_ID },
      text: 'Ваша учётная запись отключена. Обратитесь к администратору Agent OS.',
    },
    {
      query: { error: 'provider_unavailable' },
      text: 'Не удалось войти. Попробуйте ещё раз или обратитесь к администратору Agent OS.',
    },
  ])(
    'shows the reason of the query $query above the form',
    async ({ query, text }) => {
      serveProviders(PROVIDERS);
      render(<LoginForm {...query} />);

      expect(await screen.findByText(text)).toBeInTheDocument();
    },
  );
});
