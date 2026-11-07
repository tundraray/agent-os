// agent-quality / lifecycle Integration Test Skeleton (database side) - Design Doc: docs/features/agent-quality/design-lifecycle.md
// PRD: docs/features/agent-quality/prd.md (FR-19). ADRs: ADR-0002 (app schema migrations), ADR-0003 (Drizzle data layer).
// Generated: 2026-11-06 | Part: lifecycle | Test type: Integration (the migrator called directly + real Postgres, one scratch database for the one test)
// Implementation timing: created alongside the migration of this part (statuses `completed` and `failed`, table `chat_thread_runs`, the closing of already-finished investigations).
//
// File name and placement. Same package and config as `migrations.e2e-spec.ts` (`test/**/*.e2e-spec.ts` of `vitest.config.e2e.ts`; `pnpm --filter @agent-os/db test:e2e`, never in the default `vitest run`).
// A separate file, not new rows in `migrations.e2e-spec.ts`, because that file belongs to another part.
//
// Environment:
// - Postgres 16 from infra/docker-compose.yml; the test migrates its own scratch database (`withDatabase`, `ScratchDatabases` of test/support/scratch-db.ts), created with CREATE DATABASE and dropped afterwards.
//   To seed rows in the state BEFORE this part's migration the test applies a copy of `MIGRATIONS_FOLDER` without the migration of this part (journal cut at that migration's tag, `test/support/migrations-before.ts`), seeds with plain SQL, then calls
//   `applyMigrations` with the full folder. This copy helper is the only support to add.
//
// Budget: this file holds INT-5 of the part's 5 integration tests (whole budget in apps/api/test/agent-quality-lifecycle.int.e2e-spec.ts), as ONE test over one migration run. INT-5 is an extra; unique
// defect: the data step of the migration maps already-finished investigations to a wrong status, or closes the ones it must leave. Nothing else can show it: the CHECK domain test (`migrations.e2e-spec.ts` AC-RT-8) compares the allowed values
// with the contract enum, not the rows a migration rewrites. That CHECK test also covers the new values `completed` and `failed` automatically (the constraint is built from `InvestigationStatusSchema`) and
// `chat_thread_runs` is created by the same migration run it already checks; neither gets a row here.
//
// Proven elsewhere (not in this file):
// - the CHECK domain of `research_investigations.status` equals `InvestigationStatusSchema` including the two new values: existing `migrations.e2e-spec.ts` (AC-RT-8), no change needed.
// - applying the migrations twice changes nothing: existing `migrations.e2e-spec.ts` (AC-10.1).

import type pg from 'pg';
import { applyMigrations } from '../src/index.js';
import { applyMigrationsBefore } from './support/migrations-before.js';
import { ScratchDatabases, withDatabase } from './support/scratch-db.js';

/** Tag of this part's migration: statuses `completed` and `failed`, `chat_thread_runs`, closing of finished investigations. */
const LIFECYCLE_MIGRATION = '0005_even_kabuki';

/** Two migrator runs (to the previous migration, then to the end) over one scratch database. */
const ROW_TIMEOUT_MS = 120_000;

type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** One investigation as it stood before the migration. */
interface SeededInvestigation {
  investigationId: string;
  status: 'active' | 'cancelled' | 'deleting';
  /** Status of its controller task; `null` — a shell whose start failed before the controller task. */
  controller: TaskStatus | null;
  workers: TaskStatus[];
}

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

