// custom-agents / library - API integration skeletons (real AppModule + real Postgres, workers off, no model call at all)
// Design Doc: docs/features/custom-agents/design-library.md (v1.0), Test Strategy UC-1..UC-7, UC-E1..UC-E6;
//   PRD: docs/features/custom-agents/prd.md FR-01..FR-11 (AC-01.1 .. AC-11.3).
// Generated: 2026-11-17
// Budget Used: 5/3 integration skeletons for the part (INT-1 .. INT-5), all in this file - the default 3 plus 2 extras, each
//   naming the defect no other test catches (INT-4: the panel's own read condition and the ban; INT-5: the lost update and the audit
//   written in the action's transaction). 0 E2E: the Test Strategy names none, and the part has no screen - the journey through the
//   screens is the `web` part's, the journey through a chat is the `runtime` part's; there is no browser E2E tool in the repo.
// Test Type: Integration.
//
// Harness (follows apps/api/test/support/*, enterprise-access-identity.int.e2e-spec.ts and enterprise-access-access.int.e2e-spec.ts):
//   one `createTestApp()` against the docker-compose Postgres, the real AppModule with the real SessionGuard, `IdentityDirectory`,
//   `AccessService`, `Agents.mcp` and `AuditLog`. Mock boundary: NONE for the library - the model is never called (a record is stored,
//   never run), so no scripted model and no `workers` are needed. Servers «Jira» and «Sentry» of the design are the run's
//   `LOGS_SERVER` and `BACKOFFICE_SERVER` (the fixture process of `createTestApp({ mcpServers })` serves the registry check), made
//   available to a role through the existing admin operations (`allowRole` of support/access.ts: `POST /api/admin/models`,
//   `POST /api/admin/grants`), under run names (`runName`, `runModel`) - never the developer's real rows. The run's provider and
//   default chat model come from `useRunModels`, whose restore `afterAll` runs before `removeRunRows`.
//   Employees come from `insertEmployee` + `signInWithPassword`, the administrator from `seedSuperAdmin`; roles and their members go
//   through `POST /api/admin/roles` and `PUT /api/admin/users/:id/roles/:roleId` of `identity`. Responses are parsed with the schemas of
//   `@agent-os/contracts` (`library.ts`). Every case uses its own employees, roles and records (names carry the run suffix, no check of a
//   global list - design INT-4). A case that changes role membership or an account's status makes its own employees and roles and
//   leaves the shared Аня, Борис, Вера and «SRE» as they are, so the order of the cases decides nothing. `afterAll` deletes the
//   run's system records by id (they have no owner and no cascade), then `removeRunRows` (employee records and shares go by cascade).
//   Support the implementation tasks add (not skeletons):
//   - `test/support/library.ts`: `createRecord(app, session, body)`, `getRecord`, `putRecord`, `shareWith(app, session, id, roleIds)`,
//     `libraryRoutes(recordId)` (the table of every employee and panel route with its method and body, used by INT-1) and
//     `auditOfRecord(pool, recordId)` over `app.audit_events` rows of the object type `library_record`.
//   - the table list of `packages/db/test/migrations.e2e-spec.ts` gets `agents`, `agent_versions` and `agent_shares` (data-model design-agents.md).
//
// Proven elsewhere, not repeated here (CLAUDE.md: one test at the lowest level that catches the defect):
//   - 401 without a session and the 403 `ADMIN_REQUIRED` + `access_denied` row of `@AdminOnly()`: the route walk and row 2 of
//       enterprise-access-identity INT-1 take the new library routes from the router by themselves. INT-1 here proves only that library
//       routes answer an invisible record as a missing one and a visible-but-foreign one as read-only.
//   - The thread-owner `404` of `threads.e2e-spec.ts` is about conversations; the library's visibility is a different query (KD-2).
//
// `provenAt: unit` (tables next to the code, not skeletons - a rule never gets a second proof here):
//   - `apps/api/src/library/save-rules.spec.ts`, one table over the save rule: AC-06.1 (name taken by the author, case-insensitive,
//       any kind), AC-06.2 (a system record's name; the check runs only when the name changes - DC-8), AC-07.1 (new server without
//       a right, `server_not_allowed`), AC-07.2 (a server already in the record stays), AC-07.3 (an administrator picks any registered
//       server or any catalogue model), DC-9 (`model_not_allowed` only when the author has some allowed model), DC-10
//       (`all_servers_not_allowed`), `agent_not_visible`.
//   - `packages/contracts/src/library.spec.ts`, one table over the content and body schemas: AC-06.3 (description over 300, name 1..80
//       trimmed), executor without a row, `*` only once, closed tool set (`start_workflow` not for an executor).
//   - `apps/api/src/library/audience-rules.spec.ts`: the rule rows behind AC-04.1 (`role_not_member` only for ADDED roles - DC-4),
//       `sharing_banned`, `audience_fixed` (`chat`), `holder_not_found`.
//   - `apps/api/src/library/copy-rules.spec.ts`, UC-E4: AC-05.4 and AC-05.5 (the model-replacement table: kept / platform default /
//       first allowed in "Мой доступ" order / kept and marked in `missingRights`), DC-5 (the copy name: `— копия`, smallest free N,
//       80-character cut), DC-6 (all servers -> the servers the copier can use), DC-7 (agents the copier does not see are dropped).
//   - `AccessService.allowedModels` and `Agents.mcp.usable` get rows in the existing `effective-access.spec.ts` and the mcp-accounts
//       spec as their own units (the same table that proves `myModels` / the connections list), not here.
//
// `provenAt: not automated`: the migration constraints themselves (name unique per owner, one `builtinKey`, one-of-three share holder)
//   are the database's; the only case where they matter to behaviour - the concurrent create of two records with one name answered
//   `RECORD_NAME_TAKEN` (Flow 1) - is a unique-index property and is left to the migration test's table list plus the review; a
//   dedicated race test would repeat the library's (Postgres's) behaviour.
//
// acProof (the one proof of every criterion; `rule` = the unit table above):
//   AC-01.1 INT-2 · AC-01.2 INT-2 · AC-02.1 INT-1 · AC-02.2 INT-2 · AC-02.3 INT-1 · AC-03.1 INT-2 · AC-04.1 INT-2 (wiring of the
//   owner's real roles; the rule rows are unit) · AC-04.2 INT-1 · AC-04.3 INT-2 · AC-05.1 INT-3 · AC-05.2 INT-3 · AC-05.3 INT-3 ·
//   AC-05.4 unit · AC-05.5 unit · AC-06.1 unit · AC-06.2 unit · AC-06.3 unit · AC-07.1 INT-3 (one reject row through the real
//   registry; the rule rows are unit) · AC-07.2 INT-3 (one pass row) · AC-07.3 unit · AC-08.1 INT-5 · AC-09.1 INT-4 · AC-09.2 INT-4 ·
//   AC-09.3 INT-4 · AC-09.4 INT-4 · AC-10.1 INT-5 · AC-11.1 INT-2 · AC-11.2 INT-2 · AC-11.3 INT-2 · AC-12.2 INT-1 (row 5).

import { randomUUID } from 'node:crypto';
import {
  AdminUserDetailSchema,
  AdminUserSummarySchema,
  BannedRecordSchema,
  CopyResultSchema,
  MyRoleListSchema,
  RECORD_MAX_TURNS_MAX,
  RecordDetailSchema,
  RecordSummarySchema,
  type RecordDetail,
} from '@agent-os/contracts';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  addModel,
  allowRole,
  grantTo,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  type RunRole,
  useRunModels,
} from './support/access';
import { expectBody, expectError } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import {
  agentBody,
  auditOfRecord,
  BUILTIN,
  createRecord,
  createSystemRecord,
  deepAgentBody,
  getRecord,
  libraryRoutes,
  listLibrary,
  putRecord,
  recordName,
  setSystemAudience,
  shareWith,
  type LibraryRoute,
} from './support/library';
import { BACKOFFICE_SERVER, LOGS_SERVER, runName } from './support/mcp-servers';
import {
  apiRequest,
  insertEmployee,
  seedSuperAdmin,
  signInWithPassword,
  type Session,
} from './support/session';

/** Bound of one test; the requests settle far sooner. */
const TEST_TIMEOUT_MS = 180_000;

/** The platform's default chat model while the file runs (`useRunModels`): allowed to every role of the file. */
const DEFAULT_MODEL = runModel('haiku');
/** The second model: allowed only to «Оплаты», where Аня is and Борис is not (INT-3, step 1). */
const SECOND_MODEL = runModel('sonnet');
/** The registered server allowed to no role of the file (INT-3, step 3). */
const TRACKER_SERVER = runName('tracker');

