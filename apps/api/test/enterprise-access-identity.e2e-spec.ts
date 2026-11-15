// enterprise-access / identity - E2E skeleton (the operator command as a separate process against real Postgres)
// Design Doc: docs/features/enterprise-access/design-identity.md (v2.2, Approved), Test Strategy UC-5; PRD: docs/features/enterprise-access/prd.md (v2.4) FR-32.
// Generated: 2026-11-15 | Budget Used: 1/2 E2E for the part (3 integration skeletons in enterprise-access-identity.int.e2e-spec.ts).
//   Implementation timing: after the whole part is built (final phase).
// Test Type: End-to-End. The case is `it.todo` - skeleton only.
//
// Why this one: it is the way back into a deployment nobody can sign in to, and it is the only thing in the part that is a separate
//   process with the password on standard input - an integration skeleton cannot hold that. The block journey that was an E2E in v2.0 is
//   now INT-2 row 5 / UC-4 (one process, no second instance, no `stopOwner`: the agent's task ends `failed` with `owner_disabled` at its next
//   check, so integration is the lowest level that catches it). The owner allows one more E2E; none is needed. There is no browser E2E tool
//   in the repo (no Playwright); the browser journey is the part's manual L1 checklist.
//
// Harness: `createTestApp()` of the integration file's support (support/session.ts: `signInWithPassword`, the cookie helper); the app runs
//   in the test process against the same Postgres as the command. The command is the real `identity:super-admin` entry point
//   (`pnpm --filter api identity:super-admin`, or the compiled entry with `DATABASE_URL`) spawned as a child process; the test writes the
//   password to its standard input and reads its exit code, output and stderr. The test uses a login no other test uses, so the database
//   does not have to be empty. The case cleans up its own rows.

import { describe, it } from 'vitest';

describe('enterprise-access / identity - E2E (operator command + real Postgres)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1: the operator command is the way back in
  // ---------------------------------------------------------------------------------------------------------------
  // User Journey: the operator runs `identity:super-admin` for login `igor` with the password on standard input -> Игорь signs in and
  //   administers -> the built-in role cannot be broken -> Игорь forgets the password and the operator runs the command again with a new one ->
  //   he signs in as an administrator again.
  // AC: AC-32.1 "в базе нет ни одного сотрудника: оператор заводит локальную учётную запись с логином, паролем и ролью «Супер-администратор»,
  //   её владелец входит и получает доступ к операциям администратора"; AC-32.2 "ни один администратор не может войти: оператор прописывает роль
  //   локальной учётной записи, владелец после входа получает доступ". Design: DC-15; UC-5. (AC-32.3, no sign-up path, is proven by the
  //   INT-1 route walk; AC-08.2 and AC-11.1 of UC-5 - an assigned admin role gives access and is audited - are asserted in INT-1 row 3, the
  //   lowest level; here Игорь only needs to assign and unassign a role to show the built-in one is not special for other employees.)
  // Verification items:
  //   - the command runs as a separate process with `DATABASE_URL` and the password only on standard input; exit code 0; neither the password
  //     nor its hash appears in the process arguments, its output or the log
  //   - the account exists with a server-issued UUID, the built-in «Супер-администратор» role is assigned, the account is enabled; Игорь signs
  //     in through `POST /api/auth/password` -> `me.isAdmin: true` and an `@AdminOnly` route answers 200; the audit holds an `admin_change`
  //     with actor `system`
  //   - `DELETE`, a rename and "remove the admin right" on the built-in role -> 409 BUILTIN_ROLE each, role unchanged; assigning the role to
  //     another employee and unassigning it works as for any role
  //   - the command is run again for `igor` with a new password -> the old password is refused, the new one signs in as an administrator; if
  //     Игорь had been blocked, the command re-enabled him
  //   - a command run for a login that belongs to an existing employee finds that account instead of making a second one
  // Catches: a recovery path that cannot be used (the role not assigned, the account left disabled, the new password not taking effect), a
  //   password leaked through the command line, shell history or the log, a second account created for the same login, and an administrator
  //   role that someone can delete or weaken and so lock everyone out for good.
  // @category: e2e
  // @dependency: full-system (identity:super-admin entry point as a child process, PasswordSignIn, built-in role, AdminRolesController, AuditLog, Postgres)
  // @complexity: medium
  it.todo('E2E-1: the operator command creates or repairs a super-administrator with the password taken from standard input, and the built-in role stays intact');
});
