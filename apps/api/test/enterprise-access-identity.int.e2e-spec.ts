// enterprise-access / identity - integration skeletons (real AppModule + real Postgres + one in-process OIDC issuer)
// Design Doc: docs/features/enterprise-access/design-identity.md (v2.2, Approved), Test Strategy UC-1..UC-5 (INT-1 = UC-1, INT-2 = UC-2 + UC-4,
//   INT-3 = UC-3, the E2E = UC-5); PRD: docs/features/enterprise-access/prd.md (v2.4) FR-01..FR-04, FR-06..FR-08, FR-11, FR-33, NFR-01..NFR-03.
// Generated: 2026-11-15 | Budget Used: 3/3 API integration skeletons (boundary and sessions; password sign-in and local accounts; OIDC
//   provider sign-in), 0 web integration (see "NOT here"), 1 E2E in enterprise-access-identity.e2e-spec.ts (the operator command).
// Test Type: Integration. Every case is `it.todo` - skeletons only, no implementation.
//
// Design facts the skeletons rest on (v2.2): one API process; login and password is always on (argon2id, one
//   `INVALID_CREDENTIALS`, no attempt limit); providers are only OIDC-based, `google` (preset issuer) and `oidc` (Okta), led by
//   `openid-client`, managed under `/api/admin/providers`; the provider's email is trusted as returned, no email -> `no_email`; same email =
//   same employee; a first provider sign-in creates an account with no roles; there are no IdP groups and no role-to-group mapping: roles
//   are assigned only by the administrator and a sign-in never gives or takes a role; blocking is the administrator's `POST /api/admin/users/:id/block`:
//   sessions end at once and a running agent is not stopped from above - at its next model or tool call `OwnerGate.check` refuses, the
//   agent's task ends `failed` with reason `owner_disabled` and the agent's history shows that event; open SSE streams are not closed by a
//   block or a sign-out (they live until they drop and the reconnect gets 401), so no skeleton asserts stream closure; session lifetimes and `publicUrl` are `SignInSettings` (`/api/admin/settings/sign-in`, defaults 480 /
//   1440 min); provider secrets are stored as they are but never returned, logged or left unmasked in the audit; passwords and the session
//   token are hashes; there is no dev sign-in, no SAML, no SCIM, no GitHub or Facebook, no last-administrator rule, no `stopOwner`.
// Placement notes (v2.2): AC-06.1 is asserted in INT-3 row 3; AC-06.2 is `provenAt: unit` here (`IdentityDirectory.rolesOf` reads the
//   assignments at call time) and its end effect on a running agent is proven by the `access` part (FR-18); AC-11.1 is asserted in INT-1
//   row 3. AC-01.5, AC-03.2 and AC-03.3 are manual in the design; their INT-3 rows (steps 2 and 11) cost nothing extra and may be dropped
//   if the skeleton grows. AC-04.3 stays with INT-4 of agent-platform-chat.int.e2e-spec.ts (same defect, adapted to the cookie helper), not
//   a second isolation test in UC-2.
//
// Harness (follows apps/api/test/support/*, vitest.config.e2e.ts): one `createTestApp({ workers: true })` per file against the docker-compose
//   Postgres, real AppModule with the real global SessionGuard; only `AGENT_TURN_CLIENT` is the scripted model (as in
//   agent-platform-chat.int.e2e-spec.ts). Every case uses its own employees. Responses are parsed with `@agent-os/contracts` schemas.
//   Support the implementation tasks add (not skeletons) - see the report for what is still needed:
//   - `test/support/test-provider.ts`: one OIDC issuer in the test process (discovery, authorize, token, JWKS, signed ID tokens with `email` and
//     `name`, a no-email variant) and a record of the `client_id` and secret each token call carried.
//   - `createTestApp` option `providerEndpoints` (the `google` preset issuer points at the test issuer) and a captured process log for the
//     NFR-02 scan.
//   - `test/support/session.ts`: cookie-jar request helper; `signInWithPassword(app, login, password)` through `POST /api/auth/password`
//     (returns cookie and the `id` read from `GET /api/auth/me`); `seedSuperAdmin(app, login, password)` (the function the operator command
//     calls, no process) so the first administrator exists; `createEmployee(adminApi, {...})` through `POST /api/admin/users`;
//     `ageSession(pool, cookie, { createdMinutesAgo, lastSeenMinutesAgo })` that moves the session row's timestamps - the clock is never faked.
//   - `chatApi` and `sseClient` in support/api.ts stop sending `x-user-id` and carry the cookie; `newUser()` is replaced by `createEmployee`.
// Mock boundary: the model (scripted double, with its latch) and the provider (in-process). SessionGuard, AuditLog, password hashing,
//   OwnerGate, repositories, Postgres - real. Do NOT mock the guard, the database or the hasher.
//
// Replaced by this design (delete with the stub, do not duplicate):
//   - apps/api/src/auth/session.guard.spec.ts            (x-user-id stub, `system:` prefix rule; Invariant 3 -> INT-3 UUID check)
//   - apps/api/src/audit/audit.interceptor.spec.ts       (interceptor removed, KD-7)
//   - apps/api/test/threads.e2e-spec.ts case "answers 401 on every /threads route when NODE_ENV=production"
//       (the config spy no longer means anything; every route is 401 without a session -> INT-1 route walk)
// Kept, adapted only to the cookie helper (not new tests): INT-4 of agent-platform-chat.int.e2e-spec.ts proves AC-04.3 (another
//   employee's conversation answers as a missing id).
//
// NOT here on purpose (lower level, `provenAt: unit`, one table-driven test each, cases as rows):
//   - password policy 12..256 and the argon2id hash/verify round trip with parameters stored in the string
//   - login and email normalization, `next` path sanitization
//   - provider options schema and completeness per type (`google`, `oidc`), `unknown_type` (AC-03.5), `PROVIDER_CHECK_FAILED` reasons
//     (`insecure_url`, `unreachable`, `invalid_document`) with a fake fetch, public URL derivation from the first request (AC-03.4 rule)
//   - `SignInSettings` bounds (idle 15..1440, absolute 60..43200, idle not above absolute)
//   - AuditLog redaction (`secret_changed`, `password_changed`) over the logger's list of secret names
//   - OwnerGate.check (disabled or unknown owner refuses the call with OWNER_DISABLED, the base-agent check of DC-8)
//   - IdentityDirectory.rolesOf reads assignments at call time (AC-06.2)
//   - web (no integration skeleton - the units below catch what a jsdom journey would): the single 401 handler and its reason mapping
//     (AUTH_REQUIRED -> expired, ACCOUNT_DISABLED -> disabled, `next` carry-over), the API client wrapper sending every 401 to it, the live
//     store asking `GET /api/auth/me` after a dropped stream, the login form (form only without providers, divider and buttons with them,
//     one «Неверный логин или пароль.», password cleared), UserMenu (name, email, «Выйти», no «Режим разработки»), and the «Пароль»
//     section following `hasPassword`. The real-browser journey is the part's manual L1 checklist.

