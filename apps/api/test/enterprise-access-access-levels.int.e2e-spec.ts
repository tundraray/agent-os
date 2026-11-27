// enterprise-access / access-levels - API integration (real AppModule + real Postgres + MCP fixture process)
// Design Doc: docs/features/enterprise-access/design-access-levels.md, Test Strategy UC-4 (a switched-off tool is not called), UC-5 (the
//   base access of «Все сотрудники»), UC-6 (save and isolation) and UC-7 (built-in roles and the copy); PRD AC-36.1, AC-36.5, AC-37.2,
//   AC-37.5, AC-37.6, AC-37.8, AC-38.1, AC-38.2, AC-39.2, AC-40.3, DC-1, DC-2.
// Test Type: Integration. Not run locally: CI runs it.
//
// Harness: one `createTestApp({ workers: true, mcpServers: ['logs', 'backoffice', 'tracker'] })` — the fixture process registered under
//   the run's names, so three servers with lists, and its journal proves what reached a server; `seedSuperAdmin` is the administrator,
//   employees come from `POST /api/admin/users`, roles from `POST /api/admin/roles`. Every role and employee is the file's own (run-named
//   roles), so rows of the developer never meet the assertions; `afterAll` deletes them (their grants and memberships go by cascade) with
//   their audit rows. The one shared row a case changes is «Все сотрудники»: UC-5 gives it a level on the run's `backoffice` only and sets
//   it back to `none`. Responses are parsed with `@agent-os/contracts` schemas. Mock boundary: the model only (the scripted chat model on
//   the run's model; the built-in records point at it).
//
// Proven elsewhere, not repeated here: the derivation rows -> level and back (UC-1, `apps/api/src/access/levels.spec.ts`), the coverage
//   rule (UC-2, `packages/contracts/src/access-levels.spec.ts`).

import { randomUUID } from 'node:crypto';
import type {
  RecordedModelCall,
  ScriptedToolCall,
} from '@agent-os/agents/testing';
import {
  AGENTS_TOOL_CONFIRMATION,
  AdminUserDetailSchema,
  GrantSchema,
  McpToolViewSchema,
  RoleDetailSchema,
  RoleLevelsSchema,
  RoleListSchema,
  RoleSummarySchema,
  ServerAccessSchema,
  UserLevelsSchema,
  type ConversationView,
  type RoleLevels,
  type RoleSummary,
} from '@agent-os/contracts';
import { waitFor } from '@agent-os/db/testing';
import { readFixtureLog } from '@agent-os/mcp-fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  auditOf,
  grantTo,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  useRunModels,
} from './support/access';
import { chatApi, expectBody, expectError } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import { pointBuiltinsAt } from './support/library';
import { BACKOFFICE_SERVER, LOGS_SERVER, runName } from './support/mcp-servers';
import {
  apiRequest,
  createEmployee,
  type Method,
  seedSuperAdmin,
  type Session,
} from './support/session';

const TEST_TIMEOUT_MS = 120_000;
const TRACKER_SERVER = runName('tracker');
const MODEL = runModel('levels');
const mcpTool = (server: string, tool: string) => `mcp__${server}__${tool}`;
const GET_TRACE = mcpTool(LOGS_SERVER, 'get_trace');
const GET_ORDER = mcpTool(BACKOFFICE_SERVER, 'get_order');
const CREATE_NOTE = mcpTool(BACKOFFICE_SERVER, 'create_incident_note');

let harness: TestApp;
let admin: Session;
let restoreModels: (() => Promise<void>) | undefined;
let restoreBuiltins: (() => Promise<void>) | undefined;
const roleIds: string[] = [];
const userIds: string[] = [];

/** A run-named role through `POST /api/admin/roles`, optionally a copy; removed in `afterAll`. */
async function createRole(
  name: string,
  copyFrom?: string,
): Promise<RoleSummary> {
  const role = await expectBody(
    apiRequest(harness.app, admin, 'post', '/admin/roles', {
      name: runName(`${name}-${randomUUID().slice(0, 8)}`),
      ...(copyFrom === undefined ? {} : { copyFrom }),
    }),
    201,
    RoleSummarySchema,
  );
  roleIds.push(role.id);
  return role;
}

