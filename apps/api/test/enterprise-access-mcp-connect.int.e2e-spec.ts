// enterprise-access / mcp-connect - API integration (real AppModule + real Postgres + MCP fixture process with its authorization server)
// Design Doc: docs/features/enterprise-access/design-mcp-connect.md (v1.5, Approved), Test Strategy UC-1 (registration half), UC-2 (registration
//   and connect half), UC-E1, UC-E2, UC-E3, UC-E5; PRD: docs/features/enterprise-access/prd.md (v2.4) FR-12, FR-13, FR-14, NFR-02
//   (AC-12.1, AC-12.2, AC-13.4, AC-13.5, AC-13.6, AC-14.1, AC-14.3, AC-14.6).
// Budget Used: 1 of the part's 3 integration cases here (INT-3: the registry, the connect flow and the secrets scan over HTTP); INT-1 and
//   INT-2 (the call path) are in packages/agents/test/enterprise-access-mcp-connect.int.e2e-spec.ts. 0 E2E (the Test Strategy names none).
// Test Type: Integration.
//
// Harness (follows apps/api/test/support/*): one `createTestApp({ workers: true, captureLog: true, mcpServers: [] })` against the docker-compose
//   Postgres - the fixture process runs, and the test registers every server itself through the API under the run's names (`runName`).
//   Аня, Борис and Глеб are written by `insertEmployee` before the boot and sign in after it; their rights on the run's servers are personal
//   grants the administrator gives (`grantTo`, test/support/access.ts) once each server is registered, and Аня's chat runs on the run's
//   default model (`runModel`, made the platform's default chat model by `useRunModels` and restored in `afterAll`), allowed to her in `beforeAll`; the
//   super administrator comes from `seedSuperAdmin`, the second administrator is an employee given the admin right by a role (taken away in
//   row 8). The employee connect route reads only the saved public address; the test uses the one the database already holds (the test plays
//   the browser and calls the callback on the app itself, and the fixture only compares the return address with the registered one), and
//   saves `apiOrigin(app)` only when none is saved, unsetting it in `afterAll`; every user, role and server the test made is deleted there
//   too. Only `AGENT_TURN_CLIENT` is the scripted model; MCP is the fixture PROCESS over HTTP with its authorization server (KD-7): its
//   counters (`stats`: authorizations and code exchanges per account) are the proof that no code was exchanged. The test plays the browser
//   (support/mcp-browser.ts): GET the connect route without following redirects, GET the authorization URL on the fixture, take
//   `code`/`state`/`iss` from its 302 and GET that server's `/api/mcp/oauth/callback/<server>` with a cookie (or none).
// Mock boundary: the model. Real: SessionGuard, `@AdminOnly`, `AuditLog`, controllers, `Agents.mcp`, Postgres, the fixture process.
//
// NOT here on purpose: the 401/closed-by-default proof of every new route (identity INT-1's route walk reads the router's own list, so the new
//   controllers are covered there); `@AdminOnly` refusal and its audit row (identity INT-1); the Zod shape of admin bodies (name kebab 1-32,
//   token <= 4096, mode) - a unit table next to the controller schema; the scheme check (`insecure_url`: the test app runs in `test`, where
//   `http` is allowed) - a unit table in the registry's verification test; the 10-minute life and the single use of a connection request - a
//   unit test of the in-memory request store with a fake clock (connect-requests.spec.ts); the call-time behaviour (tokens, refresh, sets,
//   refusals) - agents INT-1 / INT-2; the web page and the menu - unit tables plus the manual L1 browser checklist (Sentry on
//   `http://localhost:4000`, then on an `https` tunnel). Not automated: AC-15.1 (`seed:mcp`) - manual run of the script; AC-15.2 - a property
//   of this suite (no internet, no real accounts).

import { randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  McpConnectionSchema,
  McpServerViewSchema,
  RefreshMcpToolsResponseSchema,
  RoleSummarySchema,
  SignInSettingsSchema,
  type HistoryEntry,
  type McpConnection,
  type SignInSettings,
} from '@agent-os/contracts';
import { createDatabase, type DatabaseConnection } from '@agent-os/db';
import { FIXTURE_SHARED_TOKEN } from '@agent-os/mcp-fixture';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { frontendOrigin } from '../src/identity/session-cookie';
import {
  grantTo,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  useRunModels,
} from './support/access';
import { chatApi, expectBody } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import { pointBuiltinsAt } from './support/library';
import {
  authorize,
  beginConnect,
  returnTo,
  type OAuthReturn,
} from './support/mcp-browser';
import {
  BACKOFFICE_SERVER,
  LOGS_SERVER,
  runName,
} from './support/mcp-servers';
import {
  apiOrigin,
  apiRequest,
  createEmployee,
  insertEmployee,
  seedSuperAdmin,
  signInWithPassword,
  type Method,
  type Session,
} from './support/session';
import { databaseUrl, waitFor } from '@agent-os/db/testing';

/** Bound of the case; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 180_000;
const PASSWORD = 'e2e-password-12';
/** The model of the built-in records (`pointBuiltinsAt`): a model of the run, allowed to Аня (row 11a runs her chat). */
const DEFAULT_MODEL = runModel('mcp-connect-haiku');
/** Row 8: a second `oauth` server at the same fixture path, waiting for its administrator's account. */
const SECOND_OAUTH_SERVER = runName('backoffice-second');
/** Row 5: a name the registry does not hold. */
const UNKNOWN_SERVER = runName('nobody');
/** Row 2: rejected registrations; none of them may leave a row. */
const UNREACHABLE_SERVER = runName('unreachable');
const WRONG_TOKEN_SERVER = runName('logs-wrong-token');
const NO_OAUTH_SERVER = runName('logs-oauth');
/** Deletes every server this case names; the servers take their accounts with them. */
const deleteRunServers = (pool: DatabaseConnection['pool']) =>
  pool.query('DELETE FROM app.agent_mcp_servers WHERE name = ANY($1)', [
    [
      LOGS_SERVER,
      BACKOFFICE_SERVER,
      SECOND_OAUTH_SERVER,
      UNREACHABLE_SERVER,
      WRONG_TOKEN_SERVER,
      NO_OAUTH_SERVER,
    ],
  ]);
