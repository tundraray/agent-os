// enterprise-access / access - API integration skeletons (real AppModule + real Postgres + MCP fixture process, workers on, scripted model)
// Design Doc: docs/features/enterprise-access/design-access.md (v1.6, Approved), Test Strategy UC-1 (= INT-1), UC-2 (= INT-2 and INT-3), UC-3 (proven
//   by identity INT-2, see below), plus the one `GRANT_TARGET_UNKNOWN` / `GRANT_EXISTS` step of UC-7 that needs the registry and the database;
//   PRD: docs/features/enterprise-access/prd.md (v2.4) FR-16..FR-23 (AC-16.1, AC-16.2, AC-16.3, AC-17.1, AC-17.2, AC-17.3, AC-18.1..18.4,
//   AC-19.1..19.3, AC-20.1..20.4, AC-21.1, AC-21.3, AC-22.1, AC-22.2, AC-22.3, AC-22.7, AC-22.11, AC-23.1).
// Budget Used: 3/3 integration skeletons for the part (INT-1, INT-2, INT-3), all in this file. 0 E2E: the Test Strategy names none. 0 web
//   skeletons: the part's screens (the «Модели и расход» section, the refusal and failure texts) are a unit table (UC-8), not an integration test.
// Test Type: Integration.
//
// Harness (follows apps/api/test/support/*, enterprise-access-identity.int.e2e-spec.ts and enterprise-access-mcp-connect.int.e2e-spec.ts): one
//   `createTestApp({ workers: true, captureLog: true, mcpServers: [] })` against the docker-compose Postgres, the real AppModule with
//   the real SessionGuard and the real `AccessService` behind `AccessGate`. Employees are written by `insertEmployee` and sign in with
//   `signInWithPassword`; the administrator is `seedSuperAdmin`; roles and their members go through `POST /api/admin/roles` and
//   `PUT /api/admin/users/:id/roles/:roleId` of `identity`. Only `AGENT_TURN_CLIENT` is the scripted model (it records, per request, the tool names
//   it was offered, and counts calls; the token counts of every scripted call are chosen by the test, so spend is known to the cent). MCP is the
//   `packages/mcp-fixture` PROCESS over HTTP, registered by the test through the `mcp-connect` admin operations under the run's names
//   (`runName`; shared-token servers `logs` and `tracker`, and `backoffice` with the mutating tool `create_incident_note`); its journal is the
//   proof that a server received nothing. The catalogue, rights and quotas are made ONLY through the admin operations of this design
//   (`POST /api/admin/models`, `POST /api/admin/grants`, `PATCH /api/admin/grants/:id`), so those routes are part of every setup. Time is never faked.
//   Models are named by the run (`runModel('a')`, a form `run-t<runId>/<name>` under the run's provider), never the developer's real catalogue
//   rows, and the platform's default chat model is one of them while the file runs (`useRunModels`, restored in `afterAll`). Every case uses its own employees, roles and models, so rows of one case never meet another's; a case deletes
//   what it made in `afterAll` (users, roles, models - rights go with them by cascade - and the run's servers) and writes no setting that outlives
//   the file. Responses are parsed with `@agent-os/contracts` schemas.
//   Support the implementation tasks add (not skeletons):
//   - `test/support/access.ts`: `runModel(base)`; `addModel(admin, { id, prices })`, `grantTo(admin, holder, { effect, target, quotaUsd? })` and
//     `removeRunRows(pool, ...)` over the admin routes and the pool; `spendOf(pool, ownerId, model)` that reads `runtime_model_calls` for the cost
//     assertions; `auditOf(pool, { kind, objectType, ... })` that reads `access_denied` rows by object type (the kind is shared with the
//     administrator-route refusals of identity, so rows of tools and models are filtered by `objectType`).
//   - `createTestApp`: the `mcpAccess` option, `MCP_ACCESS_TABLE` and the price file are deleted.
//   - A test deep agent record of the employee whose subagent names the `backoffice` server and runs a model script and a `run_code` script,
//     started by `start_deep_agent` of the employee's chat (INT-1 step 4).
//   - Agent records on a given model (system records the administrator shows to one employee), which the chat starts by id: the model of a
//     start is the record's (INT-2, INT-3). The built-in records run on `A` (`pointBuiltinsAt`).
//   - A latch around a scripted model call (the scripted model's `hold`/latch of the existing chat suite) so two calls stay in flight (INT-3).
// Mock boundary: the model only. Do NOT mock the database, `AccessService`, `effectiveAccess`, `IdentityDirectory`, the fixture process, `TokenLedger`.
//
// Proven elsewhere, not repeated here:
//   - `owner_disabled` (UC-3, DC-3, AC-07.2): identity INT-2 row 5 (apps/api/test/enterprise-access-identity.int.e2e-spec.ts) - the blocked
//       employee's agent ends `failed` with `owner_disabled` at its next model or tool call, and no call is made after the block. It passes through
//       the real application, so after this part it runs through `AccessService`; that file is ADAPTED by the implementation task (its
//       `IdentityOwnerGate` check of an unknown owner becomes `AccessGate.tools(unknownOwner)` answering `owner_disabled`; the assertions stay).
//       The inside of a `run_code` script for a refused owner is mcp-connect INT-2 row 6 (adapted the same way: its `ownerGate` double becomes an
//       `AccessGate` double). The verdict ORDER (disabled employee first) is the unit table of UC-5.
//   - `no_access` for an employee with NO right on a server, at every door: mcp-connect INT-1 row 6 and agent-platform-agents INT-3 A (adapted to
//       the gate double). INT-1 here starts from tool-level rows - a personal deny, a personal right on one tool, a removal at run time, a workflow.
//   - NFR-03 for this part's routes (`/api/admin/...`, `GET /api/access/models`): the route walk of identity INT-1 takes the new routes from the
//       router (no session -> 401). An employee without the admin right on this part's admin routes is step 1 of INT-1 here.
//   - The cost of a conversation title entering spend: agent-platform-chat INT-3 B (adapted: its employee gets a right to the default model
//       through `grantTo`). Spend endpoint `GET /spend`: agent-platform-chat INT-2 E (adapted: the model's price comes from `addModel`).
//
// `provenAt: unit` (tables next to the code, not skeletons - a rule never gets a second proof here):
//   - UC-4 `apps/api/src/access/effective-access.spec.ts`, one table over `effectiveAccess`: AC-16.1, AC-16.2, AC-17.1, AC-17.2, AC-17.3, AC-21.1
//       (quotas 50 + 20 + personal 30 = 100), AC-21.2, AC-21.5 (one grant without a quota removes the limit, also when added later), DC-1 (a tool
//       absent from the registry list gives nothing).
//   - UC-5 `apps/api/src/access/model-verdict.spec.ts`, the verdict order table: AC-16.3 (`no_models_allowed`), AC-20.2, AC-21.4 (prior-month spend
//       does not count), `owner_disabled` -> `model_not_connected` -> `model_not_allowed` / `no_models_allowed` -> `quota_exhausted` -> `allowed`
//       with the catalogue price; spend equal to the quota is exhausted, one cent below is not.
//   - UC-6 `model-client.spec.ts`: DC-7 (the title's `completeText` makes no call and calls the hook once on a refusal), verdict `allowed` passes
//       the price to `TokenLedger.record`, provider retries do not ask again.
//   - UC-7 `grant-rules.spec.ts`: the `GRANT_INVALID` rows (a deny for a role; a quota on a server or tool right; a quota outside 0,01..1 000 000
//       or with sub-cent digits). The `GRANT_TARGET_UNKNOWN` and `GRANT_EXISTS` rows need the registry, the catalogue and the unique index, so
//       they are one step of INT-1.
//   - UC-8 web tables next to the code: reason -> text (MC-10, MC-11, MC-14), `MyModels` row -> cell texts (MA-02): AC-20.2, AC-22.1, AC-23.1 as text.
//   - `packages/agents/src/model/model-choice.spec.ts` (no prices, the `unknown_model` rows deleted), `tool-gate.spec.ts` (the refusal reason
//       becomes `model_not_connected` / `model_not_allowed`), `packages/runtime` `monthOf` and `monthSpendByModel` tables; `model-cost.spec.ts`
//       loses the `parseModelPrices` rows, `callCostUsd` rows stay.
//
// Not automated: NFR-04 (the cost of the check) - UC-N1 is an on-demand measuring script, outside the suite (a slow machine must not turn the
//   suite red); `seed:access` on a clean development database - a developer tool, run by hand as `seed:mcp` is (mcp-connect AC-15.1).

import { randomUUID } from 'node:crypto';
import {
  createLatch,
  type RecordedModelCall,
  type ScriptedToolCall,
  type TextScript,
} from '@agent-os/agents/testing';
import {
  AGENTS_BRIEF_CONFIRMATION,
  AGENTS_TOOL_CONFIRMATION,
  CreateCatalogModelBodySchema,
  GrantSchema,
  MyModelsSchema,
  StartRefusedErrorSchema,
  type AgentNode,
  type ConversationView,
  type CreateRecordBody,
  type Grant,
  type GrantTargetBody,
  type HistoryEntry,
  type MyModel,
} from '@agent-os/contracts';
import { createDatabase, type DatabaseConnection } from '@agent-os/db';
import { readFixtureLog } from '@agent-os/mcp-fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  addModel,
  allowRole,
  auditOf,
  grantTo,
  removeRunRows,
  revokeFrom,
  runModel,
  spendOf,
  type McpTestTarget,
  type ModelPrices,
  type RunRole,
  useRunModels,
} from './support/access';
import { type ChatApi, chatApi, expectBody, expectError } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import {
  agentBody,
  BUILTIN,
  createRecord,
  createSystemRecord,
  pointBuiltinsAt,
  recordName,
  setSystemAudience,
} from './support/library';
import { BACKOFFICE_SERVER, LOGS_SERVER, runName } from './support/mcp-servers';
import { databaseUrl, waitFor } from '@agent-os/db/testing';
import {
  apiRequest,
  insertEmployee,
  type Method,
  seedSuperAdmin,
  signInWithPassword,
  type Session,
} from './support/session';

/** Bound of one case; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 180_000;
const PASSWORD = 'e2e-password-12';

/** The model of the file's built-in records (`pointBuiltinsAt`): every chat runs on it. 1 USD input and 5 USD output per million tokens. */
const MODEL_A = runModel('a');
const PRICES_1_5: ModelPrices = {
  prices: {
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
    cacheWriteUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
  },
};
const PRICES_2_10: ModelPrices = {
  prices: {
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 10,
    cacheWriteUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
  },
};
const PRICES_3_15: ModelPrices = {
  prices: {
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    cacheWriteUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
  },
};
/**
 * Usage of a helper call (titles, starting a background agent) that costs next to nothing: one input token. Zero input
 * tokens would be an answer without a count, which the model client records as an estimate of the whole request (DC-11).
 */
