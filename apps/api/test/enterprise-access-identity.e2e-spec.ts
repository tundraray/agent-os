// enterprise-access / identity - E2E skeletons (whole API process against real Postgres, workers on, scripted model)
// Design Doc: docs/features/enterprise-access/design-identity.md (v1.0), Test Strategy UC-3, UC-6, UC-E7; PRD FR-05, FR-07, FR-09, FR-03 (key).
// Generated: 2026-11-15 | Budget Used: 2/2 E2E for the part (integration skeletons: enterprise-access-identity.int.e2e-spec.ts and
//   the web one). Implementation timing: after the whole part is built (final phase).
// Test Type: End-to-End. Every case is `it.todo` - skeletons only.
//
// Why these two: they are the journeys whose failure the owner notices first and the only ones that need what an integration
//   skeleton cannot hold - a running agent with workers on (E2E-1) and several process starts against one database (E2E-2).
//   The repository has no browser E2E tool (no Playwright); the browser journey (login page -> chat -> sign out) is the web
//   integration skeleton plus the part's L1 browser checklist, not an E2E file.
//
// Harness: `createTestApp({ workers: true, model, mcpAccess })` as in agent-platform-chat.int.e2e-spec.ts; the employee id is
//   chosen up front through the fixture table (`MCP_ACCESS_TABLE` keyed by `identity_users.id`, key `*` allowed). E2E-2 needs the
//   `env` option of `createTestApp` (NODE_ENV, SECRETS_KEY, BOOTSTRAP_*) and starts the app more than once; the log is captured.
//   Cases clean up their own rows; no case depends on another.

import { describe, it } from 'vitest';

describe('enterprise-access / identity - E2E (full API process + real Postgres)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1: SCIM provisions an employee, and disabling him stops everything
  // ---------------------------------------------------------------------------------------------------------------
  // User Journey: IdP creates Борис over SCIM -> Борис signs in and starts an agent that is calling the model -> IdP changes his
  //   email, removes him from `sre`, then sends `active: false` -> everything of his stops -> IdP re-enables him -> he signs in
  //   and finds his old conversations.
  // AC: AC-05.1 "сотрудника назначают приложению: учётная запись появляется до первого входа"; AC-05.2 "поменяли имя или почту:
  //   обновлены"; AC-06.2 "убрали из группы `sre`: роли «SRE» нет"; AC-07.2 "Okta деактивирует его: следующий запрос с его сеансом
  //   получает отказ, агент «остановлен» с причиной «сотрудник отключён», и от его имени больше нет ни одного вызова модели
  //   или инструмента"; AC-07.4 "включили снова: видит прежние беседы". Design: DC-8, DC-9, DC-10; UC-3.
  // Verification items:
  //   - SCIM `POST /Users` -> the employee exists before any sign-in; `PATCH` changes the email in the same row (same `id`);
  //     `PATCH /Groups/:id` removing him from `sre` -> his role list no longer holds «SRE»
  //   - while the scripted model holds a call (latch) and an SSE stream of `GET /api/events` is open: `PATCH active:false` -> 200
  //   - the open stream is closed by the server; every next request with his cookie -> 401 ACCOUNT_DISABLED (also on a second app
  //     instance sharing the database, to prove the NOTIFY path, DC-9)
  //   - his agent is `stopped`, its history carries a `stopped` event with reason `owner_disabled` (DC-10); his tasks in `runtime_tasks`
  //     all hold `stopReason = owner_disabled`
  //   - after the latch is released the scripted model's call counter did not move: zero model and zero tool calls after the
  //     disable moment (DC-8)
  //   - `PATCH active:true` -> status active, nothing revived: old cookie still 401, the agent stays stopped; he signs in again and
  //     the conversation list holds his earlier conversations (AC-07.4)
  // Catches: an employee removed in the IdP whose already-running agent keeps calling the model or tools (spend and data access
  //   after dismissal), a stream that stays open on another instance, a disabled account that keeps a working cookie, and
  //   re-enabling that resurrects old sessions or loses conversations.
  // @category: e2e
  // @dependency: full-system (ScimController, UsersService, SessionGuard, TaskControl.stopOwner, IdentityOwnerGate, LiveHub NOTIFY, runtime workers, scripted model)
  // @complexity: high
  it.todo('E2E-1: after SCIM disables an employee with a running agent, his streams close, his cookie is refused, his agent is stopped with owner_disabled and no model or tool call follows; re-enabling restores only his data');

  // ---------------------------------------------------------------------------------------------------------------
  // E2E-2: operator lifecycle - bootstrap, restart and the secrets key
  // ---------------------------------------------------------------------------------------------------------------
  // User Journey: operator starts two instances on an empty database with `BOOTSTRAP_*` -> the first administrator signs in ->
  //   operator restarts with a connection enabled, then with all connections disabled -> operator starts with the wrong
  //   `SECRETS_KEY` -> runs `secrets:reset` with a new key -> starts again.
  // AC: AC-09.1 "база пуста, заданы `BOOTSTRAP_*`: сотрудник с почтой первого администратора после входа получает доступ к
  //   операциям администратора"; AC-09.2 "в базе есть включённое подключение: подключения и права не меняются, в логе запись, что
  //   значения не применены"; AC-09.3 "все подключения выключены: на странице входа есть подключение из окружения, а сотрудник
  //   с почтой из окружения после входа получает право администратора". Design: DC-7, DC-12; UC-6, UC-E7.
  // Verification items:
  //   - two instances started together on an empty database -> exactly one `identity_connections` row for the issuer and
  //     `client_id`; the employee with `BOOTSTRAP_ADMIN_EMAIL` signs in (test IdP) and `me.isAdmin` is true, an admin route answers 200
  //   - restart while that connection is enabled -> no new row, no right changed, the log holds `bootstrap skipped: an enabled connection exists`
  //   - all connections disabled, restart -> the same row is enabled again with the environment's secret (still one row), the
  //     connection is on `GET /api/auth/connections`, the bootstrap email gets the right again on sign-in
  //   - start with another `SECRETS_KEY` -> the process refuses to start; the log names the reason and both key numbers, and
  //     neither key value
  //   - `secrets:reset` with a new key, then start -> starts; connections are disabled, no sealed value remains in any table
  // Catches: two instances creating two connections (the second would then lock the first administrator's secret out), a restart
  //   that overwrites an operator's configuration, a deployment that cannot sign anyone in after the operator disables every
  //   connection, a server that starts with the wrong key and then fails every sign-in, a key value written to the log.
  // @category: e2e
  // @dependency: full-system (bootstrap under advisory lock, SecretBox key check, secrets:reset command, AuthController, test IdP, process start/stop)
  // @complexity: high
  it.todo('E2E-2: concurrent bootstrap makes one connection and one administrator, restarts respect existing configuration, and a wrong secrets key refuses to start until secrets:reset');
});
