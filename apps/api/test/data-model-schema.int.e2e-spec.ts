// data-model / schema - integration skeletons (real AppModule + real Postgres)
// Design Doc: docs/features/data-model/design-schema.md, Test Strategy UC-6 (covers DC-6, DC-8).
// No PRD and no UXRD for this feature (owner's decision): the Design Doc's acceptance criteria are the source.
// Test Type: Integration. Budget of the part: 4 of 3 integration skeletons (packages/db 1, packages/agents 1, this file 2), 0 E2E.
//   The first-save race below is the extra one: it names the lost-write defect that nothing else can see (a repository
//   test sees one statement, a PUT test sees one request), and the 5-test ceiling allows it for a named defect.
// Implementation timing: with step 2 of the Design Doc's build order (the settings table, the registry and the service).
// First run: the feature's full run, after the last part.
//
// File name and place follow the package convention: `test/*.e2e-spec.ts` with the `.int.` infix, picked up by
// `vitest.config.e2e.ts`; harness `createTestApp` and the admin helpers of `test/support/*`, as in `enterprise-access-identity.int.e2e-spec.ts`.
// The suite shares one migrated database: each case uses its own employees and restores the settings it changed.
//
// Already proven elsewhere and NOT repeated here (these suites are adapted by the build to the new names, one owner type
// and one deletion mark, not duplicated):
// - DC-5, the four settings rows exist and pass their key's schema: every request runs the sign-in settings read, the group suites read
//   their own key; a missing or invalid seed breaks them. The `updatedAt: null` mapping is not asserted separately.
// - DC-6 for `sign_in_settings` (the write with its `admin_change`, the new session limits acting from the next request, a refused
//   value changing nothing): INT-1 row 7 of `enterprise-access-identity.int.e2e-spec.ts`.
// - DC-6, a non-admin PUT answering 403 `ADMIN_REQUIRED` and an out-of-bounds `library_settings` value answering 400: INT-1 row 3 of
//   `custom-agents-library.int.e2e-spec.ts`.
// - DC-7, deleting the default model empties it and the start answers `model_not_configured`: INT-6 and INT-7 of `model-providers-core.int.e2e-spec.ts`.
// - DC-3, DC-4, DC-14: INT-2 A, INT-3 A, INT-3 C and INT-4 of `agent-platform-chat.int.e2e-spec.ts`, INT-4 and INT-5 D of
//   `packages/runtime/test/agent-platform-runtime.int.e2e-spec.ts`, INT-4 of `packages/agents/test/agent-platform-agents.int.e2e-spec.ts`;
//   the build adds "the deletion mark is on every task of the tree and the conversation row is unchanged" to INT-3 A.
// - DC-13, the platform's own work without an owner: INT-5 row C of `model-providers-core.int.e2e-spec.ts` (a ledger row
//   without an owner is nobody's spend).
// - Unit level (`provenAt: unit`, table-driven, cases as rows): the bounds and the rule between fields of the sign-in settings
//   (`sign-in-settings.spec.ts`), the first save of the public address with its losing branch (`identity-settings.spec.ts`), and
//   the registry's "a stored value that fails its key's schema is a failure, not a default" - one unit case of the registry in
//   `@agent-os/contracts`.
//
// Mock boundary: the model is the scripted double; AuditLog, the settings service, the repositories and Postgres are real.

import { randomUUID } from 'node:crypto';
import {
  LibrarySettingsSchema,
  ModelDefaultsSchema,
  ToolResultSettingsSchema,
  type SettingsKey,
} from '@agent-os/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { SettingsService } from '../src/settings/settings.service';
import {
  HAIKU_TEST_PRICES,
  removeRunRows,
  runEmbeddingModel,
  runModel,
  useRunModels,
} from './support/access';
import { expectBody, expectError } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import { apiRequest, seedSuperAdmin, type Session } from './support/session';

/** Bound of one test; the requests settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

const CHAT_MODEL = runModel('schema-haiku');
const EMBEDDING_MODEL = runEmbeddingModel('schema-embed');

let harness: TestApp;
let admin: Session;
let restoreModels: (() => Promise<void>) | undefined;
/** The employees this file made; `afterAll` deletes them with their sessions and audit rows. */
const userIds: string[] = [];

/** The row of a key as the database holds it. */
interface SettingsRow {
  value: Record<string, unknown>;
  updatedAt: Date | null;
  updatedBy: string | null;
}

async function settingsRow(key: SettingsKey): Promise<SettingsRow> {
  const { rows } = await harness.pool.query<SettingsRow>(
    `SELECT value, updated_at AS "updatedAt", updated_by AS "updatedBy" FROM app.settings WHERE key = $1`,
    [key],
  );
  const [row] = rows;
  if (row === undefined) throw new Error(`no settings row ${key}`);
  return row;
}

