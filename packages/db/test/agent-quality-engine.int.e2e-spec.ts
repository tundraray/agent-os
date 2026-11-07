// agent-quality / engine Integration Test (database side) - Design Doc: docs/features/agent-quality/design-engine.md (v1.3, approved 2026-11-07)
// PRD: docs/features/agent-quality/prd.md (FR-11, FR-12, FR-14, FR-15 - the stored fields; compatibility with stored data). ADRs: ADR-0002 (app schema migrations), ADR-0003 (Drizzle data layer).
// Generated: 2026-11-07 | Part: engine | Test type: Integration (the migrator called directly + real Postgres, one scratch database for the one test)
// Implementation timing: created alongside the migration of this part (pointer, claim type, assessment and group on claim revisions; the status `causal`).
//
// File name and placement. Same package and config as `migrations.e2e-spec.ts` and `agent-quality-lifecycle.int.e2e-spec.ts` (`test/**/*.e2e-spec.ts` of `vitest.config.e2e.ts`; `pnpm --filter @agent-os/db test:e2e`, never in the default `vitest run`).
// A separate file, not new rows in `migrations.e2e-spec.ts`, because that file belongs to another part.
//
// Environment: as the lifecycle db file - Postgres 16 from infra/docker-compose.yml; the test migrates its own scratch database (`withDatabase`, `ScratchDatabases` of test/support/scratch-db.ts); to seed rows in the state BEFORE this part's migration it applies
// the folder without it (`applyMigrationsBefore` of test/support/migrations-before.ts, cut at this part's tag), seeds with plain SQL, then calls `applyMigrations` with the full folder. No new support is needed.
//
// Budget: this file holds INT-5 of the part's 5 integration tests (whole budget in packages/engine/test/agent-quality-engine.int.e2e-spec.ts), as ONE test over one migration run. INT-5 is an extra; unique defect: the migration cannot be applied over
// claim revisions that already exist, or rewrites them (a NOT NULL column without a default, a CHECK that excludes a stored status, a data step that alters rows). Nothing else shows it: the CHECK-domain row of `migrations.e2e-spec.ts` (AC-RT-8) runs on a database
// migrated from empty, and the engine's tests insert rows in the new shape.
//
// Proven elsewhere (not in this file):
// - the CHECK domain of `research_claims.status` contains `causal`: the existing AC-RT-8 row of `migrations.e2e-spec.ts`, whose literal list the plan extends with `causal` together with the migration. This is a change of an existing test, not a new test.
// - old answers and old messages read without errors (the answer JSON and the conversation message): packages/engine/test/agent-quality-engine.int.e2e-spec.ts INT-2 A5 and the schema unit specs.
// - applying the migrations twice changes nothing: existing `migrations.e2e-spec.ts` (AC-10.1).

import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/index.js';
import { applyMigrationsBefore } from './support/migrations-before.js';
import { ScratchDatabases, withDatabase } from './support/scratch-db.js';

/** Tag of this part's migration: pointer, claim type, assessment and group on claim revisions; status `causal`. */
const ENGINE_MIGRATION = '0006_red_felicia_hardy';

/** Two migrator runs (to the previous migration, then to the end) over one scratch database. */
const ROW_TIMEOUT_MS = 120_000;

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const INVESTIGATION = uuid(1);
const WORKER_TASK = uuid(2);
const VERIFY_TASK = uuid(3);
/** The claim the new check revision revises (the `supported` one below). */
const CHECKED_CLAIM = uuid(202);

/** Claim revisions written before this part: one per old status, in the columns of the previous migration. */
const OLD_REVISIONS = [
  { revisionId: uuid(101), claimId: uuid(201), index: 0, status: 'unverified', evidenceIds: [] },
  { revisionId: uuid(102), claimId: CHECKED_CLAIM, index: 1, status: 'supported', evidenceIds: [uuid(301), uuid(302)] },
  { revisionId: uuid(103), claimId: uuid(203), index: 2, status: 'refuted', evidenceIds: [] },
  { revisionId: uuid(104), claimId: uuid(204), index: 3, status: 'insufficient', evidenceIds: [] },
] as const;

