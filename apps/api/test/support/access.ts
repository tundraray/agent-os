import type { INestApplication } from '@nestjs/common';
import {
  AdminUserDetailSchema,
  ApiErrorSchema,
  CatalogModelSchema,
  GrantSchema,
  ModelDefaultsSchema,
  ModelProviderErrorCode,
  ModelProviderViewSchema,
  RoleSummarySchema,
  modelProvider,
  type CatalogModel,
  type GrantEffect,
  type GrantTargetBody,
  type LongContext,
  type ModelProviderKind,
  type PriceRates,
} from '@agent-os/contracts';
import type { DatabaseConnection } from '@agent-os/db';
import type { App } from 'supertest/types.js';
import { z } from 'zod';
import { expectBody } from './api';
import { runName } from './mcp-servers';
import { apiRequest, type Session } from './session';

/**
 * The model providers, catalogue, default models and rights of the tests (design-access.md; model-providers
 * design-core.md, Test Strategy). The suites run on the developer's database, whose providers, catalogue and default
 * models are the developer's own and whose built-in role holds his rights (`seed:access`), and on an empty database in
 * CI. So a suite never names, changes or grants a row it did not make: its providers are `runProvider()` and
 * `runEmbeddingProvider()` (never the developer's `anthropic`), its models `runModel(base)` and
 * `runEmbeddingModel(base)`, its roles `<name>-t<runId>`, all made through the admin operations.
 *
 * The one shared row a suite changes is the default models (the key `model_defaults` of `settings`, one row per database):
 * `useRunModels` points them at the run's models and returns the restore, which the suite runs in `afterAll` before
 * `removeRunRows`. Who creates and who removes what:
 *   - run providers: created by `useRunModels` (once per run; a later suite finds them), removed by the global teardown
 *     (`migrate.global-setup.ts`);
 *   - run models: created by `useRunModels` / `addModel`, removed by the suite's `removeRunRows` (and the teardown);
 *   - default models: set by `useRunModels`, set back by the restore it returns.
 * Only an aborted run leaves the developer's default models on the run's models (`null` once the teardown deletes
 * them): `pnpm --filter api seed:access` fills an empty default again, or the administrator sets one with
 * `PUT /api/admin/model-defaults`. The test administrator of `seedSuperAdmin` sits in the built-in role and so sees the
 * developer's rights: no test asserts anything about the administrator's own rights.
 */

/** The run's chat provider: `run-t<runId>`, of the kind `anthropic`. */
function runProvider(): string {
  return runName('run');
}

/** The run's embedding provider: `run-embed-t<runId>`, of the kind `gemini` (the kind `anthropic` serves no embeddings). */
function runEmbeddingProvider(): string {
  return runName('run-embed');
}

/** The run's chat model id: `run-t<runId>/<base>-t<runId>`. */
export function runModel(base: string): string {
  return `${runProvider()}/${runName(base)}`;
}

/** The run's embedding model id: `run-embed-t<runId>/<base>-t<runId>`. */
export function runEmbeddingModel(base: string): string {
  return `${runEmbeddingProvider()}/${runName(base)}`;
}

/** The fake key of the run's providers: the scripted doubles answer every call, so it never reaches a provider. */
const RUN_PROVIDER_KEY = 'run-provider-fake-key';

/** Prices of a catalogue model as `POST /api/admin/models` takes them. */
export interface ModelPrices {
  readonly prices: PriceRates;
  /** Omitted or `null` — one price. */
  readonly longContext?: LongContext | null;
}

/**
 * Haiku's prices of the former price file, on which the chat suite's spend literals are computed: input 0.1, output
 * 0.5, cache write 0.125, cache read 0.01 USD per MTok; above 100 000 input tokens 0.5 / 2.5 / 0.625 / 0.05.
 */
export const HAIKU_TEST_PRICES: ModelPrices = {
  prices: {
    inputUsdPerMTok: 0.1,
    outputUsdPerMTok: 0.5,
    cacheWriteUsdPerMTok: 0.125,
    cacheReadUsdPerMTok: 0.01,
  },
  longContext: {
    aboveInputTokens: 100_000,
    prices: {
      inputUsdPerMTok: 0.5,
      outputUsdPerMTok: 2.5,
      cacheWriteUsdPerMTok: 0.625,
      cacheReadUsdPerMTok: 0.05,
    },
  },
};

type TestApp = INestApplication<App>;

/** A chat model as `addModel` takes it. */
export type ChatModelInput = ModelPrices & {
  readonly id: string;
  readonly name?: string;
};

/** An embedding model as `addModel` takes it. */
export interface EmbeddingModelInput {
  readonly purpose: 'embedding';
  readonly id: string;
  readonly name?: string;
  readonly inputUsdPerMTok: number;
  readonly dimensions: number;
}

