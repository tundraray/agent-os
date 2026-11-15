// enterprise-access / mcp-connect (web) - integration skeleton
// Design Doc: docs/features/enterprise-access/design-mcp-connect.md (v1.1), C3 · web, Test Strategy UC-6; UXRD: docs/features/enterprise-access/uxrd.md
//   Screen 2 (UM-01), Screen 3 (MA-01), RF-01, MC-6, MC-8, MC-10.
// Generated: 2026-11-15 | Budget Used: 1 web integration skeleton (the part's 5th and last: INT-1/INT-2 in
//   packages/agents/test/enterprise-access-mcp-connect.int.e2e-spec.ts, INT-3/INT-4 in apps/api/test/enterprise-access-mcp-connect.int.e2e-spec.ts),
//   0 web E2E (no browser tool in the repo; the L1 browser checklist covers the rest).
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom). Case is `it.todo` - skeleton only.
//
// Harness (src/test/): `renderWithRuntime` mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname and search
//   params, router spy) - extend it for `/account?connected=` and `/account?error=&server=`; MSW server from '@/test/msw-server'
//   (onUnhandledRequest: 'error'); the event source is injected as in agent-platform-web.int.test.tsx (`createTestLiveSource`).
//   Fixtures in src/test/fixtures.ts: add a tool-call history entry with outcome `auth_required`.
// Mock boundary: network (MSW: `GET /api/mcp/connections`, `DELETE /api/mcp/connections/:server`, `GET /api/auth/me`, thread routes with the
//   history entry) and next/navigation. The `/account` page, `UserMenu`, the shared 401 handler from `identity`, `lib/mcp`, the tool-call
//   block (`tool-fallback.aui.tsx`) - real. Do NOT mock the handler or the menu.
//
// Adapted, not duplicated: src/components/shell/user-menu.test.tsx is rewritten by `identity` for the `GET /api/auth/me` identity; the dot
//   and the number of the «Мой доступ» item are proven here (UM-01), not by a second test in that file.
// `provenAt: unit` (small tables next to the code): the status-to-label mapping of a connection row and the `connected`/`error` parameter
//   parsing; the `needs_auth` count helper behind the menu dot.
// NOT here: the 401 redirect (identity UC-9), the models/spend section of the page (part `access`), the admin screens (part `admin`).

import { describe, it } from 'vitest';

describe('enterprise-access / mcp-connect - web integration (jsdom + MSW)', () => {
  // AC: AC-14.1 "Аня видит Sentry со статусом «нужна аутентификация»"; AC-14.3 "Аня подключила аккаунт ... возвращается в Agent OS:
  //   статус - «подключено»"; AC-14.4 "Аня отключила аккаунт: статус - «нужна аутентификация»"; AC-14.5 "обновить токен не удалось:
  //   вызов получает ошибку «нужно подключить аккаунт» ... агент продолжает работу"; AC-14.6 "нет права на сервер: в списке его нет".
  //   Design: C3 · web; UC-6.
  // Behavior: the user passes one story in one mounted shell -> each step is what the screen shows and which request the page sent.
  // Steps (literal texts from uxrd.md MC-6, MC-8, MC-10; `GET /api/mcp/connections` answers `sentry` `needs_auth` and `jira` `connected`):
  //   1. the menu is closed: the avatar carries the dot and the screen-reader text «нужна аутентификация: 1»; open it: «Мой доступ» with the
  //      number 1; choose it -> `/account` lists `sentry` with the host of its url as the second line, the badge «Нужна аутентификация»
  //      and the button «Подключить» whose `href` is `/api/mcp/connections/sentry/connect` (a plain link: the page does not call the
  //      authorization server itself); `jira` shows «Подключено» and «Отключить»
  //   2. returning to `/account?connected=sentry` (list now answers both `connected`): the notice «Аккаунт sentry подключён» is shown,
  //      focus is on the button of the `sentry` row, the dot and the number are gone from the menu
  //   3. «Отключить» at `jira` -> exactly one `DELETE /api/mcp/connections/jira`, and the row is at once «Нужна аутентификация» with
  //      «Подключить» (no waiting for the next list load); the menu number becomes 1 again
  //   4. returning to `/account?error=connect_failed&server=sentry`: under the `sentry` row the text «Не удалось подключить аккаунт sentry:
  //      вход отменён или не завершён. Попробуйте ещё раз.»; the badge stays «Нужна аутентификация»
  //   5. an empty list (`[]`, as for an employee without the right) shows «Подключать пока нечего» and the explanation line, no rows;
  //      a failing `GET` shows «Не удалось загрузить подключения» with «Повторить», which loads again
  //   6. open a conversation whose history holds a call with outcome `auth_required` on `sentry`: the block reads «нужен вход в
  //      аккаунт» with the warning icon and the line «Подключите аккаунт sentry в разделе «Мой доступ»» whose link «Мой доступ» points at
  //      `/account`, and it has no result section; a neighbouring call with outcome «отказано» still shows its own reason, unchanged
  // Catches: the connect button wired to a `fetch` instead of a navigation (the browser then never leaves for the owner's sign-in);
  //   a stale connection list after «Отключить» or after the return (the employee thinks an account is connected when it is not);
  //   the menu dot and number out of step with the list; `auth_required` shown as a red refusal, a bare unknown outcome or an empty block,
  //   so the employee cannot tell that they themselves can fix it; an error parameter that is silently ignored.
  // @category: integration
  // @dependency: /account page, lib/mcp client, UserMenu, tool-call block (tool-fallback.aui.tsx), MSW, next/navigation mock
  // @complexity: medium
  it.todo('UC-6: the connections page, the menu dot and the call block tell the employee which accounts need sign-in, update at once after return and disconnect, and show the auth_required outcome with a link to «Мой доступ»');
});