import { randomUUID } from 'node:crypto';
import {
  AdminUserDetailSchema,
  CurrentUserSchema,
  RoleListSchema,
  RoleSummarySchema,
  SignInSettingsSchema,
  type SignInSettings,
} from '@agent-os/contracts';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frontendOrigin } from '../src/identity/session-cookie.js';
import { expectBody, expectError } from './support/api.js';
import { createTestApp, type TestApp } from './support/createTestApp.js';
import {
  ageSession,
  apiOrigin,
  apiRequest,
  createEmployee,
  seedSuperAdmin,
  type Method,
  type Session,
} from './support/session.js';
import {
  startTestProvider,
  type TestProvider,
} from './support/test-provider.js';

/** Bound of one test; the requests settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

/** The default session limits (`SignInSettings`), which every test that changes them puts back. */
const DEFAULT_LIMITS = { idleMinutes: 480, absoluteMinutes: 1440 } as const;

/** NFR-03: the only routes open without a session, as `METHOD /path` of the router. */
const PUBLIC_ROUTES = [
  'GET /api/health',
  'GET /api/auth/providers',
  'POST /api/auth/password',
  'GET /api/auth/sign-in/:providerId',
  'GET /api/auth/oauth/:providerId/callback',
  'POST /api/auth/sign-out',
] as const;

/** The admin route rows 2 and 3 call as the employee. */
const ADMIN_ROUTE = '/admin/settings/sign-in';

/** The one app, issuer and administrator of the file (INT-1..INT-3). */
let harness: TestApp;
let provider: TestProvider;
let admin: Session;

/** One route as the router holds it. */
interface RegisteredRoute {
  method: Method;
  /** With the `/api` prefix and the `:param` names, e.g. `/api/admin/users/:id`. */
  path: string;
}

/** A layer of the Express 5 router; only route layers carry `route`. */
interface RouterLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

const METHODS = new Set<string>(['get', 'post', 'patch', 'put', 'delete']);

function isMethod(method: string): method is Method {
  return METHODS.has(method);
}

/** Every route the app registered, read from its Express router. */
function registeredRoutes(): RegisteredRoute[] {
  const express = harness.app.getHttpAdapter().getInstance() as {
    router: { stack: RouterLayer[] };
  };
  return express.router.stack.flatMap(({ route }) =>
    route === undefined
      ? []
      : Object.keys(route.methods).map((method) => {
          if (!isMethod(method))
            throw new Error(
              `Route ${route.path} has method ${method} the walk does not know`,
            );
          return { method, path: route.path };
        }),
  );
}