/** An employee of the run, signed in; removed in `afterAll`. */
async function employee(name: string): Promise<Session> {
  const session = await createEmployee(harness.app, admin, { name });
  userIds.push(session.id);
  return session;
}

function roleLevels(roleId: string): Promise<RoleLevels> {
  return expectBody(
    apiRequest(harness.app, admin, 'get', `/admin/roles/${roleId}/levels`),
    200,
    RoleLevelsSchema,
  );
}

/** The run's three servers of a level response, as `server -> [level, picked]`. */
function levelsOf(levels: RoleLevels): Record<string, [string, string[]]> {
  const run = new Set([LOGS_SERVER, BACKOFFICE_SERVER, TRACKER_SERVER]);
  return Object.fromEntries(
    levels.servers
      .filter((row) => run.has(row.server))
      .map((row) => [row.server, [row.level, [...row.picked].sort()]]),
  );
}

/**
 * The `admin_change` records of a level of the holder: those whose `after` names a server, sorted by server name
 * (one save writes its records in one transaction, so their `at` is the same).
 */
async function levelAudit(
  objectId: string,
): Promise<{ server: string; before: string; after: string }[]> {
  const { rows } = await harness.pool.query<{
    server: string;
    before: string;
    after: string;
  }>(
    `SELECT after->>'server' AS server, before->>'level' AS before, after->>'level' AS after
       FROM app.audit_events
      WHERE kind = 'admin_change' AND object_id = $1 AND after ? 'server'`,
    [objectId],
  );
  return rows.sort((a, b) => a.server.localeCompare(b.server));
}

/** The employee may chat on the run's model by a personal grant, and holds nothing else of his own. */
async function chatter(session: Session): Promise<Session> {
  await grantTo(
    harness.app,
    admin,
    { userId: session.id },
    { effect: 'allow', target: { kind: 'model', model: MODEL } },
  );
  return session;
}

/** The tools of `server` a model call was offered, sorted. */
function offeredOf(
  call: RecordedModelCall | undefined,
  server: string,
): string[] {
  return (call?.toolNames ?? [])
    .filter((name) => name.startsWith(`mcp__${server}__`))
    .sort();
}

/** `<outcome> <refusal reason>` of every result of `tool` in the history, in order. */
function resultsOf(view: ConversationView, tool: string): string[] {
  return view.entries.flatMap((entry) =>
    entry.kind === 'tool_result' && entry.content.tool === tool
      ? [`${entry.content.outcome} ${entry.content.refusalReason}`]
      : [],
  );
}

/** The calls of `tool` that reached the fixture servers. */
function callsReached(tool: string): number {
  return readFixtureLog(harness.fixtureLog.callLog).filter(
    (entry) => entry.tool === tool,
  ).length;
}

/**
 * Sends `task` in the employee's conversation (a new one without `threadId`) under a scripted turn: the model asks
 * each of `calls` in turn, then answers. Returns the conversation, the turn's model calls and the history once the
 * chat is free.
 */
async function turn(
  session: Session,
  task: string,
  calls: readonly ScriptedToolCall[],
  threadId?: string,
): Promise<{
  threadId: string;
  modelCalls: readonly RecordedModelCall[];
  view: ConversationView;
}> {
  const answer = `${task}: done`;
  const script = harness.model.script({ task }, [
    ...calls.map((call) => ({ calls: [call] })),
    { text: answer },
  ]);
  const api = chatApi(harness.app, session);
  const id = threadId ?? (await api.createThread()).id;
  await api.send(id, task);
  await script.called(calls.length + 1);
  const view = await waitFor(
    () => api.history(id),
    (history) =>
      history.chat.status === 'idle' &&
      history.pending.length === 0 &&
      history.entries.some(
        (entry) =>
          entry.kind === 'model_answer' && entry.content.text === answer,
      ),
    `the turn "${task}"`,
  );
  return { threadId: id, modelCalls: script.calls, view };
}

/** Switches one tool of the server on or off or corrects its class: `PATCH /api/admin/mcp-servers/:name/tools/:tool`, 200. */
function patchTool(
  server: string,
  tool: string,
  body: { enabled?: boolean; readOnly?: boolean | null },
) {
  return expectBody(
    apiRequest(
      harness.app,
      admin,
      'patch',
      `/admin/mcp-servers/${server}/tools/${tool}`,
      body,
    ),
    200,
    McpToolViewSchema,
  );
}

