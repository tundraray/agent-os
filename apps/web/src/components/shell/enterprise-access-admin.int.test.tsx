// enterprise-access / admin (web) - integration skeleton
// Design Doc: docs/features/enterprise-access/design-admin.md (v1.4), Test Strategy UC-1..UC-10, UC-E1..UC-E9; UXRD: docs/features/enterprise-access/uxrd.md (v2.2)
//   Screens AD-01..AD-11, AD-14..AD-16, GR-01, GR-02; MC-19, MC-22..MC-30, MC-33, MC-34.
// API contracts the rows follow (built): packages/contracts/src/identity.ts, mcp.ts, access.ts; controllers apps/api/src/identity/admin-*.controller.ts,
//   agents/admin-mcp-servers.controller.ts, access/admin-models.controller.ts, access/admin-access.controller.ts.
// Generated: 2026-11-16 (rewritten to the final design; replaces the 2026-11-15 five-skeleton version).
// Budget Used: 3/3 web integration skeletons (INT-1..INT-3), each a table of rows; 0 web E2E (the design's Test Strategy names none; its
//   «L1-сценарии в браузере» table is the manual real-browser acceptance and is not turned into skeletons).
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom). Cases are `it.todo` - skeletons only.
//
// Harness (src/test/): `renderWithRuntime` mounts ChatRuntimeProvider + ChatShell + Toaster with mocked next/navigation (controlled pathname,
//   router spy). MSW server from '@/test/msw-server' (`onUnhandledRequest: 'error'`: a request the screen must NOT send fails the test); `deferred()` and
//   `currentUser({ isAdmin })` from '@/test/fixtures'. Test support the implementation tasks add is listed in the report of this skeleton and is marked
//   `[support]` below. Response bodies are built by fixtures that pass the `@agent-os/contracts` schemas (grant holder `{ kind: 'role' | 'user' }`).
// Mock boundary: network (MSW: `GET /api/auth/me`, `/api/admin/*`, the reads the shell makes anyway), next/navigation, the same-tab navigation
//   (`location.assign`, jsdom does not navigate), the clipboard, and the logger module (a recording stand-in: the logger is the Sentry/console boundary).
//   Real: shell route parsing, AdminGate, the panel sidebar and user menu, `apiRequest` with its 401 / 403 handlers, `adminApi`, `useResource`,
//   `DataTable`, `AdminForm`, `SecretField`, `CopyValue`, toast, announcer, focus service. Do NOT mock any of them.
//
// Server-side proofs are NOT repeated: that a non-admin is refused on every admin route, the last-admin and quota rules, quotas rounded to cents,
//   that deleting a model deletes its grants and that no secret leaves the API are proven by the API tests of identity, mcp-connect and access. This
//   file proves only what the browser does with those answers: what it shows, what it sends, what it keeps.
//
// `provenAt: unit` (table-driven tests next to the code, named for the plan; one table per rule, cases as rows):
//   - `parseShellRoute` (shell-route.test.ts): every address of C3 · web; `/admin/servers/new` opens the server named `new` while
//     `/admin/register-server` opens the form; `/admin` and an unknown address under it open «Сотрудники»; percent-decoded keys.
//   - `useResource` / `usePagedResource`: a response for a previous key and one after unmount are dropped, one log record per error, the «Показать
//     ещё» error keeps the loaded rows; the 300 ms employee search debounce and the stale search answer («ан» arriving after «аня») - DC-3.
//   - `apiRequest` / `ApiRequestError` (api-request.test.ts): `PUT`, 204 without body, `reason` carried from the body, the 401 and the 403
//     `ADMIN_REQUIRED` handlers called once each, `describeApiError` has method, path, status, code and reason and never a body; `adminApi` paths
//     with `encodeURIComponent` (server name, model id `anthropic/...`).
//   - `describeAdminError`: code and `reason` -> UXRD text for LOGIN_TAKEN, EMAIL_TAKEN, `weak_password`, ROLE_NAME_TAKEN, `GRANT_INVALID`
//     (`deny_for_role`, `quota_not_on_model_allow`, `quota_out_of_range`), `GRANT_TARGET_UNKNOWN` (`server_unknown`, `tool_unknown`, `model_unknown`),
//     GRANT_EXISTS, PROVIDER_CHECK_FAILED (`insecure_url`, `unreachable`, `invalid_document`), MCP_SERVER_CHECK_FAILED (seven reasons of MC-29),
//     MCP_SERVER_NAME_TAKEN, MODEL_ID_TAKEN; the fallback to the server's `message` for a code or reason with no UXRD text (PUBLIC_URL_REQUIRED,
//     `invalid_cursor`, NOT_LOCAL_ACCOUNT, BUILTIN_ROLE).
//   - form rules (pure functions): account (login, name, email, password 12..256), role name 1..80, provider name 1..60, server name kebab-case 1..32,
//     https address, token <= 4096, model id `anthropic/<name>` and the four prices with comma decimals, long-context threshold; sign-in settings
//     hours <-> minutes both ways, comma decimals, MC-33 bounds (idle 0,25..24 h = 15..1440 min, total 1..720 h = 60..43200 min, total >= idle);
//     grant quota 0,01..1 000 000 with two decimals, empty = no quota, sent as a number without float drift («0,29» -> 0.29).
//   - orphan-grant detection (GR-02), `formatQuota` / `formatPrice` / `formatSpend`, status and mode labels, the «читает» / «меняет» mark (a tool
//     without the mark is «меняет»).
//   - `DataTable` focus after a removed row (next row, else previous, else `h1`) and `AdminForm` focus on the first field with an error: component
//     tests next to the components.
//
// `not automated`: density, tokens, contrast and the keyboard order across the panel (NFR-05, UC-N1) - component tests of the primitives and the L1
//   browser table; the loss of a deleted role's rights for running agents (AC-25.2, server half) - proven by `access`; FR-31 (audit journal) is out of
//   the feature; delete-user does not exist.
//
// AC proof map (one proof per AC):
//   AC-24.1 INT-1 | AC-24.2 INT-1 | AC-25.1 INT-2 | AC-25.2 INT-2 (panel half: confirmed DELETE, list, notice; rights loss - `access`) | AC-25.3 INT-2
//   AC-26.1 INT-3 | AC-26.3 INT-3 | AC-26.4 INT-3 | AC-27.1 INT-3 | AC-28.2 INT-2 | AC-29.2 INT-2 | NFR-02 (web half) INT-2 + INT-3 | NFR-05 not automated

