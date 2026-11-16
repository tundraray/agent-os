// enterprise-access / mcp-connect - API integration skeleton (real AppModule + real Postgres + MCP fixture process with its authorization server)
// Design Doc: docs/features/enterprise-access/design-mcp-connect.md (v1.5, Approved), Test Strategy UC-1 (registration half), UC-2 (registration
//   and connect half), UC-E1, UC-E2, UC-E3, UC-E5; PRD: docs/features/enterprise-access/prd.md (v2.4) FR-12, FR-13, FR-14, NFR-02
//   (AC-12.1, AC-12.2, AC-13.4, AC-13.5, AC-13.6, AC-14.1, AC-14.3, AC-14.6).
// Generated: 2026-11-16 (rewritten to v1.5) | Budget Used: 1 of the part's 3 integration skeletons here (INT-3: the registry, the connect flow and
//   the secrets scan over HTTP); INT-1 and INT-2 (the call path) are in packages/agents/test/enterprise-access-mcp-connect.int.e2e-spec.ts.
//   0 E2E (the Test Strategy names none); the former E2E file and the web skeleton are deleted.
// Test Type: Integration. The case is `it.todo` - skeleton only, no implementation.
//
// Harness (follows apps/api/test/support/*, enterprise-access-identity.int.e2e-spec.ts): one `createTestApp({ workers: true, captureLog: true })`
//   against the docker-compose Postgres, real AppModule with the real global SessionGuard; employees from `createEmployee` / `signInWithPassword`
//   (support/session.ts) with a super administrator from `seedSuperAdmin` and a second administrator; the administrator's right is removed
//   through the identity operation `/api/admin/users/:id` (role change) or the block route. Responses are parsed with `@agent-os/contracts`
//   schemas. Only `AGENT_TURN_CLIENT` is the scripted model; MCP is the fixture PROCESS over HTTP with its authorization server (KD-7); its
//   journal is the proof that a server received nothing and its authorization-server log is the proof that no code was exchanged. The test
//   plays the browser: GET the connect route without following redirects, GET the authorization URL on the fixture, take `code`/`state`/`iss`
//   from its 302 and GET `/api/mcp/oauth/callback` with the employee's cookie (and, for forged rows, another cookie, `state` or `iss`).
//   Support the implementation tasks add (not skeletons): `createTestApp` options `fixtureProcess` (start/stop, base URL, controls: a source
//   without `registration_endpoint`, a new tool, token revocation) and `PUBLIC_URL`/`NODE_ENV` env; `test/support/mcp-browser.ts`;
//   the `MCP_SERVERS_FILE` option of `createTestApp` is deleted with the loader.
// Mock boundary: the model. Real: SessionGuard, `@AdminOnly`, `AuditLog`, controllers, `Agents.mcp`, Postgres, the fixture process.
//
// NOT here on purpose: the 401/closed-by-default proof of every new route (identity INT-1's route walk reads the router's own list, so the new
//   controllers are covered there); `@AdminOnly` refusal and its audit row (identity INT-1); the Zod shape of admin bodies (name kebab 1-32,
//   token <= 4096, mode) - a unit table next to the controller schema, `provenAt: unit`; the scheme check (`insecure_url`: the test app runs
//   in `test`, where `http` is allowed) - a unit table in the registry's verification test; the 10-minute life of a connection request - a
//   unit test of the in-memory request store with a fake clock (a pure rule; the request lives in memory, so there is no table to age);
//   the call-time behaviour (tokens, refresh, sets, refusals) - agents INT-1 / INT-2; the web page and the menu - unit tables
//   (status-to-label, `needs_auth` count, `connected`/`error` parameters) plus the manual L1 browser checklist (Sentry on `http://localhost:4000`,
//   then on an `https` tunnel; first call after access-token expiry); no web integration test, the part's budget goes to rights and secrets.
// Not automated: AC-15.1 (`seed:mcp`) - manual run of the script; AC-15.2 - a property of this suite (no internet, no real accounts).

import { describe, it } from 'vitest';

