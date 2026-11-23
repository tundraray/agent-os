// data-model / schema - integration skeleton (real Postgres, one scratch database migrated by the initial set)
// Design Doc: docs/features/data-model/design-schema.md, Test Strategy UC-8 (covers DC-12).
// No PRD and no UXRD for this feature (owner's decision): the Design Doc's acceptance criteria are the source.
// Test Type: Integration. Budget of the part: 4 of 3 integration skeletons (this file 1, packages/agents 1, apps/api 2), 0 E2E.
//   The fourth is the first-save race of the public address (apps/api file); it names a defect no other test catches (the
//   shared file header lists it) and stays within the 5 the budget allows for a named defect.
// Implementation timing: with step 3 of the Design Doc's build order (references, owners). First run: the feature's full run.
//
// File name and place follow the package convention: `test/*.e2e-spec.ts`, picked up by `vitest.config.e2e.ts` (no migration
// setup: the row migrates its own scratch database through `ScratchDatabases`); the `.int.` infix marks it as integration.
// Do NOT run it against the development database (packages/db/CLAUDE.md).
//
// Already proven elsewhere and NOT repeated here:
// - DC-9 table names, DC-10 "an empty database gets the schema once" and the CHECK domains: `migrations.e2e-spec.ts`,
//   adapted by the build (APP_TABLES, constraint names). `pnpm db:generate` on an unchanged schema
//   creating nothing is a CI command, not a vitest case.
// - DC-5 "every settings row exists and passes its key's schema": every API suite reads `sign_in_settings` on each request and the
//   group suites read their own key from the migrated database; a missing or invalid seed breaks them all. No test of its own.
// - DC-13, a task and a ledger row of the platform are written without an owner: the `knowledge.embed` task of INT-11 in
//   `packages/agents/test/self-learning-core.int.e2e-spec.ts` and the ledger row of INT-5 row C in
//   `apps/api/test/model-providers-core.int.e2e-spec.ts`, both written by the real code.
// - DC-11 (runtime imports no table) is the lint of `packages/runtime`. DC-15 (dropped columns are absent) has no test:
//   `typecheck` shows only that no code names a dropped column; that the columns are gone is checked by the schema review.
// - Row counts, column lists and the names of foreign keys are not asserted: that would restate the schema file.
//
// Mock boundary: none. Real Postgres, the real migrator, raw SQL inserts.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/index';
import { ScratchDatabases, withDatabase } from './support/scratch-db';

/** Creating, migrating and dropping a scratch database. */
const ROW_TIMEOUT_MS = 120_000;

/** SQLSTATE of a refused reference and of a missing required value. */
const FOREIGN_KEY_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';

