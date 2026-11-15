// enterprise-access / identity (web) - integration skeleton
// Design Doc: docs/features/enterprise-access/design-identity.md (v2.0), C3 · web, Test Strategy UC-9; UXRD: docs/features/enterprise-access/uxrd.md
//   Screen 1 (LG-01..LG-03), Screen 2 (UM-01), Screen 3 (MA-03), MC-1, MC-2, MC-3, MC-6, MC-35.
// Generated: 2026-11-15 | Budget Used: 1 web integration skeleton (the part's 5th and last: 4 API ones in
//   apps/api/test/enterprise-access-identity.int.e2e-spec.ts), 0 web E2E (no browser tool in the repo; L1 browser checklist covers the rest).
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom). Case is `it.todo` - skeleton only.
//
// Harness (src/test/): `renderWithRuntime` mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname,
//   router spy) - extend it for `/login` and `/account` and for `?reason=`/`?error=`/`?next=`; MSW server from '@/test/msw-server'
//   (onUnhandledRequest: 'error'); the event source is injected as in agent-platform-web.int.test.tsx (`createTestLiveSource`). MSW
//   handlers to add in `src/test/`: `GET /api/auth/providers`, `GET /api/auth/me` (with `hasPassword`), `POST /api/auth/password`,
//   `POST /api/auth/password/change`, `POST /api/auth/sign-out`. API base URL: NEXT_PUBLIC_API_URL.
// Mock boundary: network (MSW) and next/navigation. The login page, UserMenu, the account page, the 401 handler, lib/threads/* and the
//   live store - real. Do NOT mock the handler.
//
// Replaced / adapted with the stub (not duplicated here):
//   - src/components/shell/user-menu.test.tsx and the «Меню пользователя dev-user» line of src/lib/i18n/i18n.test.tsx: rewritten for the
//     identity from `GET /api/auth/me` (name, email, «Выйти», no «Режим разработки»); the component-level proof of UM-01.
//   - src/lib/dev-user.ts is deleted with its imports.
// `provenAt: unit` (small component tests / tables next to the code): the 401 handler's reason mapping (AUTH_REQUIRED -> expired,
//   ACCOUNT_DISABLED -> disabled) and `next` carry-over; the login form's own states (one «Неверный логин или пароль.» for
//   INVALID_CREDENTIALS, «Слишком много попыток. Попробуйте позже.» for 429, login kept and password cleared, the «Показать пароль»
//   toggle, provider buttons by SignInOptions, the divider only when providers exist); the password section's errors by `reason`
//   (MC-35: `wrong_current_password`, `weak_password`).

import { describe, it } from 'vitest';

describe('enterprise-access / identity - web integration (jsdom + MSW)', () => {
  // AC: AC-01.1 "администратор не включил ни одного провайдера: страница входа только с формой логина и пароля и ничего из чата";
  //   AC-01.2 "верные логин и пароль: открывается его чат, а в меню его имя"; AC-01.5 (web half) "включены Google и Okta: форма и две
  //   кнопки с названиями"; AC-07.1 "выходит: следующий запрос из этого браузера получает страницу входа"; AC-01.4 (web half) "отказ
  //   «нужен вход» переводит на вход; после входа возвращает на ту же страницу"; AC-33.3 (web half) "смена своего пароля на «Мой
  //   доступ»". Design: DC-13; UC-9.
  // Behavior: the user passes through one story in one mounted shell -> each step is what the screen shows.
  // Steps (literal expected texts from uxrd.md MC-1, MC-2, MC-3, MC-6, MC-35):
  //   1. no session (`GET /api/auth/me` -> 401 AUTH_REQUIRED) on `/threads/<id>`, the providers list empty: the tab goes to
  //      `/login?next=/threads/<id>` and shows only the form «Логин», «Пароль», «Войти» - no divider, no provider buttons, no chat, no
  //      thread list, no «Зарегистрироваться» or «Забыли пароль?» link (AC-01.1)
  //   2. with one enabled provider «Okta» the page also shows the divider «или» and «Войти через Okta»; the button points at
  //      `/api/auth/sign-in/<providerId>?next=/threads/<id>` (the page does not call the provider itself)
  //   3. the form posts `POST /api/auth/password`; on 204 the same conversation is open, the menu header shows the name and email,
  //      «Выйти» present, «Режим разработки» absent; the menu's «Мой доступ» opens `/account` whose last section «Пароль» is present
  //      because `me.hasPassword` is true, and absent when `hasPassword` is false
  //   4. «Выйти» -> `POST /api/auth/sign-out` and the tab shows `/login?reason=signed_out` with «Вы вышли из Agent OS.»
  //   5. after a new sign-in a chat request answers 401 ACCOUNT_DISABLED -> `/login?reason=disabled` with «Ваша учётная запись
  //      отключена. Обратитесь к администратору Agent OS.»; and the live stream dropping without reconnect makes the client ask
  //      `GET /api/auth/me`, whose 401 gives the same redirect
  // Catches: one of the API clients (fetch or the event stream) missing the shared 401 handler, so a dead session shows a broken or empty
  //   chat instead of the login page; losing the page the employee was on; a stale identity or the old dev-user left in the menu; the
  //   password section shown to an employee who has no password; a registration path on the login page.
  // @category: integration
  // @dependency: login page, UserMenu, account page (MA-03), 401 handler in lib/threads and the live store, MSW, next/navigation mock
  // @complexity: medium
  it.todo('UC-9: an unauthenticated tab lands on the login form and returns to the same conversation after sign-in; sign-out and a 401 from a request or the stream send it back with the right reason; the password section follows hasPassword');
});