describe('enterprise-access / mcp-connect - API integration (real AppModule + real Postgres + MCP fixture process)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: the registry verifies before it saves, a connection binds to the browser's session, and no secret leaves
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-12.1 "администратор зарегистрировал сервер с общей учётной записью, регистрация прошла: в реестре виден список инструментов
  //   сервера с пометками"; AC-12.2 "адрес недоступен или учётные данные не подходят, администратор сохраняет сервер: сохранение возвращает
  //   причину, а сервер не включается"; AC-13.4 "администратор регистрирует сервер с личным OAuth и подключает свой аккаунт: платформа
  //   получает список инструментов, и сервер появляется в реестре"; AC-13.5 "администратор сохранил общую учётную запись сервера, сервер
  //   читают снова: значения нет, только пометка «задан»"; AC-13.6 "Аня и Борис подключили аккаунты к серверу, администратор удаляет
  //   сервер: токенов Ани и Бориса для этого сервера на платформе больше нет"; AC-14.1 "Ане дано право на Sentry MCP с личным OAuth, а
  //   аккаунт не подключён: Аня видит Sentry со статусом «нужна аутентификация»"; AC-14.3 (the status half: "статус - «подключено»");
  //   AC-14.6 "у Ани нет права на сервер с личным OAuth: этого сервера в списке нет"; NFR-02 "ни в логах, ни в аудите, ни в ответах, ни в
  //   истории агентов". Design: DC-5, DC-6, DC-7, DC-13, KD-6; UC-1 and UC-2 (registration and connect), UC-E1, UC-E2, UC-E3, UC-E5.
  // Behavior: admin and employee HTTP calls -> the server is checked over HTTP before anything is saved -> the stored view, status and audit
  //   row; the browser's connect and return go through the session-guarded `/api/mcp/...` routes -> `agent_mcp_accounts` row or a refusal
  //   redirect; at the end one scripted agent run and a scan of every outward channel for the known secret values.
  // Binding note (the OAuth callback is a GET that changes state, so it must not act without the browser's own binding): the design binds it
  //   with the session itself plus a one-time `state` that belongs to the employee who began it (KD-6, DC-5); there is no separate cookie
  //   and the callback is not `@Public()`. Row 6 below is that proof (it is also the login-CSRF case of UC-E2: someone else's code and `state` in Аня's session, or Аня's in Борис's).
  // Rows (literal status codes, redirects, `errorCode`/`reason`; after every rejected row the stored rows are unchanged and the authorization
  //   server of the fixture saw no token request for it):
  //   registry
  //   1. AC-12.1 / AC-13.5: `POST /api/admin/mcp-servers` `logs`, mode `shared`, the fixture's token -> 201, status `enabled`, tools with
  //      `readOnly` true only where the fixture declares `readOnlyHint: true`, `sharedTokenSet: true`; `GET .../logs` returns the same, and no
  //      field of any response holds the token; the audit holds `admin_change` with `objectType: mcp_server`, before/after and
  //      `secret_changed`, no value. `PATCH` with a wrong token -> 422 `MCP_SERVER_CHECK_FAILED` reason `unauthorized`, the stored token
  //      still works.
  //   2. AC-12.2 / DC-6 (UC-E1): an address nobody answers -> 422 `unreachable`; `logs`-source with a wrong shared token -> `unauthorized`;
  //      a fixture source without `registration_endpoint` registered as oauth -> `oauth_not_supported`; the name `logs` again -> 409
  //      `MCP_SERVER_NAME_TAKEN` and the fixture saw no request for it; the table `agent_mcp_servers` has not grown.
  //   3. AC-13.4 / DC-7: `POST` `backoffice`, mode `oauth` -> 201, status `awaiting_admin_account`; `PATCH enabled:true` -> 409
  //      `MCP_SERVER_INCOMPLETE`; Аня's `GET /api/mcp/connections` does not list it. The admin's `GET /api/admin/mcp-servers/backoffice/connect`
  //      -> 302 to the fixture authorization URL; his return with his cookie -> 302 `/admin/servers/backoffice?connected=1`; the view is
  //      `enabled` with its tool list. `POST .../tools/refresh` by a second administrator without an account -> 409 `MCP_ACCOUNT_REQUIRED`;
  //      by the first -> 200 with `added` and `removed` after the fixture's tool set changed.
  //   employee connection
  //   4. AC-14.1 / AC-14.6: Аня (permitted) lists `backoffice` as `needs_auth`; Глеб (no right) gets an empty list.
  //   5. refused starts: Глеб's connect, an unknown name, a disabled server, a `shared` server -> 302
  //      `/account?error=connect_failed&server=<name>` each, and the fixture's authorization server received no authorize request.
  //   6. binding of the return (the callback is not `@Public()`): Аня begins a connection; the return WITHOUT a cookie -> 401
  //      `AUTH_REQUIRED` and nothing is consumed or stored; Борис's cookie with Аня's `code` and `state` -> 302
  //      `/account?error=connect_failed&server=backoffice`, no account for Борис; then Аня's own return with her cookie -> 302
  //      `/account?connected=backoffice` (the refused attempts did not spend or hijack her request); her list is `connected` (AC-14.3);
  //      the same return sent again -> `connect_failed` and no second change.
  //   7. forged and cancelled returns, each -> `/account?error=connect_failed&server=backoffice` and no account: the authorization server
  //      answers `error=access_denied` (Аня cancelled); a return whose `iss` is another issuer; a return with `iss` missing while the
  //      authorization server announces it.
  //   8. DC-13 (UC-E5): the administrator begins connecting his account to a second oauth server that awaits its account; his admin right is
  //      then removed through the identity operation; he returns with a valid code -> 302 `/admin/servers/<name>?error=connect_failed`, the
  //      authorization log has no code exchange, no account and no tool list stored, the server is still `awaiting_admin_account`, and the audit
  //      holds `access_denied` for this employee.
  //   9. `DELETE /api/mcp/connections/backoffice` by Аня -> 204, her list is `needs_auth`; the same call again with no account -> 204.
  //   deletion
  //   10. AC-13.6: Аня, Борис and the administrator have accounts on `backoffice`; `DELETE /api/admin/mcp-servers/backoffice` -> 204; no row of
  //       `agent_mcp_accounts` names `backoffice` any more; `agent_tool_calls` history rows of the server stay with the name as text.
  //   secrets
  //   11. NFR-02 (UC-E3): with the known values (the shared token before and after the administrator replaced it, Аня's and the admin's access
  //       and refresh tokens, the OAuth client secret if the fixture issues one, `state`, the authorization `code`), one scripted run of Аня's
  //       agent calls `logs` and `backoffice`, the second with a lost account (`auth_required`); then the captured process log, the audit rows,
  //       every response of rows 1-10, the agent's history and the tool outputs hold none of the values; the log carries server, employee,
  //       call and connection-request ids and `expiresIn` only; the audit of the token replacement holds `secret_changed`.
  // Catches: a server saved without being checked (the owner learns at the first employee call); a shared token or a client secret echoed in a
  //   response, the audit, the log or the agent history by a path no other test reads (the OAuth callback's redirect logging, the transport's error
  //   text, tool outputs); a half-registered oauth server offered to employees or to agents; a rejected registration that still leaves a row; a
  //   second administrator's missing account treated as the first's; a login-CSRF where someone else's code or `state` binds the attacker's
  //   account to Аня (her agent then acts in the attacker's account); a replayed return accepted; a code from another authorization server
  //   accepted (no `iss` check); a callback left open without a session, or one that spends a request without it; a demoted administrator
  //   still enabling a server and saving its tool list; an employee able to connect a server they have no right to; accounts surviving the
  //   deletion of their server.
  // @category: core-functionality
  // @dependency: AdminMcpServersController, McpConnectionsController, McpRegistry, McpAccounts (begin/finish), SessionGuard, AuditLog, logger masker, scripted model, runtime workers, MCP fixture process + authorization server, Postgres
  // @complexity: high
  it.todo(
    'INT-3: a server is verified before it is saved, the OAuth return changes nothing without the session of the employee who began it, a demoted administrator stores nothing, deletion removes every account, and no secret value appears in any response, audit row, log or history',
  );
});
