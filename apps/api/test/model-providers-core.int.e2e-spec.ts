// model-providers / core - API integration skeletons (real AppModule + real Postgres, the scripted model and the embedding double as the only seams)
// Design Doc: docs/features/model-providers/design-core.md (v1.0), Test Strategy UC-E1, UC-E2, UC-E3, UC-E5, UC-E6, UC-E7, UC-3, UC-4;
//   PRD: docs/features/model-providers/prd.md FR-01, FR-02, FR-05, FR-06, FR-08, FR-09, FR-11, NFR-01.
// Generated: 2026-11-20
// Part: core. THE PART'S BUDGET, THE FULL acProof AND THE LIST OF UNIT TABLES ARE IN `packages/agents/test/model-providers-core.int.e2e-spec.ts`
//   (one place; this file holds INT-2 .. INT-7 of 7). 0 E2E: the part has no screen.
// Test Type: Integration. Run with the api e2e config (`*.e2e-spec.ts`), like the other `*.int.e2e-spec.ts` files of this folder.
//
// Harness (follows enterprise-access-identity.int.e2e-spec.ts, agent-platform-chat.int.e2e-spec.ts and custom-agents-runtime.int.e2e-spec.ts):
//   one `createTestApp()` against the docker-compose Postgres, the real AppModule with the real SessionGuard, `AccessService` + `AccessGate`,
//   `Agents.providers`, `Agents.embeddings`, `ModelClient`, `TokenLedger` and `AuditLog`; the seams are the scripted `AGENT_TURN_CLIENT` (the model
//   of a chat run - the provider check, rights and price above it are real) and the `EmbeddingClient` double. Employees from `createEmployee` /
//   `insertEmployee` + sessions, the administrator from `seedSuperAdmin`; roles, grants, quotas and catalogue models through the existing admin
//   routes (`allowRole`); providers, the catalogue and the defaults through the new admin routes; responses parsed with the schemas of
//   `@agent-os/contracts` (`ModelProviderView`, `ModelProviderCheck`, `CatalogModel`, `ModelDefaults`, `ApiErrorSchema`). Every case makes its
//   own employees, roles, provider names (`runName('mp-…')`, so the global teardown removes them too), models and records; `afterAll` gives the
//   default models and the `chat` record back and deletes the run's rows. The real `anthropic` provider row is never named.
//   Harness (test/support, Task 5.3): `createTestApp({ captureLog: true, embeddings })`, `useRunModels` (run providers, models and default
//   models with their restore), `addModel`. The connection check goes to a provider double on 127.0.0.1 (`startProviderDouble` below): it
//   answers 401 and echoes the key it received, so the check's message is a real path for the key, and its count of requests is the proof
//   that a refused check sent none. The Sentry half of AC-11.1 is a unit test of the `beforeSend` text mask (sentry-mask.spec.ts, not here).
//
// Proven elsewhere: see the list in `packages/agents/test/model-providers-core.int.e2e-spec.ts` (catalogue rule rows - `embeddings_not_supported`,
//   `provider_unknown`, `not_chat` / `not_embedding`, grant `embedding_model` - are one unit table of the access service and `modelVerdict`; the
//   validation rows - name pattern, key 8..512, `apiKey: null` - are contract-schema rows).

import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createLatch, type ScriptedToolCall } from '@agent-os/agents/testing';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  AGENTS_BRIEF_CONFIRMATION,
  AdminUserSummarySchema,
  ApiErrorSchema,
  CatalogModelSchema,
  LibraryChoicesSchema,
  ModelDefaultsSchema,
  ModelProviderCheckSchema,
  ModelProviderViewSchema,
  MyModelsSchema,
  RecordDetailSchema,
  StartRefusedErrorSchema,
  type ModelDefaults,
  type ModelProviderView,
  type MyModel,
  type RecordDetail,
} from '@agent-os/contracts';
import { createDatabase, type DatabaseConnection } from '@agent-os/db';
import { PLATFORM_OWNER_ID } from '@agent-os/runtime';
import type { INestApplication } from '@nestjs/common';
import type { Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  addModel,
  allowRole,
  grantTo,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runEmbeddingModel,
  runModel,
  useRunModels,
} from './support/access';
import { chatApi, expectBody, expectError } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import {
  agentBody,
  BUILTIN,
  createRecord,
  deepAgentBody,
  getRecord,
  recordName,
} from './support/library';
import { runName } from './support/mcp-servers';
import { databaseUrl, waitFor } from '@agent-os/db/testing';
import {
  apiRequest,
  createEmployee,
  seedSuperAdmin,
  type Method,
  type Session,
} from './support/session';

/** Bound of a case and of the hooks; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;
/** The suite's default models (`useRunModels`): the chat model and an embedding model, so INT-6 sees the embedding choice kept. */
const RUN_CHAT_MODEL = runModel('mp-chat');
const RUN_EMBEDDING_MODEL = runEmbeddingModel('mp-embed');

/** INT-2: the provider the administrator keys and re-keys, and the one another instance wrote straight into the table. */
const KEYED_PROVIDER = runName('mp-key');
const OTHER_INSTANCE_PROVIDER = runName('mp-other');
/** INT-3: the provider and the model the employee tries to change, and the names his creations would get. */
const GUARD_PROVIDER = runName('mp-guard');
const GUARD_MODEL = `${GUARD_PROVIDER}/guard-chat`;
const EMPLOYEE_PROVIDER = runName('mp-employee');
const EMPLOYEE_MODEL = `${GUARD_PROVIDER}/employee-chat`;
/** INT-6: the provider with two catalogue models. */
const DELETE_PROVIDER = runName('mp-delete');
const DELETE_MODEL_A = `${DELETE_PROVIDER}/chat-a`;
const DELETE_MODEL_B = `${DELETE_PROVIDER}/chat-b`;
/** INT-4: a Gemini provider of the case with one chat model, made missing, disabled and keyless in turn. */
const REFUSE_PROVIDER = runName('mp-refuse');
const REFUSE_MODEL = `${REFUSE_PROVIDER}/chat-refuse`;
/** INT-5: the default embedding model of the case (1 USD per million input tokens, 4 dimensions) and Sonnet with a spent quota. */
const INT5_EMBEDDING_MODEL = runEmbeddingModel('mp-embed5');
const INT5_SONNET = runModel('mp-sonnet5');
/** INT-7: the default chat model before and after the change. */
const INT7_HAIKU = runModel('mp-haiku7');
const INT7_SONNET = runModel('mp-sonnet7');
const CASE_PROVIDERS = [
  KEYED_PROVIDER,
  OTHER_INSTANCE_PROVIDER,
  GUARD_PROVIDER,
  EMPLOYEE_PROVIDER,
  DELETE_PROVIDER,
  REFUSE_PROVIDER,
];
const CASE_MODELS = [
  RUN_CHAT_MODEL,
  RUN_EMBEDDING_MODEL,
  GUARD_MODEL,
  EMPLOYEE_MODEL,
  DELETE_MODEL_A,
  DELETE_MODEL_B,
  REFUSE_MODEL,
  INT5_EMBEDDING_MODEL,
  INT5_SONNET,
  INT7_HAIKU,
  INT7_SONNET,
];

/**
 * Fake keys, one set per case so a leak names its case; each ends in distinct last four characters. They reach no
 * real provider: the keyed providers point at the double, the others are never called.
 */
const INT2_FIRST_KEY = 'int2-fake-key-first-A1b2';
const INT2_SECOND_KEY = 'int2-fake-key-second-C3d4';
const INT2_OTHER_INSTANCE_KEY = 'int2-fake-key-other-instance-E5f6';
const INT3_GUARD_KEY = 'int3-fake-key-guard-G7h8';
const INT3_EMPLOYEE_KEY = 'int3-fake-key-employee-J9k0';
const INT6_DELETE_KEY = 'int6-fake-key-delete-L1m2';
const INT4_REFUSE_KEY = 'int4-fake-key-refuse-N3p4';

/** The mark `AuditLog` writes for any field with a secret name (`apiKey`), never the value. */
const SECRET_CHANGED = 'secret_changed';
const REDACTED = '[redacted]';

