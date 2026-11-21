// enterprise-access / identity - E2E (the operator command as a separate process against real Postgres)
// Design Doc: docs/features/enterprise-access/design-identity.md (v2.2, Approved), Test Strategy UC-5; PRD: docs/features/enterprise-access/prd.md (v2.4) FR-32.
// Budget Used: 1/2 E2E for the part (3 integration tests in enterprise-access-identity.int.e2e-spec.ts).
//
// Why this one: it is the way back into a deployment nobody can sign in to, and it is the only thing in the part that is a separate
//   process with the password on standard input - an integration test cannot hold that. The block journey that was an E2E in v2.0 is
//   now INT-2 row 5 / UC-4 (one process, no second instance, no `stopOwner`: the agent's task ends `failed` with `owner_disabled` at its next
//   check, so integration is the lowest level that catches it). There is no browser E2E tool in the repo (no Playwright); the browser
//   journey is the part's manual L1 checklist.
//
// Harness: `createTestApp()` (support/session.ts: `signInWithPassword`, `createEmployee`); the app runs in the test process against the
//   same Postgres as the command. The command is the compiled entry of `pnpm --filter api identity:super-admin` (precondition: `pnpm
//   --filter api build`) spawned as a child process the way the package script runs it, with the app's `DATABASE_URL`; the test writes
//   the password to its standard input and reads its exit code, output and stderr. The test uses a login no other test uses, so the
//   database does not have to be empty. `afterAll` deletes the two accounts the case made (plan rule 11; there is no API to delete an
//   account, so the rows are deleted in the database, and their role assignments and sessions go by cascade).

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigService } from '@nestjs/config';
import {
  AdminUserDetailSchema,
  AdminUserSummarySchema,
  CurrentUserSchema,
  RoleDetailSchema,
  RoleListSchema,
} from '@agent-os/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR } from '../src/audit/audit-log';
import { expectBody, expectError } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import {
  apiRequest,
  createEmployee,
  signInWithPassword,
} from './support/session';

/** Bound of one test: two argon2id hashes in child processes and a few requests. */
const TEST_TIMEOUT_MS = 120_000;

/** `apps/api`: the working directory of `pnpm --filter api identity:super-admin`. */
const API_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The compiled command entry, relative to `API_DIR`. */
const COMMAND_ENTRY = 'dist/super-admin-cli.js';

/** The sources the compiled entry runs, relative to `API_DIR`. */
const COMMAND_SOURCES = [
  'src/identity/super-admin-cli.ts',
  'src/identity/super-admin.ts',
  'src/identity/password.ts',
] as const;

/** Fails fast unless the compiled entry exists and is not older than its sources (the e2e run does not build). */
function assertCommandBuilt(): void {
  const entry = join(API_DIR, COMMAND_ENTRY);
  const hint = 'run `pnpm --filter api build` before this test';
  if (!existsSync(entry))
    throw new Error(`${COMMAND_ENTRY} is missing: ${hint}`);
  const builtAt = statSync(entry).mtimeMs;
  const stale = COMMAND_SOURCES.filter(
    (source) => statSync(join(API_DIR, source)).mtimeMs > builtAt,
  );
  if (stale.length > 0)
    throw new Error(
      `${COMMAND_ENTRY} is older than ${stale.join(', ')}: ${hint}`,
    );
}

/** An `@AdminOnly` route every check of the admin right calls. */
const ADMIN_ROUTE = '/admin/roles';

let harness: TestApp;

/** The accounts this file created; `afterAll` deletes exactly these rows. */
const createdUserIds: string[] = [];

interface CommandRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the operator command as `pnpm --filter api identity:super-admin` does (`node
 * --env-file-if-exists=.env dist/super-admin-cli.js`, from `apps/api`) with the app's
 * `DATABASE_URL`, writes `password` and one line break to its standard input and waits for its exit.
 */
function runSuperAdminCommand(
  args: readonly string[],
  password: string,
): Promise<CommandRun> {
  const databaseUrl = harness.app
    .get(ConfigService)
    .getOrThrow<string>('DATABASE_URL');
  const child = spawn(
    process.execPath,
    ['--env-file-if-exists=.env', COMMAND_ENTRY, ...args],
    { cwd: API_DIR, env: { ...process.env, DATABASE_URL: databaseUrl } },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(`${password}\n`);
  });
}

/** `--login`, `--name`, `--email` of Игорь's account. */
function igorArgs(login: string): string[] {
  return [
    '--login',
    login,
    '--name',
    'Игорь',
    '--email',
    `${login}@example.test`,
  ];
}

/** Every stored row of `login` with its password hash. */
async function accountRows(
  login: string,
): Promise<{ id: string; status: string; passwordHash: string }[]> {
  const { rows } = await harness.pool.query<{
    id: string;
    status: string;
    passwordHash: string;
  }>(
    'SELECT id, status, password_hash AS "passwordHash" FROM app.identity_users WHERE login = $1',
    [login],
  );
  return rows;
}