import { IdentityErrorCode } from '@agent-os/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { trackRequests, type TrackedRequests } from '@/test/admin-support';
import {
  adminUserPage,
  adminUserSummary,
  currentUser,
  deferred,
  fixtureId,
  roleSummary,
  threadList,
  threadSummary,
} from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

vi.mock('@/lib/logger', async () => (await import('@/test/admin-support')).loggerModule);

const API = 'http://api.test';

/** `/api/admin/*` requests as «METHOD path», in the order they started. */
const adminRequests = ({ requests }: TrackedRequests): string[] =>
  requests.filter((request) => request.path.startsWith('/api/admin/')).map((request) => `${request.method} ${request.path}`);

/** Opens the user menu, reads its items (the theme radios aside) and closes it again. */
async function userMenuItems(user: UserEvent): Promise<string[]> {
  await user.click(screen.getByRole('button', { name: /^Меню пользователя/ }));
  const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  return items;
}

/** next/navigation is emulated: a link click must not make jsdom follow the href; the test sets the pathname. */
async function followLink(user: UserEvent, link: HTMLElement, setPathname: (pathname: string) => void): Promise<void> {
  const href = link.getAttribute('href');
  expect(href).not.toBeNull();
  link.addEventListener('click', (event) => event.preventDefault());
  await user.click(link);
  setPathname(href ?? '');
}