/** Row 3: the tool the fixture adds to the back office before the list is read anew. */
const ADDED_TOOL = 'list_refunds';
/** A shared token the fixture refuses; a known value for the secrets scan. */
const WRONG_TOKEN = `e2e-wrong-shared-token-${randomUUID()}`;
/** An address where nobody answers. */
const NOBODY_URL = 'http://127.0.0.1:1/mcp';
/** Row 11: the task of Аня's scripted chat and its two calls. */
const RUN_TASK = 'INT-3 row 11: read the trace and the order';
const GET_TRACE = `mcp__${LOGS_SERVER}__get_trace`;
const GET_ORDER = `mcp__${BACKOFFICE_SERVER}__get_order`;
const TRACE_ARGS = { traceId: '0'.repeat(32) };
const ORDER_ARGS = { orderId: 'ord-00000001' };

/** Tools of the fixture sources as the registry shows them (by name; `readOnly` only for `readOnlyHint: true`). */
const LOGS_TOOL_NAMES = ['aggregate_logs', 'get_trace', 'search_logs'];
const LOGS_TOOLS = [
  ['aggregate_logs', true],
  ['get_trace', true],
  ['search_logs', true],
];
const BACKOFFICE_TOOLS = [
  ['create_incident_note', false],
  ['get_order', true],
  ['search_orders', true],
];

/** One `app.audit_events` row of a registry server as the assertions read it. */
interface AuditRow {
  kind: string;
  actor: string;
  before: unknown;
  after: unknown;
  outcome: string;
  reason: string | null;
}

