// enterprise-access / identity - integration skeletons (real AppModule + real Postgres + in-process test IdP)
// Design Doc: docs/features/enterprise-access/design-identity.md (v1.0), Test Strategy UC-1, UC-2, UC-4, UC-5, UC-7, UC-8 (isolation half),
//   UC-E1..UC-E6; PRD: docs/features/enterprise-access/prd.md FR-01..FR-11, NFR-01..NFR-03.
// Generated: 2026-11-15 | Budget Used: 4 API integration skeletons here + 1 web integration skeleton
//   (apps/web/src/components/shell/enterprise-access-identity.int.test.tsx) = 5/5 for the part (over the 3-test default,
//   at the 5-test ceiling: each skeleton names a defect no other test catches, see "Catches"), 2 E2E in
//   enterprise-access-identity.e2e-spec.ts.
// Test Type: Integration. Every case is `it.todo` - skeletons only, no implementation.
//
// Harness (follows apps/api/test/support/*, vitest.config.e2e.ts): one `createTestApp()` per file against the docker-compose
//   Postgres, real AppModule with the real global SessionGuard; only `AGENT_TURN_CLIENT` is the scripted model. Every case uses
//   its own employees, so rows of one case never meet another's. Responses are parsed with `@agent-os/contracts` schemas.
//   Support the implementation tasks add (not skeletons): `test/support/test-idp.ts` (an OIDC issuer in the test process and
//   a `samlify` IdP; the test plays the browser: redirect -> IdP -> callback with the `aos_login` cookie), `test/support/session.ts`
//   (cookie-carrying request helper; `devSignIn(app, name, { admin })` via `POST /api/auth/dev/sign-in`, returns cookie and `id`),
//   `createTestApp` options `env` (extra boot env, e.g. NODE_ENV/BOOTSTRAP_*/SECRETS_KEY) and a log capture for the NFR-02 scan.
//   `chatApi`/`sseClient` in support/api.ts stop sending `x-user-id` and carry the dev-sign-in cookie instead.
// Mock boundary: the model (scripted double) and the IdP (in-process). SessionGuard, AuditLog, SecretBox, SCIM, repositories,
//   Postgres - real. Do NOT mock the guard, the database or the clock source: session age is set by moving the row's timestamps.
//
// Replaced by this design (delete with the stub, do not duplicate):
//   - apps/api/src/auth/session.guard.spec.ts            (x-user-id stub, `system:` prefix rule; Invariant 4 -> INT-2 UUID check)
//   - apps/api/src/audit/audit.interceptor.spec.ts       (interceptor removed, KD-7)
//   - apps/api/test/threads.e2e-spec.ts case "answers 401 on every /threads route when NODE_ENV=production"
//       (the config spy no longer means anything; every route is 401 without a session -> INT-1 route walk)
// Kept, adapted only to the cookie helper (not new tests): INT-4 of agent-platform-chat.int.e2e-spec.ts proves AC-04.3 (another
//   employee's conversation answers as a missing id); the sign-in work adds no second isolation test.
//
// NOT here on purpose (lower level, `provenAt: unit`): SecretBox seal/open table (other purpose, other key, tampered string,
//   no value in the error text), AuditLog secret-field redaction table (one list shared with the logger), OwnerGate
//   (disabled and unknown owner -> stopOwner + OWNER_DISABLED), `next` path sanitization table, group-name normalization.

import { describe, it } from 'vitest';