function routeKey(route: RegisteredRoute): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

/** The route's path under `/api` with every path parameter replaced by a random UUID. */
function concretePath(route: RegisteredRoute): string {
  return route.path.replace(/^\/api/, '').replace(/:\w+/g, () => randomUUID());
}

/** Fails unless the response is `status` with `errorCode`. */
async function expectRefusal(
  response: Promise<Response> | Response,
  status: number,
  errorCode: string,
): Promise<void> {
  expect((await expectError(response, status)).errorCode).toBe(errorCode);
}

/** A request under `/api` with the session cookie and the given `Origin` (`undefined` = no header). */
function requestWithOrigin(
  session: Session,
  method: Method,
  path: string,
  origin: string | undefined,
  body: object,
): Promise<Response> {
  const test = request(apiOrigin(harness.app))
    [method](`/api${path}`)
    .set('cookie', session.cookie);
  if (origin !== undefined) test.set('origin', origin);
  return test.send(body);
}

async function countUsers(): Promise<number> {
  const { rows } = await harness.pool.query<{ count: string }>(
    'SELECT count(*) FROM app.identity_users',
  );
  return Number(rows[0]?.count);
}

/** One `app.audit_events` row as the assertions read it. */
interface AuditRow {
  kind: string;
  actor: string;
  objectType: string | null;
  objectId: string | null;
  before: unknown;
  after: unknown;
  outcome: string;
  reason: string | null;
  at: Date;
}

/** The audit rows of `kind` written by `actor`, oldest first. */
async function auditRows(kind: string, actor: string): Promise<AuditRow[]> {
  const { rows } = await harness.pool.query<AuditRow>(
    `SELECT kind, actor, object_type AS "objectType", object_id AS "objectId", before, after, outcome, reason, at
       FROM app.audit_events WHERE kind = $1 AND actor = $2 ORDER BY at, id`,
    [kind, actor],
  );
  return rows;
}

function getSettings(): Promise<SignInSettings> {
  return expectBody(
    apiRequest(harness.app, admin, 'get', ADMIN_ROUTE),
    200,
    SignInSettingsSchema,
  );
}

function putSettings(body: object): Promise<Response> {
  return apiRequest(harness.app, admin, 'put', ADMIN_ROUTE, body);
}

