// enterprise-access / identity - integration skeletons (real AppModule + real Postgres + in-process test providers)
// Design Doc: docs/features/enterprise-access/design-identity.md (v2.0), Test Strategy UC-1, UC-2, UC-4, UC-5, UC-7, UC-8 (isolation half),
//   UC-E1..UC-E5, UC-E6, UC-E7; PRD: docs/features/enterprise-access/prd.md (v2.1) FR-01..FR-08, FR-11, FR-32, FR-33, NFR-01..NFR-03.
// Generated: 2026-11-15 | Budget Used: 4 API integration skeletons here + 1 web integration skeleton
//   (apps/web/src/components/shell/enterprise-access-identity.int.test.tsx) = 5/5 for the part (over the 3-test default, at the
//   5-test ceiling: each skeleton names a defect no other test catches, see "Catches"), 2 E2E in enterprise-access-identity.e2e-spec.ts.
// Test Type: Integration. Every case is `it.todo` - skeletons only, no implementation.
//
// Design facts the skeletons rest on: login and password is always on (argon2id hash, one `INVALID_CREDENTIALS`, five failures per
//   entered login close it for 15 min with 429 `TOO_MANY_ATTEMPTS`); five provider types (`google`, `oidc`, `github`, `facebook`,
//   `saml`) under `/api/admin/providers`; the provider's email is trusted as returned, no email -> `no_email`; same email = same
//   employee; a first provider sign-in creates an account with no roles; SCIM token per `oidc`/`saml` provider; session lifetimes and
//   `publicUrl` are `SignInSettings` (`/api/admin/settings/sign-in`, defaults 480 / 1440 min), not constants; no dev sign-in, no
//   bootstrap, no encryption: provider secrets are stored as they are but never returned, logged or left unmasked in the audit;
//   passwords, the session token and the SCIM token are hashes.
//
// Harness (follows apps/api/test/support/*, vitest.config.e2e.ts): one `createTestApp()` per file against the docker-compose Postgres,
//   real AppModule with the real global SessionGuard; only `AGENT_TURN_CLIENT` is the scripted model. Every case uses its own
//   employees. Responses are parsed with `@agent-os/contracts` schemas.
//   Support the implementation tasks add (not skeletons):
//   - `test/support/test-provider.ts`: an OAuth 2.0 / OIDC provider in the test process (authorize, token, JWKS, discovery, `userinfo`,
//     and the GitHub-shaped `GET /user` + `GET /user/emails` and Facebook-shaped `GET /me?fields=name,email` answers), a `samlify` IdP
//     (signed and foreign-key-signed responses, expired window), and a record of the `client_id`/secret each token call carried. The test
//     plays the browser: redirect -> provider -> callback / ACS with the `aos_login` cookie.
//   - `createTestApp` option `providerEndpoints` so the `github` and `facebook` fixed addresses point at the test provider (design,
//     Test Strategy), and a captured process log (for the NFR-02 scan).
//   - `test/support/session.ts`: cookie-jar request helper, `signInWithPassword(app, login, password)` through `POST /api/auth/password`
//     (returns cookie and the `id` read from `GET /api/auth/me`), `seedSuperAdmin(app, login, password)` (the same function the operator
//     command calls, no process), `createEmployee(adminApi, {...})` through `POST /api/admin/users`, and `ageSession(pool, cookie,
//     { createdMinutesAgo, lastSeenMinutesAgo })` that moves the session row's timestamps - the clock is never faked.
//   - `chatApi` and `sseClient` in support/api.ts stop sending `x-user-id` and carry the cookie; `newUser()` is replaced by `createEmployee`.
// Mock boundary: the model (scripted double) and the providers (in-process). SessionGuard, AuditLog, SCIM, password hashing, repositories,
//   Postgres - real. Do NOT mock the guard, the database or the hasher.
//
// Replaced by this design (delete with the stub, do not duplicate):
//   - apps/api/src/auth/session.guard.spec.ts            (x-user-id stub, `system:` prefix rule; Invariant 4 -> INT-3 UUID check)
//   - apps/api/src/audit/audit.interceptor.spec.ts       (interceptor removed, KD-7)
//   - apps/api/test/threads.e2e-spec.ts case "answers 401 on every /threads route when NODE_ENV=production"
//       (the config spy no longer means anything; every route is 401 without a session -> INT-1 route walk)
// Kept, adapted only to the cookie helper (not new tests): INT-4 of agent-platform-chat.int.e2e-spec.ts proves AC-04.3 (another
//   employee's conversation answers as a missing id).
//
// NOT here on purpose (lower level, `provenAt: unit`, one table-driven test each, cases as rows):
//   - password policy 12..256 and the hash/verify round trip with parameters stored in the string
//   - login attempt counter: fifth failure closes, 15 minute window, success / reset / operator run clears (injected clock)
//   - login and email normalization, `next` path sanitization, group-name normalization
//   - provider options schema and completeness per type, `unknown_type` (AC-03.5), `PROVIDER_CHECK_FAILED` reasons
//     (`insecure_url`, `unreachable`, `invalid_document`) with a fake fetch, public URL derivation from the first request (AC-03.4 rule)
//   - GitHub primary-email choice from the email list and Facebook `/me` profile mapping (pure mappers)
//   - `SignInSettings` bounds (idle 15..1440, absolute 60..43200, idle not above absolute)
//   - AuditLog redaction (`secret_changed`, `password_changed`) over the logger's list of secret names
//   - OwnerGate (disabled or unknown owner -> stopOwner + OWNER_DISABLED)
//   - SCIM filter parsing and PATCH operation mapping

