// enterprise-access / mcp-connect - API integration skeletons (real AppModule + real Postgres + MCP fixture process with its authorization server)
// Design Doc: docs/features/enterprise-access/design-mcp-connect.md (v1.1), Test Strategy UC-1 (registration half), UC-2 (registration and connect half),
//   UC-E1, UC-E2, UC-E5; PRD: docs/features/enterprise-access/prd.md FR-12, FR-13, FR-14 (AC-12.1, AC-12.2, AC-13.4, AC-13.5, AC-14.1, AC-14.3, AC-14.6).
// Generated: 2026-11-15 | Budget Used: 2 API integration skeletons here (INT-3, INT-4). The part's other 3 integration skeletons:
//   packages/agents/test/enterprise-access-mcp-connect.int.e2e-spec.ts (INT-1, INT-2) and
//   apps/web/src/components/shell/enterprise-access-mcp-connect.int.test.tsx (INT-5) = 5/5 (at the 5-test ceiling, each names a defect no
//   other test catches). 2 E2E in enterprise-access-mcp-connect.e2e-spec.ts.
// Test Type: Integration. Every case is `it.todo` - skeletons only, no implementation.
//
// Harness (follows apps/api/test/support/*, enterprise-access-identity.int.e2e-spec.ts): one `createTestApp()` per file against the docker-compose
//   Postgres, real AppModule with the real global SessionGuard; employees from `devSignIn(app, name, { admin })` (returns cookie and `id`), the
//   admin right removable through the identity admin operations. Responses are parsed with `@agent-os/contracts` schemas. Only `AGENT_TURN_CLIENT`
//   is the scripted model; MCP is the fixture PROCESS over HTTP with its authorization server (KD-7); its journal is the proof that a server
//   received nothing and its authorization-server log is the proof that no code was exchanged. The test plays the browser: GET the connect route
//   without following redirects, GET the authorization URL on the fixture, take `code`/`state`/`iss` from its 302 and GET `/api/mcp/oauth/callback`
//   with the employee's cookie (and, for forged cases, a different cookie, `state`, `iss`, or clock - the request row's expiry is moved in the table).
//   Support the implementation tasks add (not skeletons): `createTestApp` options `fixtureProcess` (start/stop, base URL, controls: no
//   `registration_endpoint`, token lifetime, revoke) and `env` (`PUBLIC_URL`, `NODE_ENV`); `test/support/mcp-browser.ts`; the `MCP_SERVERS_FILE`
//   option of `createTestApp` is deleted with the loader (see the adapted tests in the agents file header).
// Mock boundary: the model. Real: SessionGuard, `@AdminOnly`, `AuditLog`, `SecretBox`, controllers, `Agents.mcp`, Postgres, the fixture process.
//
// NOT here on purpose: the 401/closed-by-default proof of every new route (identity INT-1's route walk reads the router's own list, so the new
//   controllers are covered there); `@AdminOnly` refusal and its `access_denied` audit row (identity INT-1 row 3); the SecretBox seal table and
//   audit redaction table (identity unit tests); the address-scheme check and the error-to-outcome map (agents unit tests, see the
//   agents file header); the Zod shape of admin bodies (name kebab 1-32, token <= 4096, mode) - a unit table next to the controller schema,
//   `provenAt: unit`; the call-time behaviour (tokens, refresh, sets) - agents INT-1 / INT-2.

import { describe, it } from 'vitest';

