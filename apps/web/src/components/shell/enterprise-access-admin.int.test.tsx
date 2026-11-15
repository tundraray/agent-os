// enterprise-access / admin (web) - integration skeleton
// Design Doc: docs/features/enterprise-access/design-admin.md (v1.1), Test Strategy UC-1..UC-10, UC-E1..UC-E10; UXRD: docs/features/enterprise-access/uxrd.md
//   Screens AD-01..AD-12, AD-14, AD-15, GR-01, QD-01; MC-19, MC-21..MC-34.
// Generated: 2026-11-15 | Budget Used: 5/5 web integration skeletons (INT-1..INT-5; the part is web only, there are no API files to share the
//   budget with; the two above the usual 3 each name the defect no other test catches, see their `Catches`), 0 web E2E (the repository has no
//   browser E2E tool; the design's «L1-сценарии в браузере» table is the manual real-browser acceptance and is not turned into skeletons).
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom). Cases are `it.todo` - skeletons only.
//
// Harness (src/test/): `renderWithRuntime` mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy) -
//   as in enterprise-access-access.int.test.tsx; extend it for search params (`?connected=1`, `?error=...`) and for a spy on the same-tab
//   navigation to `GET /api/admin/mcp-servers/:name/connect` (jsdom does not navigate). MSW server from '@/test/msw-server'
//   (onUnhandledRequest: 'error', so a request the screen must NOT send fails the test); the event source is injected as in
//   agent-platform-web.int.test.tsx (`createTestLiveSource`); `deferred()` from '@/test/fixtures' holds a response. Admin fixtures to add to
//   src/test/fixtures.ts: `CurrentUser` bodies (admin / not admin), users, roles with groups, a grant list, `UserAccess`, `ConnectionView`
//   (OIDC with `clientSecretSet`, SAML with `idpData`), `McpServerView` (`sentry` with two tools, `jira` awaiting_admin_account),
//   `QuotaPauseRow` with `quota.parts`. Response bodies follow the schemas of `@agent-os/contracts`.
// Mock boundary: network (MSW: `GET /api/auth/me`, `/api/admin/*`, the thread routes the sidebar's history reads) and next/navigation. The
//   shell route parsing, AdminGate, the panel sidebar and menu, `apiRequest` with its 401 / 403 handlers, `adminApi`, `useResource`,
//   `DataTable`, `AdminForm`, `SecretField`, `ShowOnceDialog`, the toast and announcer - real. Do NOT mock any of them.
//
// Server-side proofs are NOT repeated: that a non-admin is refused on every admin route and that `LAST_ADMIN`, secrets and quotas are decided
//   by the server are proven by API INT-1 of identity (route walk), INT-1..INT-3 of access and INT-3/INT-4 of mcp-connect. This file proves only
//   what the browser does with those answers.
//
// `provenAt: unit` (table-driven tests next to the code, named for the plan; one table per rule, cases as rows):
//   - `parseShellRoute`: every address of C3 · web, including `/admin/servers/new` opening the server named `new` while `/admin/register-server`
//     opens the form, `/admin` and an unknown address under it opening «Сотрудники», percent-decoded keys (shell-route.test.ts).
//   - `useResource` / `usePagedResource`: a response for a previous key and a response after unmount are dropped, one log line per error,
//     «Показать ещё» error keeps the loaded rows; the 300 ms search debounce (DC-5, UC-E10).
//   - `apiRequest` / `ApiRequestError`: `PUT`, 204 without body, `reason` carried from the body, the 401 and 403 `ADMIN_REQUIRED` handlers each
//     called once, `describeApiError` carries method, path, status, code and reason and never a body (NFR-02, the log half); `adminApi` paths
//     with `encodeURIComponent` for a server name, a model id containing `/` and an IdP group name.
//   - `describeAdminError`: code and `reason` -> MC-21, MC-25..MC-31, MC-33 text, and the fallback to the server's `message` for an unlisted
//     code or reason.
//   - session settings form: hours <-> minutes both ways, comma decimals, the MC-33 bounds and «Общий срок не может быть меньше срока без
//     активности» (UC-E7, DC-6); the grant dialog's quota rule (0,01..1 000 000, two decimals, empty = no quota) and the pause limit (1..720).
//   - orphan-grant detection (GR-02), the AD-04 mapping of `result`/`source` to «Доступен · роль SRE» / «Закрыт · закрыто личным запретом»
//     and of `quota` to «100 $ = SRE 50 + Дежурный 20 + лично 30» (AC-28.1 and AC-29.1 text half), `formatSpend` / `formatQuota` / `formatPrice`.
//   - `DataTable` focus after a removed row (next row, else previous, else `h1`) and `AdminForm` focus on the first field with an error:
//     component tests next to the components; the keyboard order across the panel (UC-N1, NFR-05) is the L1 browser checklist.
//
// `not automated`: AC-29.1's catalogue screen (AD-11: add, change, remove a model) - its rules are the formats above and the server's
//   `MODEL_ID_TAKEN` text from `describeAdminError`; the density, tokens and contrast of NFR-05 (L1 table); FR-31, the audit journal, is out of
//   scope of the feature.