import { describe, it } from 'vitest';

describe('enterprise-access / identity - integration (real AppModule + real Postgres + in-process providers)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: the session boundary - who may call what (table-driven)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.4 "запрос к серверу без действующего сеанса: отказ «нужен вход», данных в ответе нет"; AC-01.6 "запрос с заголовком
  //   `x-user-id` и без сеанса: отказ с причиной «нужен вход»"; AC-05.3 "запрос SCIM без токена или с отменённым токеном: отказ и
  //   ничего не меняет"; AC-05.4 "токен SCIM возвращается только в ответе на его создание"; AC-07.1 (API half) "после выхода
  //   следующий запрос получает страницу входа"; AC-07.5 "администратор поменял срок жизни сеанса: запрос со старшим сеансом получает
  //   отказ «нужен вход»"; AC-08.1 "без права администратора: отказ, в аудите «отказ по правам»"; AC-32.3 "в базе нет ни одного
  //   сотрудника: обычная страница входа, создать с неё учётную запись нельзя"; NFR-01 (токен SCIM только хешем); NFR-03 "без сеанса
  //   открыты только вход, SCIM со своим токеном и проверка здоровья". Design: DC-1, DC-2, DC-3, DC-11; UC-E4, UC-E6, UC-E7.
  // Behavior: request with some credential -> global SessionGuard / Origin check / @AdminOnly / SCIM bearer -> status + errorCode
  //   (and, for the admin refusal, an `access_denied` audit row).
  // Rows (one request each, literal expected status and errorCode):
  //   1. every route registered by AppModule, called with no cookie and with only `x-user-id` -> 401 AUTH_REQUIRED; the walk reads the
  //      router's own route list, and the allow-list is exactly: `GET /api/health` (200), `GET /api/auth/providers`, `POST
  //      /api/auth/password`, `GET /api/auth/sign-in/:id`, the OAuth callback, the SAML ACS and metadata, `POST /api/auth/sign-out`,
  //      and `/api/scim/v2/*` (own 401). No allow-listed route creates an account (AC-32.3)
  //   2. employee without the right calls an `@AdminOnly` route -> 403 ADMIN_REQUIRED, audit row `access_denied` with employee and route
  //   3. mutating request with a valid cookie and a foreign `Origin`, and with an empty `Origin` -> 403 ORIGIN_REJECTED, nothing changed
  //   4. `POST /api/auth/sign-out`, then the old cookie on `GET /api/auth/me` -> 401 AUTH_REQUIRED; sign-out without a session -> 204
  //   5. default limits: a session row created more than 1440 min ago, and another idle for more than 480 min (timestamps moved in the
  //      row; limits come from `identity_settings`) -> 401 AUTH_REQUIRED
  //   6. UC-E7 (AC-07.5): Аня's session opened 2 h ago, last request 1 h ago (rows moved); an administrator `PUT
  //      /api/admin/settings/sign-in` with `idleMinutes: 30`, `absoluteMinutes: 61` -> 200 echoing `SignInSettings`, audit
  //      `admin_change` on `sign_in_settings` with old and new limits; Аня's next request with the same cookie -> 401 AUTH_REQUIRED (no
  //      restart); then `PUT` with `idleMinutes: 2000` -> 400 VALIDATION_FAILED and `GET` shows the limits unchanged
  //   7. SCIM per provider: for the `saml` provider an administrator creates token `T1`, then `T2`; SCIM `GET /Users` with no token and
  //      with `T1` -> 401 and no rows changed, with `T2` -> 200; token creation for a `github` provider -> 409 SCIM_NOT_SUPPORTED;
  //      `T1` and `T2` appear only in their creation responses (later `GET /api/admin/providers/:id`, the audit and the log hold none;
  //      audit has `scim_token_created`), and the provider row holds a SHA-256 hash, not the token (NFR-01)
  // Catches: a new controller left open by default (the forgotten @Public mark), the old `x-user-id` header still honoured, a public
  //   route that creates accounts, a cross-site POST riding the cookie, a non-admin reaching an admin operation, a signed-out or expired
  //   session still alive, a shortened session lifetime that does not reach sessions already open (limits cached at boot or stamped
  //   into the row), an out-of-bounds limit saved, a rotated-out SCIM token still accepted, a SCIM token kept or returned in clear.
  // @category: core-functionality
  // @dependency: SessionGuard, Origin check, AdminOnly, SettingsController, ScimController, AuditLog, Postgres
  // @complexity: high
  it.todo('INT-1: every route is closed without a valid session, Origin, right or SCIM token, the open ones are exactly the documented ones, and shortened session limits reach open sessions');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: login and password - the always-on method, its lockout and the local account lifecycle
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.2 "верные логин и пароль: открывается его чат, в меню его имя"; AC-01.3 "логин или пароль неверны: сеанс не открыт,
  //   одна и та же причина, что бы из двух ни было неверно, попытка в аудите"; AC-07.3 (password half) "отключённый сотрудник: вход
  //   отклонён «учётная запись отключена»"; AC-33.1 "администратор завёл учётную запись с начальным паролем: сотрудник входит";
  //   AC-33.2 "администратор сбросил пароль: старый отклонён, новый проходит"; AC-33.3 "сотрудник верно назвал текущий пароль: следующий
  //   вход только с новым"; AC-33.4 "неверно назвал текущий: пароль не меняется"; AC-11.3 "вход отклонён: запись со способом входа,
  //   временем и причиной"; NFR-01 "пароли только хешем". Design: DC-14, DC-16; UC-7, UC-E3 (password half).
  // Behavior: `POST /api/admin/users` / `POST /api/auth/password` / `POST /api/auth/password/change` / `PUT /api/admin/users/:id/password`
  //   -> status, errorCode, `reason`, session rows, audit rows, and what the database holds.
  // Rows:
  //   1. administrator creates Борис (login, name, email, initial password) -> 201 `AdminUserSummary` with `login`, no roles; Борис signs
  //      in -> 204 and cookie, `GET /api/auth/me` -> his name and email, `hasPassword: true`, `id` is a UUID, not `system:`-prefixed
  //   2. wrong password for an existing login, and an unknown login -> both 401 INVALID_CREDENTIALS with the same body; audit has
  //      `sign_in_rejected` with method `password` and reasons `wrong_password` and `unknown_login` respectively
  //   3. lockout: five wrong passwords in a row for Борис -> the sixth try with the RIGHT password -> 429 TOO_MANY_ATTEMPTS, audit reason
  //      `locked`; five tries on a login that does not exist -> the same 429; four failures, one success, four failures -> no lock
  //      (the success reset the counter)
  //   4. Борис disabled: the right password -> 401 ACCOUNT_DISABLED; a wrong password -> 401 INVALID_CREDENTIALS (the status is not
  //      disclosed without the password)
  //   5. self change: wrong current password -> 400 VALIDATION_FAILED with `reason: wrong_current_password` (counted as a failure of
  //      this login) and the password is unchanged; a provider-only employee -> 400 `not_local_account`; right current password -> 204,
  //      his other open session stays valid, and a later sign-in works only with the new password
  //   6. administrator resets the password (`PUT /api/admin/users/:id/password`) -> 204; every open session of Борис -> 401
  //      AUTH_REQUIRED; the old password -> INVALID_CREDENTIALS, the new one -> 204; if his login was locked, the reset unlocked it
  //   7. NFR-01: no text column of any `app` table contains any password used above; the stored value is an argon2id string; the audit
  //      rows of create, change and reset carry `password_changed` and none of the values
  // Catches: a wrong login answering differently from a wrong password (account enumeration), a lock that only protects existing
  //   logins, a lock that a correct password still passes, a disabled flag leaked to someone without the password, a counter that a
  //   success or reset does not clear, a reset that leaves the old sessions alive, a changed password that does not change, a password
  //   readable in the database or the audit, an attempt left out of the audit.
  // @category: core-functionality
  // @dependency: PasswordSignIn, AdminUsersController, AuthController, SessionStore, identity_login_attempts, AuditLog, Postgres
  // @complexity: high
  it.todo('INT-2: password sign-in answers one reason for every bad credential, locks a login after five failures even for the right password, and a reset or change takes effect at once without leaving a password anywhere');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: providers - configuration, sign-in outcomes and one account per email (table-driven over the five types)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.5 "включены Google и Okta: форма и две кнопки с названиями администратора"; AC-02.1 "OIDC: открывается чат, в меню имя
  //   и почта от провайдера"; AC-02.2 "SAML с неверной подписью или истёкшим сроком: вход отклонён, сеанс не открыт, попытка в аудите";
  //   AC-02.3 "отказ провайдера или отмена: страница входа с причиной, сеанса нет"; AC-02.5 "провайдер любого типа первой версии: как в
  //   AC-02.1"; AC-03.1 "секрет клиента сохранён: при чтении «задан», значения нет"; AC-03.2 "выключенный провайдер: кнопки нет, попытка
  //   отклоняется"; AC-03.3 "настройки изменены: вход по новым без рестарта"; AC-03.4 "публичный адрес не сохранён: первое сохранение
  //   провайдера делает им адрес обращения к API"; AC-04.1 "первый вход создаёт учётную запись с именем и почтой провайдера"; AC-04.2
  //   "локальная запись с почтой anna@company.ru, вход через Google с той же почтой: те же беседы"; AC-04.4 "идентификатор не
  //   начинается с `system:`"; AC-04.5 "провайдер не вернул почту: вход отклонён «провайдер не вернул почту», сеанса нет, попытка в
  //   аудите"; AC-06.1 "группа `sre` сопоставлена с ролью «SRE»: роль с пометкой «из IdP»"; AC-06.5 "вход по паролю или через Google:
  //   роль «SRE» остаётся"; AC-07.3 (provider half) "отключённый сотрудник: «учётная запись отключена»"; AC-08.2 "право есть у роли:
  //   доступ к операциям администратора"; AC-11.2 "замена секрета: «секрет изменён», значения нет"; AC-11.3; NFR-02 "ни секрет, ни токен
  //   не в логах, аудите, ответах". Design: DC-4, DC-6; UC-1, UC-2, UC-4, UC-E1, UC-E2, UC-E3 (provider half).
  // Behavior: administrator configures providers through the admin API with known secrets -> browser starts sign-in
  //   (`GET /api/auth/sign-in/:providerId?next=`) -> test provider answers -> callback / ACS with or without the `aos_login` cookie ->
  //   redirect target, `aos_session` cookie or none, audit rows, and a scan of every observable store for the known secrets.
  // Steps and rows:
  //   configuration:
  //   1. first `POST /api/admin/providers` (type `oidc`, name «Okta») with no saved public URL -> `GET /api/admin/settings/sign-in`
  //      now holds the address the test used to reach the API, and `providerData.redirectUri` is built from it; the provider is
  //      `enabled: false`; enabling it with no options -> 409 PROVIDER_INCOMPLETE; saving an issuer the test provider does not serve
  //      -> 422 PROVIDER_CHECK_FAILED with `reason: unreachable` and nothing stored; saving the test issuer with secret `S1` -> `complete:
  //      true`, `clientSecretSet: true`, no field of any response holds `S1`; the other four types are created with their own secrets
  //   2. `GET /api/auth/providers` without a session -> the enabled providers in creation order with their names and types; a disabled
  //      one is absent (AC-01.5, AC-03.2)
  //   accepted (each: 302 to `next` with the cookie; `GET /api/auth/me` -> name and email from the provider; audit `sign_in` with the
  //   method):
  //   3. UC-1: first sign-in of Аня through «Okta» (OIDC) with groups `sre`,`all`, role «SRE» mapped to `sre` and carrying the admin right
  //      -> `isAdmin: true`, `id` is a UUID (not `system:`-prefixed), her role list shows «SRE» with source `idp` and group `sre`;
  //      a first sign-in of another employee through the same provider with no mapped group -> no roles, `isAdmin: false`
  //   4. the same table over `google`, `github` (email from the primary entry of the email list), `facebook` and `saml` (signed response,
  //      attributes `email`, `name`, `groups`) -> each opens a session for a first-time email (AC-02.5)
  //   5. UC-2: Аня has a local account `anna@company.ru` and the role «SRE» from group `sre`; she creates a conversation, then signs in
  //      with the password, then through `github`, `facebook`, `google` and `saml`, the provider email in another letter case -> every
  //      time the same `id` and the same conversation list; after `github`, `facebook`, `google` and the password sign-in the «SRE» role
  //      is still there (those providers send no groups and do not touch the set, AC-06.5)
  //   rejected (each: redirect to `/login?error=<reason>`, no `aos_session` cookie, no session row, audit `sign_in_rejected` with
  //   method, provider, time and reason, and no provider response text in the audit or log):
  //   6. OIDC callback with `error=access_denied` -> `cancelled`
  //   7. the accepted callback replayed a second time -> `failed`
  //   8. callback without the `aos_login` cookie (another browser) -> `failed`
  //   9. login request older than 10 minutes (row's expiry moved) -> `failed`
  //   10. `facebook` profile without an email -> `no_email`
  //   11. SAML response signed with a foreign key; then a SAML response past its validity window -> `failed` each
  //   12. the provider switched off after the button was shown: the old sign-in link -> `provider_unavailable`
  //   13. employee disabled before sign-in (a normal provider answer for him) -> `account_disabled`
  //   edit and secrecy:
  //   14. replace `S1` with `S2` and change `clientId` of «Okta»; an employee signs in through it -> the test provider saw the new
  //      `clientId` and secret (no restart); audit has `admin_change` carrying `secret_changed`
  //   15. scan: neither `S1`, `S2` nor any other provider secret appears in any response of this skeleton, the captured process log or
  //      any audit row (the database holds provider secrets as they are, so it is not scanned)
  // Catches: a forged, stale, replayed or foreign-browser answer opening a session (the design's biggest risk); an email-less provider
  //   result creating an account; SAML, OIDC, GitHub, Facebook, Google and the password creating several accounts for one person;
  //   a provider that sends no groups wiping the groups and roles of the employee; a client-chosen or `system:`-prefixed id; a disabled
  //   provider or employee still letting someone in; a provider edit served from the cached old configuration until restart; a
  //   provider enabled without complete settings; a provider secret readable in a response, the log or the audit; a rejection left out
  //   of the audit.
  // @category: core-functionality
  // @dependency: AuthController, OAuthSignIn, SamlSignIn, SignInService, AdminProvidersController, SessionStore, AuditLog, logger, test provider, Postgres
  // @complexity: high
  it.todo('INT-3: a valid answer from any of the five provider types opens one session on the one account of that email, every forged, replayed, foreign, email-less or disabled attempt opens none and is audited, and no provider secret leaks');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4: roles from two sources and the last-administrator guard
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-06.3 "роль «Дежурный» назначена в панели: когда IdP присылает группы без такой группы, роль остаётся"; AC-06.4
  //   "сотрудник в роли и из IdP, и из панели: когда IdP убирает его из группы, он остаётся в роли по назначению из панели";
  //   AC-08.3 "право администратора только у одного включённого сотрудника: снятие права с него или с его роли и блокировка
  //   отклоняются с причиной «не останется ни одного администратора»"; AC-08.4 "изменение от IdP применяется, в аудите и логе «не
  //   осталось ни одного администратора»"; AC-11.1 "смена сопоставления группы с ролью: запись с администратором, временем, ролью,
  //   прежним и новым сопоставлением". Design: KD-6; UC-5, UC-E5.
  // Behavior: admin panel calls and SCIM / provider sign-in group changes -> membership read back through `GET /api/admin/users/:id`
  //   -> status codes, unchanged state on rejection, audit rows.
  // Steps (one story over three people, literal expectations):
  //   1. UC-5: Аня holds «Дежурный» (panel) and «SRE» (IdP group `sre` AND panel assignment); the admin changes the group mapping of
  //      «SRE»; Аня signs in through `oidc` with groups that include neither `sre` nor `oncall` -> she still holds «Дежурный» and «SRE»,
  //      both with source `panel` only; audit has the mapping change with admin, role, old and new group sets
  //   2. UC-E5: the only administrator Игорь holds the right through a role mapped to IdP group `adm`; the panel's "remove the role's
  //      admin right" -> 409 LAST_ADMIN; "block Игорь" -> 409 LAST_ADMIN; both leave rows unchanged
  //   3. concurrency (KD-6): two administrators remove the personal right from each other at the same moment -> exactly one request is
  //      200 and the other 409 LAST_ADMIN; at least one enabled administrator remains
  //   4. IdP side: SCIM (the `oidc` provider's token) removes Игорь from `adm` -> 200, applied, audit and log hold `last_admin_removed`
  // Catches: an IdP sign-in wiping a panel assignment, a role vanishing from a person who was assigned it twice, a deployment left
  //   without an administrator by one request or by two crossing ones, an IdP change blocked by the panel's guard, an admin change that
  //   leaves no audit trail of before and after.
  // @category: core-functionality
  // @dependency: AdminUsersController, AdminRolesController, UsersService, ScimController, SignInService, AuditLog, advisory lock, Postgres
  // @complexity: high
  it.todo('INT-4: panel assignments survive the IdP, the last administrator cannot be removed from the panel even concurrently, and an IdP removal is applied and recorded');
});