/**
 * Adds a model to the catalogue through `POST /api/admin/models`: a chat model unless `purpose: 'embedding'`; the name
 * is the id unless given. The model's provider must be registered (`useRunModels` registers the run's).
 */
export function addModel(
  app: TestApp,
  admin: Session,
  model: ChatModelInput | EmbeddingModelInput,
): Promise<CatalogModel> {
  const name = model.name ?? model.id;
  const body =
    'purpose' in model
      ? {
          purpose: model.purpose,
          id: model.id,
          name,
          inputUsdPerMTok: model.inputUsdPerMTok,
          dimensions: model.dimensions,
        }
      : {
          purpose: 'chat',
          id: model.id,
          name,
          prices: model.prices,
          longContext: model.longContext ?? null,
        };
  return expectBody(
    apiRequest(app, admin, 'post', '/admin/models', body),
    201,
    CatalogModelSchema,
  );
}

/** `GET /api/admin/models`, 200: the ids of the catalogue. */
export async function catalogueModelIds(
  app: TestApp,
  admin: Session,
): Promise<Set<string>> {
  const models = await expectBody(
    apiRequest(app, admin, 'get', '/admin/models'),
    200,
    z.array(CatalogModelSchema),
  );
  return new Set(models.map((model) => model.id));
}

/**
 * Registers a run provider through `POST /api/admin/model-providers`, enabled and with the run's fake key; a 409
 * `MODEL_PROVIDER_NAME_TAKEN` means an earlier suite of the run has registered it.
 */
async function registerRunProvider(
  app: TestApp,
  admin: Session,
  provider: { readonly name: string; readonly kind: ModelProviderKind },
): Promise<void> {
  const response = await apiRequest(
    app,
    admin,
    'post',
    '/admin/model-providers',
    { ...provider, apiKey: RUN_PROVIDER_KEY },
  );
  if (
    response.status === 409 &&
    ApiErrorSchema.parse(response.body).errorCode ===
      ModelProviderErrorCode.MODEL_PROVIDER_NAME_TAKEN
  )
    return;
  await expectBody(response, 201, ModelProviderViewSchema);
}

/** `PUT /api/admin/model-defaults`, 200. */
function putModelDefaults(
  app: TestApp,
  admin: Session,
  defaults: {
    readonly chatModel: string | null;
    readonly embeddingModel: string | null;
  },
) {
  return expectBody(
    apiRequest(app, admin, 'put', '/admin/model-defaults', defaults),
    200,
    ModelDefaultsSchema,
  );
}

/**
 * Makes the run's models the platform's default models (FR-02: a start reads the default chat model from the
 * database): registers the provider of each model (`run-t<runId>` of the kind `anthropic`, `run-embed-t<runId>` of
 * the kind `gemini`), adds the models (`addModel`) and sets them through `PUT /api/admin/model-defaults`; without
 * `embedding` the default embedding model stays as it is. `chat.id` is a `runModel(base)`, `embedding.id` a
 * `runEmbeddingModel(base)`; rights are the suite's (`allowRole`, `grantTo`). Returns the restore: it sets back the
 * default models read before, each only while it is still in the catalogue, otherwise `null` (not chosen). Run it in
 * `afterAll` while the app lives, before `removeRunRows` removes the models.
 */
export async function useRunModels(
  app: TestApp,
  admin: Session,
  models: {
    readonly chat: ChatModelInput;
    readonly embedding?: Omit<EmbeddingModelInput, 'purpose'>;
  },
): Promise<() => Promise<void>> {
  const before = await expectBody(
    apiRequest(app, admin, 'get', '/admin/model-defaults'),
    200,
    ModelDefaultsSchema,
  );
  await registerRunProvider(app, admin, {
    name: modelProvider(models.chat.id),
    kind: 'anthropic',
  });
  await addModel(app, admin, models.chat);
  if (models.embedding !== undefined) {
    await registerRunProvider(app, admin, {
      name: modelProvider(models.embedding.id),
      kind: 'gemini',
    });
    await addModel(app, admin, { ...models.embedding, purpose: 'embedding' });
  }
  await putModelDefaults(app, admin, {
    chatModel: models.chat.id,
    embeddingModel: models.embedding?.id ?? before.embeddingModel,
  });
  return async () => {
    const catalogue = await catalogueModelIds(app, admin);
    const kept = (model: string | null) =>
      model !== null && catalogue.has(model) ? model : null;
    await putModelDefaults(app, admin, {
      chatModel: kept(before.chatModel),
      embeddingModel: kept(before.embeddingModel),
    });
  };
}

/** The holder of a grant: a role or one employee. */
export type GrantHolder =
  { readonly roleId: string } | { readonly userId: string };