async function insertTask(
  client: pg.Client,
  task: {
    taskId: string;
    investigationId: string;
    workflowType: string;
    status: TaskStatus;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO app.research_tasks (task_id, investigation_id, workflow_type, workflow_version, input, input_refs,
       expected_output, dedup_key, status, max_tool_calls, max_retries, deadline_ms, max_tokens)
     VALUES ($1, $2, $3, 1, '{}', '[]', '{}', $4, $5, 5, 2, 60000, 1000)`,
    [
      task.taskId,
      task.investigationId,
      task.workflowType,
      `v1:${task.taskId}`,
      task.status,
    ],
  );
}

/** Seeds each investigation, its tasks and its engine row with plain SQL (the schema before the migration). */
async function seed(
  client: pg.Client,
  investigations: readonly SeededInvestigation[],
): Promise<void> {
  let nextTask = 1000;
  for (const investigation of investigations) {
    const { investigationId } = investigation;
    await client.query(
      `INSERT INTO app.research_investigations (investigation_id, resource_id, thread_id, query, status, max_tasks, max_tool_calls)
       VALUES ($1, 'user-1', $2, 'query', $3, 10, 10)`,
      [investigationId, `thread-${investigationId}`, investigation.status],
    );
    let controllerTaskId: string | null = null;
    if (investigation.controller !== null) {
      controllerTaskId = uuid(nextTask++);
      await insertTask(client, {
        taskId: controllerTaskId,
        investigationId,
        workflowType: 'controller',
        status: investigation.controller,
      });
    }
    for (const status of investigation.workers) {
      await insertTask(client, {
        taskId: uuid(nextTask++),
        investigationId,
        workflowType: 'worker',
        status,
      });
    }
    await client.query(
      `INSERT INTO app.research_engine_runs (investigation_id, resource_id, launch_key, process_id, process_version,
         process_config, source_mode, controller_task_id, token_budget)
       VALUES ($1, 'user-1', $2, 'deep-research', 1, '{}', 'sources', $3, 1000)`,
      [investigationId, `launch-${investigationId}`, controllerTaskId],
    );
  }
}

const readStatuses = async (
  client: pg.Client,
): Promise<Record<string, string>> =>
  Object.fromEntries(
    (
      await client.query<{ investigation_id: string; status: string }>(
        'SELECT investigation_id, status FROM app.research_investigations',
      )
    ).rows.map((row) => [row.investigation_id, row.status]),
  );

const readTasks = async (client: pg.Client): Promise<unknown[]> =>
  (await client.query('SELECT * FROM app.research_tasks ORDER BY task_id'))
    .rows;

interface MigrationOutcome {
  statuses: Record<string, string>;
  tasksBefore: unknown[];
  tasksAfter: unknown[];
}

describe('agent-quality / lifecycle - migration of schema app (real Postgres, scratch database)', () => {
  const scratch = new ScratchDatabases();

  afterAll(() => scratch.dropAll());

  /** A scratch database at the migration before this part's, seeded, then migrated to the end. */
  async function migrateSeeded(
    investigations: readonly SeededInvestigation[],
  ): Promise<MigrationOutcome> {
    const url = await scratch.create();
    await applyMigrationsBefore(url, LIFECYCLE_MIGRATION);
    const tasksBefore = await withDatabase(url, async (client) => {
      await seed(client, investigations);
      return readTasks(client);
    });
    await applyMigrations(url);
    return withDatabase(url, async (client) => ({
      statuses: await readStatuses(client),
      tasksBefore,
      tasksAfter: await readTasks(client),
    }));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // INT-5  The migration closes investigations that were already finished, by the status of their controller task, and nothing else
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // Design Doc "Data Model": "Та же миграция переводит строку `active`, у которой задача controller уже `succeeded`, `failed` или `cancelled`, в `completed`, `failed` или `cancelled`. Расследования без задачи
  //   controller — оболочки неудачного старта — остаются `active`: их переиспользует повтор старта. Незаконченные задачи таких старых расследований миграция не трогает."
  // AC-19.1 / AC-19.2 for investigations that finished before the update: "расследование в состоянии «завершено»" / "«не удалось»" - an old finished research must not stay `active` after the update.
  // Use case: none of its own; the Design Doc names the rule in "Data Model". Risk: investigation closed by a wrong mapping or shells closed by mistake.
  //
  // Primary failure mode (turns red when): a controller `succeeded` investigation stays `active` or becomes `failed`; a `failed` or `cancelled` controller is mapped to `completed`; an investigation whose
  // controller is still `queued`/`running`/`waiting` is closed; a shell with no controller task is closed (the start retry would no longer reuse it); the migration cancels or rewrites tasks.
  // Behavior: a database at the previous migration with investigations in several shapes -> `applyMigrations` -> the status of each row and the rows of its tasks are read back
  // @category: integration
  // @dependency: applyMigrations, MIGRATIONS_FOLDER, ScratchDatabases, Postgres
  // @complexity: medium
  //
  // Verification items (one test, one migration run; every investigation below is a row of its seed, read after the migration; literal expected values):
  // - B1 mapping (AC-19.1, AC-19.2): controller task `succeeded` -> `completed`; controller `failed` -> `failed`; controller `cancelled` -> `cancelled`
  // - B1 what stays (Data Model; formerly B2, merged into the same run so one scratch database proves the mapping and the exclusions side by side): controller `running` (an investigation still in progress
  //   at the update) -> `active`; a shell with no controller task -> `active`; an investigation already `cancelled` or `deleting` is unchanged; the unfinished worker tasks of a migrated investigation keep their
  //   status and rows (the migration rewrites no task: the task rows before and after the migration are equal)
  describe('INT-5', () => {
    it(
      'INT-5 B1: one migration run closes finished investigations by the status of their controller task, leaves the ones in progress, the shells and the already closed ones as they are, and touches no task row',
      async () => {
        const { statuses, tasksBefore, tasksAfter } = await migrateSeeded([
          // the mapping: finished controller -> closed investigation
          { investigationId: uuid(1), status: 'active', controller: 'succeeded', workers: [] },
          { investigationId: uuid(2), status: 'active', controller: 'failed', workers: [] },
          { investigationId: uuid(3), status: 'active', controller: 'cancelled', workers: [] },
          // still in progress at the update
          { investigationId: uuid(11), status: 'active', controller: 'running', workers: ['queued'] },
          // shell of a failed start: the start retry reuses it
          { investigationId: uuid(12), status: 'active', controller: null, workers: [] },
          // already closed or being deleted
          { investigationId: uuid(13), status: 'cancelled', controller: 'succeeded', workers: [] },
          { investigationId: uuid(14), status: 'deleting', controller: 'succeeded', workers: [] },
          // closed by the migration; its unfinished worker tasks stay as they are
          { investigationId: uuid(15), status: 'active', controller: 'succeeded', workers: ['queued', 'running'] },
        ]);

        expect(statuses).toEqual({
          [uuid(1)]: 'completed',
          [uuid(2)]: 'failed',
          [uuid(3)]: 'cancelled',
          [uuid(11)]: 'active',
          [uuid(12)]: 'active',
          [uuid(13)]: 'cancelled',
          [uuid(14)]: 'deleting',
          [uuid(15)]: 'completed',
        });
        expect(tasksBefore).toHaveLength(10);
        expect(tasksAfter).toEqual(tasksBefore);
      },
      ROW_TIMEOUT_MS,
    );
  });
});