/** Fails unless the run printed none of `secrets` (the password, its hash) to its output or stderr. */
function expectNoSecretsIn(run: CommandRun, secrets: readonly string[]): void {
  for (const secret of secrets) {
    expect(run.stdout).not.toContain(secret);
    expect(run.stderr).not.toContain(secret);
  }
}

async function expectRefusal(
  response: ReturnType<typeof apiRequest>,
  status: number,
  errorCode: string,
): Promise<void> {
  expect((await expectError(response, status)).errorCode).toBe(errorCode);
}

function expectSignInRefused(
  login: string,
  password: string,
  errorCode: 'INVALID_CREDENTIALS' | 'ACCOUNT_DISABLED',
): Promise<void> {
  return expectRefusal(
    apiRequest(harness.app, null, 'post', '/auth/password', {
      login,
      password,
    }),
    401,
    errorCode,
  );
}

describe('enterprise-access / identity - E2E (operator command + real Postgres)', () => {
  beforeAll(async () => {
    assertCommandBuilt();
    harness = await createTestApp({ captureLog: true });
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    // Only the rows this run made: their sessions and role assignments go by cascade.
    await harness?.pool.query(
      'DELETE FROM app.identity_users WHERE id = ANY($1::uuid[])',
      [createdUserIds],
    );
    await harness?.close();
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1: the operator command is the way back in
  // ---------------------------------------------------------------------------------------------------------------
  // User Journey: the operator runs `identity:super-admin` for login `igor` with the password on standard input -> Игорь signs in and
  //   administers -> the built-in role cannot be broken -> Игорь is blocked and forgets the password, the operator runs the command again
  //   with a new one -> he signs in as an administrator again.
  // AC: AC-32.1 "в базе нет ни одного сотрудника: оператор заводит локальную учётную запись с логином, паролем и ролью «Супер-администратор»,
  //   её владелец входит и получает доступ к операциям администратора"; AC-32.2 "ни один администратор не может войти: оператор прописывает роль
  //   локальной учётной записи, владелец после входа получает доступ". Design: DC-15; UC-5. (AC-32.3, no sign-up path, is proven by the
  //   INT-1 route walk; AC-08.2 and AC-11.1 of UC-5 are asserted in INT-1 row 3, the lowest level.)
  // Catches: a recovery path that cannot be used (the role not assigned, the account left disabled, the new password not taking effect), a
  //   password leaked through the command line, its output or the log, a second account created for the same login, and an administrator
  //   role that someone can delete or weaken and so lock everyone out for good.
  // @category: e2e
  // @dependency: full-system (identity:super-admin entry point as a child process, PasswordSignIn, built-in role, AdminRolesController, AuditLog, Postgres)
  // @complexity: medium
  it(
    'E2E-1: the operator command creates or repairs a super-administrator with the password taken from standard input, and the built-in role stays intact',
    async () => {
      const { app } = harness;
      const login = `igor-${randomUUID()}`;
      const firstPassword = `igor-first-${randomUUID()}`;
      const newPassword = `igor-new-${randomUUID()}`;

      // A password typed as an argument is refused without echoing it, and no account is made.
      const typedPassword = `typed-${randomUUID()}`;
      const typedLogin = `igor-typed-${randomUUID()}`;
      for (const args of [
        [...igorArgs(typedLogin), '--password', typedPassword],
        [...igorArgs(typedLogin), typedPassword],
      ]) {
        const refused = await runSuperAdminCommand(args, firstPassword);
        expect(refused.exitCode).toBe(1);
        expectNoSecretsIn(refused, [typedPassword, firstPassword]);
      }
      expect(await accountRows(typedLogin)).toEqual([]);

      // Step 1 (AC-32.1) - When: the operator runs the command with the password on standard input;
      // Then: exit 0, the account is made enabled, and neither the password nor its hash is printed
      const created = await runSuperAdminCommand(
        igorArgs(login),
        firstPassword,
      );
      expect(created.exitCode).toBe(0);
      const [account, ...extra] = await accountRows(login);
      expect(extra).toEqual([]);
      expect(account).toMatchObject({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        status: 'active',
      });
      if (account === undefined) throw new Error(`No account for ${login}`);
      createdUserIds.push(account.id);
      expect(created.stdout).toContain('Super-administrator created');
      expect(created.stdout).toContain(account.id);
      expectNoSecretsIn(created, [firstPassword, account.passwordHash]);

      // Step 2 - Then: Игорь signs in as an administrator, the built-in role is his, and the audit
      // holds the command's change with actor `system`
      let igor = await signInWithPassword(app, login, firstPassword);
      expect(igor.id).toBe(account.id);
      const me = await expectBody(
        apiRequest(app, igor, 'get', '/auth/me'),
        200,
        CurrentUserSchema,
      );
      expect(me.isAdmin).toBe(true);
      const roles = await expectBody(
        apiRequest(app, igor, 'get', ADMIN_ROUTE),
        200,
        RoleListSchema,
      );
      const builtinRole = roles.find((role) => role.builtin);
      if (builtinRole === undefined)
        throw new Error('No built-in role in GET /admin/roles');
      const builtin = { id: builtinRole.id, name: builtinRole.name };
      const igorView = await expectBody(
        apiRequest(app, igor, 'get', `/admin/users/${igor.id}`),
        200,
        AdminUserDetailSchema,
      );
      expect(igorView).toMatchObject({
        status: 'active',
        adminRight: { roles: [builtin] },
      });
      const { rows: audit } = await harness.pool.query<{
        before: unknown;
        after: unknown;
      }>(
        `SELECT before, after FROM app.audit_events
          WHERE kind = 'admin_change' AND actor = $1 AND object_type = 'user' AND object_id = $2
          ORDER BY at, id`,
        [SYSTEM_ACTOR, igor.id],
      );
      expect(audit).toEqual([
        {
          before: null,
          after: expect.objectContaining({ login, builtinRole: true }),
        },
      ]);

      // Step 3 (DC-15) - When: delete, rename and take the admin right off the built-in role;
      // Then: 409 BUILTIN_ROLE each, and the role is unchanged
      const builtinPath = `/admin/roles/${builtin.id}`;
      await expectRefusal(
        apiRequest(app, igor, 'delete', builtinPath),
        409,
        'BUILTIN_ROLE',
      );
      for (const change of [
        { name: `e2e-renamed-${randomUUID()}` },
        { isAdmin: false },
      ]) {
        await expectRefusal(
          apiRequest(app, igor, 'patch', builtinPath, change),
          409,
          'BUILTIN_ROLE',
        );
      }
      expect(
        await expectBody(
          apiRequest(app, igor, 'get', builtinPath),
          200,
          RoleDetailSchema,
        ),
      ).toMatchObject({ name: builtin.name, isAdmin: true, builtin: true });

      // Step 4 - Assigning the built-in role to another employee gives him the admin right, as any role
      const employee = await createEmployee(app, igor);
      createdUserIds.push(employee.id);
      await expectBody(
        apiRequest(
          app,
          igor,
          'put',
          `/admin/users/${employee.id}/roles/${builtin.id}`,
        ),
        200,
        AdminUserDetailSchema,
      );
      await expectBody(
        apiRequest(app, employee, 'get', ADMIN_ROUTE),
        200,
        RoleListSchema,
      );

      // Step 5 (AC-32.2) - Given: Игорь is blocked and his password is lost; When: the operator runs the
      // command again with a new one; Then: the same account is enabled, only the new password works,
      // and he is an administrator again
      expect(
        await expectBody(
          apiRequest(app, employee, 'post', `/admin/users/${igor.id}/block`),
          200,
          AdminUserSummarySchema,
        ),
      ).toMatchObject({ status: 'disabled' });
      await expectSignInRefused(login, firstPassword, 'ACCOUNT_DISABLED');

      const repaired = await runSuperAdminCommand(igorArgs(login), newPassword);
      expect(repaired.exitCode).toBe(0);
      const repairedRows = await accountRows(login);
      expect(repairedRows).toEqual([
        {
          id: account.id,
          status: 'active',
          passwordHash: expect.any(String),
        },
      ]);
      expect(repaired.stdout).toContain('Super-administrator repaired');
      // The repair ends the account's sessions, as a password reset does.
      expect(
        (
          await harness.pool.query(
            'SELECT 1 FROM app.identity_sessions WHERE user_id = $1',
            [account.id],
          )
        ).rowCount,
      ).toBe(0);
      expectNoSecretsIn(repaired, [
        newPassword,
        repairedRows[0]?.passwordHash ?? '',
      ]);

      await expectSignInRefused(login, firstPassword, 'INVALID_CREDENTIALS');
      igor = await signInWithPassword(app, login, newPassword);
      expect(igor.id).toBe(account.id);
      expect(
        (
          await expectBody(
            apiRequest(app, igor, 'get', '/auth/me'),
            200,
            CurrentUserSchema,
          )
        ).isAdmin,
      ).toBe(true);

      // Step 6 - Taking the built-in role back from the employee takes his admin right, as any role
      await expectBody(
        apiRequest(
          app,
          igor,
          'delete',
          `/admin/users/${employee.id}/roles/${builtin.id}`,
        ),
        200,
        AdminUserDetailSchema,
      );
      await expectRefusal(
        apiRequest(app, employee, 'get', ADMIN_ROUTE),
        403,
        'ADMIN_REQUIRED',
      );

      // No password reached the app's log either (the sign-ins carried both).
      expect(
        harness.log.filter(
          (line) => line.includes(firstPassword) || line.includes(newPassword),
        ),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