/** Gives `holder` a right or a deny through `POST /api/admin/grants`. */
export function grantTo(
  app: TestApp,
  admin: Session,
  holder: GrantHolder,
  grant: {
    readonly effect: GrantEffect;
    readonly target: GrantTargetBody;
    readonly quotaUsd?: number | null;
  },
) {
  return expectBody(
    apiRequest(app, admin, 'post', '/admin/grants', { ...holder, ...grant }),
    201,
    GrantSchema,
  );
}

/** A role of the run with its rights. */
export interface RunRole {
  readonly id: string;
  /** Puts the employee into the role through `PUT /api/admin/users/:id/roles/:roleId`. */
  add(employee: { readonly id: string }): Promise<void>;
}

/**
 * Creates the role `<name>-t<runId>` through `POST /api/admin/roles` and allows it each model and each server (all
 * of its tools) without a quota. The servers must already be in the registry.
 */
export async function allowRole(
  app: TestApp,
  admin: Session,
  role: {
    readonly name: string;
    readonly models: readonly string[];
    readonly servers: readonly string[];
  },
): Promise<RunRole> {
  const { id } = await expectBody(
    apiRequest(app, admin, 'post', '/admin/roles', {
      name: runName(role.name),
    }),
    201,
    RoleSummarySchema,
  );
  const targets: GrantTargetBody[] = [
    ...role.models.map((model) => ({ kind: 'model' as const, model })),
    ...role.servers.map((server) => ({ kind: 'server' as const, server })),
  ];
  for (const target of targets)
    await grantTo(app, admin, { roleId: id }, { effect: 'allow', target });
  return {
    id,
    add: async (employee) => {
      await expectBody(
        apiRequest(
          app,
          admin,
          'put',
          `/admin/users/${employee.id}/roles/${id}`,
        ),
        200,
        AdminUserDetailSchema,
      );
    },
  };
}

/**
 * Deletes the rows a suite made, by id: models (their grants go by cascade), roles (their members and grants go
 * by cascade) and employees with their audit records; what an employee owns — conversations, agent trees, ledger
 * rows, sessions, role memberships and personal grants — goes by the cascade of the owner's foreign keys. Run it after the app is closed, so no worker writes behind it.
 * The employees' conversations go first: a conversation holds its agent version by a restrict key, and one employee's
 * conversation may stand on a version of another employee's agent, which the cascade of that owner would delete.
 */
export async function removeRunRows(
  pool: DatabaseConnection['pool'],
  rows: {
    readonly models: readonly string[];
    readonly roles: readonly string[];
    readonly users?: readonly string[];
  },
): Promise<void> {
  const users = rows.users ?? [];
  await pool.query(
    'DELETE FROM app.audit_events WHERE actor = ANY($1::text[]) OR object_id = ANY($1::text[])',
    [users],
  );
  await pool.query(
    'DELETE FROM app.conversations WHERE owner_id = ANY($1::uuid[])',
    [users],
  );
  await pool.query(
    'DELETE FROM app.identity_users WHERE id = ANY($1::uuid[])',
    [users],
  );
  await pool.query('DELETE FROM app.models WHERE id = ANY($1::text[])', [
    rows.models,
  ]);
  await pool.query(
    'DELETE FROM app.identity_roles WHERE id = ANY($1::uuid[]) AND NOT builtin',
    [rows.roles],
  );
}

/** One `access_denied` (or other) audit record as the assertions read it. */
export interface AuditRecord {
  readonly actor: string;
  readonly objectId: string | null;
  readonly outcome: string;
  readonly reason: string | null;
}

/**
 * The audit records of `kind` and `objectType` whose actor is one of `actors`, in the order written. The kind
 * `access_denied` is shared with the administrator-route refusals of identity, so rows of tools and models are
 * told apart by `objectType`.
 */
export async function auditOf(
  pool: DatabaseConnection['pool'],
  filter: {
    readonly kind: string;
    readonly objectType: string;
    readonly actors: readonly string[];
  },
): Promise<AuditRecord[]> {
  const { rows } = await pool.query<AuditRecord>(
    `SELECT actor, object_id AS "objectId", outcome, reason FROM app.audit_events
      WHERE kind = $1 AND object_type = $2 AND actor = ANY($3::text[]) ORDER BY at, id`,
    [filter.kind, filter.objectType, filter.actors],
  );
  return rows;
}

/**
 * The cost in USD of each model call an agent of `ownerId` made on `model`, by time (`runtime_model_calls`). Calls
 * outside a task (the conversation title) are left out: their cost is a line of its own.
 */
export async function spendOf(
  pool: DatabaseConnection['pool'],
  ownerId: string,
  model: string,
): Promise<number[]> {
  const { rows } = await pool.query<{ costUsd: string }>(
    `SELECT cost_usd AS "costUsd" FROM app.runtime_model_calls
      WHERE owner_id = $1 AND model = $2 AND task_id IS NOT NULL ORDER BY called_at, call_id`,
    [ownerId, model],
  );
  return rows.map((row) => Number(row.costUsd));
}