import { describe, it } from 'vitest';

describe('enterprise-access / admin - web integration (jsdom + MSW)', () => {
  // INT-1 ---------------------------------------------------------------------------------------------------------------------------------
  // AC: AC-24.1 "Given администратор вошёл, when он открывает меню, then видит вход в панель, а в панели - все разделы, перечисленные в FR-24";
  //   AC-24.2 "Given у сотрудника нет права администратора, when он открывает адрес панели напрямую, then видит отказ, а не данные панели, и
  //   входа в панель в его меню нет"; Design: DC-1, DC-2, DC-3, KD-2; UC-1, UC-E1, UC-E2.
  // Behavior: the shell asks `me` once -> the panel is shown only to an administrator and its requests start only after that answer; a 403 later
  //   takes the right away in place.
  // Steps (literal texts from uxrd.md MC-19 and the design; `GET /api/auth/me` is held with `deferred()` in step 1):
  //   1. not an administrator (`isAdmin: false`) opens `/admin/roles`: until `me` answers the screen is the «Право ещё не известно» state (AD-01);
  //      then «Нет доступа» / «Панель администратора открыта только администраторам Agent OS.» with «В чат», the ordinary sidebar with the
  //      conversation list, no «Панель администратора» in the user menu, the tab title «Нет доступа — Agent OS»; NO request to `/api/admin/*`
  //      was ever sent (the unhandled-request error of MSW is the check), and «В чат» leaves without a chat restart
  //   2. an administrator (`isAdmin: true`, one row from `GET /api/admin/quota-pauses`) opens the menu and chooses «Панель администратора»:
  //      «Сотрудники» is open, the sidebar shows «К чату» and the six sections «Сотрудники», «Роли», «Вход и SCIM», «MCP-серверы», «Модели»,
  //      «Паузы по квоте» with the number 1 at the last one (no number when there are no rows), the focus is on the `h1` «Сотрудники», the tab
  //      title is «Сотрудники — Панель — Agent OS»; the first request after `GET /api/auth/me` is `GET /api/admin/users`
  //   3. on «Роли» «Создать роль» is answered `403 ADMIN_REQUIRED`: the same address now shows «Нет доступа», the ordinary sidebar, the menu
  //      without the panel item, and no row of panel data is left on screen
  // Catches: the panel fetching `/api/admin/*` before `me` answers or for a non-admin (every such open writes `access_denied` into the audit) or
  //   showing its data to him until a 403 arrives; the 403 handler not wired into the shell, so an administrator whose right was withdrawn
  //   keeps a working-looking panel whose every action fails silently; the pause count taken from a stale source.
  // @category: core-functionality
  // @dependency: parseShellRoute, AdminGate, CurrentUser, AppSidebar, UserMenu, MainView, ThreadNotice, apiRequest 403 handler, adminApi, MSW, next/navigation mock
  // @complexity: medium
  it.todo('UC-1 / UC-E1 / UC-E2: a non-administrator gets «Нет доступа» and sends no panel request; an administrator gets the panel with its sections and the pause count; a 403 ADMIN_REQUIRED turns the open panel into «Нет доступа» in place');

  // INT-2 ---------------------------------------------------------------------------------------------------------------------------------
  // AC: AC-25.1 "Given у Ани роль «SRE» из IdP и роль «Дежурный» из панели, when администратор открывает Аню, then видит обе роли с источником и
  //   может снять только «Дежурный»"; AC-25.2 (screen half) "Given администратор удалил роль, ... then права этой роли пропадают у них со
  //   следующего вызова модели" (the panel deletes the role; the loss of rights is proven by `access`); AC-28.1 "Given право на Sentry MCP Аня
  //   получает от роли «SRE», а один инструмент ей запрещён лично, when администратор открывает действующие права Ани, then видит Sentry с
  //   источником ... "; AC-29.1 "видит действующую квоту на Sonnet 100 $ с разбивкой «SRE 50 + Дежурный 20 + лично 30» и расход"; the rights half
  //   of AC-08.3 "последний администратор не снимается" (screen side). Design: DC-4; UC-2, UC-3, UC-7, UC-E3.
  // Behavior: the administrator changes who may do what -> each action sends the one request the screen names, shows the server's refusal at the
  //   action that caused it, and the lists show the new read rather than a patched copy (invariant 4).
  // Steps (literal texts from uxrd.md MC-21, MC-23, MC-24, MC-26):
  //   1. «Сотрудники» -> Аня -> tab «Роли»: two rows, «SRE» with «из IdP · группа sre» and «Дежурный» with «из панели»; «Снять роль» only on
  //      the second; pressing it sends `DELETE /api/admin/users/:id/roles/:roleId` and after the new read the row «Дежурный» is gone
  //   2. tab «Доступ» (reads the user, `GET .../access` and `GET /api/admin/grants?userId=` at once): the Sentry row «Доступен · роль SRE», under
  //      it `update_issue` «Закрыт · закрыто личным запретом»; Sonnet «100 $ = SRE 50 + Дежурный 20 + лично 30» with the spend «64,20 $» and the
  //      month of `UserAccess.month`
  //   3. Игорь, the only administrator: «Заблокировать» -> confirm «Заблокировать Игорь?» -> `409 LAST_ADMIN` -> «Нельзя: не останется ни
  //      одного администратора.» at the button, his status still «Включён»
  //   4. «Роли» -> «Дежурный» -> «Удалить» -> the dialog «Удалить роль «Дежурный»?» / «Сотрудники роли сразу потеряют её права.» -> «Удалить»:
  //      exactly one `DELETE /api/admin/roles/:id`, the role list is open, the notice «Роль удалена», the focus on the list's `h1`; then the
  //      role «SRE» «Право администратора» switch turned off answers `409 LAST_ADMIN`: the switch is back «вкл.» and MC-21 stands under it
  // Catches: «Снять роль» offered on a role that comes from the IdP (the next sign-in puts it back and the administrator thinks it is gone);
  //   a deletion that does not return to a refreshed list or ask for the confirmation that names its effect; a refused last-administrator action
  //   that still changes the screen (the status or the switch shows the new value while the server kept the old), so the administrator believes
  //   he removed the last admin right; the effective rights page assembled from only one of the three reads, or the quota total shown without its
  //   parts, which is the one place an administrator checks why an agent paused.
  // @category: core-functionality
  // @dependency: users and roles screens, adminApi (users, roles, grants, access), useResource, DataTable, AdminForm, alert-dialog, toast, focus service, MSW
  // @complexity: high
  it.todo('UC-2 / UC-3 / UC-7 / UC-E3: roles of an employee with their source and the panel-only «Снять роль», the effective rights and the quota breakdown, role deletion with its notice, and LAST_ADMIN refusals that leave status and switch unchanged');

  // INT-3 ---------------------------------------------------------------------------------------------------------------------------------
  // AC: AC-26.1 "Given администратор создаёт подключение SAML, when он открывает его, then видит данные Agent OS для IdP и может скопировать
  //   каждое значение"; AC-26.2 "Given администратор создаёт токен SCIM, when токен создан, then панель показывает его один раз, как в AC-05.4";
  //   AC-26.3 "Given администратор открывает настройки входа, when он смотрит сроки жизни сеанса, then видит действующие значения обоих сроков и
  //   может изменить каждый"; NFR-02 (web half) "значение секрета не попадает в лог, уведомление, заголовок вкладки и сообщение об ошибке".
  //   Design: DC-6 (wiring case), DC-7, DC-8; UC-4, UC-5, UC-E4, UC-E5, UC-E6.
  // Behavior: a secret is held only where the screen says - in the field before sending, in the open dialog after the server made it - and the
  //   screen does what it says when the server refuses.
  // Steps (literal texts from uxrd.md MC-27, MC-28, MC-33):
  //   1. «Вход и SCIM» (`idleMinutes` 480, `absoluteMinutes` 1440): the fields show «8» and «24»; entering «0,25» and «24» and «Сохранить» sends
  //      one `PUT` with 15 and 1440 and the notice «Сроки сеанса сохранены»; an out-of-range value sends no request and puts the focus on the field
  //   2. the toggle «Включено» of a connection without IdP data answers `409 CONNECTION_INCOMPLETE`: the toggle returns to «выкл.» and under it
  //      stands «Нельзя включить: сначала заполните данные от IdP.» with the role `alert`
  //   3. a SAML connection's page lists «ACS URL», «Entity ID» and the three attributes of `idpData`; each has «Копировать: {подпись}» and
  //      after pressing it «Скопировано»
  //   4. the OIDC connection with `clientSecretSet: true`: the «Client secret» field reads «Задан» with no input; changing the title and
  //      «Сохранить» sends a `PATCH` WITHOUT `clientSecret`; «Заменить» -> typing a value -> «Сохранить» sends it in the second `PATCH`; afterwards
  //      «Задан» again and the typed value is nowhere - not in the field, the toasts, the tab title, the announcer text or the logger's records
  //   5. «Создать новый токен» -> «Создать новый токен?» / «Прежний токен сразу перестанет работать, ...» -> «Создать»: the dialog «Токен SCIM»
  //      shows the value from `POST /api/admin/scim/token` with the focus on «Копировать»; «Готово» closes it, the section shows «создан {дата}»,
  //      the focus is on «Создать новый токен», the token string is in no part of the document and in no logger record, and the next `GET
  //      /api/admin/scim` (MSW answers without the value, as the server does) is the only source of the section
  // Catches: the SCIM token or an OIDC secret kept in page state, a store, a toast, a log record or an error text after it was shown once (the
  //   one defect that makes the one-time display a fiction); a replacement secret sent on every save or the old one sent as empty, wiping it;
  //   a toggle that stays «вкл.» after the server refused, so the administrator thinks sign-in works; the session hours sent as hours instead of
  //   minutes (an eight-minute session) because the conversion is not wired into the request.
  // @category: core-functionality
  // @dependency: sign-in and SCIM screens, SecretField, ShowOnceDialog, CopyValue, AdminForm, adminApi (connections, sessions, scim), logger, toast, announcer, MSW
  // @complexity: high
  it.todo('UC-4 / UC-5 / UC-E4 / UC-E5 / UC-E6: the IdP data is copyable, the session hours are saved as minutes, a refused enable switch returns, an OIDC secret is never read back, and the SCIM token exists only in the open dialog');

  // INT-4 ---------------------------------------------------------------------------------------------------------------------------------
  // AC: AC-27.1 "Given администратор регистрирует Sentry MCP по адресу в режиме личного OAuth, when он подключает свой аккаунт Sentry, then видит
  //   список инструментов Sentry с пометками «читает» и «меняет»"; AC-28.2 "Given администратор даёт право на инструмент, when он выбирает
  //   инструмент, then выбирает его из списка инструментов сервера в реестре"; the deny/allow target of AC-28.1 (the right is created on the
  //   target and with the effect the dialog says). Design: DC-9, DC-10, DC-11; UC-6, UC-8, UC-E9.
  // Behavior: the registry the administrator registers is the registry the rights dialog offers; leaving for the owner's sign-in is a navigation.
  // Steps (literal texts from uxrd.md MC-25, MC-29):
  //   1. «Зарегистрировать сервер»: «Имя» sentry, «Адрес», «Личный OAuth» -> «Зарегистрировать» sends one `POST /api/admin/mcp-servers`; the answer
  //      `201 awaiting_admin_account` sends the TAB to `GET /api/admin/mcp-servers/sentry/connect` by navigation (not by `fetch`)
  //   2. the tab returns at `/admin/servers/sentry?connected=1`: the page shows «Включён» and the tools table with «читает» and «меняет»
  //      marks, and the address no longer holds `connected` (a reload does not repeat the notice); `?error=connect_failed` shows «Ждёт аккаунта
  //      администратора» with «Подключить мой аккаунт» and the MC-29 text, `?error=tools_failed` the text above the table
  //   3. «Обновить список» answers `409 MCP_ACCOUNT_REQUIRED`: no error text, the tab goes to the same connect address as «Подключить мой
  //      аккаунт»; a successful refresh shows «Список обновлён: новых {N}, убрано {M}»
  //   4. the role «SRE» page -> «Добавить право» -> «Что»: «Инструмент сервера»: `jira` (`awaiting_admin_account`) cannot be chosen, `sentry`
  //      offers its two tools with their Mono names and «читает» / «меняет», `search_issues` carries «уже есть» and cannot be chosen, there is no
  //      field to type a tool name; «Добавить» sends `POST /api/admin/grants` with `roleId`, `effect: allow` and the target `tool` of the chosen
  //      server and tool; «Добавить запрет» on a person's page sends `effect: deny`
  // Catches: the connect step done by a `fetch` (the administrator's tab never reaches the owner's sign-in and the server stays «Ждёт
  //   аккаунта»); `connected` / `error` left in the address and replayed on reload; a registered server the name `new` can not open; a tool typed
  //   by hand or a server without tools offered in the dialog, creating a right that matches nothing; a deny sent as allow (or the reverse), the
  //   one mistake that silently opens or closes a server for a role.
  // @category: core-functionality
  // @dependency: MCP server screens, grant dialog (GR-01), adminApi (servers, grants), parseShellRoute, window navigation spy, MSW, next/navigation mock
  // @complexity: high
  it.todo('UC-6 / UC-8 / UC-E9: registering a server leaves the tab for the owner\'s sign-in and returns to its tools without the return parameter, MCP_ACCOUNT_REQUIRED does the same, and the rights dialog offers only registry tools with the right effect');

  // INT-5 ---------------------------------------------------------------------------------------------------------------------------------
  // AC: AC-30.1 "Given агенты Ани на паузе по Sonnet, when администратор открывает раздел пауз, then видит строку Ани с моделью, расходом, квотой,
  //   числом агентов и временем начала, без текста бесед"; AC-30.2 "Given администратор поднял личную квоту Ани из этой строки, when изменение
  //   сохранено, then агенты Ани продолжают работу, а строка пропадает"; AC-30.3 "Given администратор отказал из строки Ани, when отказ сохранён,
  //   then агенты Ани получают статус «сбой», а строка пропадает"; AC-30.4 "Given администратор поменял предел ожидания, when новый агент встаёт
  //   на паузу, then его пауза кончается по новому пределу"; Design: KD-7, DC-12, DC-13; UC-9, UC-10, UC-E8.
  // Behavior: money changes are saved one part at a time, stop at the first refusal, and what the screen says afterwards is the new read of
  //   the pause list, never the administrator's own arithmetic.
  // Steps (literal texts from uxrd.md MC-31; `GET /api/admin/quota-pauses` answers Аня / Sonnet, «100,40 $ / 100 $», 2 agents, «с 14:20»):
  //   1. «Паузы по квоте»: the row shows the employee, model, «100,40 $ / 100 $», «2», the start time and no conversation text; the field
  //      «Предел ожидания» 24 -> 48 and «Сохранить» sends `PUT /api/admin/settings/quota-pause` with `waitLimitHours` 48, notice «Сохранено»
  //   2. «Поднять квоту» -> «Квота Sonnet для Аня»: a row «Роль SRE — изменит квоту всем сотрудникам роли: {N}» and a row «Лично»; entering 150
  //      at «Лично» (the person has a personal right) sends one `PATCH /api/admin/grants/:id` with `quotaUsd: 150`, then `GET
  //      /api/admin/quota-pauses` (now without the row): the row collapses, the notice «Квота поднята — агенты продолжают»; with no personal
  //      right the same step sends `POST /api/admin/grants` with `effect: allow`, the model and `quotaUsd`
  //   3. a new quota not above the spend (100): the line «Квота не выше расхода — агенты останутся на паузе.» shows, saving is allowed, the row
  //      stays with the new quota and the notice is «Квота сохранена — агенты на паузе» (the notice follows the new read, not the sum typed)
  //   4. both the role's part and «Лично» changed and the second `PATCH` answers `422 GRANT_INVALID`: the first request was sent once, the
  //      second once, the dialog stays open with the form error starting «Не удалось сохранить:», the pause list was read again and shows the
  //      role's new quota as saved; when that read has no row any more the dialog closes with the «агенты продолжают» notice that says part was
  //      not saved
  //   5. «Отказать» -> «Отказать: Аня, Sonnet?» / «Агенты на паузе (2) завершатся сбоем «квота исчерпана».» -> «Отказать» sends one `POST
  //      /api/admin/quota-pauses/refuse` with `userId` and `model`, the list is read again, the row is gone, the notice «Отказано — агенты
  //      завершены»; an empty list shows «Никто не ждёт решения по квоте»
  // Catches: the quota parts saved in parallel or continued after a refusal, so a half-saved raise is shown as done and the administrator can not
  //   tell which part took effect (the screen's one money risk); the notice decided by comparing the typed total with the spend on the client,
  //   which says «агенты продолжают» for agents the server still holds paused; a refusal sent without its confirmation or with the wrong person
  //   or model, ending the agents of someone else; a row that stays after the refusal because the list was patched instead of read again.
  // @category: core-functionality
  // @dependency: quota-pause screen and QD-01 dialog, AdminForm, DataTable, adminApi (grants, pauses, pauseSettings), alert-dialog, toast, focus service, MSW
  // @complexity: high
  it.todo('UC-9 / UC-10 / UC-E8: the pause list, the pause limit, raising the quota part by part with a stop at the first refusal and a notice that follows the new read, and the confirmed refusal of the right person and model');
});
