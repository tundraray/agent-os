// enterprise-access / identity - E2E skeletons (whole API process against real Postgres, workers on, scripted model)
// Design Doc: docs/features/enterprise-access/design-identity.md (v2.0), Test Strategy UC-3, UC-6; PRD: docs/features/enterprise-access/prd.md
//   (v2.1) FR-05, FR-07, FR-32.
// Generated: 2026-11-15 | Budget Used: 2/2 E2E for the part (integration skeletons: enterprise-access-identity.int.e2e-spec.ts and the web
//   one). Implementation timing: after the whole part is built (final phase).
// Test Type: End-to-End. Every case is `it.todo` - skeletons only.
//
// Why these two: they are the journeys whose failure the owner notices first and the only ones that need what an integration skeleton
//   cannot hold - a running agent with workers on and several app instances (E2E-1) and a separate operator process with a password on
//   standard input (E2E-2). The repository has no browser E2E tool (no Playwright); the browser journey (login page -> chat -> sign out)
//   is the web integration skeleton plus the part's L1 browser checklist, not an E2E file.
//
// Harness: `createTestApp({ workers: true, model, mcpAccess })` as in agent-platform-chat.int.e2e-spec.ts; employees sign in through
//   `POST /api/auth/password` (support/session.ts of the integration file), and their `id` is read from `GET /api/auth/me`; the test
//   puts that id (or `*`) into `mcpAccess` when it must reach a fixture MCP server, by creating the employee before the app's table is
//   read or by using the `*` key. E2E-1 needs the test provider/IdP of the integration file (support/test-provider.ts) and a second app
//   instance on the same database. E2E-2 spawns the real `identity:super-admin` entry point (`pnpm --filter api identity:super-admin`,
//   or the compiled entry with `DATABASE_URL`) as a child process. Cases clean up their own rows; no case depends on another.

import { describe, it } from 'vitest';

describe('enterprise-access / identity - E2E (full API process + real Postgres)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1: SCIM provisions an employee, and disabling him stops everything
  // ---------------------------------------------------------------------------------------------------------------
  // User Journey: IdP creates Борис over SCIM (token of the `oidc` provider) -> Борис signs in through the provider and starts an agent
  //   that is calling the model -> IdP changes his email, removes him from `sre`, then sends `active: false` -> everything of his stops ->
  //   IdP re-enables him -> he signs in and finds his old conversations.
  // AC: AC-05.1 "сотрудника назначают приложению: учётная запись появляется до первого входа"; AC-05.2 "поменяли имя или почту:
  //   обновлены"; AC-06.2 "убрали из группы `sre`: роли «SRE» нет"; AC-07.2 "Okta деактивирует его: следующий запрос с его сеансом
  //   получает отказ, агент «остановлен» с причиной «сотрудник отключён», и от его имени больше нет ни одного вызова модели или
  //   инструмента"; AC-07.4 "включили снова: видит прежние беседы". Design: DC-8, DC-9, DC-10; UC-3.
  // Verification items:
  //   - SCIM `POST /Users` -> the employee exists before any sign-in; `PATCH` changes the email in the same row (same `id`);
  //     `PATCH /Groups/:id` removing him from `sre` -> his role list no longer holds «SRE»
  //   - while the scripted model holds a call (latch) and an SSE stream of `GET /api/events` is open: `PATCH active:false` -> 200
  //   - the open stream is closed by the server; every next request with his cookie -> 401 ACCOUNT_DISABLED (also on a second app
  //     instance sharing the database, to prove the NOTIFY path, DC-9)
  //   - his agent is `stopped`, its history carries a `stopped` event with reason `owner_disabled` (DC-10); his tasks in `runtime_tasks`
  //     all hold `stopReason = owner_disabled`
  //   - after the latch is released the scripted model's call counter did not move: zero model and zero tool calls after the disable
  //     moment (DC-8)
  //   - `PATCH active:true` -> status active, nothing revived: the old cookie is 401 AUTH_REQUIRED, the agent stays stopped; he signs in
  //     again and the conversation list holds his earlier conversations (AC-07.4)
  // Catches: an employee removed in the IdP whose already-running agent keeps calling the model or tools (spend and data access after
  //   dismissal), a stream that stays open on another instance, a disabled account that keeps a working cookie, and re-enabling that
  //   resurrects old sessions or loses conversations.
  // @category: e2e
  // @dependency: full-system (ScimController, UsersService, SessionGuard, TaskControl.stopOwner, OwnerGate, LiveHub NOTIFY, runtime workers, scripted model, test provider)
  // @complexity: high
  it.todo('E2E-1: after SCIM disables an employee with a running agent, his streams close, his cookie is refused, his agent is stopped with owner_disabled and no model or tool call follows; re-enabling restores only his data');

  // ---------------------------------------------------------------------------------------------------------------
  // E2E-2: the operator command is the way back in
  // ---------------------------------------------------------------------------------------------------------------
  // User Journey: operator runs `identity:super-admin` for login `igor` with the password on standard input -> Игорь signs in and
  //   administers -> the built-in role cannot be broken -> Игорь forgets the password, five bad tries lock his login, and the operator
  //   runs the command again with a new password -> he signs in as an administrator again.
  // AC: AC-32.1 "в базе нет ни одного сотрудника: оператор заводит локальную учётную запись с логином, паролем и ролью «Супер-
  //   администратор», её владелец входит и получает доступ к операциям администратора"; AC-32.2 "ни один администратор не может войти:
  //   оператор прописывает роль локальной учётной записи, владелец после входа получает доступ". Design: DC-15, DC-14 (reset by the
  //   command); UC-6. (AC-32.3, no sign-up path, is proven by the INT-1 route walk; the test does not need an empty database, it uses
  //   a login no other test uses.)
  // Verification items:
  //   - the command runs as a separate process with `DATABASE_URL` and the password only on standard input; exit code 0; neither the
  //     password nor its hash appears in the process arguments, its output or the log
  //   - the account exists with a server-issued UUID, the built-in «Супер-администратор» role is assigned, the account is enabled; Игорь
  //     signs in through `POST /api/auth/password` -> `me.isAdmin: true` and an `@AdminOnly` route answers 200; the audit holds an
  //     `admin_change` with actor `system`
  //   - `DELETE`, a rename and "remove the admin right" on the built-in role -> 409 BUILTIN_ROLE each, role unchanged; assigning and
  //     unassigning the role to other employees works as for any role
  //   - five wrong passwords for `igor` -> the next try with the right password is 429 TOO_MANY_ATTEMPTS; the command is run again with
  //     a new password -> the counter is cleared, the old password is refused, the new one signs in as an administrator; his earlier
  //     disabled flag, if set, is cleared too
  //   - a command run for a login that belongs to an existing employee finds that account instead of making a second one
  // Catches: a recovery path that cannot be used (the role not assigned, the lockout not cleared, the account left disabled), a password
  //   leaked through the command line, shell history or the log, a second account created for the same login, and an administrator
  //   role that someone can delete or weaken and so lock everyone out for good.
  // @category: e2e
  // @dependency: full-system (identity:super-admin entry point as a child process, PasswordSignIn, built-in role, AdminRolesController, AuditLog, Postgres)
  // @complexity: medium
  it.todo('E2E-2: the operator command creates or repairs a super-administrator whose password and lockout are reset, and the built-in role stays intact');
});
