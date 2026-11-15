// enterprise-access / identity (web) - integration skeleton
// Design Doc: docs/features/enterprise-access/design-identity.md (v1.1), C3 · web, Test Strategy UC-9; UXRD: docs/features/enterprise-access/uxrd.md
//   Screen 1 (LG-01..LG-03), Screen 2 (UM-01), MC-3, MC-6.
// Generated: 2026-11-15 | Budget Used: 1 web integration skeleton (the part's 5th and last: 4 API ones in
//   apps/api/test/enterprise-access-identity.int.e2e-spec.ts), 0 web E2E (no browser tool in the repo; L1 browser checklist covers the rest).
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom). Case is `it.todo` - skeleton only.
//
// Harness (src/test/): `renderWithRuntime` mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname,
//   router spy) - extend it for `/login` and for `?reason=`/`?next=`; MSW server from '@/test/msw-server' (onUnhandledRequest: 'error');
//   the event source is injected as in agent-platform-web.int.test.tsx (`createTestLiveSource`). API base URL: NEXT_PUBLIC_API_URL.
// Mock boundary: network (MSW: `GET /api/auth/connections`, `GET /api/auth/me`, `POST /api/auth/sign-out`, thread routes) and
//   next/navigation. The login page, UserMenu, the 401 handler, lib/threads/* and the live store - real. Do NOT mock the handler.
//
// Replaced / adapted with the stub (not duplicated here):
//   - src/components/shell/user-menu.test.tsx and the «Меню пользователя dev-user» line of src/lib/i18n/i18n.test.tsx: rewritten
//     for the identity from `GET /api/auth/me` (name, email, «Выйти», no «Режим разработки»); this is the component-level proof of UM-01.
//   - src/lib/dev-user.ts is deleted with its imports.
// `provenAt: unit` (small tables next to the code): the 401 handler's reason mapping (AUTH_REQUIRED -> expired,
//   ACCOUNT_DISABLED -> disabled) and `next` carry-over; the login page's own states (LG-01..LG-03 by SignInOptions).

import { describe, it } from 'vitest';

describe('enterprise-access / identity - web integration (jsdom + MSW)', () => {
  // AC: AC-01.1 "сотрудник открывает Agent OS без сеанса: страница входа с кнопкой подключения и ничего из чата"; AC-07.1 "выходит:
  //   следующий запрос из этого браузера получает страницу входа"; AC-01.4 (web half) "отказ «нужен вход» переводит на вход; после
  //   входа возвращает на ту же страницу". Design: DC-13; UC-9.
  // Behavior: the user passes through one story in one mounted shell -> each step is what the screen shows.
  // Steps (literal expected texts from uxrd.md MC-2, MC-3, MC-6):
  //   1. no session (`GET /api/auth/me` -> 401 AUTH_REQUIRED) on `/threads/<id>`: the tab goes to `/login?next=/threads/<id>` and shows
  //      the buttons from `GET /api/auth/connections` («Войти через Okta», «Войти через Okta (SAML)») with no chat, no thread list
  //   2. the button points at `/api/auth/sign-in/<connectionId>?next=/threads/<id>` (the page does not call the IdP itself)
  //   3. signed in (`me` -> name and email): the same conversation is open and the menu header shows the name and email, «Выйти» present,
  //      «Режим разработки» absent
  //   4. «Выйти» -> `POST /api/auth/sign-out` and the tab shows `/login?reason=signed_out` with «Вы вышли из Agent OS.»
  //   5. after a new sign-in a chat request answers 401 ACCOUNT_DISABLED -> `/login?reason=disabled` with «Ваша учётная запись
  //      отключена. Обратитесь к администратору Agent OS.»; and the live stream dropping without reconnect makes the client ask
  //      `GET /api/auth/me`, whose 401 gives the same redirect
  // Catches: one of the API clients (fetch or the event stream) missing the shared 401 handler, so a dead session shows a broken or
  //   empty chat instead of the login page; losing the page the employee was on; a stale identity or the old dev-user left in the menu.
  // @category: integration
  // @dependency: login page, UserMenu, 401 handler in lib/threads and the live store, MSW, next/navigation mock
  // @complexity: medium
  it.todo('UC-9: an unauthenticated tab lands on the login page and returns to the same conversation after sign-in; sign-out and a 401 from a request or the stream send it back with the right reason');
});