/** The password of every employee the file inserts. */
const PASSWORD = 'e2e-library-password-12';

/** The one app and administrator of the file (INT-1..INT-5). */
let harness: TestApp;
let admin: Session;
/** Gives the platform back its default models (`useRunModels`); run in `afterAll` before the run's rows go. */
let restoreModels: (() => Promise<void>) | undefined;
/** Shared employees: Аня in «SRE» and «Оплаты», Борис in «SRE», Вера in no role. No case changes their roles or status. */
let anya: Session;
let boris: Session;
let vera: Session;
/** Shared roles: «SRE» (default model, `BACKOFFICE_SERVER`), «Оплаты» (both models, both servers), «Финансы» (default model, nobody). */
let sre: RunRole;
let payments: RunRole;
let finance: RunRole;

/** What this file created; `afterAll` deletes exactly these rows. */
const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();
const systemRecordIds = new Set<string>();

/** A new employee of the run with the login to sign in again with (`PASSWORD`), remembered for the cleanup. */
async function newAccount(
  tag: string,
  name: string,
): Promise<{ session: Session; login: string }> {
  const login = `e2e-library-${tag}-${randomUUID()}`;
  const id = await insertEmployee(harness.pool, {
    login,
    name,
    password: PASSWORD,
  });
  createdUserIds.add(id);
  return {
    session: await signInWithPassword(harness.app, login, PASSWORD),
    login,
  };
}

/** A new employee of the run (login `e2e-library-<tag>-<uuid>`, display `name`), signed in and remembered for the cleanup. */
async function newEmployee(tag: string, name: string): Promise<Session> {
  return (await newAccount(tag, name)).session;
}

/** A role of the run (`allowRole`), remembered for the cleanup. */
async function newRole(
  name: string,
  rights: { models: readonly string[]; servers: readonly string[] },
): Promise<RunRole> {
  const role = await allowRole(harness.app, admin, { name, ...rights });
  createdRoleIds.add(role.id);
  return role;
}

/** The administrator takes `role` from the employee (`DELETE /api/admin/users/:id/roles/:roleId`). */
async function takeRole(employee: Session, role: RunRole): Promise<void> {
  await expectBody(
    apiRequest(
      harness.app,
      admin,
      'delete',
      `/admin/users/${employee.id}/roles/${role.id}`,
    ),
    200,
    AdminUserDetailSchema,
  );
}

/** A system record made by the administrator, remembered for the cleanup. */
async function newSystemAgent(base: string): Promise<RecordDetail> {
  const record = await createSystemRecord(
    harness.app,
    admin,
    agentBody(recordName(base), { model: DEFAULT_MODEL }),
  );
  systemRecordIds.add(record.id);
  return record;
}

function call(session: Session, route: LibraryRoute): Promise<Response> {
  return apiRequest(harness.app, session, route.method, route.path, route.body);
}

/** Fails unless the response is `status` with `errorCode` (and `reason`, when given); returns the raw body text. */
async function expectRefusal(
  response: Promise<Response> | Response,
  status: number,
  errorCode: string,
  reason?: string,
): Promise<string> {
  const answered = await response;
  const body = await expectError(answered, status);
  expect(body.errorCode).toBe(errorCode);
  if (reason !== undefined) expect(body.reason).toBe(reason);
  return answered.text;
}

/**
 * AC-02.1: each route answers the record exactly as it answers a number that does not exist and one that is not
 * a UUID - 404 RECORD_NOT_FOUND with one body, byte for byte.
 */
async function expectAnsweredAsMissing(
  session: Session,
  routes: (recordId: string) => readonly LibraryRoute[],
  recordId: string,
): Promise<void> {
  const onRecord = routes(recordId);
  const onMissing = routes(randomUUID());
  const onNotUuid = routes('not-a-uuid');
  for (const [index, route] of onRecord.entries()) {
    const where = `${route.method.toUpperCase()} ${route.path}`;
    const missing = await expectRefusal(
      call(session, onMissing[index] as LibraryRoute),
      404,
      'RECORD_NOT_FOUND',
    );
    const recordText = await expectRefusal(
      call(session, route),
      404,
      'RECORD_NOT_FOUND',
    );
    const notUuid = await expectRefusal(
      call(session, onNotUuid[index] as LibraryRoute),
      404,
      'RECORD_NOT_FOUND',
    );
    expect(recordText, where).toBe(missing);
    expect(notUuid, where).toBe(missing);
  }
}

const employeeRoutes = (id: string) => libraryRoutes(id).employee;
const panelRoutes = (id: string) => libraryRoutes(id).panel;
/** The employee routes that change a record: `PUT`, `PUT .../audience`, `DELETE` (AC-04.2). */
const changingRoutes = (id: string) =>
  employeeRoutes(id).filter(
    (route) => route.method !== 'get' && !route.path.endsWith('/copy'),
  );

/** The ids of the records `session` sees in `GET /api/library`. */
async function visibleIds(session: Session): Promise<string[]> {
  return (await listLibrary(harness.app, session)).map((record) => record.id);
}

/** The `count(*)` of a counting query of the test with its one parameter. */
async function countRows(sql: string, parameter: unknown): Promise<number> {
  const { rows } = await harness.pool.query<{ count: string }>(sql, [
    parameter,
  ]);
  return Number(rows[0]?.count);
}

