import type { INestApplication } from '@nestjs/common';
import {
  AdminUserDetailSchema,
  CreateCatalogModelBodySchema,
  GrantSchema,
  RoleSummarySchema,
  type CatalogModel,
  type GrantEffect,
  type GrantTargetBody,
  type LongContext,
  type PriceRates,
} from '@agent-os/contracts';
import type { DatabaseConnection } from '@agent-os/db';
import type { App } from 'supertest/types.js';
import { expectBody } from './api.js';
import { runName } from './mcp-servers.js';
import { apiRequest, type Session } from './session.js';

/**
 * The model catalogue and rights of the tests (design-access.md; plan rule 11). The suites run on the developer's
 * database, whose catalogue holds the developer's own models and whose built-in role holds his rights (`seed:access`),
 * and on an empty catalogue in CI. So a suite never names, changes or grants a row it did not make: every model is
 * `runModel(base)`, every role is `<name>-t<runId>`, both made through the admin operations and removed by the suite
 * (and by the global teardown). The test administrator of `seedSuperAdmin` sits in the built-in role and so sees the
 * developer's rights: no test asserts anything about the administrator's own rights.
 */

/** The run's model id: `anthropic/<base>-t<runId>`. */
export function runModel(base: string): string {
  return `anthropic/${runName(base)}`;
}

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

/** Adds a model to the catalogue through `POST /api/admin/models`; the name is the id unless given. */
export function addModel(
  app: TestApp,
  admin: Session,
  model: ModelPrices & { readonly id: string; readonly name?: string },
): Promise<CatalogModel> {
  return expectBody(
    apiRequest(app, admin, 'post', '/admin/models', {
      id: model.id,
      name: model.name ?? model.id,
      prices: model.prices,
      longContext: model.longContext ?? null,
    }),
    201,
    CreateCatalogModelBodySchema,
  );
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
 * Deletes the rows a suite made, by id: models (their grants go by cascade) and roles (their members and grants go
 * by cascade).
 */
export async function removeRunRows(
  pool: DatabaseConnection['pool'],
  rows: {
    readonly models: readonly string[];
    readonly roles: readonly string[];
  },
): Promise<void> {
  await pool.query('DELETE FROM app.access_models WHERE id = ANY($1::text[])', [
    rows.models,
  ]);
  await pool.query(
    'DELETE FROM app.identity_roles WHERE id = ANY($1::uuid[]) AND NOT builtin',
    [rows.roles],
  );
}