describe('enterprise-access / mcp-connect - API integration (real AppModule + real Postgres + MCP fixture process)', () => {
  let harness: TestApp;
  /** The test's own pool: employees before the boot, cleanup after the app is closed. */
  let database: DatabaseConnection;
  let admin: Session;
  let admin2: Session;
  let anya: Session;
  let boris: Session;
  let gleb: Session;
  let adminRoleId: string | undefined;
  /** The sign-in settings as found, kept only when they had no public address and the test saved one. */
  let settingsWithoutPublicUrl: SignInSettings | undefined;
  /** Gives the built-in records back their models; run in `afterAll` while the app is up. */
  let restoreBuiltins: (() => Promise<void>) | undefined;
  /** Gives the platform back its default models (`useRunModels`); run in `afterAll` while the app is up. */
  let restoreModels: (() => Promise<void>) | undefined;
  const userIds: string[] = [];

  beforeAll(async () => {
    database = createDatabase({
      connectionString: databaseUrl(),
      poolMax: 2,
    });
    // An earlier suite of the run registered `logs` and `backoffice` and left them: this case registers them itself.
    await deleteRunServers(database.pool);
    const tag = randomUUID().slice(0, 8);
    const login = (name: string) => `e2e-mcp-${name}-${tag}`;
    const [anyaId, borisId, glebId] = [
      await insertEmployee(database.pool, {
        login: login('anya'),
        password: PASSWORD,
      }),
      await insertEmployee(database.pool, {
        login: login('boris'),
        password: PASSWORD,
      }),
      await insertEmployee(database.pool, {
        login: login('gleb'),
        password: PASSWORD,
      }),
    ];
    userIds.push(anyaId, borisId, glebId);
    harness = await createTestApp({
      workers: true,
      captureLog: true,
      mcpServers: [],
    });
    harness.model.completeText({ text: 'MCP conversation' });
    const { app } = harness;
    admin = await seedSuperAdmin(app, login('admin'));
    userIds.push(admin.id);
    anya = await signInWithPassword(app, login('anya'), PASSWORD);
    boris = await signInWithPassword(app, login('boris'), PASSWORD);
    gleb = await signInWithPassword(app, login('gleb'), PASSWORD);
    admin2 = await createEmployee(app, admin);
    userIds.push(admin2.id);
    // Аня's chat (row 11a) runs on the run's model; Глеб never gets a right: no MCP server is his.
    restoreModels = await useRunModels(app, admin, {
      chat: { id: DEFAULT_MODEL, ...HAIKU_TEST_PRICES },
    });
    restoreBuiltins = await pointBuiltinsAt(app, admin, DEFAULT_MODEL);
    await grantTo(
      app,
      admin,
      { userId: anya.id },
      { effect: 'allow', target: { kind: 'model', model: DEFAULT_MODEL } },
    );

    // The second administrator's right comes from a role (row 8 takes it away).
    const role = await expectBody(
      apiRequest(app, admin, 'post', '/admin/roles', { name: login('admins') }),
      201,
      RoleSummarySchema,
    );
    adminRoleId = role.id;
    await expectBody(
      apiRequest(app, admin, 'patch', `/admin/roles/${role.id}`, {
        isAdmin: true,
      }),
      200,
      RoleSummarySchema,
    );
    await expectBody(
      apiRequest(
        app,
        admin,
        'put',
        `/admin/users/${admin2.id}/roles/${role.id}`,
      ),
      200,
      z.unknown(),
    );

    // The employee connect route reads only the saved public address. A saved one is used as it is - a killed
    // run must not leave the developer's database with this app's address; an unset one is set, and unset
    // again in afterAll.
    const settings = await expectBody(
      apiRequest(app, admin, 'get', '/admin/settings/sign-in'),
      200,
      SignInSettingsSchema,
    );
    if (settings.publicUrl === null) {
      settingsWithoutPublicUrl = settings;
      await expectBody(
        apiRequest(app, admin, 'put', '/admin/settings/sign-in', {
          ...settings,
          publicUrl: apiOrigin(app),
        }),
        200,
        SignInSettingsSchema,
      );
    }
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    try {
      try {
        await restoreBuiltins?.();
        await restoreModels?.();
      } finally {
        if (harness !== undefined && settingsWithoutPublicUrl !== undefined) {
          await expectBody(
            apiRequest(
              harness.app,
              admin,
              'put',
              '/admin/settings/sign-in',
              settingsWithoutPublicUrl,
            ),
            200,
            SignInSettingsSchema,
          );
        }
      }
    } finally {
      await harness?.close();
      // The servers take their accounts with them; the users take their sessions, role assignments and
      // personal grants; the model takes its grants.
      await deleteRunServers(database.pool);
      await removeRunRows(database.pool, {
        models: [DEFAULT_MODEL],
        roles: [],
      });
      if (adminRoleId !== undefined)
        await database.pool.query(
          'DELETE FROM app.identity_roles WHERE id = $1',
          [adminRoleId],
        );
      await database.pool.query(
        'DELETE FROM app.identity_users WHERE id = ANY($1)',
        [userIds],
      );
      await database.close();
    }
  }, TEST_TIMEOUT_MS);

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
  //   redirect; one scripted agent run and a scan of every outward channel for the known secret values.
  // Binding note (the OAuth callback is a GET that changes state, so it must not act without the browser's own binding): the design binds it
  //   with the session itself plus a one-time `state` that belongs to the employee who began it (KD-6, DC-5); there is no separate cookie
  //   and the callback is not `@Public()`. A connection request is consumed by the first `state` presented, whoever presents it (T2.2).
  // Rows (literal status codes, redirects, `errorCode`/`reason`; after every rejected row the stored rows are unchanged and the authorization
  //   server of the fixture exchanged no code for it):
  //   registry
  //   1. AC-12.1 / AC-13.5: `POST /api/admin/mcp-servers` `logs`, mode `shared`, the fixture's token -> 201, status `enabled`, tools with
  //      `readOnly` true only where the fixture declares `readOnlyHint: true`, `sharedTokenSet: true`; `GET .../logs` returns the same; the
  //      audit holds `admin_change` with `objectType: mcp_server`, before/after and `secret_changed`, no value. `PATCH` with a wrong token ->
  //      422 `MCP_SERVER_CHECK_FAILED` reason `unauthorized`, the stored token still works (the list is read with it).
  //   2. AC-12.2 / DC-6 (UC-E1): an address nobody answers -> 422 `unreachable`; `logs`-source with a wrong shared token -> `unauthorized`;
  //      the shared-token path (no OAuth metadata) registered as oauth -> `oauth_not_supported`; the name `logs` again (at an address
  //      nobody answers) -> 409 `MCP_SERVER_NAME_TAKEN`, so no check ran; the table `agent_mcp_servers` has not grown.
  //   3. AC-13.4 / DC-7: `POST` `backoffice`, mode `oauth` -> 201, status `awaiting_admin_account`; `PATCH enabled:true` -> 409
  //      `MCP_SERVER_INCOMPLETE`; Аня's `GET /api/mcp/connections` does not list it. The admin's `GET /api/admin/mcp-servers/backoffice/connect`
  //      -> 302 to the fixture authorization URL; his return with his cookie -> 302 `/admin/servers/backoffice?connected=1`; the view is
  //      `enabled` with its tool list. `POST .../tools/refresh` by a second administrator without an account -> 409 `MCP_ACCOUNT_REQUIRED`;
  //      by the first -> 200 with `added` and `removed` after the fixture's tool set changed.
  //   employee connection
  //   4. AC-14.1 / AC-14.6: Аня (permitted) lists `backoffice` as `needs_auth`; Глеб (no right) gets an empty list.
  //   5. refused starts: Глеб's connect, an unknown name, a disabled server, a `shared` server -> 302
  //      `/account?error=connect_failed&server=<name>` each, and the fixture's authorization server received no authorize request.
  //   6. binding of the return (the callback is not `@Public()`; a request is consumed by the first `state` presented): Аня begins a
  //      connection; Борис's cookie with Аня's `code` and `state` -> 302 `/account?error=connect_failed` WITHOUT `server`, nothing stored
  //      for either; Аня's own return of that request now also fails the same way. Аня begins a new connection; its return WITHOUT a cookie
  //      -> 401 `AUTH_REQUIRED` and nothing consumed or stored: her return with her cookie -> 302 `/account?connected=backoffice`, her list
  //      is `connected` (AC-14.3); the same return sent again -> `/account?error=connect_failed` and no second exchange.
  //   7. forged returns of Борис, each -> `/account?error=connect_failed&server=backoffice` and no account: a return whose `iss` is
  //      another issuer; a return with `iss` missing while the authorization server announces it; no code was exchanged.
  //   8. DC-13 (UC-E5): the second administrator begins connecting his account to a second oauth server that awaits its account; his admin
  //      right is then removed through the identity operation (the role is taken); he returns with a valid code -> 302
  //      `/admin/servers/<name>?error=connect_failed`, the authorization server exchanged no code, no account and no tool list stored, the
  //      server is still `awaiting_admin_account`, and the audit holds `access_denied` for this employee.
  //   9. `DELETE /api/mcp/connections/backoffice` by Аня -> 204, her list is `needs_auth`; the same call again with no account -> 204.
  //   11a (the run before the deletion, so its history names the server): Аня connects again, the authorization server then revokes her
  //       tokens; one scripted run of her chat calls `logs` (success) and `backoffice` (the account is lost on the call: `auth_required`).
  //   deletion
  //   10. AC-13.6: Аня, Борис and the administrator have accounts on `backoffice`; `DELETE /api/admin/mcp-servers/backoffice` -> 204; no row of
  //       `agent_mcp_accounts` names `backoffice` any more; tool calls in `agent_messages` history rows of the server stay with the name as text.
  //   secrets
  //   11. NFR-02 (UC-E3): the known values (the shared token before and after the administrator replaced it, the wrong token, every access
  //       and refresh token stored, the OAuth client secret if the fixture issued one, every `state` and authorization `code`, the session
  //       cookies) appear in none of: the captured process log, the audit rows of the run's servers, the API responses of rows 1-10 (the
  //       authorization redirect excepted: it carries `state` to the authorization server by design), the agent's history and tool calls, the
  //       model's input (the tool outputs). The audit of the token replacement holds `secret_changed`.
  // Catches: a server saved without being checked; a shared token or a client secret echoed in a response, the audit, the log or the agent
  //   history by a path no other test reads (the OAuth callback's redirect logging, the transport's error text, tool outputs); a half-registered
  //   oauth server offered to employees or to agents; a rejected registration that still leaves a row; a second administrator's missing
  //   account treated as the first's; a login-CSRF where someone else's code or `state` binds an account in another session; a replayed return
  //   accepted; a code from another authorization server accepted (no `iss` check); a callback left open without a session, or one that
  //   spends a request without it; a demoted administrator still enabling a server and saving its tool list; an employee able to connect a
  //   server they have no right to; accounts surviving the deletion of their server.
  // @category: core-functionality
  // @dependency: AdminMcpServersController, McpConnectionsController, McpRegistry, McpAccounts (begin/finish), SessionGuard, AuditLog, logger, scripted model, runtime workers, MCP fixture process + authorization server, Postgres
  // @complexity: high
  it(
    'INT-3: a server is verified before it is saved, the OAuth return changes nothing without the session of the employee who began it, a demoted administrator stores nothing, deletion removes every account, and no secret value appears in any response, audit row, log or history',
    async () => {
      const { app, fixture } = harness;
      const web = frontendOrigin();
      const pool = database.pool;
      /** Every API response of rows 1-10 except the authorization redirects (row 11 scans them). */
      const answers: string[] = [];
      /** Known secret values by label (row 11); a label never holds the value. */
      const secrets = new Map<string, string>();
      const keepSecret = (label: string, value: string | null | undefined) => {
        if (value === null || value === undefined || value === '') return;
        if (![...secrets.values()].includes(value))
          secrets.set(`${label} #${secrets.size}`, value);
      };
      for (const [name, session] of Object.entries({
        admin,
        admin2,
        anya,
        boris,
        gleb,
      }))
        keepSecret(`session cookie of ${name}`, session.cookie.split('=')[1]);
      keepSecret('fixture shared token', FIXTURE_SHARED_TOKEN);
      keepSecret('wrong shared token', WRONG_TOKEN);

      const seen = (response: Response): Response => {
        answers.push(
          JSON.stringify({
            status: response.status,
            location: response.headers.location ?? null,
            body: response.text,
          }),
        );
        return response;
      };
      const call = async (
        session: Session,
        method: Method,
        path: string,
        body?: object,
      ): Promise<Response> =>
        seen(await apiRequest(app, session, method, path, body));
      const refusal = async (response: Promise<Response>, status: number) => {
        const answered = await response;
        expect(answered.status).toBe(status);
        const { errorCode, reason } = ApiErrorSchema.parse(answered.body);
        return { errorCode, reason };
      };
      const view = (response: Promise<Response>, status: number) =>
        expectBody(response, status, McpServerViewSchema);
      const toolsOf = (tools: readonly { name: string; readOnly: boolean }[]) =>
        tools.map((tool) => [tool.name, tool.readOnly]);
      const connections = (session: Session): Promise<McpConnection[]> =>
        expectBody(
          call(session, 'get', '/mcp/connections'),
          200,
          z.array(McpConnectionSchema),
        );
      /** The browser's return; the `code` and `state` it carries are kept for the scan. */
      const back = async (
        session: Session | null,
        params: OAuthReturn,
      ): Promise<Response> => {
        keepSecret('state', params.state);
        keepSecret('authorization code', params.code);
        return seen(await returnTo(app, session, params));
      };
      const ownersOn = async (server: string): Promise<string[]> => {
        const rows = await pool.query<{ owner_id: string }>(
          'SELECT owner_id FROM app.agent_mcp_accounts WHERE server = $1 ORDER BY owner_id',
          [server],
        );
        return rows.rows.map((row) => row.owner_id);
      };
      /** Reads every stored token of the run's servers into the scan's values. */
      const keepStoredSecrets = async () => {
        const accounts = await pool.query<{
          owner_id: string;
          server: string;
          access_token: string;
          refresh_token: string | null;
        }>(
          'SELECT owner_id, server, access_token, refresh_token FROM app.agent_mcp_accounts WHERE server = ANY($1)',
          [[BACKOFFICE_SERVER, SECOND_OAUTH_SERVER]],
        );
        for (const row of accounts.rows) {
          keepSecret(
            `access token ${row.owner_id}@${row.server}`,
            row.access_token,
          );
          keepSecret(
            `refresh token ${row.owner_id}@${row.server}`,
            row.refresh_token,
          );
        }
        const servers = await pool.query<{
          name: string;
          oauth_client_secret: string | null;
        }>(
          'SELECT name, oauth_client_secret FROM app.agent_mcp_servers WHERE name = ANY($1)',
          [[BACKOFFICE_SERVER, SECOND_OAUTH_SERVER]],
        );
        for (const row of servers.rows)
          keepSecret(`client secret ${row.name}`, row.oauth_client_secret);
      };
      const auditOf = async (server: string): Promise<AuditRow[]> => {
        const rows = await pool.query<AuditRow>(
          `SELECT kind, actor, before, after, outcome, reason FROM app.audit_events
            WHERE object_type = 'mcp_server' AND object_id = $1 ORDER BY at, id`,
          [server],
        );
        return rows.rows;
      };
      /** A personal right of the employee on every tool of a registered server. */
      const allowServer = (session: Session, server: string) =>
        grantTo(
          app,
          admin,
          { userId: session.id },
          { effect: 'allow', target: { kind: 'server', server } },
        );
      const runServerCount = async (): Promise<number> => {
        const rows = await pool.query<{ count: string }>(
          'SELECT count(*) FROM app.agent_mcp_servers WHERE name LIKE $1',
          [`%${LOGS_SERVER.slice('logs'.length)}`],
        );
        return Number(rows.rows[0]?.count);
      };
      const exchangesOf = async (account: string) =>
        (await fixture.control.stats(account)).codeExchanges;
      const employeeConnect = (server: string) =>
        `/mcp/connections/${server}/connect`;
      /** A full employee connection through the browser: begin, sign in at the fixture as `account`, return. */
      const connectAs = async (
        session: Session,
        account: string,
      ): Promise<string | undefined> => {
        const returned = await authorize(
          await beginConnect(app, session, employeeConnect(BACKOFFICE_SERVER)),
          {
            account,
          },
        );
        return (await back(session, returned)).headers.location;
      };

      // Row 1 (AC-12.1, AC-13.5) - When: the administrator registers `logs` with the fixture's shared token
      const logsUrl = fixture.sharedUrl('logs');
      const registered = await view(
        call(admin, 'post', '/admin/mcp-servers', {
          name: LOGS_SERVER,
          url: logsUrl,
          mode: 'shared',
          sharedToken: FIXTURE_SHARED_TOKEN,
        }),
        201,
      );
      // Then: enabled with its tools marked, the token only as «set»; the read-back is the same
      expect({ ...registered, tools: toolsOf(registered.tools) }).toEqual({
        name: LOGS_SERVER,
        url: logsUrl,
        mode: 'shared',
        status: 'enabled',
        toolCount: 3,
        sharedTokenSet: true,
        tools: LOGS_TOOLS,
      });
      expect(
        await view(
          call(admin, 'get', `/admin/mcp-servers/${LOGS_SERVER}`),
          200,
        ),
      ).toEqual(registered);
      expect(await auditOf(LOGS_SERVER)).toEqual([
        {
          kind: 'admin_change',
          actor: admin.id,
          before: null,
          after: {
            name: LOGS_SERVER,
            url: logsUrl,
            mode: 'shared',
            enabled: true,
            tools: LOGS_TOOL_NAMES,
            sharedToken: 'secret_changed',
          },
          outcome: 'ok',
          reason: null,
        },
      ]);
      // Аня's right on the registered server (she reads it in row 11a)
      await allowServer(anya, LOGS_SERVER);
      // When: a wrong token replaces it; Then: 422 unauthorized, and the stored token still reads the list
      expect(
        await refusal(
          call(admin, 'patch', `/admin/mcp-servers/${LOGS_SERVER}`, {
            sharedToken: WRONG_TOKEN,
          }),
          422,
        ),
      ).toEqual({
        errorCode: 'MCP_SERVER_CHECK_FAILED',
        reason: 'unauthorized',
      });
      const reread = await expectBody(
        call(admin, 'post', `/admin/mcp-servers/${LOGS_SERVER}/tools/refresh`),
        200,
        RefreshMcpToolsResponseSchema,
      );
      expect([reread.server.status, reread.added, reread.removed]).toEqual([
        'enabled',
        [],
        [],
      ]);
      // When: the administrator replaces the token (the fixture knows one shared token, so with the same value)
      await view(
        call(admin, 'patch', `/admin/mcp-servers/${LOGS_SERVER}`, {
          sharedToken: FIXTURE_SHARED_TOKEN,
        }),
        200,
      );
      // Then: the audit of the replacement marks the token, never its value
      const replacement = (await auditOf(LOGS_SERVER)).at(-1);
      expect([replacement?.before, replacement?.after]).toEqual([
        {
          name: LOGS_SERVER,
          url: logsUrl,
          mode: 'shared',
          enabled: true,
          tools: LOGS_TOOL_NAMES,
        },
        {
          name: LOGS_SERVER,
          url: logsUrl,
          mode: 'shared',
          enabled: true,
          tools: LOGS_TOOL_NAMES,
          sharedToken: 'secret_changed',
        },
      ]);

      // Row 2 (AC-12.2, DC-6, UC-E1) - When: registrations that fail the check, and a taken name
      const serversBefore = await runServerCount();
      const rejected = [
        {
          name: UNREACHABLE_SERVER,
          url: NOBODY_URL,
          mode: 'shared',
          sharedToken: FIXTURE_SHARED_TOKEN,
        },
        {
          name: WRONG_TOKEN_SERVER,
          url: logsUrl,
          mode: 'shared',
          sharedToken: WRONG_TOKEN,
        },
        { name: NO_OAUTH_SERVER, url: logsUrl, mode: 'oauth' },
      ];
      const reasons = [];
      for (const body of rejected)
        reasons.push(
          await refusal(call(admin, 'post', '/admin/mcp-servers', body), 422),
        );
      // Then: each carries its reason
      expect(reasons).toEqual([
        { errorCode: 'MCP_SERVER_CHECK_FAILED', reason: 'unreachable' },
        { errorCode: 'MCP_SERVER_CHECK_FAILED', reason: 'unauthorized' },
        { errorCode: 'MCP_SERVER_CHECK_FAILED', reason: 'oauth_not_supported' },
      ]);
      // Then: a taken name at an address nobody answers is 409, not 422 - the name is refused before any check
      expect(
        await refusal(
          call(admin, 'post', '/admin/mcp-servers', {
            name: LOGS_SERVER,
            url: NOBODY_URL,
            mode: 'shared',
            sharedToken: FIXTURE_SHARED_TOKEN,
          }),
          409,
        ),
      ).toEqual({ errorCode: 'MCP_SERVER_NAME_TAKEN', reason: undefined });
      expect(await runServerCount()).toBe(serversBefore);

      // Row 3 (AC-13.4, DC-7) - When: the administrator registers `backoffice` with personal OAuth
      const backofficeUrl = fixture.oauthUrl('backoffice');
      const waiting = await view(
        call(admin, 'post', '/admin/mcp-servers', {
          name: BACKOFFICE_SERVER,
          url: backofficeUrl,
          mode: 'oauth',
        }),
        201,
      );
      expect([
        waiting.status,
        waiting.toolCount,
        waiting.sharedTokenSet,
        waiting.tools,
      ]).toEqual(['awaiting_admin_account', 0, false, []]);
      // Аня's and Борис's rights on the registered server (Глеб has none)
      await allowServer(anya, BACKOFFICE_SERVER);
      await allowServer(boris, BACKOFFICE_SERVER);
      // Then: it cannot be switched on and no employee sees it
      expect(
        await refusal(
          call(admin, 'patch', `/admin/mcp-servers/${BACKOFFICE_SERVER}`, {
            enabled: true,
          }),
          409,
        ),
      ).toEqual({ errorCode: 'MCP_SERVER_INCOMPLETE', reason: undefined });
      expect(await connections(anya)).toEqual([]);
      // When: the administrator connects his account through the browser
      const adminAuthorization = await beginConnect(
        app,
        admin,
        `/admin/mcp-servers/${BACKOFFICE_SERVER}/connect`,
      );
      expect(
        adminAuthorization.startsWith(`${fixture.baseUrl}/authorize?`),
      ).toBe(true);
      const adminReturn = await back(
        admin,
        await authorize(adminAuthorization, { account: 'admin' }),
      );
      // Then: back on the server's page, and the server is enabled with its list
      expect([adminReturn.status, adminReturn.headers.location]).toEqual([
        302,
        `${web}/admin/servers/${BACKOFFICE_SERVER}?connected=1`,
      ]);
      const completed = await view(
        call(admin, 'get', `/admin/mcp-servers/${BACKOFFICE_SERVER}`),
        200,
      );
      expect([completed.status, toolsOf(completed.tools)]).toEqual([
        'enabled',
        BACKOFFICE_TOOLS,
      ]);
      expect(await ownersOn(BACKOFFICE_SERVER)).toEqual([admin.id]);
      // When: a second administrator without an account reads the list anew; Then: 409, not the first one's account
      expect(
        await refusal(
          call(
            admin2,
            'post',
            `/admin/mcp-servers/${BACKOFFICE_SERVER}/tools/refresh`,
          ),
          409,
        ),
      ).toEqual({ errorCode: 'MCP_ACCOUNT_REQUIRED', reason: undefined });
      // When: the fixture lists one more tool and the first administrator reads the list anew
      await fixture.control.addTool({ source: 'backoffice', name: ADDED_TOOL });
      const refreshed = await expectBody(
        call(
          admin,
          'post',
          `/admin/mcp-servers/${BACKOFFICE_SERVER}/tools/refresh`,
        ),
        200,
        RefreshMcpToolsResponseSchema,
      );
      expect([
        refreshed.added,
        refreshed.removed,
        refreshed.server.toolCount,
      ]).toEqual([[ADDED_TOOL], [], 4]);
      await keepStoredSecrets();

      // Row 4 (AC-14.1, AC-14.6) - Then: Аня (permitted) sees the server needing her account; Глеб (no right) sees nothing
      expect(await connections(anya)).toEqual([
        { server: BACKOFFICE_SERVER, url: backofficeUrl, status: 'needs_auth' },
      ]);
      expect(await connections(gleb)).toEqual([]);

      // Row 5 - When: starts that must be refused (disabled: the server is switched off for the row)
      const refusedStarts = [
        [gleb, BACKOFFICE_SERVER],
        [anya, UNKNOWN_SERVER],
        [anya, LOGS_SERVER],
      ] as const;
      const starts = [];
      for (const [session, server] of refusedStarts)
        starts.push(await beginConnect(app, session, employeeConnect(server)));
      await view(
        call(admin, 'patch', `/admin/mcp-servers/${BACKOFFICE_SERVER}`, {
          enabled: false,
        }),
        200,
      );
      starts.push(
        await beginConnect(app, anya, employeeConnect(BACKOFFICE_SERVER)),
      );
      await view(
        call(admin, 'patch', `/admin/mcp-servers/${BACKOFFICE_SERVER}`, {
          enabled: true,
        }),
        200,
      );
      // Then: each goes back to «Мой доступ» with the error, and the authorization server saw nobody
      expect(starts).toEqual([
        `${web}/account?error=connect_failed&server=${BACKOFFICE_SERVER}`,
        `${web}/account?error=connect_failed&server=${UNKNOWN_SERVER}`,
        `${web}/account?error=connect_failed&server=${LOGS_SERVER}`,
        `${web}/account?error=connect_failed&server=${BACKOFFICE_SERVER}`,
      ]);
      expect((await fixture.control.stats('anya')).authorizations).toBe(0);

      // Row 6 (KD-6, DC-5, UC-E2) - Given: Аня began a connection and the authorization server gave her a code
      const anyaFirst = await authorize(
        await beginConnect(app, anya, employeeConnect(BACKOFFICE_SERVER)),
        {
          account: 'anya',
        },
      );
      // When: Борис presents Аня's code and state with his own session
      const borisHijack = await back(boris, anyaFirst);
      // Then: refused without naming a server, nothing stored for either, no code exchanged
      expect([borisHijack.status, borisHijack.headers.location]).toEqual([
        302,
        `${web}/account?error=connect_failed`,
      ]);
      // When: Аня's own return of that request comes after; Then: the request is spent, it fails the same way
      const anyaLate = await back(anya, anyaFirst);
      expect(anyaLate.headers.location).toBe(
        `${web}/account?error=connect_failed`,
      );
      expect([
        await ownersOn(BACKOFFICE_SERVER),
        await exchangesOf('anya'),
      ]).toEqual([[admin.id], 0]);
      // When: Аня's own valid code and state of a new request come back at ANOTHER server's return address
      const anyaElsewhere = await authorize(
        await beginConnect(app, anya, employeeConnect(BACKOFFICE_SERVER)),
        {
          account: 'anya',
        },
      );
      const elsewhere = await back(anya, {
        ...anyaElsewhere,
        server: LOGS_SERVER,
      });
      // Then: refused; the request is consumed, so its return at its own address fails too; nothing stored, no code exchanged
      expect([elsewhere.status, elsewhere.headers.location]).toEqual([
        302,
        `${web}/account?error=connect_failed&server=${BACKOFFICE_SERVER}`,
      ]);
      expect((await back(anya, anyaElsewhere)).headers.location).toBe(
        `${web}/account?error=connect_failed`,
      );
      expect([
        await ownersOn(BACKOFFICE_SERVER),
        await exchangesOf('anya'),
      ]).toEqual([[admin.id], 0]);
      // When: Аня starts a new connection and its return comes without any cookie
      const anyaSecond = await authorize(
        await beginConnect(app, anya, employeeConnect(BACKOFFICE_SERVER)),
        {
          account: 'anya',
        },
      );
      const anonymous = await back(null, anyaSecond);
      // Then: 401, nothing consumed or stored
      expect([
        anonymous.status,
        ApiErrorSchema.parse(anonymous.body).errorCode,
      ]).toEqual([401, 'AUTH_REQUIRED']);
      expect([
        await ownersOn(BACKOFFICE_SERVER),
        await exchangesOf('anya'),
      ]).toEqual([[admin.id], 0]);
      // When: her return with her cookie; Then: connected (AC-14.3)
      const anyaConnected = await back(anya, anyaSecond);
      expect([anyaConnected.status, anyaConnected.headers.location]).toEqual([
        302,
        `${web}/account?connected=${BACKOFFICE_SERVER}`,
      ]);
      expect(await connections(anya)).toEqual([
        { server: BACKOFFICE_SERVER, url: backofficeUrl, status: 'connected' },
      ]);
      expect(await ownersOn(BACKOFFICE_SERVER)).toEqual(
        [admin.id, anya.id].sort(),
      );
      // When: the same return is sent again; Then: refused, and no second exchange
      const replay = await back(anya, anyaSecond);
      expect(replay.headers.location).toBe(
        `${web}/account?error=connect_failed`,
      );
      expect(await exchangesOf('anya')).toBe(1);
      await keepStoredSecrets();

      // Row 7 - When: Борис's forged returns (each from a request of its own)
      const borisReturn = async (
        change: (returned: OAuthReturn) => OAuthReturn,
      ) => {
        const returned = await authorize(
          await beginConnect(app, boris, employeeConnect(BACKOFFICE_SERVER)),
          { account: 'boris' },
        );
        return (await back(boris, change(returned))).headers.location;
      };
      const forged = [
        await borisReturn((returned) => ({
          ...returned,
          iss: 'http://issuer.example.test',
        })),
        await borisReturn(({ iss: _iss, ...returned }) => returned),
      ];
      // Then: each is refused on «Мой доступ», no account and no code exchanged
      expect(forged).toEqual([
        `${web}/account?error=connect_failed&server=${BACKOFFICE_SERVER}`,
        `${web}/account?error=connect_failed&server=${BACKOFFICE_SERVER}`,
      ]);
      expect([
        await ownersOn(BACKOFFICE_SERVER),
        await exchangesOf('boris'),
      ]).toEqual([[admin.id, anya.id].sort(), 0]);

      // Row 8 (DC-13, UC-E5) - Given: a second oauth server waits for its administrator's account
      await view(
        call(admin, 'post', '/admin/mcp-servers', {
          name: SECOND_OAUTH_SERVER,
          url: backofficeUrl,
          mode: 'oauth',
        }),
        201,
      );
      // When: the second administrator begins connecting, loses his right, then returns with a valid code
      const demotedAuthorization = await authorize(
        await beginConnect(
          app,
          admin2,
          `/admin/mcp-servers/${SECOND_OAUTH_SERVER}/connect`,
        ),
        { account: 'admin2' },
      );
      await expectBody(
        call(admin, 'delete', `/admin/users/${admin2.id}/roles/${adminRoleId}`),
        200,
        z.unknown(),
      );
      const demoted = await back(admin2, demotedAuthorization);
      // Then: refused on the server's page before any exchange; nothing stored; the refusal is audited
      expect([demoted.status, demoted.headers.location]).toEqual([
        302,
        `${web}/admin/servers/${SECOND_OAUTH_SERVER}?error=connect_failed`,
      ]);
      expect([
        await exchangesOf('admin2'),
        await ownersOn(SECOND_OAUTH_SERVER),
      ]).toEqual([0, []]);
      const stillWaiting = await view(
        call(admin, 'get', `/admin/mcp-servers/${SECOND_OAUTH_SERVER}`),
        200,
      );
      expect([stillWaiting.status, stillWaiting.tools]).toEqual([
        'awaiting_admin_account',
        [],
      ]);
      expect(
        (await auditOf(SECOND_OAUTH_SERVER)).filter(
          (row) => row.actor === admin2.id,
        ),
      ).toEqual([
        {
          kind: 'access_denied',
          actor: admin2.id,
          before: null,
          after: null,
          outcome: 'rejected',
          reason: 'admin_required',
        },
      ]);

      // Row 9 - When: Аня disconnects, twice; Then: 204 both times, her list needs her account again
      expect(
        (await call(anya, 'delete', `/mcp/connections/${BACKOFFICE_SERVER}`))
          .status,
      ).toBe(204);
      expect(await connections(anya)).toEqual([
        { server: BACKOFFICE_SERVER, url: backofficeUrl, status: 'needs_auth' },
      ]);
      expect(
        (await call(anya, 'delete', `/mcp/connections/${BACKOFFICE_SERVER}`))
          .status,
      ).toBe(204);
      expect(await ownersOn(BACKOFFICE_SERVER)).toEqual([admin.id]);

      // Row 11a (NFR-02, UC-E3) - Given: Аня connected again, then the authorization server revoked her tokens
      expect(await connectAs(anya, 'anya')).toBe(
        `${web}/account?connected=${BACKOFFICE_SERVER}`,
      );
      await keepStoredSecrets();
      await fixture.control.revoke({ account: 'anya', which: 'all' });
      // When: one scripted run of her chat calls `logs` and `backoffice`
      const chat = harness.model.script({ task: RUN_TASK }, [
        {
          calls: [
            { tool: GET_TRACE, args: TRACE_ARGS },
            { tool: GET_ORDER, args: ORDER_ARGS },
          ],
        },
        { text: 'Read the trace; the order needs your account.' },
      ]);
      const anyaApi = chatApi(app, anya);
      const thread = await anyaApi.createThread();
      await anyaApi.send(thread.id, RUN_TASK);
      const run = await waitFor(
        () => anyaApi.history(thread.id),
        (history) =>
          history.chat.status === 'idle' && history.entries.length === 5,
        'the scripted run of row 11',
      );
      // Then: the logs call succeeds, the back-office call finds the account lost and the account is gone
      expect(run.entries.map(entryLine)).toEqual([
        `task: ${RUN_TASK}`,
        `model_answer:  [${LOGS_SERVER}/get_trace, ${BACKOFFICE_SERVER}/get_order]`,
        'tool_result: get_trace success',
        'tool_result: get_order auth_required',
        'model_answer: Read the trace; the order needs your account. []',
      ]);
      expect(await ownersOn(BACKOFFICE_SERVER)).toEqual([admin.id]);

      // Row 10 (AC-13.6) - Given: Аня, Борис and the administrator have accounts on `backoffice`
      expect([
        await connectAs(anya, 'anya'),
        await connectAs(boris, 'boris'),
      ]).toEqual([
        `${web}/account?connected=${BACKOFFICE_SERVER}`,
        `${web}/account?connected=${BACKOFFICE_SERVER}`,
      ]);
      expect(await ownersOn(BACKOFFICE_SERVER)).toEqual(
        [admin.id, anya.id, boris.id].sort(),
      );
      await keepStoredSecrets();
      // When: the administrator deletes the server
      expect(
        (await call(admin, 'delete', `/admin/mcp-servers/${BACKOFFICE_SERVER}`))
          .status,
      ).toBe(204);
      // Then: no account and no grant names it; the history of its calls stays with the name as text
      expect(await ownersOn(BACKOFFICE_SERVER)).toEqual([]);
      expect(
        (await pool.query('SELECT id FROM app.access_grants WHERE server = $1', [BACKOFFICE_SERVER]))
          .rows,
      ).toEqual([]);
      const history = await pool.query<{
        server: string | null;
        tool: string;
        outcome: string | null;
      }>(
        `SELECT c.content ->> 'server' AS server, c.content ->> 'tool' AS tool, c.content ->> 'outcome' AS outcome
           FROM app.agent_messages c
           JOIN app.agent_sessions s ON s.task_id = c.task_id
          WHERE s.owner_id = $1 AND c.kind = 'tool_result' ORDER BY c.created_at, c.seq`,
        [anya.id],
      );
      expect(history.rows).toEqual([
        { server: LOGS_SERVER, tool: 'get_trace', outcome: 'success' },
        {
          server: BACKOFFICE_SERVER,
          tool: 'get_order',
          outcome: 'auth_required',
        },
      ]);

      // Row 11 (NFR-02) - Then: no known value appears in the log, the audit, the responses, the history or the model's input
      const tokenLabels = [...secrets.keys()].filter((label) =>
        label.startsWith('access token'),
      );
      // The administrator's, Аня's three (rows 6, 11a, 10) and Борис's.
      expect(tokenLabels.length).toBe(5);
      const agentRows = await pool.query<{ content: unknown }>(
        `SELECT to_jsonb(m) AS content FROM app.agent_messages m
           JOIN app.agent_sessions s ON s.task_id = m.task_id WHERE s.owner_id = $1`,
        [anya.id],
      );
      const audit = await pool.query<{ row: unknown }>(
        `SELECT to_jsonb(a) AS row FROM app.audit_events a
          WHERE object_type = 'mcp_server' AND object_id = ANY($1)`,
        [[LOGS_SERVER, BACKOFFICE_SERVER, SECOND_OAUTH_SERVER]],
      );
      const places: Record<string, string> = {
        log: harness.log.join('\n'),
        audit: JSON.stringify(audit.rows),
        responses: answers.join('\n'),
        history: JSON.stringify([run, agentRows.rows]),
        'model input': JSON.stringify(chat.calls),
      };
      const leaks = Object.entries(places).flatMap(([place, text]) =>
        [...secrets]
          .filter(([, value]) => text.includes(value))
          .map(([label]) => `${label} in ${place}`),
      );
      expect(leaks).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

/** A history entry as one literal line (the chat suite's form). */
function entryLine(entry: HistoryEntry): string {
  switch (entry.kind) {
    case 'model_answer': {
      const calls = entry.content.toolCalls.map((call) =>
        call.server === null ? call.tool : `${call.server}/${call.tool}`,
      );
      return `model_answer: ${entry.content.text} [${calls.join(', ')}]`;
    }
    case 'tool_result':
      return `tool_result: ${entry.content.tool} ${entry.content.outcome}`;
    case 'task':
    case 'user_message':
    case 'agent_message':
    case 'notice':
      return `${entry.kind}: ${entry.content.text}`;
    default:
      return entry.kind;
  }
}