async function builtinRole(kind: 'super_admin' | 'everyone') {
  const roles = await expectBody(
    apiRequest(harness.app, admin, 'get', '/admin/roles'),
    200,
    RoleListSchema,
  );
  const role = roles.find((listed) => listed.builtinKind === kind);
  if (role === undefined) throw new Error(`no built-in role ${kind}`);
  return role;
}

describe('enterprise-access / access-levels - integration', () => {
  beforeAll(async () => {
    harness = await createTestApp({
      workers: true,
      mcpServers: ['logs', 'backoffice', 'tracker'],
    });
    harness.model.completeText({ text: 'Levels title' });
    admin = await seedSuperAdmin(harness.app, `e2e-admin-${randomUUID()}`);
    userIds.push(admin.id);
    restoreModels = await useRunModels(harness.app, admin, {
      chat: { id: MODEL, ...HAIKU_TEST_PRICES },
    });
    restoreBuiltins = await pointBuiltinsAt(harness.app, admin, MODEL);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await restoreBuiltins?.();
      await restoreModels?.();
    } finally {
      if (harness !== undefined) {
        await harness.pool.query(
          'DELETE FROM app.audit_events WHERE object_id = ANY($1::text[])',
          [roleIds],
        );
        await removeRunRows(harness.pool, {
          models: [MODEL],
          roles: roleIds,
          users: userIds,
        });
      }
      await harness?.close();
    }
  }, TEST_TIMEOUT_MS);

  // UC-4 — catches: `tool_disabled` checked after the coverage rule (so «Все» or the super-administrator pass it), a switched-off
  //   tool's call reaching the server, or its refusal audited zero or two times.
  it(
    'UC-4: a switched-off tool is refused for an employee with «Все» and for the super-administrator, and the server is not called',
    async () => {
      const app = harness.app;
      const anya = await chatter(await employee('Аня'));
      await expectBody(
        apiRequest(app, admin, 'put', `/admin/users/${anya.id}/levels`, {
          servers: [{ server: LOGS_SERVER, level: 'all' }],
        }),
        200,
        UserLevelsSchema,
      );
      const igor = await seedSuperAdmin(app, `e2e-igor-${randomUUID()}`);
      userIds.push(igor.id);
      await chatter(igor);
      expect(
        (await patchTool(LOGS_SERVER, 'get_trace', { enabled: false })).enabled,
      ).toBe(false);

      try {
        const traceCall = {
          tool: GET_TRACE,
          args: { traceId: 'd4'.repeat(16) },
        };
        for (const [session, who] of [
          [anya, 'Аня'],
          [igor, 'Игорь'],
        ] as const) {
          const { modelCalls, view } = await turn(
            session,
            `UC-4: ${who} reads the trace`,
            [traceCall],
          );
          // Not offered (AC-36.2); the call the model still asks is refused `tool_disabled` as its result (AC-36.1, DC-1)
          expect(offeredOf(modelCalls[0], LOGS_SERVER)).not.toContain(
            GET_TRACE,
          );
          expect(resultsOf(view, GET_TRACE), who).toEqual([
            'refused tool_disabled',
          ]);
        }
        expect(callsReached('get_trace')).toBe(0);
        const audit = await auditOf(harness.pool, {
          kind: 'access_denied',
          objectType: 'tool',
          actors: [anya.id, igor.id],
        });
        expect(
          audit
            .map((row) => `${row.actor} ${row.objectId} ${row.reason}`)
            .sort(),
        ).toEqual(
          [anya.id, igor.id]
            .map((actor) => `${actor} ${LOGS_SERVER}/get_trace tool_disabled`)
            .sort(),
        );
      } finally {
        await patchTool(LOGS_SERVER, 'get_trace', { enabled: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  // UC-5 — catches: «Все сотрудники» left out of an employee's roles on the call path; `read` giving a changing tool; the
  //   administrator's class correction not reaching the set and the confirmation decision, or not audited.
  it(
    'UC-5: «Все сотрудники» gives a newcomer its level, and a tool corrected to «читает» runs without confirmation',
    async () => {
      const app = harness.app;
      const everyone = await builtinRole('everyone');
      const newcomer = await chatter(await employee('Новичок'));
      const saveEveryone = (level: 'read' | 'none') =>
        expectBody(
          apiRequest(app, admin, 'put', `/admin/roles/${everyone.id}/levels`, {
            servers: [{ server: BACKOFFICE_SERVER, level }],
          }),
          200,
          RoleLevelsSchema,
        );
      const noteCall = {
        tool: CREATE_NOTE,
        args: { orderId: 'ord-0000e005', text: 'UC-5 note' },
      };
      await saveEveryone('read');
      try {
        // No roles of his own: the read tool runs, the changing one is `no_access` and reaches no server (AC-38.1, AC-37.2)
        const first = await turn(
          newcomer,
          'UC-5: read the order, write a note',
          [{ tool: GET_ORDER, args: { orderId: 'ord-0000e005' } }, noteCall],
        );
        const firstSet = offeredOf(first.modelCalls[0], BACKOFFICE_SERVER);
        expect(firstSet).toContain(GET_ORDER);
        expect(firstSet).not.toContain(CREATE_NOTE);
        expect(resultsOf(first.view, 'get_order')).toEqual(['success null']);
        expect(resultsOf(first.view, CREATE_NOTE)).toEqual([
          'refused no_access',
        ]);
        expect(callsReached('create_incident_note')).toBe(0);

        // The administrator corrects the class to «читает», audited with the class before and after (AC-36.5)
        expect(
          await patchTool(BACKOFFICE_SERVER, 'create_incident_note', {
            readOnly: true,
          }),
        ).toMatchObject({ readOnly: true, overridden: true });
        const { rows } = await harness.pool.query<{
          before: unknown;
          after: unknown;
        }>(
          `SELECT before, after FROM app.audit_events
            WHERE kind = 'admin_change' AND object_type = 'mcp_tool' AND object_id = $1 AND actor = $2`,
          [`${BACKOFFICE_SERVER}/create_incident_note`, admin.id],
        );
        expect(rows).toEqual([
          {
            before: { enabled: true, readOnly: false, serverReadOnly: null },
            after: { enabled: true, readOnly: true, serverReadOnly: null },
          },
        ]);

        // The next turn is offered the tool and runs it without a confirmation
        const second = await turn(
          newcomer,
          'UC-5: write the note again',
          [noteCall],
          first.threadId,
        );
        expect(offeredOf(second.modelCalls[0], BACKOFFICE_SERVER)).toContain(
          CREATE_NOTE,
        );
        expect(resultsOf(second.view, 'create_incident_note')).toEqual([
          'success null',
        ]);
        expect(
          second.view.decisions.filter(
            (decision) => decision.kind === AGENTS_TOOL_CONFIRMATION,
          ),
        ).toEqual([]);
        expect(callsReached('create_incident_note')).toBe(1);
      } finally {
        await saveEveryone('none');
        await patchTool(BACKOFFICE_SERVER, 'create_incident_note', {
          readOnly: null,
        });
      }
    },
    TEST_TIMEOUT_MS,
  );

  // UC-6 — catches: a level route open without the admin right; a 422 that leaves changed rows; audit written per row
  //   instead of per level; a server-page save that does not reach the role; a personal save that touches another employee.
  it(
    'UC-6: saves levels in one transaction, audits each level and keeps holders apart',
    async () => {
      const app = harness.app;
      const role = await createRole('sre');
      const plain = await employee('Без права');
      const someId = randomUUID();

      // 403 on every new route without the admin right (AC-37.5 boundary, Security «каждый новый маршрут»).
      const routes: [Method, string, object?][] = [
        ['get', `/admin/roles/${someId}/levels`],
        ['put', `/admin/roles/${someId}/levels`, { servers: [] }],
        ['get', `/admin/users/${someId}/levels`],
        ['put', `/admin/users/${someId}/levels`, { servers: [] }],
        ['get', `/admin/mcp-servers/${LOGS_SERVER}/access`],
        ['put', `/admin/mcp-servers/${LOGS_SERVER}/access`, { roles: [] }],
      ];
      for (const [method, path, body] of routes) {
        const refused = await expectError(
          apiRequest(app, plain, method, path, body),
          403,
        );
        expect(refused.errorCode, `${method} ${path}`).toBe('ADMIN_REQUIRED');
      }

      // Three levels, one on an unknown server: 422 and not one row changed (AC-37.5, DC-2).
      const invalid = await expectError(
        apiRequest(app, admin, 'put', `/admin/roles/${role.id}/levels`, {
          servers: [
            { server: LOGS_SERVER, level: 'read' },
            { server: TRACKER_SERVER, level: 'all' },
            { server: runName('missing'), level: 'all' },
          ],
        }),
        422,
      );
      expect(invalid).toMatchObject({
        errorCode: 'LEVELS_INVALID',
        reason: 'server_unknown',
      });
      expect(levelsOf(await roleLevels(role.id))).toEqual({
        [LOGS_SERVER]: ['none', []],
        [BACKOFFICE_SERVER]: ['none', []],
        [TRACKER_SERVER]: ['none', []],
      });
      expect(await levelAudit(role.id)).toEqual([]);

      // Three valid levels: saved, and one audit record per level with the level before and after (AC-37.6).
      const saved = await expectBody(
        apiRequest(app, admin, 'put', `/admin/roles/${role.id}/levels`, {
          servers: [
            { server: LOGS_SERVER, level: 'read' },
            {
              server: BACKOFFICE_SERVER,
              level: 'pick',
              picked: ['get_order', 'search_orders'],
            },
            { server: TRACKER_SERVER, level: 'all' },
          ],
        }),
        200,
        RoleLevelsSchema,
      );
      expect(levelsOf(saved)).toEqual({
        [LOGS_SERVER]: ['read', []],
        [BACKOFFICE_SERVER]: ['pick', ['get_order', 'search_orders']],
        [TRACKER_SERVER]: ['all', []],
      });
      // In the helper's order, by server name: backoffice, logs, tracker
      expect(await levelAudit(role.id)).toEqual([
        { server: BACKOFFICE_SERVER, before: 'none', after: 'pick' },
        { server: LOGS_SERVER, before: 'none', after: 'read' },
        { server: TRACKER_SERVER, before: 'none', after: 'all' },
      ]);

      // From the server page: two roles get «Только чтение»; each role's page shows it, one record per role (AC-39.2).
      const onCall = await createRole('on-call');
      const access = await expectBody(
        apiRequest(
          app,
          admin,
          'put',
          `/admin/mcp-servers/${BACKOFFICE_SERVER}/access`,
          {
            roles: [
              { roleId: role.id, level: 'read' },
              { roleId: onCall.id, level: 'read' },
            ],
          },
        ),
        200,
        ServerAccessSchema,
      );
      expect(
        access.roles
          .filter((row) => row.id === role.id || row.id === onCall.id)
          .map((row) => row.level),
      ).toEqual(['read', 'read']);
      for (const held of [role, onCall]) {
        expect(levelsOf(await roleLevels(held.id))[BACKOFFICE_SERVER]).toEqual([
          'read',
          [],
        ]);
        expect(
          (await levelAudit(held.id)).filter(
            (entry) => entry.server === BACKOFFICE_SERVER,
          ).length,
        ).toBe(held === role ? 2 : 1);
      }

      // A personal level of Аня leaves Борис's personal level as it was (AC-40.3).
      const anya = await employee('Аня');
      const boris = await employee('Борис');
      await expectBody(
        apiRequest(app, admin, 'put', `/admin/users/${boris.id}/levels`, {
          servers: [{ server: LOGS_SERVER, level: 'denied' }],
        }),
        200,
        UserLevelsSchema,
      );
      await expectBody(
        apiRequest(app, admin, 'put', `/admin/users/${anya.id}/levels`, {
          servers: [
            {
              server: LOGS_SERVER,
              level: 'pick',
              marks: [{ tool: 'search_logs', effect: 'allow' }],
            },
          ],
        }),
        200,
        UserLevelsSchema,
      );
      const borisLevels = await expectBody(
        apiRequest(app, admin, 'get', `/admin/users/${boris.id}/levels`),
        200,
        UserLevelsSchema,
      );
      expect(
        borisLevels.servers.find((row) => row.server === LOGS_SERVER)?.personal,
      ).toEqual({ level: 'denied', marks: [] });
    },
    TEST_TIMEOUT_MS,
  );

  // UC-7 — catches: «Все сотрудники» assignable, renamable, deletable or given the admin right past the panel; a copy that
  //   loses levels or model quotas, or carries the template's employees or admin right; a copy of «Супер-администратор».
  it(
    'UC-7: protects «Все сотрудники» and copies a role without its people and rights',
    async () => {
      const app = harness.app;
      const everyone = await builtinRole('everyone');
      const superAdmin = await builtinRole('super_admin');
      const member = await employee('Сотрудник');
      expect(everyone.memberCount).toBeNull();

      // Every change of «Все сотрудники» the panel hides is refused by the server too (AC-38.2).
      const refusals: [Method, string, object?][] = [
        ['put', `/admin/users/${member.id}/roles/${everyone.id}`],
        ['delete', `/admin/users/${member.id}/roles/${everyone.id}`],
        ['patch', `/admin/roles/${everyone.id}`, { name: runName('renamed') }],
        ['patch', `/admin/roles/${everyone.id}`, { isAdmin: true }],
        ['delete', `/admin/roles/${everyone.id}`],
      ];
      for (const [method, path, body] of refusals) {
        const refused = await expectError(
          apiRequest(app, admin, method, path, body),
          409,
        );
        expect(refused.errorCode, `${method} ${path}`).toBe('BUILTIN_ROLE');
      }

      // «SRE» with levels, a model with a quota, an employee and the admin right.
      const sre = await createRole('sre');
      await expectBody(
        apiRequest(app, admin, 'put', `/admin/roles/${sre.id}/levels`, {
          servers: [
            { server: LOGS_SERVER, level: 'all' },
            {
              server: BACKOFFICE_SERVER,
              level: 'pick',
              picked: ['search_orders'],
            },
          ],
        }),
        200,
        RoleLevelsSchema,
      );
      await grantTo(
        app,
        admin,
        { roleId: sre.id },
        {
          effect: 'allow',
          target: { kind: 'model', model: MODEL },
          quotaUsd: 50,
        },
      );
      await expectBody(
        apiRequest(
          app,
          admin,
          'put',
          `/admin/users/${member.id}/roles/${sre.id}`,
        ),
        200,
        AdminUserDetailSchema,
      );
      await expectBody(
        apiRequest(app, admin, 'patch', `/admin/roles/${sre.id}`, {
          isAdmin: true,
        }),
        200,
        RoleDetailSchema,
      );

      // The copy has the same levels and model grant with its quota, and no employees or admin right (AC-37.8).
      const copy = await createRole('sre-intern', sre.id);
      expect(copy).toMatchObject({ isAdmin: false, memberCount: 0 });
      expect(levelsOf(await roleLevels(copy.id))).toEqual(
        levelsOf(await roleLevels(sre.id)),
      );
      expect(levelsOf(await roleLevels(copy.id))[LOGS_SERVER]).toEqual([
        'all',
        [],
      ]);
      const copyGrants = await expectBody(
        apiRequest(app, admin, 'get', `/admin/grants?roleId=${copy.id}`),
        200,
        z.array(GrantSchema),
      );
      // Only the model grant: `/api/admin/grants` lists none of the copy's level rows (access-levels KD-6)
      expect(copyGrants.map((grant) => [grant.effect, grant.quotaUsd])).toEqual(
        [['allow', 50]],
      );

      // A copy of «Супер-администратор» is refused and makes no role.
      const refusedName = runName(`super-copy-${randomUUID().slice(0, 8)}`);
      const refusedCopy = await expectError(
        apiRequest(app, admin, 'post', '/admin/roles', {
          name: refusedName,
          copyFrom: superAdmin.id,
        }),
        409,
      );
      expect(refusedCopy.errorCode).toBe('BUILTIN_ROLE');
      const rolesAfter = await expectBody(
        apiRequest(app, admin, 'get', '/admin/roles'),
        200,
        RoleListSchema,
      );
      expect(rolesAfter.map((listed) => listed.name)).not.toContain(
        refusedName,
      );
    },
    TEST_TIMEOUT_MS,
  );
});