const ZERO_TOKENS = { inputTokens: 1, outputTokens: 0 } as const;
/** The most a helper call costs at 1 / 5 USD per million: a call above it is a paid one. */
const HELPER_CALL_USD = 0.00001;
/** 1000 input and 100 output tokens: 0,0015 USD at 1 / 5, 0,003 USD at 2 / 10. */
const SMALL_CALL = { inputTokens: 1_000, outputTokens: 100 } as const;
/** The call INT-3 holds in flight: 10 000 input and 1 000 output tokens = 0,015 USD at 1 / 5. */
const HELD_CALL = { inputTokens: 10_000, outputTokens: 1_000 } as const;
/** The title every conversation gets (the text script of `beforeAll`); a model call of the employee at zero tokens. */
const TITLE = 'Access title';

/** The run's servers (registered by `createTestApp` at the fixture's shared-token paths). */
const TRACKER_SERVER = runName('tracker');
const mcpTool = (server: string, tool: string) => `mcp__${server}__${tool}`;
const CREATE_NOTE = mcpTool(BACKOFFICE_SERVER, 'create_incident_note');
const GET_ORDER = mcpTool(BACKOFFICE_SERVER, 'get_order');
const SEARCH_ORDERS = mcpTool(BACKOFFICE_SERVER, 'search_orders');
const AGGREGATE_LOGS = mcpTool(LOGS_SERVER, 'aggregate_logs');
const GET_TRACE = mcpTool(LOGS_SERVER, 'get_trace');
const SEARCH_LOGS = mcpTool(LOGS_SERVER, 'search_logs');
const SEARCH_TICKETS = mcpTool(TRACKER_SERVER, 'search_tickets');
const RUN_CODE = 'run_code';

/** The one subagent of the INT-1 deep agent, which the deep agent gives work to by name with `task`. */
const ACCESS_SUBAGENT = 'access-subagent';

/**
 * The INT-1 deep agent record: the deep agent on `A` without servers and one subagent on `A` that names the run's
 * `backoffice`. Every session has `run_code` without naming it, and a record never holds it.
 */
function accessCheckDeepAgent(): Extract<
  CreateRecordBody,
  { kind: 'deep_agent' }
> {
  return {
    kind: 'deep_agent',
    name: recordName('access-check'),
    description:
      'Test deep agent of the access integration tests: one subagent that writes an incident note.',
    content: {
      prompt: `Give the work to the subagent ${ACCESS_SUBAGENT} with task.`,
      servers: [],
      model: MODEL_A,
      maxTurns: 6,
      subagents: [
        {
          name: ACCESS_SUBAGENT,
          description: 'Writes the incident note of the access check.',
          prompt:
            'You write the incident note of the access check from your assignment.',
          servers: [BACKOFFICE_SERVER],
          model: MODEL_A,
          maxTurns: 4,
          maxRuns: 1,
          taskList: false,
        },
      ],
      finalSubagent: ACCESS_SUBAGENT,
      taskList: true,
      listDelegation: false,
      selfLearning: false,
      scripts: [],
    },
  };
}

/** The log record of a quota refusal (`ModelClient`: `access gate refused a model call`). */
const QuotaRefusalRecordSchema = z.object({
  message: z.literal('access gate refused a model call'),
  fields: z.object({
    ownerId: z.string(),
    reason: z.literal('quota_exhausted'),
    spentUsd: z.number(),
    quotaUsd: z.number(),
    month: z.string(),
  }),
});

/** A `start_agent` call of a scripted answer: the agent record named `agent` runs on its own model; by default the general agent on `A`. */
function startAgent(
  description: string,
  prompt: string,
  agent: string = BUILTIN.generalPurpose.name,
): ScriptedToolCall {
  return { tool: 'start_agent', args: { agent, description, prompt } };
}

/** A read `run_code` call whose script calls `name` and returns `<outcome> <reason>` of the refusal, or `passed`. */
function refusedFromCode(
  description: string,
  name: string,
  args: object,
): ScriptedToolCall {
  const script = [
    `try { await callTool(${JSON.stringify(name)}, ${JSON.stringify(args)}); return "passed"; }`,
    'catch (error) { return error.outcome + " " + error.reason; }',
  ].join('\n');
  return { tool: RUN_CODE, args: { description, class: 'read', script } };
}