describe('enterprise-access / identity - integration (real AppModule + real Postgres + in-process OIDC issuer)', () => {
  beforeAll(async () => {
    provider = await startTestProvider();
    harness = await createTestApp({
      workers: true,
      providerEndpoints: { google: provider.issuer },
      captureLog: true,
    });
    admin = await seedSuperAdmin(harness.app, `e2e-admin-${randomUUID()}`);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await harness?.close();
    await provider?.close();
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: the session boundary - who may call what (table-driven)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.4 "запрос к серверу без действующего сеанса: отказ «нужен вход», данных в ответе нет"; AC-01.6 "запрос с заголовком
  //   `x-user-id` и без сеанса: отказ с причиной «нужен вход»"; AC-07.1 (API half) "после выхода следующий запрос получает страницу
  //   входа"; AC-07.5 "администратор поменял срок жизни сеанса: запрос со старшим сеансом получает отказ «нужен вход»"; AC-08.1 "без
  //   права администратора: отказ, в аудите «отказ по правам»"; AC-08.2 "право администратора есть у роли: сотрудник с этой ролью
  //   получает доступ к операциям администратора"; AC-32.3 "в базе нет ни одного сотрудника: обычная страница входа, создать с неё
  //   учётную запись нельзя"; AC-11.1 "администратор назначил сотруднику роль: в аудите запись с администратором, временем, сотрудником и ролями до и после"; NFR-03 "без сеанса открыты только вход и проверка здоровья". Design: DC-1, DC-2, DC-3, DC-11; UC-1 (AC-08.2 and AC-11.1 are listed under UC-5 in the design and asserted here at the lowest level).
  // Behavior: request with some credential -> global SessionGuard / Origin check / @AdminOnly -> status + errorCode (and, for the admin
  //   refusal, an `access_denied` audit row).
  // Rows (one request each, literal expected status and errorCode):
  //   1. every route registered by AppModule, called with no cookie and with only `x-user-id` -> 401 AUTH_REQUIRED; the walk reads the
  //      router's own route list, and the allow-list is exactly: `GET /api/health` (200), `GET /api/auth/providers`, `POST
  //      /api/auth/password`, `GET /api/auth/sign-in/:id`, `GET /api/auth/oauth/:id/callback`, `POST /api/auth/sign-out`. No allow-listed
  //      route creates an account (AC-32.3)
  //   2. employee without the right calls an `@AdminOnly` route -> 403 ADMIN_REQUIRED, audit row `access_denied` with employee and route
  //   3. the administrator creates a role with `isAdmin: true` and assigns it to that employee (`PUT /api/admin/users/:id/roles/:roleId`);
  //      his next request to the same admin route -> 200 with the same cookie, and the audit holds `admin_change` with the administrator, the
  //      time, the employee and his roles before and after (AC-11.1); the administrator removes the assignment -> his next request is 403
  //      ADMIN_REQUIRED again (AC-08.2)
  //   4. mutating request with a valid cookie and a foreign `Origin`, and with an empty `Origin` -> 403 ORIGIN_REJECTED, nothing changed
  //   5. `POST /api/auth/sign-out`, then the old cookie on `GET /api/auth/me` -> 401 AUTH_REQUIRED; sign-out without a session -> 204
  //   6. default limits: a session row created more than 1440 min ago, and another idle for more than 480 min (timestamps moved in the
  //      row; limits come from `identity_settings`) -> 401 AUTH_REQUIRED
  //   7. UC-1 (AC-07.5): Аня's session opened 2 h ago, last request 1 h ago (rows moved); an administrator `PUT
  //      /api/admin/settings/sign-in` (with the current `publicUrl`) and `idleMinutes: 30`, `absoluteMinutes: 61` -> 200 echoing
  //      `SignInSettings`, audit `admin_change` on `sign_in_settings` with old and new limits; Аня's next request with the same cookie
  //      -> 401 AUTH_REQUIRED (no restart); then `PUT` with `idleMinutes: 2000` -> 400 VALIDATION_FAILED and `GET` shows the limits unchanged
  // Catches: a new controller left open by default (the forgotten @Public mark), the old `x-user-id` header still honoured, a public route
  //   that creates accounts, a cross-site POST riding the cookie, a non-admin reaching an admin operation, an admin right that a role
  //   assignment does not give or a removal does not take back, a signed-out or expired session still alive, a shortened session lifetime
  //   that does not reach sessions already open (limits cached at boot or stamped into the row), an out-of-bounds limit saved.
  // @category: core-functionality
  // @dependency: SessionGuard, Origin check, AdminOnly, AdminRolesController, SignInSettings controller, AuditLog, Postgres
  // @complexity: high
  it(
    'INT-1: every route is closed without a valid session, Origin or right, the open ones are exactly the documented ones, an assigned admin role takes effect at once, and shortened session limits reach open sessions',
    async () => {
      const { app, pool } = harness;

      // Row 1 - Given: the router's own route list; When: each closed route is called with no cookie and with
      // only `x-user-id`; Then: 401 AUTH_REQUIRED, and the open ones are exactly the six (NFR-03, AC-01.4, AC-01.6)
      const routes = registeredRoutes();
      const publicKeys: readonly string[] = PUBLIC_ROUTES;
      expect(
        routes
          .map(routeKey)
          .filter((key) => publicKeys.includes(key))
          .sort(),
      ).toEqual([...PUBLIC_ROUTES].sort());
      const closedRoutes = routes.filter(
        (route) => !publicKeys.includes(routeKey(route)),
      );
      expect(closedRoutes.map(routeKey)).toEqual(
        expect.arrayContaining([
          'GET /api/auth/me',
          'GET /api/threads',
          'PUT /api/admin/settings/sign-in',
        ]),
      );
      const leaks: string[] = [];
      for (const route of closedRoutes) {
        const path = concretePath(route);
        const answers = [
          await apiRequest(app, null, route.method, path),
          await apiRequest(app, null, route.method, path).set(
            'x-user-id',
            admin.id,
          ),
        ];
        for (const answer of answers) {
          const errorCode = (answer.body as { errorCode?: unknown }).errorCode;
          if (answer.status !== 401 || errorCode !== 'AUTH_REQUIRED') {
            leaks.push(
              `${routeKey(route)} -> ${answer.status} ${String(errorCode)}`,
            );
          }
        }
      }
      expect(leaks).toEqual([]);

      // Row 1 (AC-32.3) - the open routes answer without a session, and none of them creates an account
      const usersBefore = await countUsers();
      expect((await apiRequest(app, null, 'get', '/health')).status).toBe(200);
      expect(
        (await apiRequest(app, null, 'get', '/auth/providers')).status,
      ).toBe(200);
      await expectRefusal(
        apiRequest(app, null, 'post', '/auth/password', {
          login: `e2e-nobody-${randomUUID()}`,
          password: 'e2e-password-12',
        }),
        401,
        'INVALID_CREDENTIALS',
      );
      const unknownProvider = randomUUID();
      const started = await apiRequest(
        app,
        null,
        'get',
        `/auth/sign-in/${unknownProvider}`,
      );
      expect(started.status).toBe(302);
      expect(started.headers.location).toBe(
        `${frontendOrigin()}/login?error=provider_unavailable&provider=${unknownProvider}`,
      );
      const returned = await apiRequest(
        app,
        null,
        'get',
        `/auth/oauth/${unknownProvider}/callback?code=c&state=s`,
      );
      expect(returned.status).toBe(302);
      expect(returned.headers.location).toBe(
        `${frontendOrigin()}/login?error=failed&provider=${unknownProvider}`,
      );
      expect(await countUsers()).toBe(usersBefore);

      // Row 2 (AC-08.1) - Given: an employee without the right; When: he calls an @AdminOnly route;
      // Then: 403 ADMIN_REQUIRED and an `access_denied` audit row with him and the route
      const employee = await createEmployee(app, admin);
      await expectRefusal(
        apiRequest(app, employee, 'get', ADMIN_ROUTE),
        403,
        'ADMIN_REQUIRED',
      );
      expect(await auditRows('access_denied', employee.id)).toEqual([
        expect.objectContaining({
          objectType: 'route',
          objectId: `GET /api${ADMIN_ROUTE}`,
          outcome: 'rejected',
          reason: 'admin_required',
        }),
      ]);

      // Row 3 (AC-08.2, AC-11.1) - Given: a role with the admin right; When: the administrator assigns it and
      // then takes it away; Then: the same cookie gets 200, then 403 again, and each change is audited
      const role = await expectBody(
        apiRequest(app, admin, 'post', '/admin/roles', {
          name: `e2e-admins-${randomUUID()}`,
        }),
        201,
        RoleSummarySchema,
      );
      const roleRef = { id: role.id, name: role.name };
      try {
        await expectBody(
          apiRequest(app, admin, 'patch', `/admin/roles/${role.id}`, {
            isAdmin: true,
          }),
          200,
          RoleSummarySchema,
        );
        const assigned = await expectBody(
          apiRequest(
            app,
            admin,
            'put',
            `/admin/users/${employee.id}/roles/${role.id}`,
          ),
          200,
          AdminUserDetailSchema,
        );
        expect(assigned.adminRight).toEqual({
          personal: false,
          roles: [roleRef],
        });
        await expectBody(
          apiRequest(app, employee, 'get', ADMIN_ROUTE),
          200,
          SignInSettingsSchema,
        );

        await expectBody(
          apiRequest(
            app,
            admin,
            'delete',
            `/admin/users/${employee.id}/roles/${role.id}`,
          ),
          200,
          AdminUserDetailSchema,
        );
        await expectRefusal(
          apiRequest(app, employee, 'get', ADMIN_ROUTE),
          403,
          'ADMIN_REQUIRED',
        );

        // The employee's creation is an `admin_change` on him too, with no `before`.
        const roleChanges = (await auditRows('admin_change', admin.id)).filter(
          (row) =>
            row.objectType === 'user' &&
            row.objectId === employee.id &&
            row.before !== null,
        );
        expect(roleChanges).toEqual([
          expect.objectContaining({
            before: { roles: [] },
            after: { roles: [roleRef] },
            outcome: 'ok',
            at: expect.any(Date),
          }),
          expect.objectContaining({
            before: { roles: [roleRef] },
            after: { roles: [] },
            outcome: 'ok',
            at: expect.any(Date),
          }),
        ]);
      } finally {
        expect(
          (await apiRequest(app, admin, 'delete', `/admin/roles/${role.id}`))
            .status,
        ).toBe(204);
      }

      // Row 4 (DC-3) - Given: a valid cookie; When: a changing request comes with a foreign, an empty or no
      // `Origin`; Then: 403 ORIGIN_REJECTED and nothing is created
      const refusedRole = `e2e-cross-site-${randomUUID()}`;
      for (const origin of ['https://evil.example', '', undefined]) {
        await expectRefusal(
          requestWithOrigin(admin, 'post', '/admin/roles', origin, {
            name: refusedRole,
          }),
          403,
          'ORIGIN_REJECTED',
        );
      }
      const roles = await expectBody(
        apiRequest(app, admin, 'get', '/admin/roles'),
        200,
        RoleListSchema,
      );
      expect(roles.map((listed) => listed.name)).not.toContain(refusedRole);

      // Row 5 (AC-07.1) - Given: a signed-in employee; When: he signs out; Then: his old cookie gets 401
      // AUTH_REQUIRED; a sign-out without a session is still 204
      const leaving = await createEmployee(app, admin);
      expect(
        (await apiRequest(app, leaving, 'post', '/auth/sign-out')).status,
      ).toBe(204);
      await expectRefusal(
        apiRequest(app, leaving, 'get', '/auth/me'),
        401,
        'AUTH_REQUIRED',
      );
      expect(
        (await apiRequest(app, null, 'post', '/auth/sign-out')).status,
      ).toBe(204);

      // Row 6 - Given: the default limits and sessions moved past each of them; Then: 401 AUTH_REQUIRED, while
      // a session within both limits still works
      expect(await getSettings()).toMatchObject(DEFAULT_LIMITS);
      const pastAbsolute = await createEmployee(app, admin);
      const pastIdle = await createEmployee(app, admin);
      const withinLimits = await createEmployee(app, admin);
      await ageSession(pool, pastAbsolute.cookie, {
        createdMinutesAgo: 1441,
        lastSeenMinutesAgo: 1,
      });
      await ageSession(pool, pastIdle.cookie, {
        createdMinutesAgo: 600,
        lastSeenMinutesAgo: 481,
      });
      await ageSession(pool, withinLimits.cookie, {
        createdMinutesAgo: 1430,
        lastSeenMinutesAgo: 470,
      });
      await expectRefusal(
        apiRequest(app, pastAbsolute, 'get', '/auth/me'),
        401,
        'AUTH_REQUIRED',
      );
      await expectRefusal(
        apiRequest(app, pastIdle, 'get', '/auth/me'),
        401,
        'AUTH_REQUIRED',
      );
      await expectBody(
        apiRequest(app, withinLimits, 'get', '/auth/me'),
        200,
        CurrentUserSchema,
      );

      // Row 7 (UC-1, AC-07.5) - Given: Аня's session opened 2 h ago, last request 1 h ago; When: the
      // administrator shortens the limits to 30 / 61 min; Then: her next request is refused without a restart
      const previous = await getSettings();
      const anya = await createEmployee(app, admin, { name: 'Аня' });
      const anyaAge = { createdMinutesAgo: 120, lastSeenMinutesAgo: 60 };
      await ageSession(pool, anya.cookie, anyaAge);
      await expectBody(
        apiRequest(app, anya, 'get', '/auth/me'),
        200,
        CurrentUserSchema,
      );
      // The check above recorded a fresh request time: move it back.
      await ageSession(pool, anya.cookie, anyaAge);
      try {
        const shortened = {
          publicUrl: previous.publicUrl,
          idleMinutes: 30,
          absoluteMinutes: 61,
        };
        const saved = await expectBody(
          putSettings(shortened),
          200,
          SignInSettingsSchema,
        );
        expect(saved).toMatchObject(shortened);
        const settingsChanges = (
          await auditRows('admin_change', admin.id)
        ).filter((row) => row.objectType === 'sign_in_settings');
        expect(settingsChanges.at(-1)).toMatchObject({
          before: { publicUrl: previous.publicUrl, ...DEFAULT_LIMITS },
          after: shortened,
          outcome: 'ok',
        });
        await expectRefusal(
          apiRequest(app, anya, 'get', '/auth/me'),
          401,
          'AUTH_REQUIRED',
        );

        await expectRefusal(
          putSettings({ ...shortened, idleMinutes: 2000 }),
          400,
          'VALIDATION_FAILED',
        );
        expect(await getSettings()).toMatchObject({
          idleMinutes: 30,
          absoluteMinutes: 61,
        });
      } finally {
        // Rule 11 of the plan: the developer's database keeps its own settings.
        await expectBody(
          putSettings({ publicUrl: previous.publicUrl, ...DEFAULT_LIMITS }),
          200,
          SignInSettingsSchema,
        );
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: password sign-in and local accounts under the administrator - create, reset, block, unblock
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.2 "верные логин и пароль: открывается его чат, а в меню его имя"; AC-01.3 "логин или пароль неверны: сеанс не открыт, одна и
  //   та же причина, что бы из двух ни было неверно, попытка в аудите"; AC-33.1 "администратор завёл учётную запись с начальным паролем:
  //   сотрудник входит"; AC-33.2 "администратор сбросил пароль: старый отклонён, новый проходит"; AC-33.3 "сотрудник верно назвал текущий
  //   пароль: следующий вход только с новым"; AC-33.4 "неверно назвал текущий: пароль не меняется"; AC-07.2 "у сотрудника открыт сеанс и
  //   работает агент, администратор блокирует его: следующий запрос с его сеансом получает отказ, а агент на своём следующем вызове модели
  //   или инструмента получает статус «сбой» с причиной «сотрудник отключён»; после блокировки заканчиваются только вызовы, которые уже
  //   шли, новых вызовов от имени сотрудника нет"; AC-07.3 (password half) "отключённый
  //   сотрудник: вход отклонён «учётная запись отключена»"; AC-07.4 "включили снова: видит прежние беседы"; AC-11.3 "вход отклонён: запись со
  //   способом входа, временем и причиной"; NFR-01 "пароли только хешем". Design: DC-8, DC-9, DC-16; UC-2, UC-4.
  // Behavior: `POST /api/admin/users`, `POST /api/auth/password`, `POST /api/auth/password/change`, `PUT /api/admin/users/:id/password`,
  //   `POST /api/admin/users/:id/block` and `/unblock` -> status, errorCode, `reason`, session rows, agent state, model call counter,
  //   audit rows, and what the database holds.
  // Rows:
  //   1. the administrator creates Борис (login, name, email, initial password) -> 201 `AdminUserSummary` with `login` and no roles; Борис
  //      signs in -> 204 and cookie, `GET /api/auth/me` -> his name and email, `hasPassword: true`, `id` a UUID (not `system:`-prefixed)
  //   2. an unknown login and a wrong password for Борис -> both 401 INVALID_CREDENTIALS with the same body; audit has `sign_in_rejected` with
  //      method `password` and reasons `unknown_login` and `wrong_password` respectively
  //   3. self change: wrong current password -> 400 VALIDATION_FAILED with `reason: wrong_current_password` and the password unchanged; a
  //      provider-only employee -> 400 `not_local_account`; right current password -> 204, his other open session stays valid, and a later
  //      sign-in works only with the new password
  //   4. the administrator resets the password (`PUT /api/admin/users/:id/password`) -> 204; every open session of Борис -> 401 AUTH_REQUIRED;
  //      the old password -> INVALID_CREDENTIALS, the new one -> 204
  //   5. block with work in flight (no `stopOwner`; the agent ends itself at its next check): Борис is signed in and his agent is holding a
  //      model call (the scripted model's latch); the administrator `POST .../block` -> 200 `status: disabled`, audit `admin_change`; `GET
  //      /api/auth/me` with his cookie -> 401 ACCOUNT_DISABLED at once; the test releases the latch and lets the agent reach its next model or
  //      tool call -> the base-agent check refuses it: the scripted model's call counter does not move after the block moment, no tool call is
  //      made, and the agent's task ends `failed` with reason `owner_disabled` (its history shows that event); a call that was already
  //      in flight when the block landed is allowed to finish (the latch is released only after the block)
  //   6. the blocked Борис signs in with the RIGHT password -> 401 ACCOUNT_DISABLED, with a wrong password -> 401 INVALID_CREDENTIALS
  //      (status not disclosed without the password)
  //   7. `POST .../unblock` -> `status: active` and nothing revived: his old cookie -> 401 AUTH_REQUIRED, the failed agent stays failed; he
  //      signs in again and the conversation list holds his earlier conversations
  //   8. NFR-01: no text column of any `app` table contains any password used above; the stored value is an argon2id string; the audit rows
  //      of create, change and reset carry `password_changed` and none of the values, and neither does the captured log
  // Catches: a wrong login answering differently from a wrong password (account enumeration), a changed password that does not change, a
  //   reset that leaves the old sessions alive, a blocked employee whose already-running agent keeps calling the model or tools (spend and
  //   data access after dismissal) because the base-agent check is missing or reads a stale status, a blocked account that keeps a working
  //   cookie, a status leaked to someone who does not know the password, an unblock that resurrects old sessions or loses conversations, a
  //   password readable in the database, the audit or the log, an attempt left out of the audit.
  // @category: core-functionality
  // @dependency: PasswordSignIn, AdminUsersController, UsersService.disable, OwnerGate (base-agent check), SessionStore, AuditLog, scripted model, runtime workers, Postgres
  // @complexity: high
  it.todo(
    "INT-2: the administrator creates, resets and blocks an employee and each takes effect at once - one error for every bad credential, no model call after the agent's next check once blocked, no password left anywhere",
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: OIDC provider sign-in - what the administrator sets is what the employee gets (table-driven over `google` and `oidc`)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.5 "включены Google и Okta: форма и две кнопки с названиями администратора"; AC-02.1 "OIDC: открывается чат, в меню имя и почта от
  //   провайдера"; AC-02.5 "провайдер любого типа
  //   первой версии: как в AC-02.1"; AC-03.1 "секрет клиента сохранён: при чтении «задан», значения нет"; AC-03.2 "выключенный провайдер:
  //   кнопки нет, попытка отклоняется"; AC-03.3 "настройки изменены: вход по новым без рестарта"; AC-03.4 "публичный адрес не сохранён: первое
  //   сохранение провайдера делает им адрес обращения к API"; AC-04.1 "первый вход создаёт учётную запись с именем и почтой провайдера";
  //   AC-04.2 "локальная запись с почтой anna@company.ru, вход через Google с той же почтой: те же беседы"; AC-04.4 "идентификатор не
  //   начинается с `system:`"; AC-06.1 "сотрудник впервые вошёл через Okta: ролей у него нет, какие бы группы у него ни были в Okta"; AC-04.5 "провайдер не вернул почту: вход отклонён «провайдер не вернул почту», сеанса нет, попытка в аудите";
  //   AC-07.3 (provider half) "отключённый сотрудник: «учётная запись отключена»"; AC-11.2 "замена секрета: «секрет изменён», значения нет";
  //   AC-11.3 "вход отклонён: запись со способом входа, временем и причиной"; NFR-02 "ни секрет, ни токен не в логах, аудите, ответах".
  //   Design: DC-4, DC-6; UC-3 (AC-01.5, AC-03.2, AC-03.3 are manual in the design).
  // Behavior: the administrator configures providers through the admin API with known secrets -> a browser starts sign-in
  //   (`GET /api/auth/sign-in/:providerId?next=`) -> the test issuer answers -> `GET /api/auth/oauth/:providerId/callback` with or without the
  //   `aos_login` cookie -> redirect target, `aos_session` cookie or none, audit rows, and a scan of every observable store for the known secrets.
  // Steps and rows:
  //   configuration:
  //   1. the first `POST /api/admin/providers` (type `oidc`, «Okta») with no saved public URL -> `GET /api/admin/settings/sign-in` now holds
  //      the address the test used to reach the API and `providerData.redirectUri` is built from it; the provider is `enabled: false`; enabling
  //      it with no options -> 409 PROVIDER_INCOMPLETE; an issuer the test issuer does not serve -> 422 PROVIDER_CHECK_FAILED with `reason:
  //      unreachable` and nothing stored; the test issuer with secret `S1` -> `complete: true`, `clientSecretSet: true`, no field of any
  //      response holds `S1`; `google` is created with its own client id and secret (its issuer is the preset, pointed at the test issuer)
  //   2. `GET /api/auth/providers` without a session -> the enabled ones in creation order with names and types; a disabled one is absent
  //   accepted (each: 302 to `next` with the cookie; `GET /api/auth/me` -> name and email from the ID token; audit `sign_in` with the method):
  //   3. first sign-in table over `oidc` and `google` -> each opens a session for a first-time email; the account has a UUID `id` (not
  //      `system:`-prefixed) and no roles - also when the ID token carries a `groups` claim, however it names its groups (AC-06.1)
  //   4. AC-04.2: Аня has a local account `anna@company.ru`, a role assigned by the administrator and a conversation; she signs in with the
  //      password, then through `google` and through `oidc` with the provider email in another letter case -> every time the same `id` and the
  //      same conversation list, and her role is unchanged after each sign-in (a provider sign-in never touches roles)
  //   rejected (each: redirect to `/login?error=<reason>`, no `aos_session` cookie, no session row, audit `sign_in_rejected` with method,
  //   provider, time and reason, and no provider response text in the audit or log):
  //   5. the accepted callback replayed a second time -> `failed`
  //   6. callback without the `aos_login` cookie (another browser) -> `failed`
  //   7. login request older than 10 minutes (row's expiry moved) -> `failed`
  //   8. an ID token without an email -> `no_email`
  //   9. the provider switched off after the button was shown: the old sign-in link -> `provider_unavailable`
  //   10. an employee blocked before sign-in (a normal ID token for him) -> `account_disabled`
  //   edit and secrecy:
  //   11. replace `S1` with `S2` and change `clientId` of «Okta»; an employee signs in through it -> the test issuer saw the new `clientId`
  //      and secret (no restart); audit has `admin_change` carrying `secret_changed`
  //   12. scan: neither `S1`, `S2` nor any other provider secret appears in any response of this skeleton, the captured process log or any
  //      audit row (the database holds provider secrets as they are, so it is not scanned)
  // Catches: a replayed, stale or foreign-browser answer opening a session; an email-less provider result creating an account;
  //   a provider and the password creating several accounts for one person; a provider sign-in that gives roles from the provider's groups or takes roles away; a
  //   client-chosen or `system:`-prefixed id; a disabled provider or blocked employee still letting someone in; a provider edit served from
  //   the cached old configuration until restart; a provider enabled without complete settings; a provider secret readable in a response, the
  //   log or the audit; a rejection missing from the audit.
  // @category: core-functionality
  // @dependency: AuthController, OAuthSignIn, SignInService, AdminProvidersController, SessionStore, AuditLog, logger, test OIDC issuer, Postgres
  // @complexity: high
  it.todo(
    'INT-3: a valid ID token from `google` or `oidc` opens one session on the one account of that email and leaves its roles alone, every replayed, foreign, expired, email-less or disabled attempt opens none and is audited, and no provider secret leaks',
  );
});