describe('enterprise-access / admin - web integration (jsdom + MSW)', () => {
  // INT-1 ---------------------------------------------------------------------------------------------------------------------------------
  // AC: AC-24.1 "Given администратор вошёл, when он открывает меню, then видит вход в панель, а в панели - все разделы, перечисленные в FR-24";
  //   AC-24.2 "Given у сотрудника нет права администратора, when он открывает адрес панели напрямую, then видит отказ, а не данные панели, и входа
  //   в панель в его меню нет". Design: DC-1, DC-2, KD-2, Flow 1; UC-1, UC-E1, UC-E2.
  // Behavior: the shell asks `GET /api/auth/me` once -> the panel and its requests exist only for an administrator; a 403 later takes the right
  //   away in place.
  // Rows (texts from uxrd.md MC-18, MC-19; `GET /api/auth/me` is held with `deferred()` in row 1):
  //   1. not an administrator (`isAdmin: false`) opens `/admin/roles`. Until `me` answers: the state «Право ещё не известно» (AD-01). Then «Нет
  //      доступа» / «Панель администратора открыта только администраторам Agent OS.» with «В чат»; the ORDINARY sidebar with the conversation list;
  //      no «Панель администратора» in the user menu; ZERO requests to `/api/admin/*` for the whole test ([support] request counter on
  //      `server.events` `request:start`, because the screen could swallow the unhandled-request error); «В чат» leaves without a chat restart
  //   2. an administrator (`isAdmin: true`) opens the user menu and chooses «Панель администратора»: «Сотрудники» is open, the sidebar shows «К чату»
  //      and exactly the sections «Сотрудники», «Роли», «Авторизация», «MCP-серверы», «Модели» (no «Журнал», no pauses), the focus is on the `h1`
  //      «Сотрудники», `document.title` is «Сотрудники — Панель — Agent OS»; the first request after `GET /api/auth/me` is `GET /api/admin/users`
  //   3. the administrator on `/admin/roles` presses «Создать роль» and creates one: `POST /api/admin/roles` answers `403 ADMIN_REQUIRED` - the SAME
  //      address now shows «Нет доступа», the ordinary sidebar, the menu without the panel item, no role row left on screen, and no further
  //      `/api/admin/*` request follows
  // Catches: the panel fetching `/api/admin/*` before `me` answers or for a non-admin (each such open writes `access_denied` to the audit) or showing
  //   its data until a 403 arrives; the 403 handler not wired into the shell, so an administrator whose right was withdrawn keeps a working-looking
  //   panel whose every action fails; a menu item shown to an employee who cannot use it.
  // @category: core-functionality
  // @dependency: parseShellRoute, AdminGate, CurrentUser store, AppSidebar, UserMenu, MainView, ThreadNotice, apiRequest 403 handler, adminApi, MSW, next/navigation mock
  // @complexity: medium
  it('INT-1 / UC-1 / UC-E1 / UC-E2: a non-administrator gets «Нет доступа» and sends no panel request; an administrator gets the panel with its five sections; a 403 ADMIN_REQUIRED turns the open panel into «Нет доступа» in place', async () => {
    // Arrange: the conversation list both employees have, the panel's reads and the refused «Создать роль»
    let threadReads = 0;
    server.use(
      http.get(`${API}/api/threads`, () => {
        threadReads += 1;
        return HttpResponse.json(threadList([threadSummary({ id: 'a', title: 'План релиза' })]));
      }),
      http.get(`${API}/api/admin/users`, () =>
        HttpResponse.json(
          adminUserPage([adminUserSummary({ id: fixtureId(2), name: 'Борис Ким', email: 'boris@corp.example' })]),
        ),
      ),
      http.get(`${API}/api/admin/roles`, () =>
        HttpResponse.json([
          roleSummary({ id: fixtureId(10), name: 'Супер-администратор', isAdmin: true, builtin: true, memberCount: 1 }),
          roleSummary({ id: fixtureId(100), name: 'SRE' }),
        ]),
      ),
      http.post(`${API}/api/admin/roles`, () =>
        HttpResponse.json(
          { statusCode: 403, message: 'Administrator right required', errorCode: IdentityErrorCode.ADMIN_REQUIRED },
          { status: 403 },
        ),
      ),
    );
    const user = userEvent.setup();

    // Row 1 - not an administrator opens `/admin/roles`; `GET /api/auth/me` is held
    const employeeMe = deferred();
    server.use(
      http.get(`${API}/api/auth/me`, async () => {
        await employeeMe.promise;
        return HttpResponse.json(currentUser({ isAdmin: false }));
      }),
    );
    const employee = trackRequests(server);
    const employeeView = renderWithRuntime({ pathname: '/admin/roles' });

    // Assert (row 1, «Право ещё не известно»): the table's Loading named «Роли», five skeleton rows in place of the sections
    expect(await screen.findByRole('status', { name: 'Роли' })).toBeInTheDocument();
    const unknownNav = screen.getByRole('navigation', { name: 'Панель' });
    expect(unknownNav.querySelectorAll('[data-slot="sidebar-menu-skeleton"]')).toHaveLength(5);
    expect(within(unknownNav).getAllByRole('link').map((link) => link.textContent)).toEqual(['К чату']);
    await waitFor(() => expect(employee.requests.map((request) => request.path)).toContain('/api/auth/me'));
    expect(employee.adminCount()).toBe(0);

    // Act (row 1): `me` answers «not an administrator»
    employeeMe.resolve();

    // Assert (row 1): «Нет доступа» with «В чат», the ordinary sidebar with the conversations, no panel item in the menu
    expect(await screen.findByRole('heading', { level: 1, name: 'Нет доступа' })).toBeInTheDocument();
    expect(screen.getByText('Панель администратора открыта только администраторам Agent OS.')).toBeInTheDocument();
    const toChat = screen.getByRole('link', { name: 'В чат' });
    expect(toChat).toHaveAttribute('href', '/');
    expect(screen.queryByRole('status', { name: 'Роли' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Панель' })).toBeNull();
    const employeeHistory = screen.getByRole('navigation', { name: 'История бесед' });
    expect(await within(employeeHistory).findByRole('link', { name: 'План релиза' })).toHaveAttribute('href', '/chat/a');
    expect(screen.getByRole('link', { name: 'Агенты' })).toBeInTheDocument();
    expect(await userMenuItems(user)).toEqual(['Мой доступ', 'Выйти']);

    // Act (row 1): «В чат»
    await followLink(user, toChat, employeeView.setPathname);

    // Assert (row 1): the chat opens in place - no reload of the tab, no second read of the list - and no panel request was ever sent
    await waitFor(() => expect(document.title).toBe('Новый чат — Agent OS'));
    expect(within(screen.getByRole('navigation', { name: 'История бесед' })).getByRole('link', { name: 'План релиза' })).toBeInTheDocument();
    expect(threadReads).toBe(1);
    expect(employeeView.assign).not.toHaveBeenCalled();
    expect(employee.adminCount()).toBe(0);
    employeeView.unmount();

    // Row 2 - an administrator on `/` chooses «Панель администратора» in the menu; `me` is held to mark when it answered
    threadReads = 0;
    const adminMe = deferred();
    let meAnsweredAfter = -1;
    server.use(
      http.get(`${API}/api/auth/me`, async () => {
        await adminMe.promise;
        meAnsweredAfter = administrator.requests.length;
        return HttpResponse.json(currentUser({ isAdmin: true, name: 'Игорь Петров', email: 'igor@corp.example' }));
      }),
    );
    const administrator = trackRequests(server);
    const adminView = renderWithRuntime({ pathname: '/' });
    await waitFor(() => expect(administrator.requests.map((request) => request.path)).toContain('/api/auth/me'));
    adminMe.resolve();

    // Act (row 2)
    await user.click(await screen.findByRole('button', { name: 'Меню пользователя Игорь Петров' }));
    await followLink(user, await screen.findByRole('menuitem', { name: 'Панель администратора' }), adminView.setPathname);

    // Assert (row 2): «Сотрудники» with its h1 focused and its tab title; «К чату», «Панель» and exactly the five sections
    const usersTitle = await screen.findByRole('heading', { level: 1, name: 'Сотрудники' });
    await waitFor(() => expect(usersTitle).toHaveFocus());
    await waitFor(() => expect(document.title).toBe('Сотрудники — Панель — Agent OS'));
    const panelNav = screen.getByRole('navigation', { name: 'Панель' });
    expect(within(panelNav).getByText('Панель')).toBeInTheDocument();
    expect(within(panelNav).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'К чату',
      'Сотрудники',
      'Роли',
      'Авторизация',
      'MCP-серверы',
      'Модели',
    ]);
    expect(within(panelNav).getByRole('link', { name: 'Сотрудники' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('navigation', { name: 'История бесед' })).toBeNull();
    expect(await screen.findByText('Борис Ким')).toBeInTheDocument();
    // The first panel request is the employees' list, and it started only after `me` had answered.
    expect(adminRequests(administrator)).toEqual(['GET /api/admin/users']);
    expect(meAnsweredAfter).toBeGreaterThan(0);
    expect(administrator.requests.findIndex((request) => request.path === '/api/admin/users')).toBeGreaterThanOrEqual(
      meAnsweredAfter,
    );

    // Act (row 3): «Роли», then «Создать роль» «Дежурный»; the API has withdrawn the right
    await followLink(user, within(panelNav).getByRole('link', { name: 'Роли' }), adminView.setPathname);
    expect(await screen.findByRole('heading', { level: 1, name: 'Роли' })).toBeInTheDocument();
    expect(await screen.findByText('SRE')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Создать роль' }));
    const dialog = await screen.findByRole('dialog', { name: 'Создать роль' });
    await user.type(within(dialog).getByLabelText('Название роли'), 'Дежурный');
    await user.click(within(dialog).getByRole('button', { name: 'Создать роль' }));

    // Assert (row 3): the same address shows «Нет доступа», the ordinary sidebar and a menu without the panel item; no role is left
    expect(await screen.findByRole('heading', { level: 1, name: 'Нет доступа' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('SRE')).toBeNull();
    expect(screen.queryByText('Супер-администратор')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Панель' })).toBeNull();
    const adminHistory = screen.getByRole('navigation', { name: 'История бесед' });
    expect(await within(adminHistory).findByRole('link', { name: 'План релиза' })).toBeInTheDocument();
    expect(await userMenuItems(user)).toEqual(['Мой доступ', 'Выйти']);
    expect(adminView.router.push).not.toHaveBeenCalled();
    expect(adminView.assign).not.toHaveBeenCalled();
    // No panel request followed the 403.
    expect(adminRequests(administrator)).toEqual(['GET /api/admin/users', 'GET /api/admin/roles', 'POST /api/admin/roles']);
    expect(administrator.requests.find((request) => request.method === 'POST')?.body).toEqual({ name: 'Дежурный' });
  });

  // INT-2 ---------------------------------------------------------------------------------------------------------------------------------
  // AC: AC-25.1 "Given администратор назначил Ане роли «SRE» и «Дежурный», when он открывает Аню, then видит обе роли и может снять каждую";
  //   AC-25.2 (panel half) "Given администратор удалил роль, ..." - the panel sends the confirmed delete and returns to the refreshed list;
  //   AC-25.3 "Given администратор открывает список сотрудников, when он заводит локальную учётную запись или сбрасывает пароль, then вводит
  //   логин, имя, почту и пароль в панели, и сотрудник появляется в списке с пометкой «локальная»";
  //   AC-28.2 "Given администратор даёт право на инструмент, when он выбирает инструмент, then выбирает его из списка инструментов сервера в реестре";
  //   AC-29.2 "Given администратор задал роли «SRE» квоту на Sonnet 50 $, а Ане - личную квоту 30 $, when он снова открывает роль и Аню, then видит
  //   обе квоты такими, какими их задал"; NFR-02 (password half). Design: DC-4, DC-5, DC-6, DC-12, DC-13, DC-14; UC-2..UC-6, UC-E6, UC-E9 (orphan).
  // Behavior: the administrator changes who may do what -> each action sends the one request the screen names, shows the server's refusal at the
  //   action that caused it, and every list shows the NEW READ, never a patch of the old copy (invariant 4); a destructive action goes out only
  //   after the confirmation that names its effect.
  // Rows (texts from uxrd.md MC-22..MC-26, MC-30; every row asserts the request method, path and body literally):
  //   1. local account (AC-25.3): «Завести учётную запись» -> «Логин», «Имя», «Почта», «Начальный пароль»; a password of 8 characters sends nothing and
  //      the focus is on the field («Пароль — от 12 до 256 знаков»); then one `POST /api/admin/users` with `{ login, name, email, password }`, the
  //      list is read again and the row carries «локальная» and the login under the name; the toast names the login («Учётная запись boris
  //      заведена») and not the password; `409 LOGIN_TAKEN` shows «Такой логин уже есть» at «Логин» with the other fields kept
  //   2. password reset (AC-25.3, NFR-02): on the page of that employee «Сбросить пароль» -> «Новый пароль для {имя}» -> one
  //      `PUT /api/admin/users/:id/password` with `{ password }` (204) -> «Пароль сброшен — передайте новый сотруднику»; reopening the dialog shows an
  //      EMPTY field; an employee with `login: null` has no «Сбросить пароль»; the typed password is in no part of the document after the answer and in no
  //      record of the logger stand-in
  //   3. roles of an employee (AC-25.1): Аня shows both «SRE» and «Дежурный», each with «Снять роль»; pressing one sends
  //      `DELETE /api/admin/users/:id/roles/:roleId` and after the new read it is gone; «Назначить роль» offers only the roles she lacks and sends
  //      `PUT /api/admin/users/:id/roles/:roleId`; «Дать лично» sends `PUT /api/admin/users/:id/admin` with `{ enabled: true }` and the row reads
  //      «есть: лично» after the new read
  //   4. built-in role (DC-5): the role list has «Супер-администратор» FIRST with «встроенная»; its page has no «Переименовать» and no «Удалить», and the
  //      «Право администратора» switch is on and disabled; on «Дежурный» the switch sends `PATCH /api/admin/roles/:id` with `{ isAdmin }`
  //   5. rights (AC-28.2, AC-29.2, DC-12, DC-14): on the role «SRE» «Добавить право» -> «Что»: «Инструмент сервера»: `jira` (`awaiting_admin_account`)
  //      cannot be chosen, `sentry` offers ONLY the tools of `GET /api/admin/mcp-servers/sentry` in Mono with «читает» / «меняет», the tool the role
  //      already has reads «уже есть» and cannot be chosen, there is no field to type a tool name; «Добавить» sends `POST /api/admin/grants` with
  //      `{ roleId, effect: 'allow', target: { kind: 'tool', server: 'sentry', tool } }`; the same dialog with «Модель» and «Квота за месяц, $» 50 sends
  //      `{ roleId, effect: 'allow', target: { kind: 'model', model }, quotaUsd: 50 }`; on Аня «Добавить запрет» for `update_issue` sends
  //      `{ userId, effect: 'deny', ... }` (a deny is never sent as allow); a personal quota 30; reopening the role and Аня shows 50 and 30 exactly as set;
  //      «Изменить квоту» 80 sends `PATCH /api/admin/grants/:id` with `{ quotaUsd: 80 }` and the list shows 80 from the new `GET /api/admin/grants`;
  //      an emptied field sends `{ quotaUsd: null }`
  //   6. server refusals of a right (DC-12): `409 GRANT_EXISTS`, `422 GRANT_TARGET_UNKNOWN`, `422 GRANT_INVALID` (with its `reason`) each leave the dialog
  //      OPEN with the fields kept and the text of the refusal in the form error; no grant row appears or changes
  //   7. orphan (DC-13): a role grant whose tool is no longer in `tools` of its server (and one whose server is gone) shows «Нет в реестре» with the single
  //      action «Убрать» -> `DELETE /api/admin/grants/:id`
  //   8. catalogue (AD-11): `GET /api/admin/models` shows name, the ID in Mono and four prices per million tokens, the long-context prices as a nested
  //      row «свыше {порог} входных токенов»; «Добавить модель» with prices typed with a comma sends `POST /api/admin/models` with numbers and
  //      `longContext: null`; `409 MODEL_ID_TAKEN` is a field error at «ID модели»; «Убрать из каталога» -> «Убрать модель «{название}» из каталога?»
  //      with the line that all rights to it are deleted -> ONE `DELETE /api/admin/models/anthropic%2F<name>` (the id with `/` encoded) -> the list is read
  //      again without the model; a role page opened afterwards (the server deleted the grants) shows no row for it
  //   9. confirmed destructive and rights-changing actions (UC-4, UC-6; one table: block, delete role, remove model - row 8 - and delete grant): the
  //      dialog names the object («Заблокировать {имя}?», «Удалить роль «{роль}»?»); «Отмена» and Escape send NOTHING; «Заблокировать» sends one
  //      `POST /api/admin/users/:id/block` and the page shows «Отключён» with «Разблокировать» and promises no instant stop of the agents; «Удалить» sends
  //      one `DELETE /api/admin/roles/:id`, opens the role list, toast «Роль удалена», focus on the `h1`; a `404` (`USER_NOT_FOUND`, `ROLE_NOT_FOUND`) or
  //      `409 BUILTIN_ROLE` answer is shown in words at the action and the resource is read again; while the request is open the confirm button
  //      is disabled (one request, not two)
  // Catches: a deny sent as an allow (or the reverse) or a right created on the wrong holder, the one mistake that silently opens or closes a server
  //   or tool; a tool typed by hand or a server without tools offered, creating a right that matches nothing; a model id with `/` sent unencoded
  //   (404 on delete); a quota that the list shows from the client's own arithmetic instead of the new read; a destructive request sent without the
  //   confirmation, twice, or for another object than the dialog named; a refused action that still changes the screen; the password kept in the
  //   dialog after the reset or reaching a toast or a log record; a built-in role offered «Удалить».
  // @category: core-functionality
  // @dependency: employees, roles, rights and models screens, grant dialog (GR-01), adminApi (users, roles, grants, servers, models), useResource, DataTable, AdminForm, alert-dialog, toast, focus service, logger stand-in, MSW
  // @complexity: high
  it.todo('INT-2 / UC-2..UC-6 / UC-E6 / UC-E9: local accounts and password reset, roles of an employee, the built-in role, rights and denies with their quotas, the model catalogue, and the confirmed destructive actions send exactly the confirmed request and show the server\'s refusal');

  // INT-3 ---------------------------------------------------------------------------------------------------------------------------------
  // AC: AC-26.1 "Given администратор создаёт провайдера OIDC для Okta, when он открывает его, then видит данные Agent OS для Okta и может скопировать
  //   каждое значение"; AC-26.3 "Given администратор открывает настройки входа, when он смотрит сроки жизни сеанса, then видит действующие значения
  //   обоих сроков и может изменить каждый"; AC-26.4 "Given администратор добавляет провайдера, when он выбирает тип из списка первой версии (FR-03), then
  //   видит поля настроек именно этого типа"; AC-27.1 "Given администратор регистрирует Sentry MCP по адресу в режиме личного OAuth, when он подключает
  //   свой аккаунт Sentry, then видит список инструментов Sentry с пометками «читает» и «меняет»"; NFR-02 (web half) "ни секрет, ни токен не попадает
  //   в лог, уведомление, заголовок вкладки и сообщение об ошибке". Design: DC-7, DC-8, DC-9, DC-10, DC-11; UC-7..UC-10, UC-E3, UC-E4, UC-E5, UC-E8.
  // Behavior: the administrator configures how people sign in and which servers agents may reach -> a secret lives only in its field until sent and is
  //   never shown back; the screen does what it says when the server refuses; leaving for the owner's sign-in is a navigation of the tab.
  // Rows (texts from uxrd.md MC-27..MC-29, MC-33; `[support] expectNowhere(value)` sweeps the document text and every input value, `document.title`, the
  //   toasts, the announcer and the logger stand-in for a known value):
  //   1. providers (AC-26.4, AC-26.1): «Авторизация» shows the permanent row «Логин и пароль» «Всегда включён» (not in the response), then
  //      `GET /api/admin/providers`; creating OIDC sends `POST /api/admin/providers` with `{ type: 'oidc', name }` and opens the provider's page with
  //      «Issuer», «Client ID», «Client secret»; creating Google shows «Client ID», «Client secret» WITHOUT «Issuer» and the Google warning; «Данные для
  //      провайдера» lists «Адрес возврата» and «Scopes» from `providerData`, each with «Копировать: {подпись}» that puts the exact value on the
  //      clipboard and shows «Скопировано»
  //   2. enabling (DC-8): the switch «Включено» sends `PATCH /api/admin/providers/:id` with `{ enabled: true }`; `409 PROVIDER_INCOMPLETE` returns the
  //      switch to «выкл.» with «Нельзя включить: сначала заполните настройки провайдера.» under it (role `alert`); `409 PUBLIC_URL_REQUIRED` does the
  //      same with the server's text (no UXRD text exists, see the report); `422 PROVIDER_CHECK_FAILED` with `invalid_document` is a form error
  //      «Не удалось проверить настройки провайдера: по этому адресу нет описания OIDC для этого Issuer. Настройки не сохранены.» with the fields kept
  //   3. secret of a provider (NFR-02, UC-E3): with `options.clientSecretSet: true` the «Client secret» field reads «Задан» with no input; changing the
  //      name and «Сохранить» sends a `PATCH` whose body has NO `options.clientSecret` key; «Заменить» -> a known value -> «Сохранить» sends it in a
  //      second `PATCH`; afterwards «Задан» again and `expectNowhere(value)` finds it nowhere, also after a refused save (`422`) and a reload of the page
  //   4. sign-in settings (AC-26.3, DC-7): with `idleMinutes` 480 and `absoluteMinutes` 1440 the fields show «8» and «24»; entering «0,25» and «24» and
  //      «Сохранить» sends ONE `PUT /api/admin/settings/sign-in` with the shown address, `idleMinutes: 15`, `absoluteMinutes: 1440` (minutes, not the
  //      hours typed), then the fields show the new read and the toast «Настройки входа сохранены»; with `publicUrl: null` the address
  //      field shows the API address the web talks to; an out-of-range value («0,3» hours) sends no request and puts the focus on the field
  //   5. register a server, personal OAuth (AC-27.1, DC-9): «Зарегистрировать сервер» -> «Имя» sentry, «Адрес», «Личный OAuth» -> ONE
  //      `POST /api/admin/mcp-servers` with `{ name, url, mode: 'oauth' }` (no token key); `201 awaiting_admin_account` sends the TAB to
  //      `{apiBaseUrl}/api/admin/mcp-servers/sentry/connect` by navigation ([support] `location.assign` spy) and no `fetch` goes there; the tab returns at
  //      `/admin/servers/sentry?connected=1`: «Включён» and the tools table with «читает» and «меняет», and `connected` is removed from the address (a
  //      reload does not repeat it); `?error=connect_failed` shows «Ждёт аккаунта администратора», «Подключить мой аккаунт» (the same connect address)
  //      and the MC-29 text once; `?error=tools_failed` shows its text above the table
  //   6. register a server, shared token (DC-10): «Общая учётная запись» -> «Токен доступа» -> `POST` with `{ mode: 'shared', sharedToken }`, the button
  //      reads «Проверяем сервер…»; `422 MCP_SERVER_CHECK_FAILED` with `unauthorized` is the form error «Не удалось зарегистрировать: сервер не принял
  //      токен доступа» with the fields kept; `409 MCP_SERVER_NAME_TAKEN` is the field error «Сервер с таким именем уже есть»
  //   7. server page (DC-10, UC-10): name, address and mode are read-only text (no input) with the hint to delete and register again; «Токен доступа»
  //      reads «Задан»; replacing it sends `PATCH /api/admin/mcp-servers/:name` with `{ sharedToken }` and `expectNowhere(value)` finds nothing; the
  //      switch «Включён» sends `{ enabled: false }`; on an awaiting server `409 MCP_SERVER_INCOMPLETE` returns the switch with «Нельзя включить: сначала
  //      подключите свой аккаунт и получите список инструментов.»; «Удалить» -> «Удалить сервер «{имя}»?» -> one `DELETE /api/admin/mcp-servers/:name`
  //      and the list; «Отмена» sends nothing
  //   8. refresh (DC-11, UC-E8): «Обновить список» sends `POST /api/admin/mcp-servers/:name/tools/refresh`, shows «Обновляем…», then «Список
  //      обновлён: новых {N}, убрано {M}» from `added` and `removed` and the new tools table; `409 MCP_ACCOUNT_REQUIRED` shows NO error text and sends
  //      the tab to the same connect address as «Подключить мой аккаунт»; `422 MCP_SERVER_CHECK_FAILED` keeps the old tool list and shows its reason
  // Catches: a provider secret or shared token kept in page state, a toast, a log record, a title or an error text after it was sent (the one defect
  //   that makes «не показывается обратно» a fiction); a replacement secret sent on every save or the stored one overwritten with an empty value; a
  //   switch that stays «вкл.» after the server refused, so the administrator thinks sign-in works; the session limit sent in hours where the server
  //   reads minutes (an idle limit of 0,25 minutes instead of 15); the connect step done by `fetch` (the tab never reaches the owner's sign-in and the server stays
  //   «Ждёт аккаунта»); `connected` / `error` left in the address and replayed on reload; fields shown for the wrong provider type; a tool list
  //   replaced by an empty one after a refused refresh.
  // @category: core-functionality
  // @dependency: sign-in (providers, settings) and MCP server screens, SecretField, CopyValue, AdminForm, adminApi (providers, signInSettings, servers), logger stand-in, clipboard stub, location.assign spy, toast, announcer, MSW, next/navigation mock
  // @complexity: high
  it.todo('INT-3 / UC-7..UC-10 / UC-E3 / UC-E4 / UC-E5 / UC-E8: provider fields and copyable data per type, a refused enable returns the switch, a secret is never read back, session hours are sent as minutes, a server registers and returns from the owner\'s sign-in with its tools, and refresh without an administrator account goes to the connect address');
});