/** The SQLSTATE a statement fails with, or `'accepted'`. */
async function outcomeOf(
  client: pg.Client,
  sql: string,
  params: unknown[],
): Promise<string> {
  try {
    await client.query(sql, params);
    return 'accepted';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

const insertTask = `INSERT INTO app.runtime_tasks (task_id, type, owner_id, root_id, depth, input)
  VALUES ($1, 'dc12.test', $2, $1, 0, '{}')`;

/** Version 1 of the default agent `chat`, a row of the built-in rows migration (data-model design-agents.md, KD-4). */
const CHAT_VERSION_ID = '90a4ae92-8807-4f4c-91da-83edcf45b5f0';

const insertRootConversation = `INSERT INTO app.conversations
  (id, owner_id, parent_id, start_call_id, title, updated_at, name, description, model, agent_version_id)
  VALUES ($1, $2, $3, $4, $5, $6, 'chat', '', 'p/m', $7)`;

const insertLedgerRow = `INSERT INTO app.runtime_model_calls
  (call_id, owner_id, task_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
  VALUES ($1, $2, NULL, 'p/m', 1, 0, 0, 0, 0)`;

const insertGrant = `INSERT INTO app.access_grants (user_id, effect, target_kind, server) VALUES ($1, 'allow', 'server', $2)`;

describe('data-model / schema: the database holds the references the design names', () => {
  // AC (DC-12): "База отказывает строке, чей владелец не сотрудник, чей родитель не беседа, или праву на незарегистрированный
  //   сервер MCP; удаление сервера MCP удаляет права на него."
  // Behavior: a scratch database migrated by the initial set -> raw INSERTs with a dangling reference (UC-8) -> the database
  //   rejects each with a foreign-key violation and the table stays unchanged; a null owner is refused for a conversation;
  //   deleting a registered MCP server removes its grants in the same statement.
  // Catches: a reference left as free text or a missing foreign key - an invented owner id, a parent that is no conversation or a
  //   grant on a server nobody registered is stored and the isolation rules built on those rows silently stop meaning anything;
  //   a server delete that leaves orphan grants now that no code removes them by hand.
  // Verification items (rows of one table-driven case, one scratch database, cases do not share rows):
  // - conversations: owner that is not in `identity_users`, parent that is not a conversation, null owner -> each rejected
  // - runtime_tasks and runtime_model_calls: owner that is not in `identity_users` -> rejected
  // - mcp_accounts: owner that is not in `identity_users` -> rejected
  // - access_grants: a grant on a server name that is not in `mcp_servers` -> rejected
  // - access_grants: delete the registered server -> its grants are gone, grants of another server stay
  // - models: delete a provider that still has a model -> refused by the database (restrict)
  // @category: core-functionality
  // @dependency: migrations (initial set), Postgres
  // @complexity: medium
  const scratch = new ScratchDatabases();
  let url: string;

  beforeAll(async () => {
    url = await scratch.create();
    await applyMigrations(url);
  }, ROW_TIMEOUT_MS);

  afterAll(() => scratch.dropAll(), ROW_TIMEOUT_MS);

  it(
    'DC-12: the database rejects a foreign owner, a missing parent, a conversation without an owner and a grant on an unregistered server, and a server delete removes its grants',
    async () => {
      await withDatabase(url, async (client) => {
        // Given: one employee, one task of hers, two registered MCP servers, a provider with a model
        const {
          rows: [employee],
        } = await client.query<{ id: string }>(
          `INSERT INTO app.identity_users (email, login) VALUES ('dc12@test.local', 'dc12') RETURNING id`,
        );
        const taskId = randomUUID();
        await client.query(insertTask, [taskId, employee.id]);
        for (const server of ['dc12-logs', 'dc12-other']) {
          await client.query(
            `INSERT INTO app.mcp_servers (name, url, mode, shared_token) VALUES ($1, 'http://localhost', 'shared', 't')`,
            [server],
          );
          await client.query(insertGrant, [employee.id, server]);
        }
        await client.query(
          `INSERT INTO app.model_providers (name, kind) VALUES ('dc12', 'anthropic')`,
        );
        await client.query(
          `INSERT INTO app.models (id, provider, name, input_usd_per_mtok, output_usd_per_mtok,
             cache_write_usd_per_mtok, cache_read_usd_per_mtok) VALUES ('dc12/m', 'dc12', 'M', 0, 0, 0, 0)`,
        );
        const nobody = randomUUID();
        const root = (ownerId: string | null, parentId: string | null) => [
          taskId,
          ownerId,
          parentId,
          parentId === null ? null : 'call-1',
          parentId === null ? '' : null,
          parentId === null ? new Date() : null,
          CHAT_VERSION_ID,
        ];

        // When: each statement is tried on its own
        const rows: [string, string, unknown[], string][] = [
          [
            'conversation of an owner who is no employee',
            insertRootConversation,
            root(nobody, null),
            FOREIGN_KEY_VIOLATION,
          ],
          [
            'conversation whose parent is no conversation',
            insertRootConversation,
            root(employee.id, randomUUID()),
            FOREIGN_KEY_VIOLATION,
          ],
          [
            'conversation without an owner',
            insertRootConversation,
            root(null, null),
            NOT_NULL_VIOLATION,
          ],
          [
            'task of an owner who is no employee',
            insertTask,
            [randomUUID(), nobody],
            FOREIGN_KEY_VIOLATION,
          ],
          [
            'ledger row of an owner who is no employee',
            insertLedgerRow,
            [randomUUID(), nobody],
            FOREIGN_KEY_VIOLATION,
          ],
          [
            'mcp account of an owner who is no employee',
            `INSERT INTO app.mcp_accounts (owner_id, server, access_token) VALUES ($1, 'dc12-logs', 't')`,
            [nobody],
            FOREIGN_KEY_VIOLATION,
          ],
          [
            'grant on an unregistered server',
            insertGrant,
            [employee.id, 'dc12-nobody'],
            FOREIGN_KEY_VIOLATION,
          ],
          [
            'delete of a provider that has a model',
            `DELETE FROM app.model_providers WHERE name = $1`,
            ['dc12'],
            FOREIGN_KEY_VIOLATION,
          ],
        ];
        const outcomes: Record<string, string> = {};
        for (const [name, sql, params] of rows)
          outcomes[name] = await outcomeOf(client, sql, params);

        // Then: each is refused as the design's references say
        expect(outcomes).toEqual(
          Object.fromEntries(
            rows.map(([name, , , expected]) => [name, expected]),
          ),
        );

        // When: a registered server is deleted; Then: its grants are gone, the other server's stay
        await client.query(
          `DELETE FROM app.mcp_servers WHERE name = 'dc12-logs'`,
        );
        const { rows: grants } = await client.query<{ server: string }>(
          "SELECT server FROM app.access_grants WHERE server LIKE 'dc12-%' ORDER BY server",
        );
        expect(grants).toEqual([{ server: 'dc12-other' }]);
      });
    },
    ROW_TIMEOUT_MS,
  );
});