describe('enterprise-access / identity - integration (real AppModule + real Postgres + in-process IdP)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: the session boundary - who may call what (table-driven)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.4 "Given запрос к серверу без действующего сеанса, when он просит данные сотрудника, then сервер отвечает отказом
  //   «нужен вход», и данных в ответе нет."; AC-05.3 "запрос SCIM без токена или с отменённым токеном ... отказ и ничего не меняет";
  //   AC-07.1 (API half) "после выхода следующий запрос получает страницу входа"; AC-08.1 "без права администратора ... отказ,
  //   в аудите «отказ по правам»"; AC-10.1/10.2/10.3 (dev sign-in works as a normal employee in test, 404 in production, a lone
  //   `x-user-id` is refused in any mode); NFR-03 "без сеанса открыты только вход, SCIM со своим токеном и проверка здоровья".
  //   Design: DC-1, DC-2, DC-3, DC-11.
  // Behavior: request with some credential -> global SessionGuard / Origin check / @AdminOnly / SCIM bearer -> status + errorCode
  //   (and, for the admin refusal, an `access_denied` audit row).
  // Rows (one request each, literal expected status and errorCode):
  //   1. every route registered by AppModule, called with no cookie and with only `x-user-id` -> 401 AUTH_REQUIRED; the walk reads the
  //      router's own route list, and the allow-list is exactly: auth sign-in/callback/acs/metadata/connections/sign-out/dev sign-in,
  //      `/api/scim/v2/*` (own 401), `GET /api/health` (200)
  //   2. dev sign-in in `test` -> cookie, `GET /api/auth/me` returns the employee; the same call with NODE_ENV=production -> 404
  //      with the body of an unknown route, and `GET /api/auth/connections` shows `devSignIn: false`
  //   3. employee without the right calls an `@AdminOnly` route -> 403 ADMIN_REQUIRED, audit row `access_denied` with employee and route
  //   4. mutating request with a valid cookie and a foreign `Origin`, and with an empty `Origin` -> 403 ORIGIN_REJECTED, nothing changed
  //   5. `POST /api/auth/sign-out`, then the old cookie on `GET /api/auth/me` -> 401 AUTH_REQUIRED; sign-out without a session -> 204
  //   6. session row older than 24 h since creation, and another idle for more than 8 h (timestamps moved in the row) -> 401 AUTH_REQUIRED
  //   7. SCIM `GET /Users` with no token, a revoked (first of two) token -> 401 and no rows changed; the current token -> 200
  // Catches: a new controller left open by default (the forgotten @Public mark), the old `x-user-id` header still honoured,
  //   a cross-site POST riding the cookie, a non-admin reaching an admin operation, a signed-out or expired session still alive,
  //   a rotated-out SCIM token still accepted, dev sign-in reachable in production.
  // @category: core-functionality
  // @dependency: SessionGuard, Origin check, AdminOnly, ScimController, AuditLog, Postgres
  // @complexity: high
  it.todo('INT-1: every route is closed without a valid session, Origin, right or SCIM token, and the open ones are exactly the documented ones');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: the sign-in callback outcomes (table-driven over OIDC and SAML)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.2 "когда Okta возвращает его в Agent OS, открывается его чат, а в меню — его имя и почта из IdP"; AC-01.3 "IdP отказал
  //   во входе или сотрудник отменил вход ... страница входа с причиной, сеанс не открыт"; AC-01.5 "включены два подключения ... две
  //   кнопки с названиями администратора"; AC-02.1 "вход через SAML открывает чат, как в AC-01.2"; AC-02.2 "ответ IdP с неверной
  //   подписью или с истёкшим сроком ... вход отклонён, сеанс не открыт, попытка записана в аудит"; AC-03.2 "выключенное подключение:
  //   кнопки нет, попытка войти отклоняется"; AC-04.1 "первый вход создаёт учётную запись с именем и почтой из IdP"; AC-04.2 "вход
  //   через SAML с той же почтой - те же беседы"; AC-04.4 "идентификатор не начинается с `system:`"; AC-06.1 "группа `sre`
  //   сопоставлена с ролью «SRE»: роль с пометкой «из IdP»"; AC-07.3 "отключённый сотрудник: вход отклонён «учётная запись
  //   отключена»"; AC-08.2 "право администратора есть у роли: доступ к операциям администратора"; AC-11.3 "вход отклонён: запись
  //   в аудите с подключением, временем и причиной". Design: DC-4, DC-5; UC-1, UC-2, UC-E1, UC-E2, UC-E3.
  // Behavior: browser starts sign-in (`GET /api/auth/sign-in/:id?next=`) -> test IdP answers -> callback / ACS with or without the
  //   `aos_login` cookie -> redirect target, `aos_session` cookie or none, audit rows.
  // Rows:
  //   accepted 1. UC-1: two enabled connections («Okta» OIDC, «Okta (SAML)»), Аня absent; `GET /api/auth/connections` without a session
  //      -> exactly those two names in creation order, `devSignIn: true`; OIDC sign-in with groups `sre`,`all` -> 302 to `next` with
  //      the cookie; `me` -> her name, email, `isAdmin: true`; `id` matches the UUID pattern (not `system:`); her roles show «SRE»
  //      with source `idp` and group `sre`; audit holds `sign_in` with the connection
  //   accepted 2. UC-2: Аня creates a conversation, signs in again through SAML with the same email in another letter case ->
  //      `me.id` is the same UUID and her conversation list holds the earlier conversation (one account, not two)
  //   rejected (each: redirect to `/login?error=<reason>`, no `aos_session` cookie, no session row, audit `sign_in_rejected` with
  //   connection, time and reason; for rows 7-8 the audit reason is the check that failed and carries no IdP response text):
  //      3. OIDC callback with `error=access_denied` -> `cancelled`
  //      4. the accepted callback replayed a second time -> `failed`
  //      5. callback without the `aos_login` cookie (another browser) -> `failed`
  //      6. login request older than 10 minutes (row's expiry moved) -> `failed`
  //      7. ID token with `email_verified: false` -> `failed`
  //      8. SAML response signed with a foreign key; then a SAML response past its validity window -> `failed` each, no session
  //      9. the connection switched off after the button was shown: the old sign-in link -> `connection_unavailable`, and the
  //         connection is absent from `GET /api/auth/connections`
  //      10. employee disabled before sign-in (a normal IdP answer for him) -> `account_disabled`, no session opened
  // Catches: a forged or stale IdP answer opening a session (the design's biggest risk), a replayed or foreign-browser callback
  //   accepted, an unverified email taking over an existing account, SAML and OIDC creating two accounts for one person,
  //   a client-chosen or `system:`-prefixed id, a disabled employee or disabled connection still letting someone in,
  //   a rejection left out of the audit.
  // @category: core-functionality
  // @dependency: AuthController, OidcSignIn, SamlSignIn, SignInService, SessionStore, AuditLog, test IdP, Postgres
  // @complexity: high
  it.todo('INT-2: a valid OIDC or SAML answer opens one account and session, and every forged, replayed, foreign, unverified or disabled attempt opens none and is audited');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: roles from two sources and the last-administrator guard
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-06.3 "роль «Дежурный» назначена в панели: когда IdP присылает группы без такой группы, роль остаётся"; AC-06.4
  //   "сотрудник в роли и из IdP, и из панели: когда IdP убирает его из группы, он остаётся в роли по назначению из панели";
  //   AC-08.3 "право администратора только у одного включённого сотрудника: снятие права с него или с его роли и блокировка
  //   отклоняются с причиной «не останется ни одного администратора»"; AC-08.4 "изменение от IdP применяется, в аудите и логе
  //   «не осталось ни одного администратора»"; AC-11.1 "смена сопоставления группы с ролью: запись с администратором, временем,
  //   ролью, прежним и новым сопоставлением". Design: KD-6; UC-5, UC-E5.
  // Behavior: admin panel calls and SCIM / sign-in group changes -> membership read back through `GET /api/admin/users/:id` ->
  //   status codes, unchanged state on rejection, audit rows.
  // Steps (one story over three people, literal expectations):
  //   1. UC-5: Аня holds «Дежурный» (panel) and «SRE» (IdP group `sre` AND panel assignment); the admin changes the group mapping of
  //      «SRE»; Аня signs in with groups that no longer include `sre` or `oncall` -> she still holds «Дежурный» and «SRE», both with
  //      source `panel` only; audit has the mapping change with admin, role, old and new group sets
  //   2. UC-E5: the only administrator Игорь holds the right through a role mapped to IdP group `adm`; the panel's "remove the
  //      role's admin right" -> 409 LAST_ADMIN; "block Игорь" -> 409 LAST_ADMIN; both leave rows unchanged
  //   3. concurrency (KD-6): two administrators remove the personal right from each other at the same moment -> exactly one
  //      request is 200 and the other 409 LAST_ADMIN; at least one enabled administrator remains
  //   4. IdP side: SCIM removes Игорь from `adm` -> 200, applied, audit and log hold `last_admin_removed`
  // Catches: an IdP sign-in wiping a panel assignment, a role vanishing from a person who was assigned it twice, a deployment left
  //   without an administrator by one request or by two crossing ones, an IdP change blocked by the panel's guard, an admin
  //   change that leaves no audit trail of before and after.
  // @category: core-functionality
  // @dependency: AdminUsersController, AdminRolesController, UsersService, ScimController, SignInService, AuditLog, advisory lock, Postgres
  // @complexity: high
  it.todo('INT-3: panel assignments survive the IdP, the last administrator cannot be removed from the panel even concurrently, and an IdP removal is applied and recorded');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4: connections, secrets and the SCIM token never leak (NFR-01, NFR-02)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-03.1 "секрет клиента сохранён: при повторном чтении вместо секрета пометка «задан»"; AC-03.3 "администратор изменил
  //   данные подключения: вход идёт по новым данным без рестарта"; AC-05.4 "токен SCIM возвращается только в ответе на его
  //   создание"; AC-11.2 "замена секрета: запись «секрет изменён», значения нет"; NFR-01 "в базе только зашифрованные"; NFR-02 "ни
  //   в логах, ни в аудите, ни в ответах, ни в истории агентов". Design: DC-6; UC-4.
  // Behavior: admin creates and edits a connection with known secret values -> every observable store is scanned for the values.
  // Steps:
  //   1. admin creates an OIDC connection by protocol and name -> `enabled: false`, `idpData.redirectUri` already holds its id;
  //      enabling it now -> 409 CONNECTION_INCOMPLETE
  //   2. saves an issuer whose discovery fails -> 422 CONNECTION_CHECK_FAILED, nothing stored
  //   3. saves the test issuer with a known secret `S1` and enables it -> `clientSecretSet: true`, no field of any response holds `S1`
  //   4. replaces the secret with `S2` and changes `client_id`; an employee signs in through it -> the IdP saw the new `client_id`
  //      (no restart); audit has `admin_change` with `secret_changed` and neither value
  //   5. creates two SCIM tokens (`T1`, then `T2`); `GET /api/admin/scim` and every later response never show a token, only the
  //      creation response does; audit has `scim_token_created` without the value
  //   6. scan: every text column of every `app` table, the captured process log, the audit rows and the responses above hold
  //      none of `S1`, `S2`, `T1`, `T2`, the sealed `SECRETS_KEY` value; the stored client secret is in the sealed format
  //      (version, key id, IV, ciphertext, tag), the stored SCIM token is a SHA-256 hash
  // Catches: a secret or token readable in the database, the log, the audit or a response; a connection edit that keeps using
  //   the cached old discovery until restart; a connection enabled without checked IdP data.
  // @category: core-functionality
  // @dependency: AdminConnectionsController, OidcSignIn (version-keyed discovery cache), SecretBox, AuditLog, logger, Postgres, test IdP
  // @complexity: high
  it.todo('INT-4: no known secret or token value appears in any table, log line, audit row or response, and an edited connection is used at the next sign-in without a restart');
});