/** The tools a model call was offered that rights decide: `run_code` and the MCP tools, sorted. */
function offered(call: RecordedModelCall | undefined): string[] {
  return (call?.toolNames ?? [])
    .filter((name) => name === RUN_CODE || name.startsWith('mcp__'))
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

/** The reports of child agents in the history. */
function reportsOf(
  view: ConversationView,
): Extract<HistoryEntry, { kind: 'child_report' }>['content'][] {
  return view.entries.flatMap((entry) =>
    entry.kind === 'child_report' ? [entry.content] : [],
  );
}

function hasAnswer(view: ConversationView, text: string): boolean {
  return view.entries.some(
    (entry) => entry.kind === 'model_answer' && entry.content.text === text,
  );
}

function agentNamed(
  nodes: readonly AgentNode[],
  description: string,
): AgentNode {
  const found = nodes.find((node) => node.description === description);
  if (found === undefined) {
    throw new Error(
      `No agent "${description}" among [${nodes.map((node) => node.description).join(', ')}]`,
    );
  }
  return found;
}

function treeOf(nodes: readonly AgentNode[]): AgentNode[] {
  return nodes.flatMap((node) => [node, ...treeOf(node.children)]);
}

/** Waits until the chat of the conversation is free (`idle`) and the view satisfies `done`. */
function untilIdle(
  api: ChatApi,
  threadId: string,
  done: (view: ConversationView) => boolean,
  what: string,
): Promise<ConversationView> {
  return waitFor(
    () => api.history(threadId),
    (view) =>
      view.chat.status === 'idle' && view.pending.length === 0 && done(view),
    what,
  );
}

/** A new conversation of the employee with its first message sent. */
async function startConversation(api: ChatApi, text: string): Promise<string> {
  const { id } = await api.createThread();
  await api.send(id, text);
  return id;
}

describe('enterprise-access / access - API integration (real AppModule + real Postgres + MCP fixture process)', () => {
  // One boot per file: two apps with workers over one database would step each other's tasks.
  let harness: TestApp;
  /** The test's own pool: the cleanup after the app is closed. */
  let database: DatabaseConnection;
  let admin: Session;
  /** The text script of every title: zero tokens, so a title costs nothing. */
  let titles: TextScript;
  /** Every row the file makes, removed in `afterAll`. */
  const made = {
    users: [] as string[],
    roles: [] as string[],
    models: [MODEL_A] as string[],
  };
  /** The system records the file makes; removed in `afterAll` (an employee's own records go with the employee). */
  const madeRecords: string[] = [];
  /** Gives the built-in records back their models; run in `afterAll` before the run's rows go. */
  let restoreBuiltins: (() => Promise<void>) | undefined;
  /** Gives the platform back its default models (`useRunModels`); run in `afterAll` before the run's rows go. */
  let restoreModels: (() => Promise<void>) | undefined;

  const adminRequest = (method: Method, path: string, body?: object) =>
    apiRequest(harness.app, admin, method, path, body);

  /** An employee written before sign-in (`insertEmployee`) and signed in with a password. */
  async function employee(name: string): Promise<Session> {
    const login = `e2e-access-${name}-${randomUUID().slice(0, 8)}`;
    made.users.push(
      await insertEmployee(harness.pool, { login, password: PASSWORD }),
    );
    return signInWithPassword(harness.app, login, PASSWORD);
  }

  /** A role of the run allowed `models` and `servers` without a quota. */
  async function runRole(
    name: string,
    models: readonly string[] = [],
    servers: readonly string[] = [],
  ): Promise<RunRole> {
    const role = await allowRole(harness.app, admin, { name, models, servers });
    made.roles.push(role.id);
    return role;
  }

  /** A catalogue model of the run, added through `POST /api/admin/models`. */
  async function catalogueModel(
    base: string,
    prices: ModelPrices,
  ): Promise<string> {
    const id = runModel(base);
    made.models.push(id);
    await addModel(harness.app, admin, { id, ...prices });
    return id;
  }

  const grant = (
    holder: { roleId: string } | { userId: string },
    effect: 'allow' | 'deny',
    target: GrantTargetBody,
    quotaUsd?: number,
  ) =>
    grantTo(harness.app, admin, holder, {
      effect,
      target,
      ...(quotaUsd === undefined ? {} : { quotaUsd }),
    });

  /** A server or tool right of `holder`, kept as an access level (access-levels KD-6). */
  const level = (
    holder: { roleId: string } | { userId: string },
    effect: 'allow' | 'deny',
    target: McpTestTarget,
  ) => grantTo(harness.app, admin, holder, { effect, target });

  async function removeGrant(id: string): Promise<void> {
    await expectBody(
      adminRequest('delete', `/admin/grants/${id}`),
      204,
      z.unknown(),
    );
  }

  async function grantsOfRole(roleId: string): Promise<Grant[]> {
    return expectBody(
      adminRequest('get', `/admin/grants?roleId=${roleId}`),
      200,
      z.array(GrantSchema),
    );
  }

  /**
   * A system agent record on `model` that only `viewer` sees, offered in the chat; returns its name. The chat starts
   * it by that name and the start runs on the record's model. Like the general agent it stands in for, it may list its agents.
   */
  async function agentOn(model: string, viewer: Session): Promise<string> {
    const name = recordName(`agent on ${model}`);
    const { id } = await createSystemRecord(
      harness.app,
      admin,
      agentBody(name, {
        model,
        tools: ['list_agents'],
      }),
    );
    madeRecords.push(id);
    await setSystemAudience(harness.app, admin, id, {
      everyone: false,
      userIds: [viewer.id],
    });
    return name;
  }

  /** `GET /api/access/models` of the employee. */
  async function myModels(session: Session): Promise<MyModel[]> {
    const page = await expectBody(
      apiRequest(harness.app, session, 'get', '/access/models'),
      200,
      MyModelsSchema,
    );
    return page.models;
  }

  /** `access_denied` records of `objectType` by the named employees as `<name> <object> <outcome> <reason>`, sorted. */
  async function deniedAudit(
    objectType: 'tool' | 'model',
    employees: Readonly<Record<string, Session>>,
  ): Promise<string[]> {
    const names = new Map(
      Object.entries(employees).map(([name, session]) => [session.id, name]),
    );
    const rows = await auditOf(harness.pool, {
      kind: 'access_denied',
      objectType,
      actors: [...names.keys()],
    });
    return rows
      .map(
        (row) =>
          `${names.get(row.actor)} ${row.objectId} ${row.outcome} ${row.reason}`,
      )
      .sort();
  }

  /** What reached the fixture servers, as `<source> <account> <tool>` in arrival order. */
  function journal(): string[] {
    return readFixtureLog(harness.fixtureLog.callLog).map(
      (entry) => `${entry.source} ${entry.account} ${entry.tool}`,
    );
  }

  /** Spend, quota and month of each `quota_exhausted` verdict the gate logged for the employee, in order. */
  function quotaRefusals(
    ownerId: string,
  ): { spentUsd: number; quotaUsd: number; month: string }[] {
    return harness.log.flatMap((line) => {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        return [];
      }
      const parsed = QuotaRefusalRecordSchema.safeParse(record);
      if (!parsed.success || parsed.data.fields.ownerId !== ownerId) return [];
      const { spentUsd, quotaUsd, month } = parsed.data.fields;
      return [{ spentUsd, quotaUsd, month }];
    });
  }

  /** Waits until the conversation's title is written: the title's model call is over. */
  async function untilTitled(api: ChatApi, threadId: string): Promise<void> {
    await waitFor(
      () => api.getThread(threadId),
      (thread) => thread.title === TITLE,
      `the title of ${threadId}`,
    );
  }

  beforeAll(async () => {
    database = createDatabase({ connectionString: databaseUrl(), poolMax: 2 });
    harness = await createTestApp({
      workers: true,
      captureLog: true,
      mcpServers: ['logs', 'backoffice', 'tracker'],
    });
    titles = harness.model.completeText({ text: TITLE, usage: ZERO_TOKENS });
    admin = await seedSuperAdmin(
      harness.app,
      `e2e-access-admin-${randomUUID().slice(0, 8)}`,
    );
    made.users.push(admin.id);
    restoreModels = await useRunModels(harness.app, admin, {
      chat: { id: MODEL_A, ...PRICES_1_5 },
    });
    restoreBuiltins = await pointBuiltinsAt(harness.app, admin, MODEL_A);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    try {
      try {
        await restoreBuiltins?.();
        await restoreModels?.();
      } finally {
        await harness?.close();
      }
    } finally {
      // The servers take their accounts; the users their sessions, memberships, personal grants, conversations,
      // agents, own records, ledger rows and audit records; the roles and models their grants. The system records
      // have no owner: they are marked deleted, as the panel deletes them (a conversation may still run on their versions).
      await database.pool.query(
        'DELETE FROM app.mcp_servers WHERE name = ANY($1)',
        [[LOGS_SERVER, BACKOFFICE_SERVER, TRACKER_SERVER]],
      );
      await database.pool.query(
        'UPDATE app.agents SET deleted_at = now() WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
        [madeRecords],
      );
      await removeRunRows(database.pool, made);
      await database.close();
    }
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: a tool is offered, called, confirmed and run from code only by the rights of that moment
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-16.1 "роль «SRE» имеет право на Sentry MCP, а Аня в этой роли и подключила аккаунт, when её агент работает, then ему доступны все
  //   инструменты Sentry"; AC-16.2 "у сотрудника нет права на сервер, но есть личное право на один его инструмент: из этого сервера ему доступен
  //   только этот инструмент"; AC-17.1 "роль даёт право на сервер, а у сотрудника личный запрет на один изменяющий инструмент этого сервера:
  //   доступны все инструменты сервера, кроме запрещённого, а вызов запрещённого получает отказ по правам"; AC-17.2 "личный запрет сервера и личное
  //   право на его инструмент: ни один инструмент сервера ему не доступен"; AC-18.1 "у сотрудника нет права на инструмент, а модель его агента всё
  //   равно просит этот инструмент: MCP-сервер не получает ни одного вызова, агент получает отказ, а в аудите - ровно одна запись «отказ по
  //   правам»"; AC-18.2 "агент работает, администратор снимает право: инструмента нет в наборе со следующего вызова модели, а вызов, начатый
  //   после снятия, получает отказ"; AC-18.3 "администратор даёт право: инструмент появляется в наборе со следующего вызова модели"; AC-18.4 "права
  //   сотруднику даёт роль, он запускает workflow и агент вызывает инструмент из скрипта `run_code`: агенты workflow и скрипт получают те же
  //   инструменты и те же отказы, что главный чат". Design: DC-1, DC-2, DC-4 (the tool half); UC-1, and the target-existence and duplicate rows of UC-7.
  // Behavior: the administrator makes rights through the admin operations -> the employees' agents run (workers on, scripted model) -> the set offered
  //   to the model, the check at the call (direct, after confirmation, from `run_code`, from a workflow agent) and the changes made while agents run all
  //   answer from the rights of that moment -> the fixture journal, tool calls in `messages` / `code_calls` rows and the audit.
  // Steps (one story, literal expectations; the registry holds `backoffice` with the mutating tool `create_incident_note` and the read tools
  //   `get_order`, `search_orders`, `logs` with `aggregate_logs`, `get_trace`, `search_logs`, and `tracker` with `search_tickets`; shared-token servers,
  //   so no account of an employee is involved):
  //   1. DC-2, before any right exists: `POST /api/admin/grants` for a model deny to a role -> 422 `GRANT_INVALID`; a right on a model outside
  //      the catalogue -> 422 `GRANT_TARGET_UNKNOWN`; the same personal model right created twice -> 201 then 409 `GRANT_EXISTS`. The `access_grants` count after the step equals the
  //      successful creations only (nothing half saved). The step removes its one right. An employee without the admin right then calls
  //      `POST /api/admin/grants` and `PATCH /api/admin/models/:id` -> 403 `ADMIN_REQUIRED` both, no grant saved, the model unchanged.
  //   2. Setup: role `sre` holds the right to server `backoffice`; Аня is in `sre` and has a personal deny of `create_incident_note`; Борис has a
  //      personal right on the tool `logs/get_trace`, a personal deny of the server `logs`, and a personal right on the one tool
  //      `tracker/search_tickets` with no right on the server; Глеб has a role right on `logs` and a personal right on the mutating tool
  //      `backoffice/create_incident_note`.
  //   3. AC-16.1, AC-17.1, AC-16.2, AC-17.2: the request the scripted model receives for Аня offers `run_code` and every `backoffice` tool except
  //      `create_incident_note`; Борис's offers `run_code` and exactly `tracker/search_tickets` (the deny of `logs` closes `get_trace`); Глеб's offers
  //      all `logs` tools and `create_incident_note`.
  //   4. AC-18.1, AC-18.4, DC-4, the doors: Аня's model asks `create_incident_note`; Борис's model asks `get_trace` of `logs`; Борис's `run_code`
  //      script calls the same tool; Аня starts a workflow whose agent asks `create_incident_note` and whose `run_code` script calls it -> every one
  //      of the five answers `no_access` (as the result of the call, the agent continues), the fixture journal holds no call for them, and the audit holds
  //      exactly one `access_denied` (objectType `tool`, id `<server>/<tool>`, the employee, the reason `no_access`) per refusal - five, not more. The
  //      workflow agent's set is the same as Аня's chat set. Борис's allowed `search_tickets` call reaches the fixture once (the check lets the
  //      right through).
  //   5. After approval: Глеб's agent asks `create_incident_note` (the call changes data, so the confirmation opens); before he approves, the administrator
  //      deletes his personal right; he approves -> the call is refused `no_access`, the journal has no `create_incident_note`, and one
  //      `access_denied` is added.
  //   6. AC-18.2 / AC-18.3, no restart: Глеб's running agent has the `logs` tools in its set; the administrator deletes the role right on `logs` and the
  //      model, still holding the old set in its script, asks a `logs` tool -> `no_access`, the journal unchanged; the administrator gives Глебу a personal
  //      right on the one tool `backoffice/get_order`; his next model call is offered `get_order` and no `logs` tool.
  // Catches: a deny that loses to a role right at one door only (the set, the call, `run_code`, or a workflow agent); the rights read once when the
  //   set was built, so a removed right still opens the call, or an approval that skips the check; a workflow agent or a script with its own looser rule
  //   than the main chat; a refusal that reaches the server or leaves zero or two audit rows; a grant for a model that does not exist, or a
  //   duplicate, saved and then silently never matching.
  // @category: core-functionality
  // @dependency: AdminAccessController, AccessService, effectiveAccess, ToolRegistry, ToolRunner, run_code, start_deep_agent, AuditLog, McpRegistry, runtime workers, scripted model, MCP fixture process, Postgres
  // @complexity: high
  // Implementation (task T3.1; where the comment above differs, the task's text and the built code decide): Аня, Борис
  //   and Глеб each get `A` through the run's role `int1-models`; Глеб's `logs` comes from the role `int1-logs`. The deep agent
  //   is Аня's own record; its subagent names `backoffice` and has `run_code` without naming it (a record never holds it).
  //   «Exactly one record per refusal»: the audit is written before the commit of the refusal (plan Notes 3), so the test
  //   waits for the refused call rows first and counts the audit after.
  it(
    'INT-1: tools are offered, run, confirmed and run from code or a workflow only by the rights of that moment, a deny wins at every door, and a refusal reaches no server and leaves exactly one audit record',
    async () => {
      // Given: three employees on the run's model; the roles that will hold the server rights have none yet
      const anya = await employee('int1-anya');
      const boris = await employee('int1-boris');
      const gleb = await employee('int1-gleb');
      const people = { anya, boris, gleb };
      const models = await runRole('int1-models', [MODEL_A]);
      for (const session of [anya, boris, gleb]) await models.add(session);
      const sre = await runRole('int1-sre');
      const logsReaders = await runRole('int1-logs');

      /**
       * Refused tool calls of the case's employees, direct and from code, as `<name> <door> <target> <reason>`: a
       * direct call to a tool the set did not offer keeps the name the model asked for; an offered one (refused after
       * its confirmation) and a call from code keep their server and tool.
       */
      const refusedCalls = async (): Promise<string[]> => {
        const names = new Map(
          Object.entries(people).map(([name, session]) => [session.id, name]),
        );
        const { rows } = await harness.pool.query<{
          owner: string;
          door: string;
          target: string;
          reason: string;
        }>(
          `SELECT s.owner_id AS owner, 'call' AS door,
                  coalesce(c.content ->> 'server' || '/' || (c.content ->> 'tool'), c.content ->> 'tool') AS target,
                  c.content ->> 'refusalReason' AS reason
             FROM app.messages c JOIN app.conversations s ON s.id = c.conversation_id
            WHERE s.owner_id = ANY($1::uuid[]) AND c.kind = 'tool_result' AND c.content ->> 'outcome' = 'refused'
           UNION ALL
           SELECT s.owner_id, 'code', k.server || '/' || k.tool, k.refusal_reason
             FROM app.code_calls k JOIN app.conversations s ON s.id = k.conversation_id
            WHERE s.owner_id = ANY($1::uuid[]) AND k.outcome = 'refused'`,
          [[...names.keys()]],
        );
        return rows
          .map(
            (row) =>
              `${names.get(row.owner)} ${row.door} ${row.target} ${row.reason}`,
          )
          .sort();
      };
      const toolAudit = () => deniedAudit('tool', people);

      // 1. DC-2, before any right of the step's holders exists: a deny for a role, a model outside the catalogue, a
      //    duplicate - nothing of them is saved. Server and tool rights are access levels (access-levels UC-6 checks them)
      const holderGrants = async (): Promise<number> => {
        const { rows } = await harness.pool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM app.access_grants WHERE role_id = $1 OR user_id = $2',
          [sre.id, anya.id],
        );
        return rows[0]?.count ?? -1;
      };
      expect(await holderGrants()).toBe(0);
      const postGrant = (body: object) =>
        adminRequest('post', '/admin/grants', body);
      const refused = [
        await expectError(
          postGrant({
            roleId: sre.id,
            effect: 'deny',
            target: { kind: 'model', model: MODEL_A },
          }),
          422,
        ),
        await expectError(
          postGrant({
            roleId: sre.id,
            effect: 'allow',
            target: { kind: 'model', model: runModel('not-in-catalogue') },
          }),
          422,
        ),
      ];
      expect(
        refused.map((error) => `${error.errorCode} ${error.reason}`),
      ).toEqual([
        'GRANT_INVALID deny_for_role',
        'GRANT_TARGET_UNKNOWN model_unknown',
      ]);
      const twice = {
        userId: anya.id,
        effect: 'allow',
        target: { kind: 'model', model: MODEL_A },
      };
      const once = await expectBody(postGrant(twice), 201, GrantSchema);
      expect((await expectError(postGrant(twice), 409)).errorCode).toBe(
        'GRANT_EXISTS',
      );
      expect(await holderGrants()).toBe(1);
      await removeGrant(once.id);
      expect(await holderGrants()).toBe(0);
      // An employee without the admin right on this part's admin routes: 403, and neither a grant nor a model changes
      const asEmployee = [
        await expectError(
          apiRequest(harness.app, anya, 'post', '/admin/grants', twice),
          403,
        ),
        await expectError(
          apiRequest(
            harness.app,
            anya,
            'patch',
            `/admin/models/${encodeURIComponent(MODEL_A)}`,
            { name: 'renamed by an employee' },
          ),
          403,
        ),
      ];
      expect(asEmployee.map((error) => error.errorCode)).toEqual([
        'ADMIN_REQUIRED',
        'ADMIN_REQUIRED',
      ]);
      expect(await holderGrants()).toBe(0);
      const catalogue = await expectBody(
        adminRequest('get', '/admin/models'),
        200,
        z.array(CreateCatalogModelBodySchema),
      );
      expect(catalogue.find((model) => model.id === MODEL_A)?.name).toBe(
        MODEL_A,
      );

      // 2. Setup: `sre` holds `backoffice`, Аня is in it with a personal deny of `create_incident_note`; Борис has a
      //    personal right on `logs/get_trace`, a personal deny of `logs` and a personal right on `tracker/search_tickets`;
      //    Глеб has `logs` by a role and a personal right on `backoffice/create_incident_note`
      await level({ roleId: sre.id }, 'allow', {
        kind: 'server',
        server: BACKOFFICE_SERVER,
      });
      await sre.add(anya);
      await level({ userId: anya.id }, 'deny', {
        kind: 'tool',
        server: BACKOFFICE_SERVER,
        tool: 'create_incident_note',
      });
      await level({ userId: boris.id }, 'allow', {
        kind: 'tool',
        server: LOGS_SERVER,
        tool: 'get_trace',
      });
      await level({ userId: boris.id }, 'deny', {
        kind: 'server',
        server: LOGS_SERVER,
      });
      await level({ userId: boris.id }, 'allow', {
        kind: 'tool',
        server: TRACKER_SERVER,
        tool: 'search_tickets',
      });
      const logsRight = { kind: 'server', server: LOGS_SERVER } as const;
      await level({ roleId: logsReaders.id }, 'allow', logsRight);
      await logsReaders.add(gleb);
      const glebNoteRight = {
        kind: 'tool',
        server: BACKOFFICE_SERVER,
        tool: 'create_incident_note',
      } as const;
      await level({ userId: gleb.id }, 'allow', glebNoteRight);
      // Аня's own deep agent record: her chat may start it, and its subagent names `backoffice`
      const accessCheck = await createRecord(
        harness.app,
        anya,
        accessCheckDeepAgent(),
      );

      const anyaTask =
        'INT-1: Аня writes the incident note and starts the access check';
      const borisTask = 'INT-1: Борис reads the trace and the tickets';
      const glebTask = 'INT-1: Глеб writes the incident note';
      const question = 'INT-1: write the incident note of the order';
      const subagentTask =
        'INT-1: the deep agent subagent writes the incident note';
      const anyaChat = harness.model.script(
        { task: anyaTask },
        [
          {
            calls: [
              {
                tool: CREATE_NOTE,
                args: { orderId: 'ord-0000a001', text: 'INT-1: from the chat' },
              },
            ],
          },
          {
            calls: [
              {
                tool: 'start_deep_agent',
                args: {
                  deepAgent: accessCheck.name,
                  question,
                  boundaries: '',
                  result: '',
                },
              },
            ],
          },
          { text: 'the access check is running' },
        ],
        { thereafter: { text: 'the report is noted' } },
      );
      harness.model.script(
        { task: JSON.stringify({ question, boundaries: '', result: '' }) },
        [
          {
            calls: [
              {
                tool: 'task',
                args: {
                  subagentType: ACCESS_SUBAGENT,
                  description: subagentTask,
                },
              },
            ],
          },
        ],
        { thereafter: { text: 'the subagent reported' } },
      );
      // The subagent's one `task` entry: the question of the brief as its labelled line, then the assignment.
      const subagent = harness.model.script(
        { task: `Question: ${question}\n\n${subagentTask}` },
        [
          {
            calls: [
              {
                tool: CREATE_NOTE,
                args: {
                  orderId: 'ord-0000a002',
                  text: 'INT-1: from the deep agent',
                },
              },
              refusedFromCode('Заметка из скрипта', CREATE_NOTE, {
                orderId: 'ord-0000a003',
                text: 'INT-1: from code',
              }),
            ],
          },
          { text: 'the note was refused' },
        ],
      );
      const borisChat = harness.model.script({ task: borisTask }, [
        {
          calls: [
            { tool: GET_TRACE, args: { traceId: 'b1'.repeat(16) } },
            { tool: SEARCH_TICKETS, args: { pageSize: 1 } },
            refusedFromCode('Трасса из скрипта', GET_TRACE, {
              traceId: 'b2'.repeat(16),
            }),
          ],
        },
        { text: 'one ticket read' },
      ]);
      const glebChat = harness.model.script({ task: glebTask }, [
        {
          calls: [
            {
              tool: CREATE_NOTE,
              args: {
                orderId: 'ord-0000c001',
                text: 'INT-1: Глеб, after approval',
              },
            },
          ],
        },
        { text: 'the note waited for the decision' },
      ]);
      const anyaApi = chatApi(harness.app, anya);
      const borisApi = chatApi(harness.app, boris);
      const glebApi = chatApi(harness.app, gleb);
      const anyaThread = await startConversation(anyaApi, anyaTask);
      const borisThread = await startConversation(borisApi, borisTask);
      const glebThread = await startConversation(glebApi, glebTask);

      // 3. AC-16.1, AC-17.1, AC-16.2, AC-17.2: the sets the scripted model was offered
      await Promise.all([
        anyaChat.called(1),
        borisChat.called(1),
        glebChat.called(1),
      ]);
      expect(offered(anyaChat.calls[0])).toEqual([
        GET_ORDER,
        SEARCH_ORDERS,
        RUN_CODE,
      ]);
      expect(offered(borisChat.calls[0])).toEqual([SEARCH_TICKETS, RUN_CODE]);
      expect(offered(glebChat.calls[0])).toEqual([
        CREATE_NOTE,
        AGGREGATE_LOGS,
        GET_TRACE,
        SEARCH_LOGS,
        RUN_CODE,
      ]);

      // 4. AC-18.1, AC-18.4, DC-4, the doors: Аня's chat, Борис's chat and its script, the subagent and its
      //    script -> five `no_access`, each the call's result (the agents go on), no call reaches the fixture but
      //    Борис's allowed `search_tickets`, and exactly one audit record per refusal
      const brief = await waitFor(
        () => anyaApi.history(anyaThread),
        (view) =>
          view.decisions.some(
            (d) => d.kind === AGENTS_BRIEF_CONFIRMATION && d.status === 'open',
          ),
        "the brief of Аня's deep agent",
      );
      const briefId =
        brief.decisions.find((d) => d.kind === AGENTS_BRIEF_CONFIRMATION)
          ?.decisionId ?? '';
      expect(await anyaApi.decide(briefId, { approve: true })).toEqual({
        outcome: 'resolved',
      });
      await Promise.all([
        subagent.called(2),
        borisChat.called(2),
        anyaChat.called(3),
      ]);
      expect(
        await waitFor(
          refusedCalls,
          (lines) => lines.length === 5,
          'the five refused calls',
        ),
      ).toEqual([
        `anya call ${CREATE_NOTE} no_access`,
        `anya call ${CREATE_NOTE} no_access`,
        `anya code ${BACKOFFICE_SERVER}/create_incident_note no_access`,
        `boris call ${GET_TRACE} no_access`,
        `boris code ${LOGS_SERVER}/get_trace no_access`,
      ]);
      expect(await toolAudit()).toEqual([
        `anya ${BACKOFFICE_SERVER}/create_incident_note rejected no_access`,
        `anya ${BACKOFFICE_SERVER}/create_incident_note rejected no_access`,
        `anya ${BACKOFFICE_SERVER}/create_incident_note rejected no_access`,
        `boris ${LOGS_SERVER}/get_trace rejected no_access`,
        `boris ${LOGS_SERVER}/get_trace rejected no_access`,
      ]);
      expect(offered(subagent.calls[0])).toEqual(offered(anyaChat.calls[0]));
      expect(journal()).toEqual(['tracker shared search_tickets']);
      // Борис's refusals are results his chat goes on with; his script got the refusal as its value
      const borisTurn = await untilIdle(
        borisApi,
        borisThread,
        (view) => hasAnswer(view, 'one ticket read'),
        "Борис's turn",
      );
      expect([
        ...resultsOf(borisTurn, GET_TRACE),
        ...resultsOf(borisTurn, 'search_tickets'),
        ...resultsOf(borisTurn, RUN_CODE),
      ]).toEqual(['refused no_access', 'success null', 'success null']);
      const scriptResult = borisTurn.entries.find(
        (entry) =>
          entry.kind === 'tool_result' && entry.content.tool === RUN_CODE,
      );
      expect(
        scriptResult?.kind === 'tool_result'
          ? scriptResult.content.text
          : undefined,
      ).toBe('refused no_access');
      // The run settles: the subagent and the deep agent report and Аня's chat is free again
      await waitFor(
        () => anyaApi.history(anyaThread),
        (view) => {
          const agents = treeOf(view.agents);
          return (
            view.chat.status === 'idle' &&
            view.pending.length === 0 &&
            agents.length === 2 &&
            agents.every((agent) => agent.status === 'completed') &&
            reportsOf(view).length === 1
          );
        },
        "Аня's deep agent to finish",
      );

      // 5. After approval: Глеб's mutating call waits for his decision; the administrator removes his personal right;
      //    he approves -> `no_access`, nothing reaches the fixture, one more audit record
      const awaiting = await waitFor(
        () => glebApi.history(glebThread),
        (view) =>
          view.decisions.some(
            (d) => d.kind === AGENTS_TOOL_CONFIRMATION && d.status === 'open',
          ),
        "Глеб's confirmation request",
      );
      const request = awaiting.decisions.find((d) => d.status === 'open');
      expect(`${request?.server}/${request?.tool}`).toBe(
        `${BACKOFFICE_SERVER}/create_incident_note`,
      );
      await revokeFrom(harness.app, admin, { userId: gleb.id }, glebNoteRight);
      expect(
        await glebApi.decide(request?.decisionId ?? '', { approve: true }),
      ).toEqual({ outcome: 'resolved' });
      await glebChat.called(2);
      const afterApproval = await untilIdle(
        glebApi,
        glebThread,
        (view) => hasAnswer(view, 'the note waited for the decision'),
        "Глеб's chat after the refusal",
      );
      expect(resultsOf(afterApproval, 'create_incident_note')).toEqual([
        'refused no_access',
      ]);
      expect(
        (
          await waitFor(
            refusedCalls,
            (lines) => lines.length === 6,
            'the refused approval',
          )
        ).filter((line) => line.startsWith('gleb')),
      ).toEqual([
        `gleb call ${BACKOFFICE_SERVER}/create_incident_note no_access`,
      ]);
      expect(
        (await toolAudit()).filter((line) => line.startsWith('gleb')),
      ).toEqual([
        `gleb ${BACKOFFICE_SERVER}/create_incident_note rejected no_access`,
      ]);
      expect(offered(glebChat.calls[1])).toEqual([
        AGGREGATE_LOGS,
        GET_TRACE,
        SEARCH_LOGS,
        RUN_CODE,
      ]);
      expect(journal()).toEqual(['tracker shared search_tickets']);

      // 6. AC-18.2 / AC-18.3, no restart: the role right on `logs` goes -> the next model call is offered no `logs`
      //    tool, and the call its script still asks for is refused; a personal right on `get_order` -> offered next
      await revokeFrom(
        harness.app,
        admin,
        { roleId: logsReaders.id },
        logsRight,
      );
      const afterRemoval = 'INT-1 step 6: read the trace once more';
      const removedTurn = harness.model.script({ task: afterRemoval }, [
        { calls: [{ tool: GET_TRACE, args: { traceId: 'c6'.repeat(16) } }] },
        { text: 'the trace was refused' },
      ]);
      await glebApi.send(glebThread, afterRemoval);
      await removedTurn.called(2);
      const refusedLogs = await untilIdle(
        glebApi,
        glebThread,
        (view) => hasAnswer(view, 'the trace was refused'),
        "Глеб's turn without logs",
      );
      expect(offered(removedTurn.calls[0])).toEqual([RUN_CODE]);
      // The tool was not offered, so its result keeps the name the model asked for
      expect(resultsOf(refusedLogs, GET_TRACE)).toEqual(['refused no_access']);
      await level({ userId: gleb.id }, 'allow', {
        kind: 'tool',
        server: BACKOFFICE_SERVER,
        tool: 'get_order',
      });
      const afterGrant = 'INT-1 step 6: which tools are there now?';
      const grantedTurn = harness.model.script({ task: afterGrant }, [
        { text: 'get_order is here' },
      ]);
      await glebApi.send(glebThread, afterGrant);
      await grantedTurn.called(1);
      await untilIdle(
        glebApi,
        glebThread,
        (view) => hasAnswer(view, 'get_order is here'),
        "Глеб's turn with get_order",
      );
      expect(offered(grantedTurn.calls[0])).toEqual([GET_ORDER, RUN_CODE]);
      expect(await refusedCalls()).toEqual([
        `anya call ${CREATE_NOTE} no_access`,
        `anya call ${CREATE_NOTE} no_access`,
        `anya code ${BACKOFFICE_SERVER}/create_incident_note no_access`,
        `boris call ${GET_TRACE} no_access`,
        `boris code ${LOGS_SERVER}/get_trace no_access`,
        `gleb call ${BACKOFFICE_SERVER}/create_incident_note no_access`,
        `gleb call ${GET_TRACE} no_access`,
      ]);
      expect(await toolAudit()).toEqual([
        `anya ${BACKOFFICE_SERVER}/create_incident_note rejected no_access`,
        `anya ${BACKOFFICE_SERVER}/create_incident_note rejected no_access`,
        `anya ${BACKOFFICE_SERVER}/create_incident_note rejected no_access`,
        `boris ${LOGS_SERVER}/get_trace rejected no_access`,
        `boris ${LOGS_SERVER}/get_trace rejected no_access`,
        `gleb ${BACKOFFICE_SERVER}/create_incident_note rejected no_access`,
        `gleb ${LOGS_SERVER}/get_trace rejected no_access`,
      ]);
      expect(journal()).toEqual(['tracker shared search_tickets']);
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: a model call is made only on a verdict, at every place that starts one, and costs the price read before it
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-19.1 "администратор добавил модель с ценой и разрешил её сотруднику: вызов идёт, а его стоимость посчитана по этой цене"; AC-19.2
  //   "администратор поменял цену: вызовы до изменения посчитаны по старой цене, а после - по новой"; AC-19.3 "модели нет в каталоге: выбор
  //   отклоняется с причиной «модель не подключена»"; AC-17.3 "роль разрешает модель, а у сотрудника личный запрет этой модели: выбор отклоняется";
  //   AC-20.1 "Ане разрешён только Haiku, чат запускает для неё агента на Sonnet: агент не запускается, а в историю родителя приходит отказ «модель
  //   не разрешена: Sonnet»"; AC-20.3 "агент работает на модели, администратор снимает разрешение и агент делает следующий вызов: вызов не идёт, а
  //   агент получает статус «сбой» с причиной «модель не разрешена»"; AC-20.4 "выбор модели отклонён: в аудите есть запись с сотрудником, моделью и
  //   причиной"; AC-16.3 / AC-20.2 (the first-call half, the verdict itself is the unit table of UC-5) "у сотрудника нет ни ролей, ни личных
  //   прав, он пишет в чат: ответа модели нет, а сотрудник видит, что ему не разрешена ни одна модель". Design: KD-4, DC-4 (the model half), DC-5,
  //   DC-6; UC-2 (the model rights half).
  // Behavior: the administrator makes the catalogue and the rights -> agents of different employees call a model, start agents and answer in the chat
  //   -> every place asks the verdict before the call -> `runtime_model_calls` rows, the agent's status and failure reason, results in the parent's
  //   history, the audit, and the scripted model's call counter (read before and after each step).
  // Steps (catalogue made through `POST /api/admin/models`: `A` at 1 USD input and 5 USD output per million tokens, `B` at 3 and 15, cache prices 0; the
  //   app's default model is `A`):
  //   1. AC-19.1 / AC-19.2: Аня is allowed A by a role; her agent calls A with 1000 input and 100 output tokens -> the ledger row costs 0,0015 USD;
  //      the administrator `PATCH`es A to 2 and 10 -> the next call of the same size costs 0,003 USD and the first row still reads 0,0015.
  //   2. AC-20.1, AC-19.3, AC-17.3, AC-20.4: Аня's model runs `start_agent` on B (not allowed to her), then on `runModel('not-in-catalogue')`, then
  //      (after the administrator gives her a personal deny of A while the role still allows it) on A -> three refusals as call results in the parent's
  //      history, `model_not_allowed` (B), `model_not_connected`, `model_not_allowed` (A); no child task exists; three `access_denied` rows (objectType
  //      `model`, the employee, the model, the reason), one per refusal.
  //   3. AC-16.3 / AC-20.2, the main chat's first message (the root's start checks the `chat` record's model, design-runtime.md Notes 9г): Борис has no
  //      role and no right and writes the first message of a new conversation -> 409 START_REFUSED with the model, no model call (the counter
  //      unchanged), no root, one `access_denied` row exists for him.
  //   4. AC-20.3, DC-5, a change at run time: Дима's agent on B waits for a message; the administrator deletes the role right on B; the next message makes it
  //      call B -> no call, the agent is `failed` with `model_not_allowed`, its parent gets one `child_finished` with the reason, one `access_denied`;
  //      a second agent of Димы on A (allowed): the administrator `DELETE`s A from the catalogue -> its next call fails `model_not_connected` (the rights
  //      on A went with the model), and the same for a new `start_agent` on A.
  // Catches: a model call made without a verdict at one place - the chat's first call, a `start_agent` start, the first call after a right was
  //   removed, a call on a model that left the catalogue; the cost taken from a cached or file price, so a price change rewrites or misprices history
  //   (money); a refused start that still creates the child or loses the refusal from the parent's history; a missing audit row, or one per retry; a
  //   catalogue removal that leaves rights or running agents on a model that is gone; a personal deny of a model that loses to the role's right.
  // @category: core-functionality
  // @dependency: AdminModelsController, AdminAccessController, AccessService, ModelClient, ModelStep, start_agent, TokenLedger, AuditLog, runtime workers, scripted model, Postgres
  // @complexity: high
  // Implementation (task T3.2, plan Notes 5 and 7; where the comment above differs, the task's text decides): the catalogue
  //   of the case is `A` (the file's default model), `B` (3 / 15), `C` and `D` (1 / 5). Step 1 changes the price of `A` and puts
  //   1 / 5 back in its `finally`. Step 2: Аня's role allows `A` and `C`, a personal deny closes `C` (her chat runs on `A`, so the
  //   call that starts the agents is made); the agents are system records on `B`, `C` and a model that left the catalogue after
  //   the record was saved. Step 3: the refused start rolls the send back, so no title starts and Борис gets ONE
  //   `access_denied`. Step 4 deletes the separate model `D`, not `A`.
  it(
    'INT-2: every model call - chat first call, agent start, running agent - is made only on a verdict, costs what the catalogue said before that call, and a refusal is recorded once',
    async () => {
      // Given: the case's catalogue and employees
      const modelB = await catalogueModel('b', PRICES_3_15);
      const modelC = await catalogueModel('c', PRICES_1_5);
      const modelD = await catalogueModel('d', PRICES_1_5);
      // A record cannot be saved on a model outside the catalogue: it is saved first, then the model leaves
      const leftCatalogue = await catalogueModel('left-catalogue', PRICES_1_5);
      const anya = await employee('int2-anya');
      const boris = await employee('int2-boris');
      const dima = await employee('int2-dima');
      const anyaRole = await runRole('int2-anya', [MODEL_A, modelC]);
      await anyaRole.add(anya);
      await grant({ userId: anya.id }, 'deny', {
        kind: 'model',
        model: modelC,
      });
      const dimaRole = await runRole('int2-dima', [MODEL_A, modelB, modelD]);
      await dimaRole.add(dima);
      const anyaApi = chatApi(harness.app, anya);
      const borisApi = chatApi(harness.app, boris);
      const dimaApi = chatApi(harness.app, dima);

      // 1. AC-19.1 / AC-19.2: a call at 1 / 5 costs 0,0015 USD; after the price is changed to 2 / 10 the same call costs
      //    0,003 USD and the first row still reads 0,0015
      const atFirstPrice = 'INT-2 step 1: a call at the first price';
      const atSecondPrice = 'INT-2 step 1: a call at the second price';
      harness.model.script({ task: atFirstPrice }, [
        { text: 'first price', usage: SMALL_CALL },
      ]);
      harness.model.script({ task: atSecondPrice }, [
        { text: 'second price', usage: SMALL_CALL },
      ]);
      const priced = await startConversation(anyaApi, atFirstPrice);
      await untilIdle(
        anyaApi,
        priced,
        (view) => hasAnswer(view, 'first price'),
        'the call at the first price',
      );
      expect(await spendOf(harness.pool, anya.id, MODEL_A)).toEqual([0.0015]);
      const modelPath = `/admin/models/${encodeURIComponent(MODEL_A)}`;
      try {
        await expectBody(
          adminRequest('patch', modelPath, PRICES_2_10),
          200,
          CreateCatalogModelBodySchema,
        );
        await anyaApi.send(priced, atSecondPrice);
        await untilIdle(
          anyaApi,
          priced,
          (view) => hasAnswer(view, 'second price'),
          'the call at the second price',
        );
        expect(await spendOf(harness.pool, anya.id, MODEL_A)).toEqual([
          0.0015, 0.003,
        ]);
      } finally {
        // `A` is the default model of the whole file
        await expectBody(
          adminRequest('patch', modelPath, PRICES_1_5),
          200,
          CreateCatalogModelBodySchema,
        );
      }
      await untilTitled(anyaApi, priced);

      // 2. AC-20.1, AC-19.3, AC-17.3, AC-20.4: `start_agent` of agent records on `B` (not allowed to her), on a model outside
      //    the catalogue and on `C` (the role allows it, a personal deny closes it) -> three refusals as call results, no
      //    child, three records
      const anyaOnB = await agentOn(modelB, anya);
      const anyaOutside = await agentOn(leftCatalogue, anya);
      const anyaOnC = await agentOn(modelC, anya);
      expect(
        (
          await adminRequest(
            'delete',
            `/admin/models/${encodeURIComponent(leftCatalogue)}`,
          )
        ).status,
      ).toBe(204);
      const startTask = 'INT-2 step 2: start agents on three models';
      harness.model.script({ task: startTask }, [
        {
          calls: [
            startAgent('agent on B', 'INT-2 step 2: work on B', anyaOnB),
            startAgent(
              'agent outside the catalogue',
              'INT-2 step 2: work outside the catalogue',
              anyaOutside,
            ),
            startAgent('agent on C', 'INT-2 step 2: work on C', anyaOnC),
          ],
        },
        { text: 'no agent started' },
      ]);
      const starts = await startConversation(anyaApi, startTask);
      const refusedStarts = await untilIdle(
        anyaApi,
        starts,
        (view) => hasAnswer(view, 'no agent started'),
        'the refused starts',
      );
      expect(resultsOf(refusedStarts, 'start_agent')).toEqual([
        'refused model_not_allowed',
        'refused model_not_connected',
        'refused model_not_allowed',
      ]);
      expect(refusedStarts.agents).toEqual([]);
      const { rows: children } = await harness.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM app.runtime_tasks WHERE owner_id = $1 AND parent_id IS NOT NULL',
        [anya.id],
      );
      expect(children[0]?.count).toBe(0);
      expect(await deniedAudit('model', { anya })).toEqual([
        `anya ${modelB} rejected model_not_allowed`,
        `anya ${modelC} rejected model_not_allowed`,
        `anya ${leftCatalogue} rejected model_not_connected`,
      ]);
      await untilTitled(anyaApi, starts);

      // 3. AC-16.3 / AC-20.2, the chat's first message: the root starts from the `chat` record only when its model is
      //    allowed (design-runtime.md, Notes 9г). Борис has no role and no right -> 409 START_REFUSED naming the model, no
      //    root, no model call of the chat or of the title (the send is rolled back), one record
      const borisTask = 'INT-2 step 3: Борис writes his first message';
      harness.model.script({ task: borisTask }, [
        { text: 'a call Борис may not make' },
      ]);
      const callsBefore = harness.model.calls.length;
      const titlesBefore = titles.calls.length;
      const { id: borisThread } = await borisApi.createThread();
      const refusedStart = await expectBody(
        borisApi.raw('post', `/threads/${borisThread}/messages`, {
          text: borisTask,
          sendKey: randomUUID(),
        }),
        409,
        StartRefusedErrorSchema,
      );
      expect([refusedStart.reason, refusedStart.model]).toEqual([
        'model_not_allowed',
        MODEL_A,
      ]);
      // No conversation appeared: it exists only from an accepted first message
      expect(
        (
          await expectError(
            borisApi.raw('get', `/threads/${borisThread}/history`),
            404,
          )
        ).errorCode,
      ).toBe('THREAD_NOT_FOUND');
      expect([harness.model.calls.length, titles.calls.length]).toEqual([
        callsBefore,
        titlesBefore,
      ]);
      expect(await deniedAudit('model', { boris })).toEqual([
        `boris ${MODEL_A} rejected no_models_allowed`,
      ]);

      // 4. AC-20.3, DC-5, a change at run time: Дима's agents on `B` and on `D` finish their turn and wait; the role right on
      //    `B` goes -> the next message makes the agent on `B` fail `model_not_allowed` without a call, its parent gets one
      //    report with the reason; `D` leaves the catalogue -> its rights go with it, the agent on `D` fails
      //    `model_not_connected`, and a new `start_agent` on `D` is refused `model_not_connected`
      const dimaTask = 'INT-2 step 4: start agents on B and on D';
      const onB = 'INT-2 step 4: the agent on B';
      const onD = 'INT-2 step 4: the agent on D';
      const dimaOnB = await agentOn(modelB, dima);
      const dimaOnD = await agentOn(modelD, dima);
      harness.model.script(
        { task: dimaTask },
        [
          {
            calls: [
              startAgent('agent on B', onB, dimaOnB),
              startAgent('agent on D', onD, dimaOnD),
            ],
          },
          { text: 'two agents started' },
        ],
        { thereafter: { text: 'the report is noted' } },
      );
      const bScript = harness.model.script({ task: onB }, [
        { text: 'B is ready' },
      ]);
      const dScript = harness.model.script({ task: onD }, [
        { text: 'D is ready' },
      ]);
      const dimaThread = await startConversation(dimaApi, dimaTask);
      const started = await untilIdle(
        dimaApi,
        dimaThread,
        (view) =>
          reportsOf(view).length === 2 &&
          view.agents.every((agent) => agent.status === 'completed'),
        "Дима's two agents to report",
      );
      const agentB = agentNamed(started.agents, 'agent on B');
      const agentD = agentNamed(started.agents, 'agent on D');
      expect([agentB.model, agentD.model]).toEqual([modelB, modelD]);
      const reportsOfAgent = (view: ConversationView, agentId: string) =>
        reportsOf(view)
          .filter((report) => report.agentId === agentId)
          .map((report) => `${report.status} ${report.reason}`);

      const roleRightOnB = (await grantsOfRole(dimaRole.id)).find(
        (row) => row.target.kind === 'model' && row.target.model === modelB,
      );
      await removeGrant(roleRightOnB?.id ?? '');
      await dimaApi.sendToAgent(agentB.agentId, 'INT-2 step 4: go on with B');
      const failedB = await waitFor(
        () => dimaApi.agentPage(agentB.agentId),
        (page) => page.agent.status === 'failed',
        'the agent on B to fail',
      );
      expect([failedB.agent.status, failedB.agent.failureReason]).toEqual([
        'failed',
        'model_not_allowed',
      ]);
      expect(bScript.calls).toHaveLength(1);
      const afterB = await untilIdle(
        dimaApi,
        dimaThread,
        (view) => reportsOfAgent(view, agentB.agentId).length === 2,
        "the report of B's failure",
      );
      expect(reportsOfAgent(afterB, agentB.agentId)).toEqual([
        'completed null',
        'failed model_not_allowed',
      ]);

      const removed = await adminRequest(
        'delete',
        `/admin/models/${encodeURIComponent(modelD)}`,
      );
      expect(removed.status).toBe(204);
      const { rows: rightsOnD } = await harness.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM app.access_grants WHERE model = $1',
        [modelD],
      );
      expect(rightsOnD[0]?.count).toBe(0);
      await dimaApi.sendToAgent(agentD.agentId, 'INT-2 step 4: go on with D');
      const failedD = await waitFor(
        () => dimaApi.agentPage(agentD.agentId),
        (page) => page.agent.status === 'failed',
        'the agent on D to fail',
      );
      expect([failedD.agent.status, failedD.agent.failureReason]).toEqual([
        'failed',
        'model_not_connected',
      ]);
      expect(dScript.calls).toHaveLength(1);
      await untilIdle(
        dimaApi,
        dimaThread,
        (view) => reportsOfAgent(view, agentD.agentId).length === 2,
        "the report of D's failure",
      );
      const againTask = 'INT-2 step 4: start an agent on D again';
      harness.model.script({ task: againTask }, [
        {
          calls: [
            startAgent(
              'agent on D again',
              'INT-2 step 4: D once more',
              dimaOnD,
            ),
          ],
        },
        { text: 'D is gone' },
      ]);
      await dimaApi.send(dimaThread, againTask);
      const refusedAgain = await untilIdle(
        dimaApi,
        dimaThread,
        (view) => hasAnswer(view, 'D is gone'),
        'the start on D again',
      );
      expect(resultsOf(refusedAgain, 'start_agent')).toEqual([
        'success null',
        'success null',
        'refused model_not_connected',
      ]);
      expect(refusedAgain.agents).toHaveLength(2);
      expect(await deniedAudit('model', { dima })).toEqual([
        `dima ${modelB} rejected model_not_allowed`,
        `dima ${modelD} rejected model_not_connected`,
        `dima ${modelD} rejected model_not_connected`,
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: money - quotas add up across roles and personal rights, the call that reaches the quota is the last one, continuation after a raise
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-21.1 (the wiring of the sum, the arithmetic is the unit table of UC-4) "у роли квота на Sonnet, лично у Ани тоже, Аня в роли: её действующая
  //   квота - сумма"; AC-21.3 "расход ниже действующей квоты: вызов идёт сразу"; AC-22.1 "расход достиг квоты: вызов не идёт, агент получает статус
  //   «сбой» с причиной «квота исчерпана», Аня видит модель, свой расход и квоту за месяц, а в аудите появляется запись"; AC-22.2 "идут два вызова, и
  //   квота исчерпана во время них: их стоимость входит в расход, а следующий вызов не начинается"; AC-22.3 "агент закончился сбоем по квоте,
  //   администратор поднял квоту выше расхода и Аня пишет ему: агент продолжает работу с того места, где закончился"; AC-22.7 "агент на Sonnet
  //   закончился сбоем по квоте, а другой агент той же беседы работает на Haiku в пределах квоты: он продолжает работу"; AC-22.11 "квота всё ещё
  //   исчерпана, Аня пишет агенту: ответа модели нет, и Аня снова видит причину «квота исчерпана»"; AC-23.1 "Ане разрешены Haiku без квоты и Sonnet с
  //   квотой: видит обе модели и расход за месяц на каждую, у Sonnet - квоту и остаток, а у Haiku - «без предела»". Design: KD-5, DC-3 (the quota
  //   end), DC-8, DC-9; UC-2 (the money half).
  // Behavior: scripted calls of known size spend a quota to the cent -> the next call of the agent that needs the exhausted model does not start and
  //   the agent ends `failed` with `quota_exhausted` -> the employee's own message after a raise continues the conversation -> history, ledger, audit,
  //   `GET /api/access/models`.
  // Steps (`A` is 1 and 5 USD per million tokens and the app's default model, `B` is 3 and 15; Аня's quota on A is two rights, a role `duty` with
  //   0,01 USD and a personal one with 0,03 USD, so the sum is 0,04 USD; her right on B has its own quota of 1 USD; Борис has a personal right on A
  //   with its own quota 0,01 USD; the call that stays in flight is 10 000 input and 1 000 output tokens = 0,015 USD):
  //   1. AC-21.1, AC-23.1, DC-9, before any call: `GET /api/access/models` for Аня parses with `MyModels`: A `quotaUsd` 0,04 (the sum of the role's and
  //      the personal grant), `spentUsd` 0, `remainingUsd` 0,04, `exhausted` false; B `quotaUsd` and `remainingUsd` 1, `exhausted` false; a model she
  //      is not allowed is absent from the list. Then one ledger row of 0,01 USD for Аня on A is written straight into the table, as a call another
  //      process recorded: the check must read the spend from the ledger.
  //   2. AC-21.3, AC-22.2: Аня's main chat and a background agent of the same conversation, both on A, each hold a call in flight on a latch (spend was
  //      0,01 < 0,04, so both calls start); an agent of Ани in another conversation works on B. The latch is released -> both results stand in the
  //      histories and her spend on A reads 0,04 USD; the next model call of each agent on A is not made (the counter shows no new call).
  //   3. AC-22.1, AC-22.7, KD-5: the main chat and the background agent are each `failed` with `quota_exhausted`; the background agent's parent has one
  //      `child_finished` with the reason; the conversation view carries the reason; the audit holds one `access_denied` per ended agent (objectType
  //      `model`, the model, the reason `quota_exhausted`); the agent on B makes one more model call after A is exhausted - it goes through, costs
  //      0,0045 USD against B only - and finishes its turn. `GET /api/access/models`: A `spentUsd` 0,04, `remainingUsd` 0, `exhausted` true; B
  //      `spentUsd` 0,0045, `remainingUsd` 0,9955.
  //   4. Isolation between employees: Борис's agent on A works and finishes while Аня's A is exhausted; his `GET /api/access/models` reads A `spentUsd` 0,
  //      `remainingUsd` 0,01 (Аня's spend is not his), and nothing of his is refused.
  //   5. AC-22.11, DC-9: Аня writes to the failed main chat while the quota is still exhausted -> no model call (the counter unchanged), the chat is
  //      `failed` with `quota_exhausted` again, one more `access_denied`; the page and the check agree - the same row said `exhausted` true.
  //   6. AC-22.3: the administrator `PATCH`es the personal grant's quota to 1 USD (the sum is 1,01) -> the response is 200 and the row reads the new
  //      quota; Аня writes to the main chat -> the model is called with the earlier history of the conversation, the answer arrives and the chat ends
  //      its turn as after any message; her spend on A is 0,04 USD plus the cost of that call (0,0015) and `GET /api/access/models` reads `exhausted`
  //      false with the remaining amount from those numbers.
  // Catches: the quota checked against a stale or per-process spend, so an agent runs one call too many or ends one call early; the in-flight calls
  //   lost from the spend or blocked by the first one's end; a quota that counts only the personal grant or only the role's; spend summed over all
  //   employees so Борис is stopped by Аня's calls (isolation, money); an agent on another model ended with no reason or ended by an exhausted model
  //   it never calls; a continuation after a raise that does not happen, or a message sent while the quota stays exhausted that makes a model call;
  //   a page of the employee that says «Квота исчерпана» while the next call still goes (or the reverse).
  // @category: core-functionality
  // @dependency: AccessService, effectiveAccess, TokenLedger.monthSpendByModel, ModelClient, ModelStep, AdminAccessController, MyAccessController, AuditLog, runtime workers, scripted model, Postgres
  // @complexity: high
  // Implementation (task T3.3, plan Notes 7 and 8; where the comment above differs, the task's text and the built code decide):
  //   a quota is whole cents from 0,01 (grant-rules: `quota_out_of_range` below it or with sub-cent digits). Аня's quota on `A`
  //   is the role `duty` 0,01 USD plus a personal 0,03 USD = 0,04 USD; the ledger row written through the pool is 0,01 USD and
  //   the call held in flight is 10 000 input and 1 000 output tokens = 0,015 USD at 1 / 5, so the row and the two held calls
  //   spend exactly the quota - a spend counted in the process would stop at 0,03 and let one more call through. Аня gets `A`
  //   ONLY through `duty` and the personal grant (a grant without a quota would lift the limit, AC-21.5); her `B` (the case's
  //   own model at 3 / 15) has a quota of 1 USD; Борис has a personal `A` with 0,01 USD. Every other call of the case - the
  //   titles, the call that starts the background agent, the calls of Борис and the first calls of the other conversation -
  //   is zero tokens (Notes 7). Both held calls start while the spend is 0,01 and stay in flight together; the main chat's latch opens first and the background agent's only once
  //   the main call's ledger row is written, so the background agent's next check reads both costs (the order of the two
  //   ledger writes is not left to the scheduler). The agent on `B` in the other conversation is held on its own latch until
  //   `A` is exhausted; its held answer asks a tool, so its next call (1000 / 100 tokens = 0,0045 USD at 3 / 15) starts after
  //   that, and its report then wakes its root on `A`, which ends `quota_exhausted` too. Step 6: `PATCH` of the
  //   personal grant to 1 USD (sum 1,01), and the continuation call is 1000 / 100 tokens = 0,0015 USD.
  it(
    'INT-3: quotas of a role and of the employee add up, calls in flight finish and count, the next call of an exhausted model ends that agent with quota_exhausted, other agents and other employees go on, and a message after a raise continues the conversation',
    async () => {
      // Given: Аня's `A` = `duty` 0,01 + personal 0,03; her `B` with a quota of 1; Борис's `A` = personal 0,01
      const modelB = await catalogueModel('quota-b', PRICES_3_15);
      const anya = await employee('int3-anya');
      const boris = await employee('int3-boris');
      const duty = await runRole('int3-duty');
      await grant(
        { roleId: duty.id },
        'allow',
        { kind: 'model', model: MODEL_A },
        0.01,
      );
      await duty.add(anya);
      const anyaQuota = await grant(
        { userId: anya.id },
        'allow',
        { kind: 'model', model: MODEL_A },
        0.03,
      );
      await grant(
        { userId: anya.id },
        'allow',
        { kind: 'model', model: modelB },
        1,
      );
      await grant(
        { userId: boris.id },
        'allow',
        { kind: 'model', model: MODEL_A },
        0.01,
      );
      const anyaApi = chatApi(harness.app, anya);
      const borisApi = chatApi(harness.app, boris);
      /** Costs of Аня's agent calls on `A` above a helper call's, by time. */
      const paidCalls = async () =>
        (await spendOf(harness.pool, anya.id, MODEL_A)).filter(
          (cost) => cost > HELPER_CALL_USD,
        );

      // 1. AC-21.1, AC-23.1, DC-9, before any call: the quota on `A` is the sum of the two grants, `B` has no limit, a model
      //    she is not allowed is not listed
      expect(await myModels(anya)).toEqual([
        {
          model: MODEL_A,
          name: MODEL_A,
          spentUsd: 0,
          quotaUsd: 0.04,
          remainingUsd: 0.04,
          exhausted: false,
          unavailableReason: null,
        },
        {
          model: modelB,
          name: modelB,
          spentUsd: 0,
          quotaUsd: 1,
          remainingUsd: 1,
          exhausted: false,
          unavailableReason: null,
        },
      ]);
      // 0,01 USD of Аня on `A` that this process did not record: only a spend read from the ledger counts it
      await harness.pool.query(
        `INSERT INTO app.runtime_model_calls
           (call_id, owner_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, called_at)
         VALUES ($1, $2, $3, 10000, 0, 0, 0, 0.01, now())`,
        [randomUUID(), anya.id, MODEL_A],
      );

      // 2. AC-21.3, AC-22.2: in another conversation Аня's root on `A` starts an agent on `B`, whose call is held; in the main
      //    conversation the chat starts a background agent on `A`, and both hold a call of 0,015 USD in flight - each started
      //    at a spend of 0,01 below the quota of 0,04
      const otherTask = 'INT-3 step 2: start an agent on B';
      const onB = 'INT-3 step 2: the agent on B';
      const bHeld = createLatch();
      const anyaOnB = await agentOn(modelB, anya);
      harness.model.script({ task: otherTask }, [
        { calls: [startAgent('agent on B', onB, anyaOnB)], usage: ZERO_TOKENS },
        { text: 'the agent on B works', usage: ZERO_TOKENS },
      ]);
      // The held answer asks a tool, so the agent on `B` makes one more model call, after `A` is exhausted
      const bScript = harness.model.script({ task: onB }, [
        {
          calls: [{ tool: 'list_agents', args: {} }],
          usage: ZERO_TOKENS,
          latch: bHeld,
        },
        { text: 'B is done', usage: SMALL_CALL },
      ]);
      const otherThread = await startConversation(anyaApi, otherTask);
      await bHeld.reached(1);
      await untilIdle(
        anyaApi,
        otherThread,
        (view) => hasAnswer(view, 'the agent on B works'),
        'the other conversation to wait for B',
      );
      await untilTitled(anyaApi, otherThread);

      const mainTask = 'INT-3 step 2: the main chat starts a background agent';
      const backgroundTask = 'INT-3 step 2: the background agent on A';
      const mainHeld = createLatch();
      const backgroundHeld = createLatch();
      harness.model.script({ task: mainTask }, [
        {
          calls: [startAgent('background on A', backgroundTask)],
          usage: ZERO_TOKENS,
        },
        { text: 'the main answer', usage: HELD_CALL, latch: mainHeld },
      ]);
      // The background agent's held answer asks a tool, so it needs one more model call after it
      const backgroundScript = harness.model.script({ task: backgroundTask }, [
        {
          calls: [{ tool: 'list_agents', args: {} }],
          usage: HELD_CALL,
          latch: backgroundHeld,
        },
      ]);
      const mainThread = await startConversation(anyaApi, mainTask);
      await Promise.all([mainHeld.reached(1), backgroundHeld.reached(1)]);
      await untilTitled(anyaApi, mainThread);
      expect(await paidCalls()).toEqual([]);
      const callsInFlight = harness.model.calls.length;

      mainHeld.open();
      expect(
        await waitFor(
          paidCalls,
          (costs) => costs.length === 1,
          'the main call in the ledger',
        ),
      ).toEqual([0.015]);
      backgroundHeld.open();

      // 3. AC-22.1, AC-22.7, KD-5: both results stand and cost 0,015 USD each; the background agent's next call is not made, it
      //    ends `quota_exhausted` and its report wakes the main chat, whose call is not made either; the agent on `B` makes its
      //    next call after that - it goes through and counts against `B` only - and finishes, and its report ends its root on
      //    `A` the same way - one record per ended agent
      const ended = await waitFor(
        () => anyaApi.history(mainThread),
        (view) => view.chat.status === 'failed' && reportsOf(view).length === 1,
        'the main chat to end on the quota',
      );
      expect(await paidCalls()).toEqual([0.015, 0.015]);
      expect(hasAnswer(ended, 'the main answer')).toBe(true);
      expect([ended.chat.status, ended.chat.failureReason]).toEqual([
        'failed',
        'quota_exhausted',
      ]);
      const background = agentNamed(ended.agents, 'background on A');
      expect([background.status, background.failureReason]).toEqual([
        'failed',
        'quota_exhausted',
      ]);
      expect(
        reportsOf(ended).map((report) => `${report.status} ${report.reason}`),
      ).toEqual(['failed quota_exhausted']);
      expect(backgroundScript.calls).toHaveLength(1);

      bHeld.open();
      const other = await waitFor(
        () => anyaApi.history(otherThread),
        (view) => view.chat.status === 'failed',
        'the other conversation to end on the quota',
      );
      expect([other.chat.status, other.chat.failureReason]).toEqual([
        'failed',
        'quota_exhausted',
      ]);
      expect(agentNamed(other.agents, 'agent on B').status).toBe('completed');
      expect(bScript.calls).toHaveLength(2);
      expect(harness.model.calls.length).toBe(callsInFlight + 1);
      expect(await spendOf(harness.pool, anya.id, modelB)).toEqual([
        0.000003, 0.0045,
      ]);
      expect(await paidCalls()).toEqual([0.015, 0.015]);
      expect(await deniedAudit('model', { anya })).toEqual([
        `anya ${MODEL_A} rejected quota_exhausted`,
        `anya ${MODEL_A} rejected quota_exhausted`,
        `anya ${MODEL_A} rejected quota_exhausted`,
      ]);
      const { month } = await expectBody(
        apiRequest(harness.app, anya, 'get', '/access/models'),
        200,
        MyModelsSchema,
      );
      expect(quotaRefusals(anya.id)).toEqual([
        { spentUsd: 0.040005, quotaUsd: 0.04, month },
        { spentUsd: 0.040005, quotaUsd: 0.04, month },
        { spentUsd: 0.040005, quotaUsd: 0.04, month },
      ]);
      expect(await myModels(anya)).toEqual([
        {
          model: MODEL_A,
          name: MODEL_A,
          spentUsd: 0.040005,
          quotaUsd: 0.04,
          remainingUsd: 0,
          exhausted: true,
          unavailableReason: null,
        },
        {
          model: modelB,
          name: modelB,
          spentUsd: 0.004503,
          quotaUsd: 1,
          remainingUsd: 0.995497,
          exhausted: false,
          unavailableReason: null,
        },
      ]);

      // 4. Isolation between employees: Борис's chat on `A` answers while Аня's `A` is exhausted; his spend is his own
      // No Cyrillic in the text: the title of a Cyrillic first message must be Cyrillic, and the title script answers in Latin
      const borisTask = "INT-3 step 4: Boris's own question";
      harness.model.script({ task: borisTask }, [
        { text: 'Борис is answered', usage: ZERO_TOKENS },
      ]);
      const borisThread = await startConversation(borisApi, borisTask);
      await untilIdle(
        borisApi,
        borisThread,
        (view) => hasAnswer(view, 'Борис is answered'),
        "Борис's answer",
      );
      await untilTitled(borisApi, borisThread);
      expect(await myModels(boris)).toEqual([
        {
          model: MODEL_A,
          name: MODEL_A,
          spentUsd: 0.000002,
          quotaUsd: 0.01,
          remainingUsd: 0.009998,
          exhausted: false,
          unavailableReason: null,
        },
      ]);
      expect(await deniedAudit('model', { boris })).toEqual([]);

      // 5. AC-22.11, DC-9: a message to the failed main chat while the quota is still exhausted -> no model call, `failed` with
      //    `quota_exhausted` again, one more record; the page says `exhausted` as the check did
      const callsBeforeMessage = harness.model.calls.length;
      const stillExhausted = 'INT-3 step 5: are you there?';
      await anyaApi.send(mainThread, stillExhausted);
      await waitFor(
        () => deniedAudit('model', { anya }),
        (rows) => rows.length === 4,
        'the fourth quota record',
      );
      const refusedAgain = await waitFor(
        () => anyaApi.history(mainThread),
        (view) =>
          view.chat.status === 'failed' &&
          view.entries.some(
            (entry) =>
              entry.kind === 'user_message' &&
              entry.content.text === stillExhausted,
          ),
        'the main chat to fail again',
      );
      expect([
        refusedAgain.chat.status,
        refusedAgain.chat.failureReason,
      ]).toEqual(['failed', 'quota_exhausted']);
      expect(harness.model.calls.length).toBe(callsBeforeMessage);
      expect((await myModels(anya))[0]).toEqual({
        model: MODEL_A,
        name: MODEL_A,
        spentUsd: 0.040005,
        quotaUsd: 0.04,
        remainingUsd: 0,
        exhausted: true,
        unavailableReason: null,
      });

      // 6. AC-22.3: the personal quota is raised to 1 USD (the sum is 1,01) -> 200 with the new quota; Аня writes to the main
      //    chat -> the model is called, the answer arrives, and the spend and the page follow from those numbers
      const raised = await expectBody(
        adminRequest('patch', `/admin/grants/${anyaQuota.id}`, { quotaUsd: 1 }),
        200,
        GrantSchema,
      );
      expect([raised.id, raised.quotaUsd]).toEqual([anyaQuota.id, 1]);
      const continueTask = 'INT-3 step 6: continue, please';
      const continued = harness.model.script({ task: continueTask }, [
        { text: 'continued after the raise', usage: SMALL_CALL },
      ]);
      await anyaApi.send(mainThread, continueTask);
      await untilIdle(
        anyaApi,
        mainThread,
        (view) => hasAnswer(view, 'continued after the raise'),
        'the continuation',
      );
      expect(continued.calls).toHaveLength(1);
      // The continued call carries the conversation so far, not only the new message
      const seen = (continued.calls[0]?.messages ?? []).flatMap((message) =>
        message.role === 'tool' ? [] : [`${message.role}: ${message.content}`],
      );
      expect(seen).toEqual(
        expect.arrayContaining([
          `user: ${mainTask}`,
          'assistant: the main answer',
          `user: ${stillExhausted}`,
        ]),
      );
      expect(seen.at(-1)).toBe(`user: ${continueTask}`);
      expect(harness.model.calls.length).toBe(callsBeforeMessage + 1);
      expect(await paidCalls()).toEqual([0.015, 0.015, 0.0015]);
      expect(await myModels(anya)).toEqual([
        {
          model: MODEL_A,
          name: MODEL_A,
          spentUsd: 0.041505,
          quotaUsd: 1.01,
          remainingUsd: 0.968495,
          exhausted: false,
          unavailableReason: null,
        },
        {
          model: modelB,
          name: modelB,
          spentUsd: 0.004503,
          quotaUsd: 1,
          remainingUsd: 0.995497,
          exhausted: false,
          unavailableReason: null,
        },
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});