/** One `app.audit_events` row of a model provider as the assertions read it. */
interface ProviderAuditRow {
  kind: string;
  actor: string;
  before: unknown;
  after: unknown;
  outcome: string;
}

/** 409 MODEL_PROVIDER_HAS_MODELS carries the number of catalogue models. */
const ProviderHasModelsErrorSchema = ApiErrorSchema.extend({
  count: z.number().int(),
});

/** One console line of the app logger (`consoleSink`: a JSON record) carrying a nested text field. */
const ProbeLineSchema = z.object({
  message: z.string(),
  fields: z.object({ detail: z.object({ text: z.string() }) }),
});

/** The console line of a refused start (`logStart`): the owner, the reason and the refused model (DC-3). */
const StartRefusedLineSchema = z.object({
  message: z.literal('agents start refused'),
  fields: z.object({
    ownerId: z.string(),
    outcome: z.string(),
    refusedModel: z.string().nullable(),
  }),
});

/** One `app.runtime_model_calls` row as the assertions read it; `costUsd` as a number. */
interface LedgerRow {
  ownerId: string;
  taskId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** A deep agent record body whose deep agent and subagent have no model of their own (`null`: the default at the start). */
function nullModelDeepAgent(name: string) {
  const body = deepAgentBody(name, RUN_CHAT_MODEL, [{ model: null }]);
  return { ...body, content: { ...body.content, model: null } };
}

/** A provider address on this machine: every request is answered 401 with the Gemini key it carried, which it keeps. */
interface ProviderDouble {
  readonly url: string;
  /** The `x-goog-api-key` of every request received, in order. */
  readonly keys: readonly string[];
  close(): Promise<void>;
}

async function startProviderDouble(): Promise<ProviderDouble> {
  const keys: string[] = [];
  const server = createServer((request, response) => {
    const key = String(request.headers['x-goog-api-key'] ?? '');
    keys.push(key);
    response.writeHead(401, { 'content-type': 'text/plain' });
    response.end(`rejected key ${key}`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('the provider double listens on no TCP port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    keys,
    close: () => {
      // The app's fetch keeps its socket alive; without this `close` waits for it to time out.
      server.closeAllConnections();
      return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/**
 * Puts the built-in `chat` record on the default chat model (`model: null`, as seeded) through the panel, so a
 * conversation start reads the default; returns the restore that gives it back the model it had.
 */
async function chatRecordOnDefaultModel(
  app: INestApplication<App>,
  admin: Session,
): Promise<() => Promise<void>> {
  const path = `/admin/library/${BUILTIN.chat.id}`;
  const putModel = async (model: string | null) => {
    const record = await expectBody(
      apiRequest(app, admin, 'get', path),
      200,
      RecordDetailSchema,
    );
    if (record.kind !== 'agent')
      throw new Error('the built-in chat record is not an agent record');
    await expectBody(
      apiRequest(app, admin, 'put', path, {
        kind: 'agent',
        name: record.name,
        description: record.description,
        version: record.version,
        content: { ...record.content, model },
      }),
      200,
      RecordDetailSchema,
    );
    return record.content.model;
  };
  const former = await putModel(null);
  return async () => {
    if (former !== null) await putModel(former);
  };
}

describe('model-providers / core - API integration (real AppModule + real Postgres, scripted model and embedding seams)', () => {
  let harness: TestApp;
  /** The test's own pool: cleanup after the app is closed. */
  let database: DatabaseConnection;
  let double: ProviderDouble;
  let admin: Session;
  /** An employee without the admin right. */
  let employee: Session;
  /** Gives the platform back its default models (`useRunModels`); run in `afterAll` while the app is up. */
  let restoreModels: (() => Promise<void>) | undefined;
  /** Gives the `chat` record back its model; run in `afterAll` while the app is up. */
  let restoreChatRecord: (() => Promise<void>) | undefined;
  const userIds: string[] = [];
  const roleIds: string[] = [];

  beforeAll(async () => {
    database = createDatabase({
      connectionString: databaseUrl(),
      poolMax: 2,
    });
    double = await startProviderDouble();
    // Workers on: INT-4 and INT-7 run agents and a deep agent to their model calls.
    harness = await createTestApp({ captureLog: true, workers: true });
    const { app } = harness;
    admin = await seedSuperAdmin(
      app,
      `e2e-mp-admin-${randomUUID().slice(0, 8)}`,
    );
    userIds.push(admin.id);
    employee = await createEmployee(app, admin);
    userIds.push(employee.id);
    restoreModels = await useRunModels(app, admin, {
      chat: { id: RUN_CHAT_MODEL, ...HAIKU_TEST_PRICES },
      embedding: {
        id: RUN_EMBEDDING_MODEL,
        inputUsdPerMTok: 0.02,
        dimensions: 8,
      },
    });
    restoreChatRecord = await chatRecordOnDefaultModel(app, admin);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    try {
      try {
        await restoreChatRecord?.();
      } finally {
        await restoreModels?.();
      }
    } finally {
      await harness?.close();
      await double?.close();
      // The models first: a provider is only a name to them, but the catalogue rows name it.
      await removeRunRows(database.pool, {
        models: CASE_MODELS,
        roles: roleIds,
        users: userIds,
      });
      // INT-5 row C: the platform's ledger row belongs to no employee.
      await database.pool.query(
        'DELETE FROM app.runtime_model_calls WHERE owner_id = $1 AND model = ANY($2::text[])',
        [PLATFORM_OWNER_ID, CASE_MODELS],
      );
      await database.pool.query(
        'DELETE FROM app.agent_model_providers WHERE name = ANY($1::text[])',
        [CASE_PROVIDERS],
      );
      await database.close();
    }
  }, TEST_TIMEOUT_MS);

  /** `GET /api/admin/model-providers/:name` as the administrator, 200. */
  const providerView = (name: string): Promise<ModelProviderView> =>
    expectBody(
      apiRequest(harness.app, admin, 'get', `/admin/model-providers/${name}`),
      200,
      ModelProviderViewSchema,
    );
  /** `GET /api/admin/model-providers` as the administrator: the names. */
  const providerNames = async (): Promise<string[]> =>
    (
      await expectBody(
        apiRequest(harness.app, admin, 'get', '/admin/model-providers'),
        200,
        z.array(ModelProviderViewSchema),
      )
    ).map((view) => view.name);
  /** `GET /api/admin/model-defaults` as the administrator. */
  const modelDefaults = (): Promise<ModelDefaults> =>
    expectBody(
      apiRequest(harness.app, admin, 'get', '/admin/model-defaults'),
      200,
      ModelDefaultsSchema,
    );
  /** The audit rows of one provider, in the order written. */
  const providerAudit = async (name: string): Promise<ProviderAuditRow[]> => {
    const { rows } = await database.pool.query<ProviderAuditRow>(
      `SELECT kind, actor, before, after, outcome FROM app.audit_events
        WHERE object_type = 'model_provider' AND object_id = $1 ORDER BY at, id`,
      [name],
    );
    return rows;
  };
  /** `PUT /api/admin/model-defaults` as the administrator: `change` over the current choice. */
  const putDefaults = async (
    change: Partial<Pick<ModelDefaults, 'chatModel' | 'embeddingModel'>>,
  ): Promise<void> => {
    const { chatModel, embeddingModel } = await modelDefaults();
    await expectBody(
      apiRequest(harness.app, admin, 'put', '/admin/model-defaults', {
        chatModel,
        embeddingModel,
        ...change,
      }),
      200,
      ModelDefaultsSchema,
    );
  };
  /** A new employee of the case in a new role of the run that allows `models` (no servers). */
  const employeeAllowed = async (
    role: string,
    models: readonly string[],
  ): Promise<Session> => {
    const allowed = await allowRole(harness.app, admin, {
      name: role,
      models,
      servers: [],
    });
    roleIds.push(allowed.id);
    const session = await createEmployee(harness.app, admin);
    userIds.push(session.id);
    await allowed.add(session);
    return session;
  };
  /** The ledger rows of `ownerId` (on `model` when given), largest input first. */
  const ledgerRows = async (
    ownerId: string,
    model?: string,
  ): Promise<LedgerRow[]> => {
    const { rows } = await database.pool.query<
      Omit<LedgerRow, 'costUsd'> & { costUsd: string }
    >(
      `SELECT owner_id AS "ownerId", task_id AS "taskId", model, input_tokens AS "inputTokens",
              output_tokens AS "outputTokens", cache_read_tokens AS "cacheReadTokens",
              cache_write_tokens AS "cacheWriteTokens", cost_usd AS "costUsd"
         FROM app.runtime_model_calls
        WHERE owner_id = $1 AND ($2::text IS NULL OR model = $2)
        ORDER BY input_tokens DESC, called_at`,
      [ownerId, model ?? null],
    );
    return rows.map((row) => ({ ...row, costUsd: Number(row.costUsd) }));
  };

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: a provider key never leaves - not in a response, not in the audit, not in a log line, also when set or replaced while the process runs
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.1 "Given администратор добавил провайдера вида Gemini с ключом, when администратор читает провайдера, then в ответе нет ключа, а есть
  //   только признак, что ключ задан, и его последние четыре символа"; AC-01.5 "Given администратор заменил ключ, when смотрят аудит, then в нём
  //   запись с провайдером и пометкой «секрет изменён», без значения ключа"; AC-11.1 "Given администратор задал ключ во время работы сервера, when
  //   в запись лога попадает текст с этим ключом, then в консоли и в Sentry вместо ключа маска"; AC-11.2 "Given администратор заменил ключ, when
  //   в запись лога попадает текст со старым ключом, then вместо него маска"; NFR-01 "Ключ провайдера не появляется ни в ответе API, ни в логе,
  //   ни в аудите, ни в причине сбоя". Design: UC-E1, KD-7, Flow 3, Invariants 1 and 2, DC-2.
  // Behavior: the administrator adds a Gemini provider with key K1 (POST) -> replaces it with K2 (PATCH) -> reads it back (GET one, GET list) ->
  //   the app logs text carrying K1 and K2 -> responses, audit and captured console lines hold neither key.
  // Rows (literal keys of 8+ characters made for the run):
  //   1. POST and PATCH and GET one and GET list and the connection-check response: `apiKeySet: true`, `apiKeyLast4` = the last four characters of the
  //      current key, no field named or valued like the key anywhere in the body (searched as text, not by property name)
  //   2. audit: one `admin_change` on the provider per change; for the replacement `apiKey` is `changed` in before and after - the key value is in no
  //      field; no other audit row of the run holds either key
  //   3. a line logged by the app's logger (a record whose message and a nested field both carry K1 and K2): the captured console line has
  //      `[redacted]` in both places and neither key - K2 was never in the logger's startup list, K1 was replaced and must stay hidden
  //   4. a provider row written straight into the database (as another instance would), read by a call of the registry: its key is masked in the
  //      next log line too - the read path feeds the mask, not only the write path
  // Catches: the key echoed in a response or the audit, a mask built at start from a fixed list that does not know a key set or replaced while the
  //   process runs (the part's top risk, KD-7), a replaced key that is shown again as soon as it stops being "current", and a key read from the
  //   database by another instance that the mask never saw.
  // @category: core-functionality
  // @dependency: AdminModelProvidersController, Agents.providers, AuditLog, createSecretMasker / rememberSecret (common), app logger (captureLog), Postgres
  // @complexity: high
  it(
    'INT-2: a provider key set or replaced while the server runs is in no API response, no audit row and no log line',
    async () => {
      const { app } = harness;
      const keys = [INT2_FIRST_KEY, INT2_SECOND_KEY, INT2_OTHER_INSTANCE_KEY];
      /** The raw text of every API response of the case (row 1 scans them). */
      const answers: string[] = [];
      const call = async (
        method: Method,
        path: string,
        body?: object,
      ): Promise<Response> => {
        const response = await apiRequest(app, admin, method, path, body);
        answers.push(response.text);
        return response;
      };
      const view = (response: Promise<Response>, status: number) =>
        expectBody(response, status, ModelProviderViewSchema);
      const keyShown = (shown: ModelProviderView | undefined) => [
        shown?.apiKeySet,
        shown?.apiKeyLast4,
      ];
      const path = `/admin/model-providers/${KEYED_PROVIDER}`;
      const logger = app.get<Logger>(LOGGER);
      /** The one captured console line holding `marker`, parsed. */
      const probeLine = (marker: string) => {
        const lines = harness.log.filter((line) => line.includes(marker));
        expect(lines).toHaveLength(1);
        return ProbeLineSchema.parse(JSON.parse(lines[0] ?? ''));
      };

      // Row 1 - When: the administrator adds a Gemini provider with K1 (at the double's address), replaces K1 with K2, reads it back
      const created = await view(
        call('post', '/admin/model-providers', {
          name: KEYED_PROVIDER,
          kind: 'gemini',
          baseUrl: double.url,
          apiKey: INT2_FIRST_KEY,
        }),
        201,
      );
      const replaced = await view(
        call('patch', path, { apiKey: INT2_SECOND_KEY }),
        200,
      );
      const readOne = await view(call('get', path), 200);
      const listed = (
        await expectBody(
          call('get', '/admin/model-providers'),
          200,
          z.array(ModelProviderViewSchema),
        )
      ).find((provider) => provider.name === KEYED_PROVIDER);
      // Then: only «set» and the last four characters of the current key
      expect([
        keyShown(created),
        keyShown(replaced),
        keyShown(readOne),
        keyShown(listed),
      ]).toEqual([
        [true, 'A1b2'],
        [true, 'C3d4'],
        [true, 'C3d4'],
        [true, 'C3d4'],
      ]);
      // When: the connection check sends K2 to the double, which echoes it in its 401 body
      const check = await expectBody(
        call('post', `${path}/check`),
        200,
        ModelProviderCheckSchema,
      );
      // Then: the double did receive K2, and the check's message carries the mask instead
      expect(double.keys.at(-1)).toBe(INT2_SECOND_KEY);
      expect(check).toEqual({
        result: 'key_rejected',
        message: `401 rejected key ${REDACTED}`,
      });
      // When: `apiKey: null` removes the key (FR-01)
      const removed = await view(call('patch', path, { apiKey: null }), 200);
      expect([...keyShown(removed), removed.state]).toEqual([
        false,
        null,
        'key_missing',
      ]);
      // Then: no response of the case holds either key, searched as text
      expect(
        answers.filter((text) => keys.some((key) => text.includes(key))),
      ).toEqual([]);

      // Row 2 - Then: one `admin_change` per change, the key a mark in before and after, never a value
      const provider = {
        name: KEYED_PROVIDER,
        kind: 'gemini',
        baseUrl: double.url,
        enabled: true,
      };
      const keyMarked = { ...provider, apiKey: SECRET_CHANGED };
      const change = (before: unknown, after: unknown): ProviderAuditRow => ({
        kind: 'admin_change',
        actor: admin.id,
        before,
        after,
        outcome: 'ok',
      });
      expect(await providerAudit(KEYED_PROVIDER)).toEqual([
        change(null, keyMarked),
        change(keyMarked, keyMarked),
        change(keyMarked, keyMarked),
      ]);
      // And: no audit row at all holds a key of the case
      const auditHolding = async (key: string) =>
        (
          await database.pool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM app.audit_events
              WHERE strpos(concat_ws(' ', object_id, before::text, after::text, reason), $1) > 0`,
            [key],
          )
        ).rows[0]?.count;
      expect([
        await auditHolding(INT2_FIRST_KEY),
        await auditHolding(INT2_SECOND_KEY),
      ]).toEqual([0, 0]);

      // Row 3 - When: the app's logger writes K1 (replaced) and K2 (set at run time, now removed) in the message and a nested field
      logger.info(
        `int-2 row 3 probe: first ${INT2_FIRST_KEY} second ${INT2_SECOND_KEY}`,
        {
          detail: {
            text: `first ${INT2_FIRST_KEY} second ${INT2_SECOND_KEY}`,
          },
        },
      );
      // Then: the console line has the mask in both places
      const row3 = probeLine('int-2 row 3 probe');
      expect([row3.message, row3.fields.detail.text]).toEqual([
        `int-2 row 3 probe: first ${REDACTED} second ${REDACTED}`,
        `first ${REDACTED} second ${REDACTED}`,
      ]);

      // Row 4 - When: another instance wrote a provider row with K3 straight into the table, and this one reads it
      await harness.pool.query(
        `INSERT INTO app.agent_model_providers (name, kind, api_key) VALUES ($1, 'gemini', $2)`,
        [OTHER_INSTANCE_PROVIDER, INT2_OTHER_INSTANCE_KEY],
      );
      const otherView = await harness.agents.providers.get(
        OTHER_INSTANCE_PROVIDER,
      );
      expect([otherView.apiKeySet, otherView.apiKeyLast4]).toEqual([
        true,
        'E5f6',
      ]);
      expect(JSON.stringify(otherView)).not.toContain(INT2_OTHER_INSTANCE_KEY);
      logger.info(`int-2 row 4 probe: ${INT2_OTHER_INSTANCE_KEY}`, {
        detail: { text: `other ${INT2_OTHER_INSTANCE_KEY}` },
      });
      // Then: the read fed the mask - the next line has it in both places
      const row4 = probeLine('int-2 row 4 probe');
      expect([row4.message, row4.fields.detail.text]).toEqual([
        `int-2 row 4 probe: ${REDACTED}`,
        `other ${REDACTED}`,
      ]);
      // And: no captured console line of the process holds any key of the case
      expect(
        harness.log.filter((line) => keys.some((key) => line.includes(key))),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: the provider, catalogue and defaults routes are administrator-only (table-driven)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.4 "Given у сотрудника нет права администратора, when он добавляет или меняет провайдера в обход панели, then сервер отказывает".
  //   Design: UC-E2, Security Considerations ("под `@AdminOnly()`"), auth-boundary pattern.
  // Behavior: an employee with no admin right calls each new admin route -> 403 `ADMIN_REQUIRED`, nothing changed; the administrator's call of
  //   the same request works.
  // Rows (one request each, literal status and `errorCode`; the employee's session and the administrator's):
  //   `GET /api/admin/model-providers`, `POST /api/admin/model-providers`, `GET|PATCH|DELETE /api/admin/model-providers/:name`,
  //   `POST /api/admin/model-providers/:name/check`, `GET /api/admin/models`, `POST /api/admin/models`, `PATCH|DELETE /api/admin/models/:id`,
  //   `GET|PUT /api/admin/model-defaults` -> 403 `ADMIN_REQUIRED`; after the writes a read as the administrator shows the provider, the model and
  //   the defaults unchanged; the connection check made no request to the provider
  // Catches: a new controller (the part adds three route families) shipped without `@AdminOnly` - any employee could read provider addresses, set
  //   a key, delete a provider or point the platform's default model at another model. The route walk of enterprise-access-identity INT-1 proves
  //   only "closed without a session" and one admin route; it does not see a new route open to every signed-in employee.
  // @category: core-functionality
  // @dependency: SessionGuard, AdminOnly, AdminModelProvidersController, catalogue and defaults controllers, AuditLog, Postgres
  // @complexity: medium
  it(
    'INT-3: every provider, catalogue and model-defaults route answers an employee without the admin right 403 ADMIN_REQUIRED and changes nothing',
    async () => {
      const { app } = harness;
      // Given: a keyed provider at the double's address with a catalogue model, as the administrator made them
      await expectBody(
        apiRequest(app, admin, 'post', '/admin/model-providers', {
          name: GUARD_PROVIDER,
          kind: 'gemini',
          baseUrl: double.url,
          apiKey: INT3_GUARD_KEY,
        }),
        201,
        ModelProviderViewSchema,
      );
      const modelBefore = await addModel(app, admin, {
        id: GUARD_MODEL,
        ...HAIKU_TEST_PRICES,
      });
      const providerBefore = await providerView(GUARD_PROVIDER);
      const defaultsBefore = await modelDefaults();
      const requestsBefore = double.keys.length;
      const provider = `/admin/model-providers/${GUARD_PROVIDER}`;
      const model = `/admin/models/${encodeURIComponent(GUARD_MODEL)}`;
      const routes: readonly {
        readonly method: Method;
        readonly path: string;
        readonly body?: object;
      }[] = [
        { method: 'get', path: '/admin/model-providers' },
        {
          method: 'post',
          path: '/admin/model-providers',
          body: {
            name: EMPLOYEE_PROVIDER,
            kind: 'gemini',
            apiKey: INT3_EMPLOYEE_KEY,
          },
        },
        { method: 'get', path: provider },
        {
          method: 'patch',
          path: provider,
          body: { enabled: false, apiKey: INT3_EMPLOYEE_KEY },
        },
        { method: 'delete', path: provider },
        { method: 'post', path: `${provider}/check` },
        { method: 'get', path: '/admin/models' },
        {
          method: 'post',
          path: '/admin/models',
          body: {
            purpose: 'chat',
            id: EMPLOYEE_MODEL,
            name: EMPLOYEE_MODEL,
            prices: HAIKU_TEST_PRICES.prices,
            longContext: null,
          },
        },
        {
          method: 'patch',
          path: model,
          body: { name: 'renamed by an employee' },
        },
        { method: 'delete', path: model },
        { method: 'get', path: '/admin/model-defaults' },
        {
          method: 'put',
          path: '/admin/model-defaults',
          body: { chatModel: GUARD_MODEL, embeddingModel: null },
        },
      ];

      // When: the employee calls every route
      const answered: string[] = [];
      for (const route of routes) {
        const response = await apiRequest(
          app,
          employee,
          route.method,
          route.path,
          route.body,
        );
        // A body that is not an error (an open route's answer) leaves the code empty.
        const errorCode = ApiErrorSchema.safeParse(response.body).data
          ?.errorCode;
        answered.push(
          `${route.method} ${route.path} ${response.status} ${errorCode}`,
        );
      }

      // Then: each is refused 403 ADMIN_REQUIRED
      expect(answered).toEqual(
        routes.map(
          (route) => `${route.method} ${route.path} 403 ADMIN_REQUIRED`,
        ),
      );
      // And: the administrator reads the provider, the model and the defaults unchanged, and nothing the employee created
      expect(await providerView(GUARD_PROVIDER)).toEqual(providerBefore);
      const catalogue = await expectBody(
        apiRequest(app, admin, 'get', '/admin/models'),
        200,
        z.array(CatalogModelSchema),
      );
      expect([
        catalogue.find((entry) => entry.id === GUARD_MODEL),
        catalogue.some((entry) => entry.id === EMPLOYEE_MODEL),
      ]).toEqual([modelBefore, false]);
      expect((await providerNames()).includes(EMPLOYEE_PROVIDER)).toBe(false);
      expect(await modelDefaults()).toEqual(defaultsBefore);
      // And: the refused check sent no request to the provider, while the administrator's same check reaches it
      expect(double.keys.length).toBe(requestsBefore);
      const check = await expectBody(
        apiRequest(app, admin, 'post', `${provider}/check`),
        200,
        ModelProviderCheckSchema,
      );
      expect([check.result, double.keys.slice(requestsBefore)]).toEqual([
        'key_rejected',
        [INT3_GUARD_KEY],
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4: a start or a running agent whose provider is not ready gets the named reason - and it is not a rights denial
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-02.1 "Given на развёртывании не выбрана модель чата по умолчанию, when сотрудник пишет в чат, then ответа модели нет, а сотрудник видит,
  //   что модель не настроена и нужно обратиться к администратору"; AC-09.1 "Given провайдер модели записи выключен, when Аня запускает запись из
  //   чата, then агент не стартует, а Аня видит, что модель недоступна, потому что её провайдер выключен"; AC-09.2 "Given агент работает, when
  //   администратор выключил провайдера его модели, then следующий вызов модели не идёт, а агент получает статус «сбой» с причиной «провайдер
  //   модели выключен»"; AC-09.4 "Given у провайдера вида Gemini нет ключа, when агент вызывает его модель, then провайдер не получает запроса, а
  //   агент получает статус «сбой» с причиной «у провайдера модели нет ключа»". Design: UC-E3, KD-2, DC-3, DC-10, Flow 1.
  // Behavior: an employee writes in chat / starts a record -> `resolveStart` reads the default model and the provider's readiness -> 409
  //   `START_REFUSED` with the reason and the model, or the run starts -> a later model call re-checks the provider (`providerReadiness` inside
  //   `ModelClient`) -> the agent ends `failed` with the named reason.
  // Rows:
  //   1. no chat model chosen by default: the first message of a new conversation -> 409 `START_REFUSED` `model_not_configured`; no conversation
  //      title is created; the reason is in the captured log (DC-3); the scripted model received no call
  //   2. model chosen, its provider missing (deleted straight in the row), disabled, and Gemini without key -> the same request is refused 409
  //      `START_REFUSED` `provider_missing`, `provider_disabled`, `provider_key_missing`, each with the `model` field; the scripted model received
  //      no call
  //   3. a run is in progress (the scripted model is held at its second call by a latch); the administrator disables the provider (PATCH
  //      `enabled: false`); the latch is released -> the run ends `failed` with `failureReason` `provider_disabled`, not `model_error`; the
  //      scripted model's second call never happened; then the same with the key removed (`apiKey: null`) -> `provider_key_missing`
  //   4. across rows 1-3: no `access_denied` audit row for the employee (a provider refusal is not a rights refusal) and the ledger has no row
  //      for a refused or failed-before-request call
  // Catches: a start that goes on to a model call that cannot be made (a cryptic provider error instead of the named reason), a run that keeps
  //   calling a provider the administrator just switched off (readiness checked only at start, below the seam where tests do not see it), and a
  //   provider refusal written to the audit as an `access_denied` rights denial - which would put provider outages into the rights-violation report.
  // @category: core-functionality
  // @dependency: resolveStart, providerReadiness, ModelClient, AccessGate.defaultChatModel, AdminModelProvidersController, AuditLog, ConversationsService, scripted AGENT_TURN_CLIENT, Postgres
  // @complexity: high
  it(
    'INT-4: a missing, disabled or keyless provider refuses a start and fails a running agent with the named reason, writes no access_denied row and sends no model call',
    async () => {
      const { app } = harness;
      const providerPath = `/admin/model-providers/${REFUSE_PROVIDER}`;
      const registerProvider = () =>
        expectBody(
          apiRequest(app, admin, 'post', '/admin/model-providers', {
            name: REFUSE_PROVIDER,
            kind: 'gemini',
            apiKey: INT4_REFUSE_KEY,
          }),
          201,
          ModelProviderViewSchema,
        );
      const patchProvider = (body: object) =>
        expectBody(
          apiRequest(app, admin, 'patch', providerPath, body),
          200,
          ModelProviderViewSchema,
        );
      // Given: a keyed Gemini provider of the case with a chat model, and Аня allowed that model; the `chat` record is on the default
      await registerProvider();
      await addModel(app, admin, { id: REFUSE_MODEL, ...HAIKU_TEST_PRICES });
      const anya = await employeeAllowed('mp-int4', [REFUSE_MODEL]);
      const anyaApi = chatApi(app, anya);
      /** The first message of a new conversation, refused 409: the conversation and `[errorCode, reason, model]`. */
      const refusedFirstMessage = async (text: string) => {
        const { id } = await anyaApi.createThread();
        const refusal = await expectBody(
          anyaApi.raw('post', `/threads/${id}/messages`, { text }),
          409,
          StartRefusedErrorSchema,
        );
        return {
          thread: id,
          refusal: [refusal.errorCode, refusal.reason, refusal.model],
        };
      };
      const modelCallsBefore = harness.model.calls.length;

      // Row 1 - When: no chat model is chosen by default, and Аня writes the first message of a conversation
      await putDefaults({ chatModel: null });
      const notConfigured = await refusedFirstMessage(
        'INT-4 row 1: the first message with no default chat model',
      );
      // Then: refused `model_not_configured` with no model; no conversation appeared
      expect(notConfigured.refusal).toEqual([
        'START_REFUSED',
        'model_not_configured',
        null,
      ]);
      expect(
        (
          await expectError(
            anyaApi.raw('get', `/threads/${notConfigured.thread}/history`),
            404,
          )
        ).errorCode,
      ).toBe('THREAD_NOT_FOUND');

      // Row 2 - Given: the case's model is the default chat model
      await putDefaults({ chatModel: REFUSE_MODEL });
      // When: its provider row is deleted straight in the table (as another instance would) - then registered again
      await database.pool.query(
        'DELETE FROM app.agent_model_providers WHERE name = $1',
        [REFUSE_PROVIDER],
      );
      const missing = await refusedFirstMessage(
        'INT-4 row 2: the provider is missing',
      );
      await registerProvider();
      // When: the provider is disabled - then enabled again
      await patchProvider({ enabled: false });
      const disabled = await refusedFirstMessage(
        'INT-4 row 2: the provider is disabled',
      );
      await patchProvider({ enabled: true });
      // When: the Gemini provider has no key - then gets it back
      await patchProvider({ apiKey: null });
      const keyless = await refusedFirstMessage(
        'INT-4 row 2: the provider has no key',
      );
      await patchProvider({ apiKey: INT4_REFUSE_KEY });
      // Then: each start is refused with the provider's reason and the model
      expect([missing.refusal, disabled.refusal, keyless.refusal]).toEqual([
        ['START_REFUSED', 'provider_missing', REFUSE_MODEL],
        ['START_REFUSED', 'provider_disabled', REFUSE_MODEL],
        ['START_REFUSED', 'provider_key_missing', REFUSE_MODEL],
      ]);
      // And: rows 1 and 2 sent no model call
      expect(harness.model.calls.length).toBe(modelCallsBefore);
      // And: each refusal is in the log with its reason and model (DC-3)
      const refusalsLogged = harness.log
        .filter(
          (line) =>
            line.includes('agents start refused') && line.includes(anya.id),
        )
        .map((line) => StartRefusedLineSchema.parse(JSON.parse(line)).fields)
        .map((fields) => [fields.outcome, fields.refusedModel]);
      expect(refusalsLogged).toEqual([
        ['model_not_configured', null],
        ['provider_missing', REFUSE_MODEL],
        ['provider_disabled', REFUSE_MODEL],
        ['provider_key_missing', REFUSE_MODEL],
      ]);

      // Row 3 - readiness is checked before the call reaches the scripted model, so the run is held at the answer of its FIRST
      // call, which asks for a second call (`list_agents`); the provider changes while it is held.
      /** Runs a conversation to its end with `change` made to the provider while the first answer is held. */
      const runWithProviderChange = async (text: string, change: object) => {
        const latch = createLatch();
        const script = harness.model.script({ task: text }, [
          { calls: [{ tool: 'list_agents', args: {} }], latch },
          { text: `${text}: an answer the provider must never be asked for` },
        ]);
        const { id: thread } = await anyaApi.createThread();
        try {
          await anyaApi.send(thread, text);
          await latch.reached(1);
          await patchProvider(change);
        } finally {
          latch.open();
        }
        const ended = await waitFor(
          () => anyaApi.history(thread),
          (view) =>
            view.chat.status === 'failed' || view.chat.status === 'idle',
          `the end of the run "${text}"`,
        );
        return {
          chat: [ended.chat.status, ended.chat.failureReason, ended.chat.model],
          modelCalls: script.calls.map((call) => call.model),
        };
      };
      // When: the administrator disables the provider mid-run; then, on a new run, removes its key mid-run
      const disabledMidRun = await runWithProviderChange(
        'INT-4 row 3: the provider is disabled mid-run',
        { enabled: false },
      );
      await patchProvider({ enabled: true });
      const keylessMidRun = await runWithProviderChange(
        'INT-4 row 3: the key is removed mid-run',
        { apiKey: null },
      );
      // Then: each run failed with the named provider reason, not `model_error`; the scripted model got the first call only
      expect([disabledMidRun, keylessMidRun]).toEqual([
        {
          chat: ['failed', 'provider_disabled', REFUSE_MODEL],
          modelCalls: [REFUSE_MODEL],
        },
        {
          chat: ['failed', 'provider_key_missing', REFUSE_MODEL],
          modelCalls: [REFUSE_MODEL],
        },
      ]);

      // Row 4 - Then: no `access_denied` record for Аня across rows 1-3 - a provider refusal is not a rights refusal
      const denied = await database.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM app.audit_events WHERE kind = 'access_denied' AND actor = $1`,
        [anya.id],
      );
      expect(denied.rows[0]?.count).toBe(0);
      // And: the ledger holds the two answered first calls of row 3 (1000 input and 100 output tokens at Haiku's prices)
      // and nothing for a refused start or a call failed before its request
      expect(
        (await ledgerRows(anya.id)).map((row) => [
          row.model,
          row.taskId !== null,
          row.inputTokens,
          row.outputTokens,
          row.costUsd,
        ]),
      ).toEqual([
        [REFUSE_MODEL, true, 1000, 100, 0.00015],
        [REFUSE_MODEL, true, 1000, 100, 0.00015],
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-5: embeddings are charged to the starter with no grant or quota, refused for a disabled employee, and a call with no employee is platform spend
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-08.1 "Given у Ани нет разрешения на модель эмбеддингов, when самообучение её запуска просит векторы, then векторы получены, а их стоимость
  //   видна в месячном расходе Ани"; AC-08.2 "Given квота Ани на Sonnet исчерпана, when самообучение её запуска просит векторы, then векторы
  //   получены, а расход Ани на Sonnet против квоты не вырос"; AC-08.3 "Given Аня отключена, when функция просит векторы от её имени, then она
  //   получает «недоступно» с причиной «сотрудник отключён», и провайдер не получает запроса"; AC-07.5 "Given функция пересчитывает векторы
  //   после смены модели, when она просит векторы без сотрудника, then векторы получены, а их стоимость записана как расход платформы и не
  //   видна ни в чьём месячном расходе"; AC-07.1 (wiring half: vectors in the order of the texts with the model's id). Design: UC-4, UC-E5, UC-E6,
  //   KD-6, DC-9, Flow 2, Invariant 6.
  // Behavior: platform code calls `Agents.embeddings.embed` -> the real `AccessGate.embedding` (no right, no quota, only "is the employee active"
  //   and "which embedding model is chosen") -> the `EmbeddingClient` double answers vectors and a token count -> one ledger row per batch.
  // Rows:
  //   A. Аня (no grant on the embedding model, Sonnet quota exhausted), 101 texts: 101 vectors in the texts' order with the model id; two ledger
  //      rows (a batch of 100 and a batch of 1) with Аня as owner, input tokens only, zero rates elsewhere, priced at the catalogue's input
  //      price; her monthly spend rose by exactly their sum; her usage against the Sonnet quota did not move
  //   B. Аня disabled: `unavailable` `owner_disabled`; the embedding double received no request; no ledger row
  //   C. no employee (`ownerId: null`): vectors returned; one ledger row with the owner `platform`; no employee's monthly spend changed (checked on
  //      Аня and on a second employee through "Мой доступ")
  // Catches: embeddings refused for lack of a grant the platform never asks anyone for, charged against a chat model's quota (a starter locked
  //   out of Sonnet by the platform's own learning), billed to nobody or to a real employee when no one asked, a disabled employee still spending
  //   money through a background feature, or platform spend that shows up in someone's month.
  // @category: core-functionality
  // @dependency: Agents.embeddings, AccessGate.embedding, AccessService (monthly spend, quota usage), TokenLedger, EmbeddingClient double, catalogue, Postgres
  // @complexity: high
  it(
    'INT-5: embeddings are charged to the starter without grant or quota, refused for a disabled employee, and recorded as platform spend when no employee is named',
    async () => {
      const { app } = harness;
      const logger = app.get<Logger>(LOGGER);
      const embed = (ownerId: string | null, texts: readonly string[]) =>
        harness.agents.embeddings.embed({
          texts,
          inputType: 'document',
          ownerId,
          taskId: null,
          signal: new AbortController().signal,
          logger,
        });
      /** The requests the embedding double received since `start`: `[model, texts, dimensions]`. */
      const requestsSince = (start: number) =>
        harness.embeddings.calls
          .slice(start)
          .map((call) => [call.model, call.texts.length, call.dimensions]);
      /** `GET /api/spend` of the employee: the month's cost. */
      const monthSpend = async (session: Session) =>
        (await chatApi(app, session).spend()).costUsd;
      /** One ledger row of an embedding batch on the case's model: input tokens only, at 1 USD per million. */
      const batchRow = (ownerId: string, inputTokens: number, costUsd: number) => ({
        ownerId,
        taskId: null,
        model: INT5_EMBEDDING_MODEL,
        inputTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd,
      });
      // Given: the case's embedding model (1 USD per million input tokens, 4 dimensions) is the default
      await addModel(app, admin, {
        purpose: 'embedding',
        id: INT5_EMBEDDING_MODEL,
        inputUsdPerMTok: 1,
        dimensions: 4,
      });
      await putDefaults({ embeddingModel: INT5_EMBEDDING_MODEL });
      // And: Аня has no grant on it, and her Sonnet quota of 0.01 USD is spent by an earlier call; Борис is another employee
      await addModel(app, admin, { id: INT5_SONNET, ...HAIKU_TEST_PRICES });
      const anya = await createEmployee(app, admin);
      userIds.push(anya.id);
      const boris = await createEmployee(app, admin);
      userIds.push(boris.id);
      await grantTo(
        app,
        admin,
        { userId: anya.id },
        {
          effect: 'allow',
          target: { kind: 'model', model: INT5_SONNET },
          quotaUsd: 0.01,
        },
      );
      await database.pool.query(
        `INSERT INTO app.runtime_model_calls
           (call_id, owner_id, task_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES ($1, $2, NULL, $3, 0, 0, 0, 0, 0.01)`,
        [randomUUID(), anya.id, INT5_SONNET],
      );
      const sonnetOfAnya = async (): Promise<MyModel | undefined> =>
        (
          await expectBody(
            apiRequest(app, anya, 'get', '/access/models'),
            200,
            MyModelsSchema,
          )
        ).models.find((entry) => entry.model === INT5_SONNET);
      const sonnetBefore = await sonnetOfAnya();
      expect([sonnetBefore?.spentUsd, sonnetBefore?.exhausted]).toEqual([
        0.01,
        true,
      ]);

      // Row A - When: platform code asks vectors of 101 texts (lengths 1..101) on Аня's behalf
      const texts = Array.from({ length: 101 }, (_, index) =>
        'x'.repeat(index + 1),
      );
      const anyaSpendBefore = await monthSpend(anya);
      const requestsBeforeA = harness.embeddings.calls.length;
      const vectors = await embed(anya.id, texts);
      // Then: a vector per text in the texts' order, of unit length, with the model's id (the double answers a text of
      // length L with L, L+1, L+2, L+3)
      const unitVector = (length: number) => {
        const raw = [length, length + 1, length + 2, length + 3];
        const norm = Math.hypot(...raw);
        return raw.map((value) => value / norm);
      };
      expect(vectors).toEqual({
        kind: 'vectors',
        vectors: texts.map((text) => unitVector(text.length)),
        model: INT5_EMBEDDING_MODEL,
        dimensions: 4,
      });
      // And: two requests - a batch of 100 and a batch of 1
      expect(requestsSince(requestsBeforeA)).toEqual([
        [INT5_EMBEDDING_MODEL, 100, 4],
        [INT5_EMBEDDING_MODEL, 1, 4],
      ]);
      // And: a ledger row per batch on Аня, input tokens only (10 per text), at the catalogue's input price
      expect(await ledgerRows(anya.id, INT5_EMBEDDING_MODEL)).toEqual([
        batchRow(anya.id, 1000, 0.001),
        batchRow(anya.id, 10, 0.00001),
      ]);
      // And: her month rose by exactly their sum, and her spend against the Sonnet quota did not move
      expect((await monthSpend(anya)) - anyaSpendBefore).toBeCloseTo(
        0.00101,
        9,
      );
      expect(await sonnetOfAnya()).toEqual(sonnetBefore);

      // Row C - When: platform code asks vectors of 3 texts with no employee
      const monthsBeforeC = [await monthSpend(anya), await monthSpend(boris)];
      const requestsBeforeC = harness.embeddings.calls.length;
      const platformVectors = await embed(null, ['a', 'bb', 'ccc']);
      // Then: vectors returned, one request, one ledger row with the owner `platform`
      expect(
        platformVectors.kind === 'vectors'
          ? [platformVectors.vectors.length, platformVectors.model]
          : platformVectors,
      ).toEqual([3, INT5_EMBEDDING_MODEL]);
      expect(requestsSince(requestsBeforeC)).toEqual([
        [INT5_EMBEDDING_MODEL, 3, 4],
      ]);
      expect(
        await ledgerRows(PLATFORM_OWNER_ID, INT5_EMBEDDING_MODEL),
      ).toEqual([batchRow('platform', 30, 0.00003)]);
      // And: no employee's month changed - Аня's nor Борис's
      expect([await monthSpend(anya), await monthSpend(boris)]).toEqual(
        monthsBeforeC,
      );

      // Row B - When: the administrator blocks Аня, and platform code asks vectors on her behalf
      await expectBody(
        apiRequest(app, admin, 'post', `/admin/users/${anya.id}/block`),
        200,
        AdminUserSummarySchema,
      );
      const requestsBeforeB = harness.embeddings.calls.length;
      const refused = await embed(anya.id, ['INT-5 row B']);
      // Then: unavailable, `owner_disabled`; the double received no request; no new ledger row
      expect(refused).toEqual({
        kind: 'unavailable',
        reason: 'owner_disabled',
        model: null,
        message: `Owner ${anya.id} is disabled or unknown`,
      });
      expect(harness.embeddings.calls.length).toBe(requestsBeforeB);
      expect(await ledgerRows(anya.id, INT5_EMBEDDING_MODEL)).toEqual([
        batchRow(anya.id, 1000, 0.001),
        batchRow(anya.id, 10, 0.00001),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-6: a provider that still has catalogue models is not deleted; a deleted default model clears the choice
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.3 "Given в каталоге есть модель провайдера, when администратор удаляет провайдера, then удаление отклоняется с причиной «у провайдера
  //   есть модели в каталоге», и провайдер остаётся"; DC-6 "Удаление модели, выбранной по умолчанию, снимает этот выбор: модели по умолчанию этого
  //   назначения больше нет, пока администратор не выберет другую". Design: UC-E7, KD-5, Data Model (`access_model_defaults` clears on delete),
  //   Invariants 4 and 5.
  // Behavior: the administrator deletes a provider that has a model -> refused; deletes the model chosen as the chat default -> the choice is
  //   cleared in the same step -> the provider is then deletable.
  // Rows:
  //   1. `DELETE /api/admin/model-providers/:name` of a provider with two catalogue models -> 409 `MODEL_PROVIDER_HAS_MODELS` with `count: 2`;
  //      the provider, its key and its models are still there (GET) and the audit has no delete row
  //   2. the chat default is one of those models: `DELETE /api/admin/models/:id` of it -> 204; `GET /api/admin/model-defaults` shows `chatModel: null`
  //      (the embedding choice untouched); the next conversation start is refused `model_not_configured` (the proof is the same 409 as INT-4 row 1,
  //      reached here by the deletion rather than by an empty database)
  //   3. after the last model is deleted the provider deletes: 204, and it is gone from the list
  // Catches: a provider deleted out from under its models (their runs fail later with `provider_missing` instead of the admin being stopped), a
  //   default pointing at a model that no longer exists (a start on a ghost model), or the choice cleared so late that one more run starts on it.
  // @category: core-functionality
  // @dependency: Agents.providers (delete with `catalogModels` input), AccessService (catalogue, access_model_defaults), AdminModelProvidersController, catalogue controller, AuditLog, Postgres
  // @complexity: medium
  it(
    'INT-6: deleting a provider that still has catalogue models is refused, and deleting the default model clears the default',
    async () => {
      const { app } = harness;
      const providerPath = `/admin/model-providers/${DELETE_PROVIDER}`;
      const modelPath = (id: string) =>
        `/admin/models/${encodeURIComponent(id)}`;
      /** Whether each audit row of the provider is its creation and whether it is its removal. */
      const createdOrRemoved = async () =>
        (await providerAudit(DELETE_PROVIDER)).map((row) => [
          row.before === null,
          row.after === null,
        ]);
      // Given: a keyed provider with two catalogue models; model A is the default chat model, the embedding choice is the run's
      await expectBody(
        apiRequest(app, admin, 'post', '/admin/model-providers', {
          name: DELETE_PROVIDER,
          kind: 'anthropic',
          apiKey: INT6_DELETE_KEY,
        }),
        201,
        ModelProviderViewSchema,
      );
      for (const id of [DELETE_MODEL_A, DELETE_MODEL_B])
        await addModel(app, admin, { id, ...HAIKU_TEST_PRICES });
      await expectBody(
        apiRequest(app, admin, 'put', '/admin/model-defaults', {
          chatModel: DELETE_MODEL_A,
          embeddingModel: RUN_EMBEDDING_MODEL,
        }),
        200,
        ModelDefaultsSchema,
      );

      // Row 1 - When: the administrator deletes the provider
      const refused = await expectBody(
        apiRequest(app, admin, 'delete', providerPath),
        409,
        ProviderHasModelsErrorSchema,
      );
      // Then: refused with the number of its models; the provider, its key and its models stay; no removal in the audit
      expect([refused.errorCode, refused.count]).toEqual([
        'MODEL_PROVIDER_HAS_MODELS',
        2,
      ]);
      const kept = await providerView(DELETE_PROVIDER);
      expect([kept.apiKeySet, kept.apiKeyLast4, kept.catalogModels]).toEqual([
        true,
        'L1m2',
        2,
      ]);
      const catalogueIds = async () =>
        (
          await expectBody(
            apiRequest(app, admin, 'get', '/admin/models'),
            200,
            z.array(CatalogModelSchema),
          )
        )
          .map((entry) => entry.id)
          .filter((id) => id.startsWith(`${DELETE_PROVIDER}/`));
      expect(await catalogueIds()).toEqual([DELETE_MODEL_A, DELETE_MODEL_B]);
      expect(await createdOrRemoved()).toEqual([[true, false]]);

      // Row 2 - When: the administrator deletes model A, the default chat model
      const deletedA = await apiRequest(
        app,
        admin,
        'delete',
        modelPath(DELETE_MODEL_A),
      );
      expect(deletedA.status).toBe(204);
      // Then: the chat choice is cleared in the same step, the embedding choice untouched
      const defaults = await modelDefaults();
      expect([defaults.chatModel, defaults.embeddingModel]).toEqual([
        null,
        RUN_EMBEDDING_MODEL,
      ]);
      // And: the employee's next conversation start is refused for want of a default chat model (the `chat` record is on the default)
      const employeeApi = chatApi(app, employee);
      const { id: thread } = await employeeApi.createThread();
      const refusedStart = await expectBody(
        employeeApi.raw('post', `/threads/${thread}/messages`, {
          text: 'INT-6 row 2: the first message after the default model went',
        }),
        409,
        StartRefusedErrorSchema,
      );
      expect([refusedStart.reason, refusedStart.model]).toEqual([
        'model_not_configured',
        null,
      ]);

      // Row 3 - When: the last model goes, then the provider
      const deletedB = await apiRequest(
        app,
        admin,
        'delete',
        modelPath(DELETE_MODEL_B),
      );
      expect(deletedB.status).toBe(204);
      expect((await providerView(DELETE_PROVIDER)).catalogModels).toBe(0);
      const deletedProvider = await apiRequest(
        app,
        admin,
        'delete',
        providerPath,
      );
      // Then: 204, gone from the list and from reads, and the audit holds its creation and its removal
      expect(deletedProvider.status).toBe(204);
      expect((await providerNames()).includes(DELETE_PROVIDER)).toBe(false);
      expect(
        (await expectError(apiRequest(app, admin, 'get', providerPath), 404))
          .errorCode,
      ).toBe('MODEL_PROVIDER_NOT_FOUND');
      expect(await createdOrRemoved()).toEqual([
        [true, false],
        [false, true],
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-7: a record with no model starts on the current default; a run already started does not follow a change
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-06.1 "Given администратор сменил модель чата по умолчанию на Sonnet, when автор создаёт новую запись агента, then в ней стоит Sonnet";
  //   DC-7 "Встроенная запись с моделью `null` стартует на модели чата по умолчанию на момент старта; запуск, который уже идёт, смену не замечает".
  //   Design: UC-3, KD-5, run-snapshot pattern (ADR-0017).
  // Behavior: a library record is saved with `model: null` -> a run starts: `resolveStart` replaces `null` with the default chat model into the
  //   snapshot -> the administrator changes the default -> the running agent's next calls and its subagents started later in that run use
  //   the snapshot's model; a NEW start takes the new default.
  // Rows:
  //   1. default = Haiku; a built-in-style record with `model: null` (a record created by an author with no model chosen is the same row): the
  //      scripted model's call carries the Haiku id
  //   2. the administrator sets the default to Sonnet while that run is held at a latch: its next call and a subagent the run starts after the
  //      change still carry Haiku (the snapshot); a second run of the same record started after the change carries Sonnet
  //   3. a record created after the change by an author with no model chosen: `GET` of it holds Sonnet (AC-06.1), a record with a model of its
  //      own is untouched by the change
  // Catches: `null` resolved late - on every call instead of at start - so a default change flips a run in the middle (a user's agent changes
  //   model and price while it works), or `null` resolved never (the model id sent empty), or built-in records that keep the old model after the
  //   default moves.
  // @category: core-functionality
  // @dependency: resolveStart, run snapshot, AccessGate.defaultChatModel, LibraryService, AdminModelDefaults route, scripted AGENT_TURN_CLIENT (recorder, latch), Postgres
  // @complexity: medium
  it(
    'INT-7: a record with a null model starts on the current default model and a run already started keeps the model it began with',
    async () => {
      const { app } = harness;
      // Given: Haiku and Sonnet of the run in the catalogue, Вера allowed both, Haiku the default chat model
      for (const id of [INT7_HAIKU, INT7_SONNET])
        await addModel(app, admin, { id, ...HAIKU_TEST_PRICES });
      const vera = await employeeAllowed('mp-int7', [INT7_HAIKU, INT7_SONNET]);
      const veraApi = chatApi(app, vera);
      await putDefaults({ chatModel: INT7_HAIKU });
      // And: Вера's deep agent record with no model of its own (like a built-in record), and her agent record with Haiku chosen
      const deepAgent = await createRecord(
        app,
        vera,
        nullModelDeepAgent(recordName('INT-7 deep agent')),
      );
      if (deepAgent.kind !== 'deep_agent')
        throw new Error('INT-7: the deep agent record is not a deep agent');
      const subagentName = deepAgent.content.subagents[0]?.name ?? '';
      const ownModel = await createRecord(
        app,
        vera,
        agentBody(recordName('INT-7 own model'), { model: INT7_HAIKU }),
      );
      /** Every script answers its calls past the listed ones, so no step fails on an unscripted report. */
      const answered = { thereafter: { text: 'INT-7: принято' } };
      const startDeepAgent = (question: string): ScriptedToolCall => ({
        tool: 'start_deep_agent',
        args: { deepAgent: deepAgent.id, question, boundaries: '', result: '' },
      });
      /** The deep agent's task: the brief as `start_deep_agent` writes it. */
      const briefTask = (question: string) =>
        JSON.stringify({ question, boundaries: '', result: '' });
      /** Вера's first message in a new conversation; she approves the brief its chat asks for. */
      const runDeepAgent = async (text: string) => {
        const { id } = await veraApi.createThread();
        await veraApi.send(id, text);
        const isOpenBrief = (decision: { kind: string; status: string }) =>
          decision.kind === AGENTS_BRIEF_CONFIRMATION &&
          decision.status === 'open';
        const view = await waitFor(
          () => veraApi.history(id),
          (current) => current.decisions.some(isOpenBrief),
          `the brief of "${text}"`,
        );
        const brief = view.decisions.find(isOpenBrief);
        if (brief === undefined) throw new Error(`INT-7: no brief for "${text}"`);
        await veraApi.decide(brief.decisionId, { approve: true });
      };

      // Row 1 - When: Вера's chat (the built-in `chat` record on `null`) starts her deep agent; its first call is held
      const firstText = 'INT-7 row 1: Вера запускает глубокого агента без своей модели';
      const firstQuestion = 'INT-7 row 1: вопрос первого запуска';
      const subagentTask = 'INT-7 row 2: задача сабагента после смены';
      const latch = createLatch();
      const firstChat = harness.model.script(
        { task: firstText },
        [{ calls: [startDeepAgent(firstQuestion)] }],
        answered,
      );
      const firstDeepAgent = harness.model.script(
        { task: briefTask(firstQuestion) },
        [
          {
            calls: [
              {
                tool: 'task',
                args: { subagentType: subagentName, description: subagentTask },
              },
            ],
            latch,
          },
        ],
        answered,
      );
      // The subagent's one `task` entry: the question of the brief as its labelled line, then the assignment
      const subagent = harness.model.script(
        { task: `Question: ${firstQuestion}\n\n${subagentTask}` },
        [],
        answered,
      );
      try {
        await runDeepAgent(firstText);
        await latch.reached(1);
        // Then: the chat and the deep agent called Haiku, the default at their start
        expect([
          firstChat.calls[0]?.model,
          firstDeepAgent.calls[0]?.model,
        ]).toEqual([INT7_HAIKU, INT7_HAIKU]);
        // Row 2 - When: the administrator sets Sonnet as the default while the run is held
        await putDefaults({ chatModel: INT7_SONNET });
      } finally {
        latch.open();
      }
      // Then: the deep agent's next call and the subagent it starts after the change still call Haiku (the snapshot)
      await subagent.called(1);
      await firstDeepAgent.called(2);
      expect([
        firstDeepAgent.calls[1]?.model,
        subagent.calls[0]?.model,
      ]).toEqual([INT7_HAIKU, INT7_HAIKU]);
      // When: a second run of the same records starts after the change
      const secondText = 'INT-7 row 2: второй запуск после смены';
      const secondQuestion = 'INT-7 row 2: вопрос второго запуска';
      const secondChat = harness.model.script(
        { task: secondText },
        [{ calls: [startDeepAgent(secondQuestion)] }],
        answered,
      );
      const secondDeepAgent = harness.model.script(
        { task: briefTask(secondQuestion) },
        [],
        answered,
      );
      await runDeepAgent(secondText);
      await secondDeepAgent.called(1);
      // Then: its chat and its deep agent call Sonnet
      expect([
        secondChat.calls[0]?.model,
        secondDeepAgent.calls[0]?.model,
      ]).toEqual([INT7_SONNET, INT7_SONNET]);

      // Row 3 - When: after the change Вера opens the editor of a new record (it takes the model of `choices`, as the web
      // does) and saves it with no model of her own choosing
      const choices = await expectBody(
        apiRequest(app, vera, 'get', '/library/choices'),
        200,
        LibraryChoicesSchema,
      );
      const created = await createRecord(
        app,
        vera,
        agentBody(recordName('INT-7 row 3'), { model: choices.defaultModel }),
      );
      // Then: the editor offered Sonnet, the new record holds Sonnet, and the record with its own Haiku is untouched
      const modelOf = (record: RecordDetail) =>
        record.kind === 'agent' ? record.content.model : undefined;
      expect([
        choices.defaultModel,
        modelOf(await getRecord(app, vera, created.id)),
        modelOf(await getRecord(app, vera, ownModel.id)),
      ]).toEqual([INT7_SONNET, INT7_SONNET, INT7_HAIKU]);
    },
    TEST_TIMEOUT_MS,
  );
});