/** Puts the row of a key back as it was, time and author included: the developer's database keeps its settings. */
async function restoreRow(key: SettingsKey, row: SettingsRow): Promise<void> {
  await harness.pool.query(
    'UPDATE app.settings SET value = $2, updated_at = $3, updated_by = $4 WHERE key = $1',
    [key, JSON.stringify(row.value), row.updatedAt, row.updatedBy],
  );
}

/** The `admin_change` rows of a key, oldest first. */
async function settingsAudit(
  key: SettingsKey,
): Promise<{ actor: string; before: unknown; after: unknown }[]> {
  const { rows } = await harness.pool.query<{
    actor: string;
    before: unknown;
    after: unknown;
  }>(
    `SELECT actor, before, after FROM app.audit_events
      WHERE kind = 'admin_change' AND object_type = $1 ORDER BY at, id`,
    [key],
  );
  return rows;
}

/** One key of the table: its route, a valid value and, where this file proves the refusal, a refused one and its answer. */
interface KeyCase {
  readonly key: SettingsKey;
  readonly route: string;
  readonly schema: z.ZodType<object>;
  readonly valid: (current: Record<string, unknown>) => object;
  readonly refused?: {
    readonly body: object;
    readonly status: number;
    readonly errorCode: string;
  };
}

const KEY_CASES: readonly KeyCase[] = [
  {
    key: 'library_settings',
    route: '/admin/library/settings',
    schema: LibrarySettingsSchema,
    valid: (current) => ({
      defaultMaxTurns: current.defaultMaxTurns === 41 ? 42 : 41,
    }),
  },
  {
    key: 'tool_result_settings',
    route: '/admin/tool-results/settings',
    schema: ToolResultSettingsSchema,
    valid: () => ({
      storeFromChars: 60_000,
      previewChars: 3_000,
      readMaxTokens: 30_000,
    }),
    // The preview is not shorter than the saving threshold.
    refused: {
      body: {
        storeFromChars: 3_000,
        previewChars: 3_000,
        readMaxTokens: 30_000,
      },
      status: 400,
      errorCode: 'VALIDATION_FAILED',
    },
  },
  {
    key: 'model_defaults',
    route: '/admin/model-defaults',
    schema: ModelDefaultsSchema,
    valid: () => ({ chatModel: CHAT_MODEL, embeddingModel: EMBEDDING_MODEL }),
    // An embedding model as the chat model: the group's rule above the schema, checked before the write.
    refused: {
      body: { chatModel: EMBEDDING_MODEL, embeddingModel: null },
      status: 422,
      errorCode: 'MODEL_DEFAULT_INVALID',
    },
  },
];