/** Pointer and assessment of the new check revision, as the engine writes them (stored as opaque jsonb). */
const POINTER = [{ pageId: uuid(301), records: [1, 2] }];
const ASSESSMENT = {
  support: 'yes',
  claimType: 'causal',
  records: [
    { record: 1, relation: 'supports' },
    { record: 2, relation: 'unrelated' },
  ],
  invalidForm: false,
};

async function insertTask(
  client: pg.Client,
  task: { taskId: string; workflowType: string },
): Promise<void> {
  await client.query(
    `INSERT INTO app.research_tasks (task_id, investigation_id, workflow_type, workflow_version, input, input_refs,
       expected_output, dedup_key, status, max_tool_calls, max_retries, deadline_ms, max_tokens)
     VALUES ($1, $2, $3, 1, '{}', '[]', '{}', $4, 'succeeded', 5, 2, 60000, 1000)`,
    [task.taskId, INVESTIGATION, task.workflowType, `v1:${task.taskId}`],
  );
}

/** Seeds one investigation, its worker task and the old claim revisions with plain SQL (the schema before the migration). */
async function seedBefore(client: pg.Client): Promise<void> {
  await client.query(
    `INSERT INTO app.research_investigations (investigation_id, resource_id, thread_id, query, status, max_tasks, max_tool_calls)
     VALUES ($1, 'user-1', 'thread-1', 'query', 'active', 10, 10)`,
    [INVESTIGATION],
  );
  await insertTask(client, { taskId: WORKER_TASK, workflowType: 'worker' });
  for (const revision of OLD_REVISIONS) {
    await client.query(
      `INSERT INTO app.research_claims (claim_revision_id, investigation_id, claim_id, task_id, claim_index, text, atoms,
         evidence_ids, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9)`,
      [
        revision.revisionId,
        INVESTIGATION,
        revision.claimId,
        WORKER_TASK,
        revision.index,
        `claim ${revision.index}`,
        JSON.stringify([{ kind: 'text', value: `atom ${revision.index}` }]),
        revision.evidenceIds,
        revision.status,
      ],
    );
  }
}

const readRevisions = async (
  client: pg.Client,
): Promise<Record<string, unknown>[]> =>
  (
    await client.query<Record<string, unknown>>(
      'SELECT * FROM app.research_claims ORDER BY seq',
    )
  ).rows;