describe('enterprise-access / mcp-connect - API integration (real AppModule + real Postgres + MCP fixture process)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: the administrator's registry - verification before saving, secrets never echoed, incomplete servers invisible
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-12.1 "администратор зарегистрировал сервер с общей учётной записью, регистрация прошла: в реестре виден список инструментов
  //   сервера с пометками"; AC-12.2 "адрес недоступен или учётные данные не подходят, администратор сохраняет сервер: сохранение
  //   возвращает причину, а сервер не включается"; AC-13.4 "администратор регистрирует сервер с личным OAuth и подключает свой аккаунт:
  //   платформа получает список инструментов, и сервер появляется в реестре"; AC-13.5 "администратор сохранил общую учётную запись
  //   сервера, сервер читают снова: значения нет, только пометка «задан»". Design: DC-6, DC-7, KD-4; UC-1 (registration half),
  //   UC-2 (before and after the admin account), UC-E1.
  // Behavior: admin HTTP calls on `/api/admin/mcp-servers` -> the server is checked over HTTP before anything is saved -> the stored view,
  //   status, audit row and (for oauth) the registered OAuth client.
  // Steps / rows (literal status and `errorCode`/`reason`; after every rejected row the table `agent_mcp_servers` is unchanged):
  //   1. `POST` `logs` with mode `shared` and the fixture's token -> 201, status `enabled`, tools with `readOnly` true only where the
  //      fixture declares `readOnlyHint: true`, `sharedTokenSet: true`; `GET /api/admin/mcp-servers/logs` returns the same and no field
  //      of any response holds the token; audit holds `admin_change` with `objectType: mcp_server`, before/after and `secret_changed`
  //      and no value. `PATCH` to a wrong token -> 422 `MCP_SERVER_CHECK_FAILED` reason `unauthorized`, the stored token still works.
  //   2. rejections (UC-E1): an address nobody answers -> 422 `unreachable`; `logs` with a wrong shared token -> `unauthorized`; a fixture
  //      source without `registration_endpoint` registered as oauth -> `oauth_not_supported`; the name `logs` again -> 409
  //      `MCP_SERVER_NAME_TAKEN` and the fixture journal and authorization log show no request for it. (No `insecure_url` row: the
  //      test app runs in `test`, where `http` is allowed, and the scheme check is a unit table, see the agents file header.)
  //   3. DC-7 / AC-13.4: `POST` `backoffice` with mode `oauth` -> 201, status `awaiting_admin_account`, a `client_id` stored; `PATCH
  //      enabled:true` -> 409 `MCP_SERVER_INCOMPLETE`; Аня's `GET /api/mcp/connections` does not list it. The admin's
  //      `GET /api/admin/mcp-servers/backoffice/connect` -> 302 to the fixture authorization URL; the browser returns with the admin's
  //      cookie -> 302 `/admin/servers/backoffice?connected=1`; the view is `enabled` with its tool list and Аня's list now holds it as
  //      `needs_auth`. `POST .../tools/refresh` by a second administrator without an account -> 409 `MCP_ACCOUNT_REQUIRED`; by the first ->
  //      200 with `added` and `removed` after the fixture's tool set changed.
  //   4. `DELETE /api/admin/mcp-servers/logs` -> 204; its `agent_tool_calls` history rows remain with the name as text; its accounts are gone.
  // Catches: a server saved without being checked (the owner learns at the first employee call); a shared token echoed in a response, the
  //   audit or the log; a half-registered oauth server offered to employees or to agents; a rejected registration that still leaves a
  //   row; a missing second administrator's account being treated as the first's.
  // @category: core-functionality
  // @dependency: AdminMcpServersController, McpRegistry, McpAccounts, SecretBox, AuditLog, MCP fixture process + authorization server, Postgres
  // @complexity: high
  it.todo(
    "INT-3: a server is verified before it is saved, no shared token appears in any response, and an oauth server stays invisible until the administrator's account has brought its tool list",
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4: connecting an employee's account - one-time, same-session, in time, and re-checked admin right
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-14.1 "Ане дано право на Sentry MCP с личным OAuth, а аккаунт не подключён, Аня открывает список подключений: видит Sentry со
  //   статусом «нужна аутентификация»"; AC-14.3 "Аня подключила аккаунт через вход в Sentry, возвращается в Agent OS: статус -
  //   «подключено»"; AC-14.6 "у Ани нет права на сервер с личным OAuth: этого сервера в списке нет". Design: DC-5, DC-13, KD-6; UC-2
  //   (employee half), UC-E2, UC-E5.
  // Behavior: employee/admin browser -> `/api/mcp/connections/:server/connect` (302) -> fixture authorization server -> `/api/mcp/oauth/callback`
  //   with the session cookie -> 302 target, `agent_mcp_accounts` row, audit row; every forged return gives the same refusal redirect.
  // Rows (literal redirects; for every rejected row: no account row for anyone changes, the fixture authorization log shows no token
  //   exchange unless stated):
  //   accepted 1. Аня's list: `backoffice` is `needs_auth`, Глеб (no right) sees an empty list; Аня's connect -> 302 to the fixture with PKCE
  //      `S256`, a `state`, `redirect_uri` = `{PUBLIC_URL}/api/mcp/oauth/callback` and a stored request row that holds the SHA-256 of `state`,
  //      not `state`; the return with her cookie -> 302 `/account?connected=backoffice`; her list is `connected`; the account row holds the
  //      tokens in the sealed format with its own purpose and no plaintext token; the request row is gone; audit `mcp_account` holds the
  //      connection without token values.
  //   refused connect 2. Глеб's connect; an unknown name; a disabled server; a `shared` server -> 302 `/account?error=connect_failed&server=<name>`
  //      each, and the authorization server received no authorize request.
  //   rejected returns (302 `/account?error=connect_failed&server=backoffice` each):
  //      3. the authorization server answers `error=access_denied` (Аня cancelled)
  //      4. Аня's correct return sent a second time (the request was consumed once)
  //      5. Аня's cookie with Борис's `code` and `state` -> no account for Аня and none created from Борис's request
  //      6. a correct return whose `iss` is another issuer, and one with `iss` missing while the authorization server announces it
  //      7. the request row older than 10 minutes (expiry moved in the table) -> expired
  //      8. no cookie -> 401 `AUTH_REQUIRED` from the session check (the callback is not `@Public()`), nothing consumed
  //   admin target 9. DC-13: the administrator starts connecting his account to `backoffice` (awaiting an account); his admin right is then
  //      removed (identity admin operation); he returns with a valid code -> 302 `/admin/servers/backoffice?error=connect_failed`, the
  //      fixture authorization log has no code exchange for it, no account and no tool list stored, the server still `awaiting_admin_account`,
  //      and audit holds `access_denied` for this employee and route.
  //   disconnect 10. `DELETE /api/mcp/connections/backoffice` -> 204, her list is `needs_auth`, audit `mcp_account` with `disconnected`;
  //      the same call again with no account -> 204 and no second audit row.
  // Catches: a login-CSRF where someone else's code or `state` binds the attacker's account to Аня, so her agent then acts in the
  //   attacker's account; a replayed or stale return accepted; a code from another authorization server accepted (no `iss` check); a
  //   callback left open without a session; a demoted administrator still enabling a server and saving its tool list; an employee shown or
  //   able to connect a server they have no right to; a token or `state` readable in the table or the audit.
  // @category: core-functionality
  // @dependency: McpConnectionsController, AdminMcpServersController, McpAccounts (begin/finish), McpRegistry, SessionGuard, SecretBox, AuditLog, MCP fixture authorization server, Postgres
  // @complexity: high
  it.todo(
    "INT-4: a connection request is consumed once, in time and only by the employee who began it, with the issuer checked, and a demoted administrator's return stores nothing",
  );
});