describe('data-model / schema: settings are written through one service', () => {
  beforeAll(async () => {
    harness = await createTestApp();
    admin = await seedSuperAdmin(harness.app, `e2e-admin-${randomUUID()}`);
    userIds.push(admin.id);
    restoreModels = await useRunModels(harness.app, admin, {
      chat: { id: CHAT_MODEL, ...HAIKU_TEST_PRICES },
      embedding: { id: EMBEDDING_MODEL, inputUsdPerMTok: 0.02, dimensions: 8 },
    });
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await restoreModels?.();
    } finally {
      if (harness !== undefined)
        await removeRunRows(harness.pool, {
          models: [CHAT_MODEL, EMBEDDING_MODEL],
          roles: [],
          users: userIds,
        });
      await harness?.close();
    }
  }, TEST_TIMEOUT_MS);

  // AC (DC-6): "PUT настроек пишет строку ключа и одну запись `admin_change` в одной транзакции; значение вне границ отвечает 400
  //   `VALIDATION_FAILED` и ничего не меняет; новые сроки сеанса действуют со следующего запроса."
  // Behavior: the administrator PUTs a valid value for a key -> the settings service validates it by the key's schema, replaces the
  //   key's row and writes one `admin_change` in the same transaction -> the response and the next GET carry the new value, time and
  //   author; the same PUT with a refused value answers 400 `VALIDATION_FAILED` and neither the row nor the audit changes.
  // Catches: one of the groups still writing around the service (the three old audit places collapse into one) - a write
  //   without its `admin_change`, an audit row with the wrong before/after or author, or a refused value that still changes the
  //   row or the audit.
  // Verification items (rows of one table-driven case; one row per key, restored afterwards; `sign_in_settings`, the non-admin
  //   PUT and the out-of-bounds `library_settings` value are proven by the suites the file header names):
  // - library_settings: valid -> row replaced with its time and author, exactly one `admin_change` with the before/after values
  // - tool_result_settings: valid, the same assertions; preview not shorter than the saving threshold (rule between fields) ->
  //   400, row and audit unchanged
  // - model_defaults: valid, and a model of the wrong purpose -> refused by the group's rule before the write, row and audit unchanged
  // @category: core-functionality
  // @dependency: SettingsService, the settings group services, SettingsRepository, AuditLog, SessionGuard, Postgres
  // @complexity: medium
  it(
    'DC-6: a PUT writes the key row and one admin_change in one transaction, and a refused value changes neither - for the library, tool result and model default keys',
    async () => {
      const { app } = harness;

      for (const row of KEY_CASES) {
        const original = await settingsRow(row.key);
        const auditBefore = (await settingsAudit(row.key)).length;
        try {
          // A valid value: the row is replaced with its time and author, one admin_change with «было» and «стало».
          const valid = row.valid(original.value);
          const saved = await expectBody(
            apiRequest(app, admin, 'put', row.route, valid),
            200,
            row.schema,
          );
          expect(saved, row.key).toMatchObject(valid);
          const written = await settingsRow(row.key);
          expect(written.value, row.key).toEqual(valid);
          expect(written.updatedAt, row.key).not.toBeNull();
          expect(written.updatedBy, row.key).toBe(admin.id);
          const audit = await settingsAudit(row.key);
          expect(audit, row.key).toHaveLength(auditBefore + 1);
          expect(audit.at(-1), row.key).toEqual({
            actor: admin.id,
            before: original.value,
            after: valid,
          });

          // A refused value: the answer of its border, neither the row nor the audit changes.
          if (row.refused === undefined) continue;
          const refused = await expectError(
            apiRequest(app, admin, 'put', row.route, row.refused.body),
            row.refused.status,
          );
          expect(refused.errorCode, row.key).toBe(row.refused.errorCode);
          expect(await settingsRow(row.key), row.key).toEqual(written);
          expect(await settingsAudit(row.key), row.key).toHaveLength(
            auditBefore + 1,
          );
        } finally {
          await restoreRow(row.key, original);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  // AC (DC-8): "Два одновременных первых сохранения публичного адреса оставляют один адрес, и оба запроса получают его."
  // Behavior: two requests that each find no public address and save the one they derived from their own request, sent at the same
  //   time -> the conditional replace writes the first and reports that it did not write the second -> both requests continue with
  //   the stored address; no `admin_change` and no change of time and author.
  // Catches: a read-then-write first save that lets the second request overwrite the first, so two requests of one moment build
  //   sign-in links on two different addresses and one of them is not the stored one.
  // Verification items:
  // - exactly one stored address, equal to the one of the request that won (two direct conditional replaces with different values)
  // - `updated_at` and `updated_by` of the row are still null, no `admin_change` was written
  // - the losing request answering with the stored address is the unit row of `identity-settings.spec.ts` (the replace reports
  //   "not written" -> `publicUrlFor` re-reads), not repeated here
  // @category: edge-case
  // @dependency: SettingsService conditional replace, SettingsRepository, Postgres
  // @complexity: medium
  it(
    'DC-8: two concurrent first saves of the public address leave one address, with no admin_change and no change of time and author',
    async () => {
      const settings = harness.app.get(SettingsService);
      const original = await settingsRow('sign_in_settings');
      const auditBefore = (await settingsAudit('sign_in_settings')).length;
      const unsaved: SettingsRow = {
        value: { ...original.value, publicUrl: null },
        updatedAt: null,
        updatedBy: null,
      };
      try {
        // Given: no saved address, and the time and author of the defaults.
        await restoreRow('sign_in_settings', unsaved);
        const { value } = await settings.read('sign_in_settings');
        const candidates = [
          'https://first.aos.example.com',
          'https://second.aos.example.com',
        ];

        // When: two first saves from the same reading go at once.
        const outcomes = await Promise.all(
          candidates.map((publicUrl) =>
            settings.replaceIf('sign_in_settings', value, {
              ...value,
              publicUrl,
            }),
          ),
        );

        // Then: exactly one wrote and the stored address is its own; time, author and audit stay untouched.
        expect(outcomes.filter(Boolean)).toHaveLength(1);
        const winner = candidates[outcomes.indexOf(true)];
        const raced = await settingsRow('sign_in_settings');
        expect(raced.value.publicUrl).toBe(winner);
        expect(raced.updatedAt).toBeNull();
        expect(raced.updatedBy).toBeNull();
        expect(await settingsAudit('sign_in_settings')).toHaveLength(
          auditBefore,
        );
      } finally {
        await restoreRow('sign_in_settings', original);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