/** A check revision of `CHECKED_CLAIM` in the new shape: pointer, type, assessment and group. */
async function insertCheckRevision(
  client: pg.Client,
  revision: {
    revisionId: string;
    index: number;
    status: string;
    confidence: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO app.research_claims (claim_revision_id, investigation_id, claim_id, task_id, claim_index, text, atoms,
       evidence_ids, status, pointer, claim_type, assessment, confidence)
     VALUES ($1, $2, $3, $4, $5, 'claim 1', '[]', $6::uuid[], $7, $8, 'causal', $9, $10)`,
    [
      revision.revisionId,
      INVESTIGATION,
      CHECKED_CLAIM,
      VERIFY_TASK,
      revision.index,
      [uuid(301)],
      revision.status,
      JSON.stringify(POINTER),
      JSON.stringify(ASSESSMENT),
      revision.confidence,
    ],
  );
}

describe('agent-quality / engine - migration over existing claim revisions (real Postgres, scratch database)', () => {
  const scratch = new ScratchDatabases();

  afterAll(() => scratch.dropAll());

  // ---------------------------------------------------------------------------------------------------------------
  // INT-5  The migration leaves claim revisions written before this part as they were, with the new fields empty
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // Design Doc "Data Model": "Миграция этой части добавляет эти поля пустыми для прежних строк и расширяет проверку статуса; прежние ревизии читаются как раньше."
  // Design Doc "Constraints", "Совместимость с сохранёнными данными": "Ответы и сообщения, записанные до этой части, читаются без ошибок: новые поля в них считаются пустыми (KD-8)."
  // KD-7: "Миграция этой части добавляет ревизии утверждения указатель, тип, оценку и группу и новый статус `causal`."
  //
  // Primary failure mode (turns red when): `applyMigrations` fails over a database that already holds claim revisions; an old revision gets a value in a new column (a group or a type it never had) or a changed status or text; the extended CHECK refuses one of the four
  // statuses stored before; the new status cannot be stored after the migration.
  // Behavior: a database at the previous migration holds claim revisions of the four old statuses, with and without `evidenceIds` -> `applyMigrations` runs the migration of this part -> the rows are unchanged, the new columns are null, and a revision of status `causal` can be inserted
  // @category: integration
  // @dependency: applyMigrations, applyMigrationsBefore, ScratchDatabases, research_claims, Postgres
  // @complexity: low
  //
  // Verification items (one migration run; assertions with literal expected values):
  // - Before: one investigation with claim revisions `unverified`, `supported`, `refuted`, `insufficient` (the `supported` one with two `evidenceIds`), written by plain SQL with the columns of the previous migration.
  // - After `applyMigrations`: the same four rows with the same id, revision, status, text, atoms and `evidenceIds`; the pointer, type, assessment and group columns are null (or the empty form the design's Data Model names) on every old row.
  // - A new revision of an existing claim with status `causal`, a pointer, a type, an assessment and a group is accepted and read back; a row with a status outside the five is still refused (the check was extended, not dropped).
  it(
    'INT-5: the migration of this part leaves old claim revisions unchanged with the new fields empty, and accepts a causal revision afterwards',
    async () => {
      const url = await scratch.create();
      await applyMigrationsBefore(url, ENGINE_MIGRATION);
      const before = await withDatabase(url, async (client) => {
        await seedBefore(client);
        return readRevisions(client);
      });
      // The seed ran on the schema before this part's migration: the new columns do not exist yet.
      expect(before).toHaveLength(4);
      for (const row of before) {
        expect(row).not.toHaveProperty('pointer');
        expect(row).not.toHaveProperty('claim_type');
      }

      await applyMigrations(url);

      await withDatabase(url, async (client) => {
        const after = await readRevisions(client);
        expect(
          after.map((row) => [
            row.claim_revision_id,
            row.status,
            row.text,
            row.evidence_ids,
          ]),
        ).toEqual([
          [uuid(101), 'unverified', 'claim 0', []],
          [uuid(102), 'supported', 'claim 1', [uuid(301), uuid(302)]],
          [uuid(103), 'refuted', 'claim 2', []],
          [uuid(104), 'insufficient', 'claim 3', []],
        ]);
        // Every column the rows had keeps its value; the four new columns are null.
        expect(after).toEqual(
          before.map((row) => ({
            ...row,
            pointer: null,
            claim_type: null,
            assessment: null,
            confidence: null,
          })),
        );

        await insertTask(client, {
          taskId: VERIFY_TASK,
          workflowType: 'research.verify',
        });
        await insertCheckRevision(client, {
          revisionId: uuid(105),
          index: 0,
          status: 'causal',
          confidence: 'high',
        });
        const causal = await client.query(
          `SELECT claim_id, status, pointer, claim_type, assessment, confidence
             FROM app.research_claims WHERE claim_revision_id = $1`,
          [uuid(105)],
        );
        expect(causal.rows).toEqual([
          {
            claim_id: CHECKED_CLAIM,
            status: 'causal',
            pointer: POINTER,
            claim_type: 'causal',
            assessment: ASSESSMENT,
            confidence: 'high',
          },
        ]);

        // The check was extended, not dropped.
        await expect(
          insertCheckRevision(client, {
            revisionId: uuid(106),
            index: 1,
            status: 'verified',
            confidence: 'high',
          }),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'research_claims_status_check',
        });
      });
    },
    ROW_TIMEOUT_MS,
  );
});