describe('custom-agents / library - integration (real AppModule + real Postgres, no model)', () => {
  beforeAll(async () => {
    harness = await createTestApp({
      mcpServers: ['logs', 'backoffice', 'tracker'],
    });
    const adminLogin = `e2e-library-admin-${randomUUID()}`;
    admin = await seedSuperAdmin(harness.app, adminLogin);
    createdUserIds.add(admin.id);
    restoreModels = await useRunModels(harness.app, admin, {
      chat: { id: DEFAULT_MODEL, ...HAIKU_TEST_PRICES },
    });
    await addModel(harness.app, admin, {
      id: SECOND_MODEL,
      ...HAIKU_TEST_PRICES,
    });
    // `tracker` of the run is allowed to nobody: the server Аня has no right on (INT-3, step 3).
    sre = await newRole('SRE', {
      models: [DEFAULT_MODEL],
      servers: [BACKOFFICE_SERVER],
    });
    payments = await newRole('Оплаты', {
      models: [DEFAULT_MODEL, SECOND_MODEL],
      servers: [LOGS_SERVER, BACKOFFICE_SERVER],
    });
    finance = await newRole('Финансы', {
      models: [DEFAULT_MODEL],
      servers: [],
    });
    anya = await newEmployee('anya', 'Аня');
    boris = await newEmployee('boris', 'Борис');
    vera = await newEmployee('vera', 'Вера');
    await sre.add(anya);
    await payments.add(anya);
    await sre.add(boris);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (harness !== undefined) {
      // System records have no owner, so no cascade takes them; they are marked deleted, as the panel deletes them
      // (data-model KD-7): a conversation may still run on one of their versions.
      await harness.pool.query(
        'UPDATE app.agents SET deleted_at = now() WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
        [[...systemRecordIds]],
      );
      await restoreModels?.();
      await removeRunRows(harness.pool, {
        models: [DEFAULT_MODEL, SECOND_MODEL],
        roles: [...createdRoleIds],
        users: [...createdUserIds],
      });
    }
    await harness?.close();
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: who sees and who may change a record - every route, three actors (table-driven)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-02.1 "Given Аня сохранила личного агента, when Борис или администратор ищет его в библиотеке или запрашивает по номеру,
  //   then записи для них нет, и ответ такой же, как на несуществующую запись"; AC-02.3 "Given системный агент открыт всем, when его
  //   ищет сотрудник без единой роли, then агента он не видит; когда администратор назначает ему роль, агент становится виден";
  //   AC-04.2 "Given сотрудник без права администратора, when он создаёт, правит, открывает или удаляет системную запись, в том числе
  //   в обход интерфейса, then отказ, и запись не меняется". Design: UC-E1 (all of it), UC-E3 (second half), UC-7, DC-2, DC-3, NFR-01;
  //   AC-12.2 (an administrator's delete of a built-in record -> 422 `builtin`).
  // Behavior: the actor calls a route with a record number -> the one visibility condition of the repository / the panel's condition /
  //   the right-to-change check of the service -> a status and the body, compared with the body for a number that does not exist.
  // Rows (literal expected status and `errorCode`; the walk is driven by `libraryRoutes(recordId)`, which lists every employee route
  //   with a record number - `GET/PUT/DELETE /api/library/:id`, `PUT .../audience`, `POST .../copy` - and every panel route with one):
  //   1. Given Аня's PERSONAL agent and a number that does not exist; When Борис calls each employee route with the agent's number and,
  //      separately, with the missing number; Then each answer for the agent is byte-for-byte the answer for the missing number
  //      (404 `RECORD_NOT_FOUND`, one body); a number that is not a UUID gives the same body; `GET /api/library` of Борис does not hold
  //      the agent; the agent is unchanged in the database (version, name, audience).
  //   2. When the administrator calls each panel route (`GET /api/admin/library/:id`, `PUT`, `PUT .../audience`, `DELETE`, `POST .../close`,
  //      `DELETE .../ban`) with the personal agent's number; Then the same 404 body as for the missing number; the three panel lists
  //      (`system`, `shared`, `bans`) do not hold it; `GET /api/library` of the administrator does not hold it either (an admin's right
  //      widens nothing - DC-3, invariant 4).
  //   3. Given a system agent opened to nobody and a non-administrator employee; When he calls `PUT`, `PUT .../audience`, `DELETE` of
  //      `/api/library/:id` with its number; Then it is invisible to him -> 404 `RECORD_NOT_FOUND` (same body as the missing number);
  //      once the administrator opens it to `everyone` and he has a role, the same calls answer 403 `RECORD_READ_ONLY` and nothing
  //      changed. On `/api/admin/library/...` (create, `PUT`, `PUT .../audience`, `DELETE`) -> 403 `ADMIN_REQUIRED`; no new system
  //      record exists afterwards (AC-04.2: also by `POST /api/library` with a system-shaped body - the owner is always the viewer, so
  //      the record that appears is personal).
  //   4. UC-7 (AC-02.3): Given a system agent opened to `everyone` and Вера, who has no role; When Вера reads `GET /api/library`; Then the
  //      agent is not there; When the administrator gives Вера a role (`PUT /api/admin/users/:id/roles/:roleId`) and she reads again;
  //      Then it is there (no restart, no cache).
  //      Дина with no role sees the three default agents (`chat`, `general-purpose`, the default deep agent) all along (data-model DC-22).
  //   5. AC-12.2, data-model DC-22: Given the default agent `chat`; When the administrator calls `DELETE /api/admin/library/:id` and
  //      `PUT /api/admin/library/:id/audience` of it; Then 422 `RECORD_REJECTED` with reason `builtin` and `audience_fixed`, and the
  //      agent is still in the database, not deleted. One default agent proves the wiring; the rule for any key is the unit rows of
  //      `save-rules.spec.ts` and `audience-rules.spec.ts`.
  // Catches: a route (existing or added later) that reads a record by number without the visibility condition and so opens a colleague's
  //   or an administrator's view of a personal agent; a body or status that tells "exists but not yours" from "does not exist"; an
  //   administrator right that is treated as visibility; a non-administrator who changes a system record through the employee
  //   routes; "everyone" that includes an employee with no role; a visibility check cached across a role change.
  // @category: core-functionality
  // @dependency: LibraryController, AdminLibraryController, LibraryService, library repository (visibility condition), SessionGuard, Postgres
  // @complexity: high
  it(
    'INT-1: an invisible record answers every employee and panel route exactly as a missing one, a visible foreign record is read-only, and a system record opened to everyone appears with the first role',
    async () => {
      const { app } = harness;

      // Row 1 (AC-02.1) - Given: Аня's personal agent; When: Борис, Вера and the administrator call every employee
      // route with its number; Then: the answer of a missing number, the agent in nobody's list, the agent unchanged
      const personal = await createRecord(
        app,
        anya,
        agentBody(recordName('Личный агент Ани'), { model: DEFAULT_MODEL }),
      );
      const stateOf = ({
        version,
        name,
        updatedAt,
        audience,
      }: RecordDetail) => ({
        version,
        name,
        updatedAt,
        audience,
      });
      const before = stateOf(await getRecord(app, anya, personal.id));
      for (const actor of [boris, vera, admin]) {
        await expectAnsweredAsMissing(actor, employeeRoutes, personal.id);
        expect(await visibleIds(actor)).not.toContain(personal.id);
      }

      // Row 2 (AC-02.1, DC-3) - When: the administrator calls every panel route with the personal agent's number;
      // Then: the same answer as a missing number, and none of the three panel lists holds it
      await expectAnsweredAsMissing(admin, panelRoutes, personal.id);
      for (const list of ['system', 'shared'] as const) {
        const rows = await expectBody(
          apiRequest(app, admin, 'get', `/admin/library/${list}`),
          200,
          z.array(RecordSummarySchema),
        );
        expect(rows.map((row) => row.id)).not.toContain(personal.id);
      }
      const bans = await expectBody(
        apiRequest(app, admin, 'get', '/admin/library/bans'),
        200,
        z.array(BannedRecordSchema),
      );
      expect(bans.map((row) => row.id)).not.toContain(personal.id);
      // Nothing of the walk reached the record: no copy, no edit, no audience, no delete.
      expect(stateOf(await getRecord(app, anya, personal.id))).toEqual(before);

      // Row 3 (AC-04.2) - Given: a system agent opened to nobody; When: Борис, who is no administrator, changes it
      // through the employee routes; Then: 404 as a missing number; once it is open to everyone and Борис has a
      // role, the same calls answer 403 RECORD_READ_ONLY; the panel routes answer 403 ADMIN_REQUIRED; nothing changed
      const system = await newSystemAgent('Системный агент');
      await expectAnsweredAsMissing(boris, changingRoutes, system.id);
      await setSystemAudience(app, admin, system.id, { everyone: true });
      for (const route of changingRoutes(system.id))
        await expectRefusal(call(boris, route), 403, 'RECORD_READ_ONLY');

      const refusedSystemName = recordName('Системный агент Бориса');
      const panelCalls: LibraryRoute[] = [
        {
          method: 'post',
          path: '/admin/library',
          body: agentBody(refusedSystemName, { model: DEFAULT_MODEL }),
        },
        ...panelRoutes(system.id).filter(
          (route) =>
            route.method === 'put' ||
            (route.method === 'delete' && !route.path.endsWith('/ban')),
        ),
        // The library's setting «Максимум шагов» of a new record is the administrator's as well.
        {
          method: 'put',
          path: '/admin/library/settings',
          body: { defaultMaxTurns: 50 },
        },
      ];
      for (const route of panelCalls)
        await expectRefusal(call(boris, route), 403, 'ADMIN_REQUIRED');
      // The administrator's own value outside the contract's bounds is refused before anything is written.
      await expectRefusal(
        apiRequest(app, admin, 'put', '/admin/library/settings', {
          defaultMaxTurns: RECORD_MAX_TURNS_MAX + 1,
        }),
        400,
        'VALIDATION_FAILED',
      );

      const systemNow = await expectBody(
        apiRequest(app, admin, 'get', `/admin/library/${system.id}`),
        200,
        RecordSummarySchema.pick({ version: true, name: true, author: true }),
      );
      expect(systemNow).toEqual({
        version: 1,
        name: system.name,
        author: null,
      });
      // A system-shaped body through the employee route makes a personal record of Борис: the owner is the viewer.
      const systemShapedName = recordName('Как будто системный');
      const shaped = await expectBody(
        apiRequest(app, boris, 'post', '/library', {
          ...agentBody(systemShapedName, { model: DEFAULT_MODEL }),
          ownerId: null,
          builtinKey: 'chat',
          everyone: true,
        }),
        201,
        RecordDetailSchema,
      );
      expect(shaped).toMatchObject({
        mine: true,
        builtinKey: null,
        author: { id: boris.id },
        audience: { everyone: false, roles: [], users: [] },
      });
      for (const name of [refusedSystemName, systemShapedName]) {
        expect(
          await countRows(
            'SELECT count(*) FROM app.agents WHERE owner_id IS NULL AND name = $1',
            name,
          ),
          name,
        ).toBe(0);
      }

      // Row 4 (UC-7, AC-02.3) - Given: the system agent open to everyone and Дина, who has no role; When: she reads
      // the library; Then: it is not there; When: the administrator gives her a role; Then: it is there at once
      const dina = await newEmployee('dina', 'Дина');
      const defaults = [
        BUILTIN.chat,
        BUILTIN.generalPurpose,
        BUILTIN.deepAgent,
      ];
      const dinaSees = await visibleIds(dina);
      expect(dinaSees).not.toContain(system.id);
      // data-model DC-22: the default agents are seen by every enabled employee, one without a role too
      for (const agent of defaults) expect(dinaSees).toContain(agent.id);
      await expectRefusal(
        apiRequest(app, dina, 'get', `/library/${system.id}`),
        404,
        'RECORD_NOT_FOUND',
      );
      const firstRole = await newRole('library-uc7', {
        models: [],
        servers: [],
      });
      await firstRole.add(dina);
      expect(await visibleIds(dina)).toContain(system.id);
      expect((await getRecord(app, dina, system.id)).canEdit).toBe(false);

      // Row 5 (AC-12.2, data-model DC-22) - Given: a default agent; When: the administrator deletes it and sets its
      // audience through the panel; Then: 422 RECORD_REJECTED `builtin` / `audience_fixed`, and it is still there
      const defaultAgent = BUILTIN.chat;
      await expectRefusal(
        apiRequest(app, admin, 'delete', `/admin/library/${defaultAgent.id}`),
        422,
        'RECORD_REJECTED',
        'builtin',
      );
      await expectRefusal(
        apiRequest(
          app,
          admin,
          'put',
          `/admin/library/${defaultAgent.id}/audience`,
          {
            everyone: false,
            roleIds: [],
            userIds: [],
            offerInChat: true,
          },
        ),
        422,
        'RECORD_REJECTED',
        'audience_fixed',
      );
      expect(
        await countRows(
          'SELECT count(*) FROM app.agents WHERE id = $1 AND deleted_at IS NULL',
          defaultAgent.id,
        ),
      ).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: the audience follows live data - share with a role, role changes, owner keeps the record, account removed
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.1 "Given Аня сохранила агента и workflow, when она делится обоими с ролью «SRE», then оба становятся видны участникам
  //   роли по одним правилам"; AC-01.2 "Given запись сохранена, when владелец открывает её снова, then видит те же имя, описание,
  //   переключатель и содержимое"; AC-02.2 "Given Аня поделилась агентом с ролью «SRE», when Борис из «SRE» открывает его, then видит
  //   промпт, инструменты и модель, а его попытка сохранить правку отклоняется"; AC-03.1 "Given Аня состоит в ролях «SRE» и «Оплаты»,
  //   when она смотрит свои роли, then видит ровно эти две"; AC-04.1 "Given Аня не состоит в роли «Финансы», when она открывает
  //   запись этой роли, then отказ с причиной, и аудитория записи не меняется"; AC-04.3 "Given Аня закрыла запись для всех ролей, when
  //   Борис ищет её, then записи для него нет"; AC-11.1 "Given Бориса сняли с роли «SRE», when он ищет агента Ани, then агента для
  //   него нет"; AC-11.2 "Given учётную запись Ани удалили из базы, then её записи не видны никому, в том числе ролевые"; AC-11.3
  //   "Given Аня открыла агента роли «SRE», when Аню снимают с этой роли, then Борис по-прежнему видит и запускает агента, а Аня
  //   по-прежнему правит его и сохраняет правку". Design: UC-1, UC-2, UC-3, UC-E3 (first half), UC-E6.
  // Behavior: sequence of owner / administrator actions -> membership read at the moment of each request -> what each employee sees
  //   and may do. Steps are ordered; each states its own Given (the record's state after the step before it).
  // Steps (literal expected statuses and fields):
  //   1. UC-1 (AC-01.2): Аня creates an agent (`POST /api/library`) and opens it by number -> 201 then 200; name, description, "offer in
  //      chat" and content equal what she sent; `version` 1, the switch on, personal audience (no roles), no ban.
  //   2. UC-2 (AC-01.1, AC-02.2, AC-03.1): Аня is in «SRE» and «Оплаты», Борис in «SRE», Вера in none. `GET /api/auth/me/roles` of Аня
  //      -> exactly those two (id and name). Аня shares an agent and a deep agent with «SRE» (`PUT .../audience`); Борис opens both ->
  //      200 with the content; his `PUT` of the agent -> 403 `RECORD_READ_ONLY` and the record unchanged (version, prompt); Борис's view
  //      of the audience holds only his own roles (`member: true`), not «Оплаты»; Вера sees neither -> 404; the audit has two
  //      `library_audience` events of one shape (kind, object type, the same fields in "after").
  //   3. UC-E3 first half (AC-04.1): Аня, who is not in «Финансы», adds that role -> 422 `RECORD_REJECTED`, reason `role_not_member`;
  //      a role number that does not exist -> the same reason; the audience still holds only «SRE», no `library_audience` event added.
  //   4. UC-3 (AC-11.3, AC-11.1, AC-04.3): the administrator removes Аня from «SRE» -> Борис still opens the agent, Аня still opens it
  //      and `PUT` of her edit -> 200 (the owner keeps it, DC: owner leaving the role changes nothing); the administrator removes
  //      Бориса from «SRE» -> Борис's `GET /api/library/:id` -> 404 and the agent is not in his list; Аня removes all roles
  //      (`PUT .../audience` with none) -> the agent is personal, Вера and Борис see nothing.
  //   5. UC-E6 (AC-11.2): Given two agents of Глеб - one personal, one open to «SRE» - and Борис in «SRE» (Борис sees the second);
  //      When the row of Глеб is deleted from `identity_users` in the database; Then Борис sees neither agent (`GET /api/library`, by
  //      number -> 404), and there is no row of Глеб in `agents` or of those records in `agent_shares`; a role deleted from
  //      the database takes its `agent_shares` rows with it and no `library_*` audit event is written by either cascade.
  // Catches: membership copied into the record at share time (a role change that does not reach the record), an owner who loses his
  //   own record when he leaves the role, a share to a role the sharer is not in that passes, an audience that survives the role or
  //   the account (a missing foreign key cascade), a colleague who can write through a read-only view, a `/me/roles` that returns other
  //   people's roles, a deep agent shared by different rules than an agent.
  // @category: core-functionality
  // @dependency: LibraryController, LibraryService, IdentityDirectory (rolesOf, isActive), AuthController (me/roles), AdminRolesController, AuditLog, Postgres (cascade)
  // @complexity: high
  it(
    "INT-2: a record shared with a role is visible to its members only, follows role changes at the next read, stays with its owner, and disappears with the owner's account",
    async () => {
      const { app, pool } = harness;
      const libraryAudience = async (recordId: string) =>
        (await auditOfRecord(pool, recordId)).filter(
          (event) => event.kind === 'library_audience',
        );

      // Step 1 (UC-1, AC-01.2) - Given: Аня saves an agent; When: she opens it again; Then: the same name,
      // description, switch and content, version 1, a personal audience, no ban
      const agentSent = agentBody(recordName('Агент Ани'), {
        model: DEFAULT_MODEL,
        prompt: 'Проверь платежи за сутки и опиши сбои',
      });
      const created = await createRecord(app, anya, agentSent);
      const opened = await getRecord(app, anya, created.id);
      expect(opened).toMatchObject({
        kind: 'agent',
        name: agentSent.name,
        description: agentSent.description,
        offerInChat: true,
        version: 1,
        mine: true,
        ban: null,
        canEdit: true,
      });
      expect(opened.content).toEqual(agentSent.content);
      expect(opened.audience).toStrictEqual({
        everyone: false,
        roles: [],
        users: [],
      });

      // Step 2 (UC-2, AC-03.1, AC-01.1, AC-02.2) - Given: Аня in «SRE» and «Оплаты», Борис in «SRE», Вера in none
      const myRoles = await expectBody(
        apiRequest(app, anya, 'get', '/auth/me/roles'),
        200,
        MyRoleListSchema,
      );
      const byId = (a: { id: string }, b: { id: string }) =>
        a.id.localeCompare(b.id);
      expect([...myRoles].sort(byId)).toEqual(
        [
          { id: sre.id, name: runName('SRE') },
          { id: payments.id, name: runName('Оплаты') },
        ].sort(byId),
      );
      // When: Аня shares the agent (with «SRE» and «Оплаты») and a deep agent (with «SRE»)
      const deepAgent = await createRecord(
        app,
        anya,
        deepAgentBody(recordName('Глубокий агент Ани'), DEFAULT_MODEL),
      );
      await shareWith(app, anya, created.id, [sre.id, payments.id]);
      await shareWith(app, anya, deepAgent.id, [sre.id]);
      // Then: Борис opens both by one rule, sees the content, and sees only his own role of the audience
      const borisAgent = await getRecord(app, boris, created.id);
      expect(borisAgent.content).toEqual(agentSent.content);
      expect(borisAgent).toMatchObject({
        mine: false,
        canEdit: false,
        canShare: false,
      });
      expect(borisAgent.audience).toStrictEqual({
        roles: [{ id: sre.id, name: runName('SRE'), member: true }],
      });
      const borisDeepAgent = await getRecord(app, boris, deepAgent.id);
      expect(borisDeepAgent.content).toEqual(deepAgent.content);
      expect(await visibleIds(boris)).toEqual(
        expect.arrayContaining([created.id, deepAgent.id]),
      );
      // His save through the read-only view is refused and the record stays as it was.
      await expectRefusal(
        apiRequest(app, boris, 'put', `/library/${created.id}`, {
          ...agentSent,
          content: { ...agentSent.content, prompt: 'Правка Бориса' },
          version: 1,
        }),
        403,
        'RECORD_READ_ONLY',
      );
      const afterBorisSave = await getRecord(app, anya, created.id);
      expect(afterBorisSave.version).toBe(1);
      expect(afterBorisSave.content).toEqual(agentSent.content);
      // Вера, in no role, sees neither.
      for (const id of [created.id, deepAgent.id])
        await expectRefusal(
          apiRequest(app, vera, 'get', `/library/${id}`),
          404,
          'RECORD_NOT_FOUND',
        );
      const veraSees = await visibleIds(vera);
      expect(veraSees).not.toContain(created.id);
      expect(veraSees).not.toContain(deepAgent.id);
      // The agent and the deep agent are shared by one rule: one `library_audience` event each, of one shape.
      const agentShares = await libraryAudience(created.id);
      const deepAgentShares = await libraryAudience(deepAgent.id);
      expect(agentShares).toHaveLength(1);
      expect(deepAgentShares).toHaveLength(1);
      const [agentShare] = agentShares;
      const [deepAgentShare] = deepAgentShares;
      expect(Object.keys(deepAgentShare?.after ?? {}).sort()).toEqual(
        Object.keys(agentShare?.after ?? {}).sort(),
      );
      expect(agentShare).toMatchObject({ actor: anya.id, outcome: 'ok' });
      expect(deepAgentShare).toMatchObject({
        actor: anya.id,
        outcome: 'ok',
        after: { kind: 'deep_agent', roleIds: [sre.id] },
      });

      // Step 3 (UC-E3 first half, AC-04.1) - When: Аня adds «Финансы», which she is not in, or a role that does not
      // exist; Then: 422 `role_not_member`, the audience still holds only «SRE», no event added
      for (const foreign of [finance.id, randomUUID()])
        await expectRefusal(
          apiRequest(app, anya, 'put', `/library/${deepAgent.id}/audience`, {
            roleIds: [sre.id, foreign],
            offerInChat: true,
          }),
          422,
          'RECORD_REJECTED',
          'role_not_member',
        );
      expect(
        (await getRecord(app, anya, deepAgent.id)).audience.roles.map(
          (role) => role.id,
        ),
      ).toEqual([sre.id]);
      expect(await libraryAudience(deepAgent.id)).toHaveLength(1);

      // Step 4 (UC-3, AC-11.3, AC-11.1, AC-04.3) - on the case's own employees and role: Ася owns the agent, Богдан
      // and Денис are members of «Дежурные»
      const duty = await newRole('Дежурные', {
        models: [DEFAULT_MODEL],
        servers: [],
      });
      const asya = await newEmployee('asya', 'Ася');
      const bogdan = await newEmployee('bogdan', 'Богдан');
      const denis = await newEmployee('denis', 'Денис');
      for (const member of [asya, bogdan, denis]) await duty.add(member);
      const dutySent = agentBody(recordName('Агент дежурных'), {
        model: DEFAULT_MODEL,
      });
      const dutyAgent = await createRecord(app, asya, dutySent);
      await shareWith(app, asya, dutyAgent.id, [duty.id]);
      // When: the owner leaves the role; Then: the members still see it and the owner still edits it
      await takeRole(asya, duty);
      expect((await getRecord(app, bogdan, dutyAgent.id)).id).toBe(
        dutyAgent.id,
      );
      expect((await getRecord(app, asya, dutyAgent.id)).canEdit).toBe(true);
      const edited = await putRecord(app, asya, dutyAgent.id, {
        ...dutySent,
        content: { ...dutySent.content, prompt: 'Правка после выхода из роли' },
        version: 1,
      });
      expect(edited.version).toBe(2);
      // When: Богдан leaves the role; Then: the agent is gone for him at his next request
      await takeRole(bogdan, duty);
      await expectRefusal(
        apiRequest(app, bogdan, 'get', `/library/${dutyAgent.id}`),
        404,
        'RECORD_NOT_FOUND',
      );
      expect(await visibleIds(bogdan)).not.toContain(dutyAgent.id);
      expect(await visibleIds(denis)).toContain(dutyAgent.id);
      // When: the owner removes every role; Then: the record is personal and no colleague sees it
      const personalAgain = await shareWith(app, asya, dutyAgent.id, []);
      expect(personalAgain.audience.roles).toEqual([]);
      for (const colleague of [denis, vera]) {
        await expectRefusal(
          apiRequest(app, colleague, 'get', `/library/${dutyAgent.id}`),
          404,
          'RECORD_NOT_FOUND',
        );
        expect(await visibleIds(colleague)).not.toContain(dutyAgent.id);
      }

      // Step 5 (UC-E6, AC-11.2) - Given: Глеб's personal agent and his agent open to «Дежурные», where Денис still
      // is, and Денис's own agent open to the role
      const gleb = await newEmployee('gleb', 'Глеб');
      await duty.add(gleb);
      const glebPersonal = await createRecord(
        app,
        gleb,
        agentBody(recordName('Личный агент Глеба'), { model: DEFAULT_MODEL }),
      );
      const glebShared = await createRecord(
        app,
        gleb,
        agentBody(recordName('Общий агент Глеба'), { model: DEFAULT_MODEL }),
      );
      await shareWith(app, gleb, glebShared.id, [duty.id]);
      const denisShared = await createRecord(
        app,
        denis,
        agentBody(recordName('Агент Дениса'), { model: DEFAULT_MODEL }),
      );
      await shareWith(app, denis, denisShared.id, [duty.id]);
      expect(await visibleIds(denis)).toContain(glebShared.id);
      const cascaded = [glebPersonal.id, glebShared.id, denisShared.id];
      const eventsBefore = await Promise.all(
        cascaded.map(async (id) => (await auditOfRecord(pool, id)).length),
      );

      // When: Глеб's account is deleted from the database; Then: his records and their shares are gone for everyone
      await pool.query('DELETE FROM app.identity_users WHERE id = $1', [
        gleb.id,
      ]);
      const denisSees = await visibleIds(denis);
      for (const id of [glebPersonal.id, glebShared.id]) {
        expect(denisSees).not.toContain(id);
        await expectRefusal(
          apiRequest(app, denis, 'get', `/library/${id}`),
          404,
          'RECORD_NOT_FOUND',
        );
      }
      expect(
        await countRows(
          'SELECT count(*) FROM app.agents WHERE owner_id = $1',
          gleb.id,
        ),
      ).toBe(0);
      expect(
        await countRows(
          'SELECT count(*) FROM app.agent_shares WHERE agent_id = ANY($1::uuid[])',
          [glebPersonal.id, glebShared.id],
        ),
      ).toBe(0);

      // When: the role is deleted from the database; Then: its shares go with it, Денис keeps his record as personal
      await pool.query('DELETE FROM app.identity_roles WHERE id = $1', [
        duty.id,
      ]);
      expect(
        await countRows(
          'SELECT count(*) FROM app.agent_shares WHERE role_id = $1',
          duty.id,
        ),
      ).toBe(0);
      expect(
        (await getRecord(app, denis, denisShared.id)).audience.roles,
      ).toEqual([]);
      // Neither cascade writes a library event.
      const eventsAfter = await Promise.all(
        cascaded.map(async (id) => (await auditOfRecord(pool, id)).length),
      );
      expect(eventsAfter).toEqual(eventsBefore);
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: the author's real rights reach the rules - copy with replacement, save with an unavailable server
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-05.1 "Given в агенте Ани есть сервер Jira, а у Бориса нет права ни на Jira, ни на один его инструмент, when Борис копирует
  //   агента, then в копии нет Jira, и Борис видит, что Jira выпал"; AC-05.2 "Given Борис скопировал агента, when Аня меняет оригинал,
  //   then копия Бориса не меняется"; AC-05.3 "Given в агенте Ани выбрана модель, которая Борису не разрешена, а модель платформы по
  //   умолчанию разрешена, when Борис копирует агента, then в копии стоит модель платформы по умолчанию, и Борис видит, какую модель
  //   заменили"; AC-07.1 "Given у Ани нет права на сервер Gmail, when она сохраняет агента с Gmail, в том числе в обход формы, then
  //   отказ с причиной"; AC-07.2 "Given в агенте Ани есть Jira, а Аня потеряла право на Jira, when она сохраняет правку промпта, then
  //   сохранение проходит, и Jira остаётся в записи". Design: UC-4 and one reject row and one pass row of UC-E2.
  // Behavior: employee request -> controller asks `Agents.mcp.usable(author)`, service asks `AccessService.allowedModels(author)` and
  //   `IdentityDirectory` -> the pure rule decides -> the stored record / the 422 body. Only the wiring of the REAL facts is asserted;
  //   the rule's variants are the unit tables (copy-rules, save-rules).
  // Steps (literal expected values):
  //   1. UC-4: Given Аня's agent open to «SRE» with servers Jira and Sentry and a model Борису not allowed; Борис's rights - only
  //      Sentry (through a role grant) and the platform default model (`useRunModels`); When Борис `POST .../copy` with
  //      `language: 'en'`; Then 201 `CopyResult`: the copy is personal, version 1, name "{name} — copy", servers exactly [Sentry], model the platform default;
  //      `removedServers` names Jira, `replacedModels` names the old and new model; the original is unchanged.
  //   2. AC-05.2: When Аня then saves a new version of the original (version 2, another prompt); Then Борис's copy still has its own
  //      prompt, servers and version 1.
  //   3. AC-07.1 (reject row): Given Аня has no right on a registered server she does not own a right on; When she `POST /api/library`
  //      with that server in the content, also with the call made without the form (direct HTTP); Then 422 `RECORD_REJECTED`, reason
  //      `server_not_allowed`, and no record was created.
  //   4. AC-07.2 (pass row): Given Аня's saved agent holds Jira and the administrator takes her Jira right away; When she saves a prompt
  //      edit that keeps Jira; Then 200, version up by one, Jira still in the content.
  // Catches: the registry or rights facts not reaching the pure rules, a copy that shares state with its original, a save that
  //   rejects an old server the author only lost the right to, a reject that still writes the record.
  // @category: integration
  // @dependency: LibraryController, LibraryService, Agents.mcp.usable, AccessService.allowedModels, AgentsModule settings (AGENTS_SETTINGS), AccessAdminController, Postgres
  // @complexity: high
  it(
    'INT-3: a copy keeps only the servers and models the copier can use and states what was dropped, and a save checks added servers against the real registry but keeps one the author lost',
    async () => {
      const { app } = harness;
      // The case takes a right away, so it runs on its own employees and roles: Алиса (the author) holds both
      // models, Jira (`LOGS_SERVER`, a grant of its own to take away in step 4) and Sentry (`BACKOFFICE_SERVER`);
      // Кирилл (the copier) holds only the default model and Sentry, through the role both are in.
      const authorRole = await newRole('Копирование-автор', {
        models: [DEFAULT_MODEL, SECOND_MODEL],
        servers: [BACKOFFICE_SERVER],
      });
      const jiraGrant = await grantTo(
        app,
        admin,
        { roleId: authorRole.id },
        { effect: 'allow', target: { kind: 'server', server: LOGS_SERVER } },
      );
      const sharedRole = await newRole('Копирование-общая', {
        models: [DEFAULT_MODEL],
        servers: [BACKOFFICE_SERVER],
      });
      const alisa = await newEmployee('alisa', 'Алиса');
      const kirill = await newEmployee('kirill', 'Кирилл');
      await authorRole.add(alisa);
      await sharedRole.add(alisa);
      await sharedRole.add(kirill);

      // Step 1 (UC-4, AC-05.1, AC-05.3) - Given: Алиса's agent with Jira and Sentry on a model Кирилл is not
      // allowed, open to the role; When: Кирилл copies it; Then: a personal copy with Sentry only and the
      // platform default model, Jira named as dropped and the model named as replaced
      const sent = agentBody(recordName('Агент разбора инцидентов'), {
        model: SECOND_MODEL,
        servers: [LOGS_SERVER, BACKOFFICE_SERVER],
        prompt: 'Найди инцидент в логах и заведи заметку',
      });
      const original = await createRecord(app, alisa, sent);
      await shareWith(app, alisa, original.id, [sharedRole.id]);
      const copied = await expectBody(
        apiRequest(app, kirill, 'post', `/library/${original.id}/copy`, {
          language: 'en',
        }),
        201,
        CopyResultSchema,
      );
      expect(copied.record).toMatchObject({
        kind: 'agent',
        // i18n UC-3 (wiring): the route hands the copier's language to the copy rule
        name: `${sent.name} — copy`,
        version: 1,
        mine: true,
        author: { id: kirill.id },
        ban: null,
      });
      expect(copied.record.id).not.toBe(original.id);
      expect(copied.record.audience).toStrictEqual({
        everyone: false,
        roles: [],
        users: [],
      });
      expect(copied.record.content).toEqual({
        ...sent.content,
        servers: [BACKOFFICE_SERVER],
        model: DEFAULT_MODEL,
      });
      expect(copied.removedServers).toEqual([
        { subagent: null, servers: [LOGS_SERVER] },
      ]);
      expect(copied.replacedModels).toEqual([
        { subagent: null, from: SECOND_MODEL, to: DEFAULT_MODEL },
      ]);
      const originalNow = await getRecord(app, alisa, original.id);
      expect(originalNow.version).toBe(1);
      expect(originalNow.content).toEqual(sent.content);

      // Step 2 (AC-05.2) - When: Алиса saves a new version of the original; Then: Кирилл's copy is as it was
      const edited = await putRecord(app, alisa, original.id, {
        ...sent,
        content: { ...sent.content, prompt: 'Новый промпт оригинала' },
        version: 1,
      });
      expect(edited.version).toBe(2);
      const copyNow = await getRecord(app, kirill, copied.record.id);
      expect(copyNow.version).toBe(1);
      expect(copyNow.content).toEqual(copied.record.content);

      // Step 3 (AC-07.1, reject row) - Given: the registered tracker, which no role of Алиса allows; When: she
      // saves a new agent with it by a direct call; Then: 422 `server_not_allowed` and no record was written
      const refusedName = recordName('Агент с трекером');
      await expectRefusal(
        apiRequest(
          app,
          alisa,
          'post',
          '/library',
          agentBody(refusedName, {
            model: DEFAULT_MODEL,
            servers: [TRACKER_SERVER],
          }),
        ),
        422,
        'RECORD_REJECTED',
        'server_not_allowed',
      );
      expect(
        await countRows(
          'SELECT count(*) FROM app.agents WHERE name = $1',
          refusedName,
        ),
      ).toBe(0);

      // Step 4 (AC-07.2, pass row) - Given: the administrator takes Алиса's Jira right away (a new record with
      // Jira is now refused, so the loss reached the rule); When: she saves a prompt edit that keeps Jira;
      // Then: 200, the version up by one, Jira still in the record
      const removed = await apiRequest(
        app,
        admin,
        'delete',
        `/admin/grants/${jiraGrant.id}`,
      );
      expect(removed.status).toBe(204);
      await expectRefusal(
        apiRequest(
          app,
          alisa,
          'post',
          '/library',
          agentBody(recordName('Новый агент с Jira'), {
            model: DEFAULT_MODEL,
            servers: [LOGS_SERVER],
          }),
        ),
        422,
        'RECORD_REJECTED',
        'server_not_allowed',
      );
      const keptPrompt = 'Правка промпта после потери Jira';
      const kept = await putRecord(app, alisa, original.id, {
        ...sent,
        content: { ...sent.content, prompt: keptPrompt },
        version: 2,
      });
      expect(kept.version).toBe(3);
      expect(kept.content).toEqual({ ...sent.content, prompt: keptPrompt });
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4: the administrator's panel - shared-with-roles list, close access, ban, unban
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-09.1 "Given запись Ани открыта роли «SRE», when администратор закрывает доступ, then запись остаётся у Ани личной, а Борис
  //   её больше не видит"; AC-09.2 "Given Аня отключена, when администратор смотрит записи, открытые ролям, then её записи отмечены
  //   «автор отключён» и по-прежнему видны роли"; AC-09.3 "Given администратор закрыл доступ к записи Ани, when Аня открывает запись,
  //   то видит, что доступ закрыл администратор, дату закрытия и что делиться нельзя; when она открывает запись роли, в том числе в
  //   обход интерфейса, then отказ с причиной, и аудитория не меняется"; AC-09.4 "Given запись Ани под запретом делиться, when
  //   администратор открывает список запретов, then видит имя записи, автора и дату закрытия, но не промпт; when он снимает запрет,
  //   then Аня снова может открыть запись роли «SRE»". Design: UC-5, Flow 4.
  // Behavior: admin panel calls on a role-shared record -> panel read condition, close (audience deleted + ban set in one transaction),
  //   ban list projection, unban -> what Борис, Аня and the administrator then see.
  // Steps (literal expected values):
  //   1. Given Аня's agent open to «SRE» and Аня disabled by the administrator; When the administrator reads `GET /api/admin/library/shared`;
  //      Then the agent is in the list with `author.disabled: true` and the role «SRE»; Борис still opens it (a disabled author does not
  //      change visibility, AC-09.2); `GET /api/admin/library/:id` returns it with content.
  //   2. Аня is enabled again. The administrator `POST /api/admin/library/:id/close` -> 204; Борис -> 404 on the record and it is not
  //      in his list; the record is no longer in `shared`; Аня opens it: `ban.closedAt` is set, `canShare: false`, audience empty, she
  //      still edits it (`canEdit: true`), the record is still in her list.
  //   3. AC-09.3: Аня `PUT .../audience` with «SRE» (direct HTTP) -> 422 `RECORD_REJECTED`, reason `sharing_banned`; the audience stays
  //      empty; a close of a record that is not role-shared (a personal one, a system one, a missing number) -> 404 `RECORD_NOT_FOUND`.
  //   4. AC-09.4: `GET /api/admin/library/bans` holds the record with its number, kind, name, author and `closedAt` and no `description`
  //      and no `content` key at all; `DELETE .../ban` -> 204 (a second one -> 404); Аня shares with «SRE» again -> 200 and Борис
  //      sees it; the audit holds `library_close` then `library_unban`.
  // Catches: a panel list that includes personal records or records under a ban (the panel's own read condition is the second of the
  //   only two and has no other test), a close that removes the audience but leaves no ban (the owner shares again at once) or sets the
  //   ban but leaves the audience (Борис still sees it), a ban list that leaks the prompt, an unban that leaves the ban in force, a
  //   disabled author whose records silently disappear for the role.
  // @category: core-functionality
  // @dependency: AdminLibraryController, LibraryPanelService, library repository (panel condition), AdminUsersController (disable/enable), AuditLog, Postgres
  // @complexity: medium
  it(
    'INT-4: closing access removes the audience and bans sharing, the panel never lists personal records and the ban list carries no content, unban lets the owner share again',
    async () => {
      const { app, pool } = harness;
      // The case disables an account, so it runs on its own employees and role: Ирина (the author) and Олег.
      const role = await newRole('Закрытие', {
        models: [DEFAULT_MODEL],
        servers: [],
      });
      const author = await newAccount('irina', 'Ирина');
      let irina = author.session;
      const oleg = await newEmployee('oleg', 'Олег');
      await role.add(irina);
      await role.add(oleg);
      const sent = agentBody(recordName('Агент сверки'), {
        model: DEFAULT_MODEL,
        prompt: 'Сверь выписку банка с реестром платежей',
      });
      const record = await createRecord(app, irina, sent);
      await shareWith(app, irina, record.id, [role.id]);
      const personal = await createRecord(
        app,
        irina,
        agentBody(recordName('Личный агент Ирины'), { model: DEFAULT_MODEL }),
      );
      const sharedList = async () =>
        expectBody(
          apiRequest(app, admin, 'get', '/admin/library/shared'),
          200,
          z.array(RecordSummarySchema),
        );
      const setStatus = (action: 'block' | 'unblock') =>
        expectBody(
          apiRequest(app, admin, 'post', `/admin/users/${irina.id}/${action}`),
          200,
          AdminUserSummarySchema,
        );

      // Step 1 (AC-09.2) - Given: Ирина's agent open to the role and Ирина disabled; When: the administrator reads
      // the shared list; Then: the agent is there marked "author disabled" with its role, the personal record is
      // not; Олег still opens it; the panel opens it with its content
      await setStatus('block');
      const rowOfDisabled = (await sharedList()).find(
        (row) => row.id === record.id,
      );
      expect(rowOfDisabled).toMatchObject({
        author: { id: irina.id, name: 'Ирина', disabled: true },
      });
      expect(rowOfDisabled?.audience.roles.map((held) => held.id)).toEqual([
        role.id,
      ]);
      expect((await sharedList()).map((row) => row.id)).not.toContain(
        personal.id,
      );
      expect((await getRecord(app, oleg, record.id)).content).toEqual(
        sent.content,
      );
      const inPanel = await expectBody(
        apiRequest(app, admin, 'get', `/admin/library/${record.id}`),
        200,
        RecordDetailSchema,
      );
      expect(inPanel.content).toEqual(sent.content);

      // Step 2 (AC-09.1) - Given: Ирина enabled again and signed in anew (the block ended her sessions);
      // When: the administrator closes access; Then: Олег no longer sees it, the panel's shared list drops it,
      // Ирина keeps it as a personal record under a ban that she still edits
      await setStatus('unblock');
      irina = await signInWithPassword(app, author.login, PASSWORD);
      const closed = await apiRequest(
        app,
        admin,
        'post',
        `/admin/library/${record.id}/close`,
      );
      expect(closed.status).toBe(204);
      await expectRefusal(
        apiRequest(app, oleg, 'get', `/library/${record.id}`),
        404,
        'RECORD_NOT_FOUND',
      );
      expect(await visibleIds(oleg)).not.toContain(record.id);
      expect((await sharedList()).map((row) => row.id)).not.toContain(
        record.id,
      );
      const ownView = await getRecord(app, irina, record.id);
      expect(ownView).toMatchObject({
        mine: true,
        canEdit: true,
        canShare: false,
      });
      expect(ownView.audience).toStrictEqual({
        everyone: false,
        roles: [],
        users: [],
      });
      const closedAt = ownView.ban?.closedAt;
      expect(closedAt).toEqual(expect.any(String));
      expect(await visibleIds(irina)).toContain(record.id);

      // Step 3 (AC-09.3) - When: Ирина opens the record to the role by a direct call; Then: 422 `sharing_banned`
      // and the audience stays empty; a close of a record the panel does not list answers as a missing one
      await expectRefusal(
        apiRequest(app, irina, 'put', `/library/${record.id}/audience`, {
          roleIds: [role.id],
          offerInChat: true,
        }),
        422,
        'RECORD_REJECTED',
        'sharing_banned',
      );
      expect((await getRecord(app, irina, record.id)).audience.roles).toEqual(
        [],
      );
      const system = await newSystemAgent('Системный агент закрытия');
      for (const id of [personal.id, system.id, randomUUID()])
        await expectRefusal(
          apiRequest(app, admin, 'post', `/admin/library/${id}/close`),
          404,
          'RECORD_NOT_FOUND',
        );

      // Step 4 (AC-09.4) - When: the administrator reads the ban list; Then: the record's number, kind, name,
      // author and close date and nothing else; When: he lifts the ban (a second lift is 404); Then: Ирина
      // shares with the role again and Олег sees it; the audit holds the close, then the unban
      const bansResponse = await apiRequest(
        app,
        admin,
        'get',
        '/admin/library/bans',
      );
      expect(bansResponse.status).toBe(200);
      const banRows = z
        .array(z.record(z.string(), z.unknown()))
        .parse(bansResponse.body);
      const banRow = banRows.find((row) => row.id === record.id);
      expect(banRow).toStrictEqual({
        id: record.id,
        kind: 'agent',
        name: sent.name,
        author: { id: irina.id, name: 'Ирина', disabled: false },
        closedAt,
      });
      expect(bansResponse.text).not.toContain(sent.content.prompt);
      expect(bansResponse.text).not.toContain(sent.description);

      const lifted = await apiRequest(
        app,
        admin,
        'delete',
        `/admin/library/${record.id}/ban`,
      );
      expect(lifted.status).toBe(204);
      await expectRefusal(
        apiRequest(app, admin, 'delete', `/admin/library/${record.id}/ban`),
        404,
        'RECORD_NOT_FOUND',
      );
      const reopened = await shareWith(app, irina, record.id, [role.id]);
      expect(reopened).toMatchObject({ ban: null, canShare: true });
      expect(await visibleIds(oleg)).toContain(record.id);

      const banEvents = (await auditOfRecord(pool, record.id)).filter(
        (event) =>
          event.kind === 'library_close' || event.kind === 'library_unban',
      );
      expect(banEvents.map((event) => event.kind)).toEqual([
        'library_close',
        'library_unban',
      ]);
      const [closeEvent, unbanEvent] = banEvents;
      expect(closeEvent).toMatchObject({
        actor: admin.id,
        after: { roleIds: [], closedAt },
      });
      expect(unbanEvent).toMatchObject({
        actor: admin.id,
        before: { kind: 'agent', name: sent.name, ownerId: irina.id, closedAt },
        after: {
          kind: 'agent',
          name: sent.name,
          ownerId: irina.id,
          closedAt: null,
        },
      });
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-5: version conflict and the audit trail of a record's whole life, in the action's transaction
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-08.1 "Given запись в версии 3 открыта в двух вкладках, when первая вкладка сохраняет правку, а затем сохраняет вторая, then
  //   вторая получает конфликт, и запись остаётся в версии 4"; AC-10.1 "Given Аня создала агента, поправила его, поделилась им,
  //   Борис его скопировал, а Аня закрыла доступ и удалила агента, then в аудите шесть записей, и ни одна не содержит текста
  //   промпта". Design: UC-E5, UC-6, KD-5, KD-7, invariants 6 and 8.
  // Behavior: the save carries the version it started from -> a new `agent_versions` row and the agent's pointer moved to it only while
  //   version N is active (data-model design-agents.md KD-2) -> 200 and N+1, or 409 and nothing;
  //   each action writes one event in its own transaction with a field sample that has no prompt.
  // Steps (literal expected values):
  //   1. Given a fresh record `r` of Аня in version 3 (saved twice after create) and `before` = its audit events; When two `PUT
  //      /api/library/:id` with `version: 3` are sent one after another (second with other content); Then the first -> 200,
  //      `version` 4; the second -> 409 `RECORD_VERSION_CONFLICT`, one constant body; the record holds the FIRST content in version 4;
  //      the second request added no audit event (a conflict leaves no trace) and a stale save with a rejected rule (422) added none;
  //      `agent_versions` holds exactly versions 1-4 of the record, each written by Аня, the earlier ones unchanged (data-model DC-16, DC-17).
  //   2. UC-6 on another fresh record: Аня creates an agent with a distinctive prompt phrase, edits it (version 2), shares it with a
  //      role, Борис (in the role) copies it, Аня removes all roles, Аня deletes the agent. The audit rows of object type
  //      `library_record` for this scenario are EXACTLY six, in order: `library_create`, `library_update`, `library_audience`,
  //      `library_copy` (with the original's number in "after", written for Борис), `library_audience` (no roles), `library_delete`;
  //      none of the six rows' serialised before/after contains the prompt phrase or the description text; each holds the owner, the
  //      version, the record's name and the audience as numbers.
  // Catches: a lost update (the second tab overwrites the first because the version is read, not compared, in the update); a version
  //   that moves on a rejected or conflicting save; a prompt or description leaked into the audit through a before/after that carries
  //   the whole row; an action (copy, audience, delete) that writes no event or two.
  // @category: core-functionality
  // @dependency: LibraryController, LibraryService, library repository (versioned update), AuditLog, Postgres
  // @complexity: high
  it(
    "INT-5: a stale save is refused and changes nothing, and a record's whole life leaves exactly one prompt-free audit event per action",
    async () => {
      const { app, pool } = harness;

      // Step 1 (UC-E5, AC-08.1) - Given: Аня's record in version 3; When: two saves started from version 3 come
      // one after the other; Then: the first is version 4, the second a 409 with one constant body; the record
      // holds the first content; neither the conflict nor a refused save adds an audit event or a version
      const sent = agentBody(recordName('Агент двух вкладок'), {
        model: DEFAULT_MODEL,
      });
      const record = await createRecord(app, anya, sent);
      const saveFrom = (
        version: number,
        prompt: string,
        servers = [] as string[],
      ) =>
        apiRequest(app, anya, 'put', `/library/${record.id}`, {
          ...sent,
          content: { ...sent.content, prompt, servers },
          version,
        });
      for (const version of [1, 2])
        await expectBody(
          saveFrom(version, `Правка ${version}`),
          200,
          RecordDetailSchema,
        );
      const eventsBefore = (await auditOfRecord(pool, record.id)).length;

      const first = await expectBody(
        saveFrom(3, 'Правка первой вкладки'),
        200,
        RecordDetailSchema,
      );
      expect(first.version).toBe(4);
      const conflict = await expectRefusal(
        saveFrom(3, 'Правка второй вкладки'),
        409,
        'RECORD_VERSION_CONFLICT',
      );
      const olderConflict = await expectRefusal(
        saveFrom(1, 'Правка давней вкладки'),
        409,
        'RECORD_VERSION_CONFLICT',
      );
      expect(olderConflict).toBe(conflict);
      await expectRefusal(
        saveFrom(4, 'Правка с чужим сервером', [TRACKER_SERVER]),
        422,
        'RECORD_REJECTED',
        'server_not_allowed',
      );
      const stored = await getRecord(app, anya, record.id);
      expect(stored.version).toBe(4);
      expect(stored.content).toMatchObject({ prompt: 'Правка первой вкладки' });
      // data-model DC-16, DC-17: every save is its own version row by Аня, earlier rows are untouched, and neither
      // the 409 nor the 422 left a version
      const { rows: versions } = await pool.query<{
        number: number;
        authorId: string | null;
        prompt: string;
      }>(
        `SELECT number, author_id AS "authorId", content->>'prompt' AS prompt FROM app.agent_versions
          WHERE agent_id = $1 ORDER BY number`,
        [record.id],
      );
      expect(versions).toEqual([
        { number: 1, authorId: anya.id, prompt: sent.content.prompt },
        { number: 2, authorId: anya.id, prompt: 'Правка 1' },
        { number: 3, authorId: anya.id, prompt: 'Правка 2' },
        { number: 4, authorId: anya.id, prompt: 'Правка первой вкладки' },
      ]);
      const eventsAfter = await auditOfRecord(pool, record.id);
      expect(eventsAfter).toHaveLength(eventsBefore + 1);
      expect(eventsAfter.at(-1)).toMatchObject({
        kind: 'library_update',
        after: { version: 4 },
      });

      // Step 2 (UC-6, AC-10.1) - Given: Аня creates an agent with a distinctive prompt and description, edits it,
      // shares it with «SRE», Борис copies it, Аня removes every role and deletes it; Then: exactly six events
      // in order, the copy's written for Борис about the copy with the original as `copiedFrom`, none holding
      // the prompt or the description, each with the owner, the version, the name and the audience as numbers
      const promptPhrase = `Секретная фраза промпта ${randomUUID()}`;
      const descriptionPhrase = `Особое описание ${randomUUID()}`;
      const lifeSent = {
        ...agentBody(recordName('Агент всей жизни'), {
          model: DEFAULT_MODEL,
          prompt: promptPhrase,
        }),
        description: descriptionPhrase,
      };
      const life = await createRecord(app, anya, lifeSent);
      await putRecord(app, anya, life.id, {
        ...lifeSent,
        content: { ...lifeSent.content, prompt: `${promptPhrase} - правка` },
        version: 1,
      });
      await shareWith(app, anya, life.id, [sre.id]);
      const copy = await expectBody(
        apiRequest(app, boris, 'post', `/library/${life.id}/copy`, {
          language: 'ru',
        }),
        201,
        CopyResultSchema,
      );
      await shareWith(app, anya, life.id, []);
      const deleted = await apiRequest(
        app,
        anya,
        'delete',
        `/library/${life.id}`,
      );
      expect(deleted.status).toBe(204);

      const { rows: lifeEvents } = await pool.query<{
        kind: string;
        actor: string;
        objectId: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }>(
        `SELECT kind, actor, object_id AS "objectId", before, after FROM app.audit_events
          WHERE object_type = 'library_record' AND (object_id = $1 OR after->>'copiedFrom' = $1)
          ORDER BY at, id`,
        [life.id],
      );
      expect(lifeEvents.map((event) => event.kind)).toEqual([
        'library_create',
        'library_update',
        'library_audience',
        'library_copy',
        'library_audience',
        'library_delete',
      ]);
      expect(lifeEvents[3]).toMatchObject({
        actor: boris.id,
        objectId: copy.record.id,
        after: { copiedFrom: life.id, ownerId: boris.id },
      });
      expect(lifeEvents[2]?.after).toMatchObject({ roleIds: [sre.id] });
      expect(lifeEvents[4]?.after).toMatchObject({ roleIds: [] });
      for (const event of lifeEvents) {
        const written = JSON.stringify([event.before, event.after]);
        expect(written, event.kind).not.toContain(promptPhrase);
        expect(written, event.kind).not.toContain(descriptionPhrase);
        expect(event.after ?? event.before, event.kind).toEqual(
          expect.objectContaining({
            ownerId: expect.any(String),
            version: expect.any(Number),
            name: expect.any(String),
            roleIds: expect.any(Array),
          }),
        );
      }
    },
    TEST_TIMEOUT_MS,
  );
});
