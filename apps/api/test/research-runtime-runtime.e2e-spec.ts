// research-runtime / runtime E2E Test Skeletons - Design Doc: docs/features/research-runtime/design-runtime.md
// PRD: docs/features/research-runtime/prd.md. Verification Strategy: "Correctness Proof Method", "Early Verification Point" (kill matrix).
// Generated: 2026-10-31 | Part: runtime | Test type: End-to-End (child processes of `apps/api` + real Postgres), CI job `e2e-runtime`
// Implementation timing: after the runtime slices of Flow 1-3 land for the first test (Early Verification Point), the full matrix at part acceptance (final phase only).
// Counterpart in-process file: research-runtime-runtime.int.e2e-spec.ts. The sibling part `mcp-source` owns research-runtime-mcp-source.e2e-spec.ts and its own restart
// scenario with a real MCP source; this file owns the process-death and multi-instance proof of the runtime itself and uses test handlers without MCP.
//
// File name follows the project convention (`*.e2e-spec.ts` under apps/api/test, run with `pnpm --filter api test:e2e`).
//
// Environment (Design Doc "Test Boundaries", "Verification Strategy"):
// - Postgres 16 from infra/docker-compose.yml. Child-process harness (test/support/runtimeChild.ts, to be created): spawns `apps/api` built with AppModule + test handlers under unique
//   workflowType, with `RUNTIME_CRASH_AT=<point>[:n]` (ignored when NODE_ENV=production), `RUNTIME_WORKERS=on`, short `RUNTIME_LEASE_MS`, `RUNTIME_REAPER_MS`, `RUNTIME_POLL_MS`; kills by `process.exit(137)` from the crash point.
// - Isolation (project convention, no truncate): unique `resourceId = 'e2e-' + randomUUID()` and unique `workflowType` per row; a row reads only its own investigation.
//   Rows of the boot test additionally use a scratch database created and dropped by the test (migrations must not run against the shared database from a half-applied state).
// - "Within the PRD target" for recovery (AC-08.4, 60 s) is the harness timeout of the wait for the end state; no latency is asserted (latency is the on-demand script UC-N2).
// - No LLM, no network, no MCP.
//
// E2E-1 holds the full kill matrix (early points T3.2, the rest T4.1); E2E-2 boots the api and the migrator against scratch databases (T4.2).
//
// Budget: E2E 2 of 2. ROI uses the raw skill formula (Business Value x Frequency + Legal x 10 + Defect Detection) / (Create 10 + Execute 20 + Maintain 8 = 38).
// With that formula no E2E test can reach the ">50" threshold the generator spec mentions (maximum 3.2); the sibling part's skeletons note the same. Both are kept because the Design Doc makes
// them gates: the kill matrix is the "first verification target" and the `e2e-runtime` CI job lists migrations (UC-14); nothing at a lower level can prove a real process death, a second real instance,
// or the exit code of a real boot. E2E-2 is the first to drop if the budget has to shrink: its ACs then stay with unit comparison tests plus the CI `db:migrate` step.

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  DeliveryStatusSchema,
  InvestigationStatusSchema,
  KnowledgeStatusSchema,
  TaskEdgeKindSchema,
  TaskStatusSchema,
} from '@agent-os/contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type EndState,
  type KillSnapshot,
  runScenario,
  runTwoInstances,
  type TaskEnd,
  TWO_INSTANCE_TASKS,
} from './support/runtimeChild.js';
import { closeRuntimeDb, query } from './support/runtimeDb.js';
import { within } from './support/testHandlers.js';

describe('research-runtime / runtime - E2E (real Postgres, child processes)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1  Exactly-once effects under process death and a second instance (kill matrix)
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: an investigation of three tasks (B depends on A, a subscriber waits on A, C independent) is running when the api process dies at a chosen point; after it is started again
  // (or while a second api instance competes for the same work) the investigation reaches the same end as an uninterrupted run, without double effects.
  // Covers (original statements):
  // AC-08.1: "Given расследование из нескольких задач исполняется, When процесс apps/api принудительно убит после записи событий и до их доставки и затем запущен снова, Then каждое ожидавшее событие доставлено и все задачи достигли тех же конечных состояний, что и в прогоне без сбоя. Намеренное исключение — задача, чей дедлайн истёк до восстановления (AC-19.2)."
  // AC-08.2: "Given тот же сценарий, Then evidence каждой fetch-задачи сохранено ровно один раз, ни одно состояние не перешло дважды, ни один подписчик не уведомлён дважды."
  // AC-08.4: "Given задача была в running в момент сбоя, Then после рестарта она не остаётся в running дольше времени восстановления (раздел Reliability) и исполняется снова; повторный вызов источника допустим, так как инструменты только читают."
  // AC-RT-4: "While работают два экземпляра apps/api с одним обработчиком, каждая готовая задача исполняется одной попыткой за раз, и каждая доставка выполняется до done одним экземпляром."
  // Use cases: UC-11, UC-E4. EARS: When / While. Design flow: Flow 3 (recovery), KD-3 (claim guard, fencing), KD-4 (outbox). Early Verification Point: at least 6 of the 9 points on a 3-task investigation.
  //
  // Primary failure mode (turns red when): a transaction boundary or guard is wrong at exactly one point of the run - an effect committed before its event/delivery (lost event), an event/delivery committed without its effect,
  // a retry that repeats an effect (second evidence, second subscriber mark, second terminal transition), or two instances executing the same task attempt.
  // ROI: 2.1 (raw formula: (10 x 7 + 0 + 10) / 38) | Business Value: 10 (the part's correctness definition) | Frequency: 7 (every restart / deploy) | Legal: false | Defect Detection: 10
  // Behavior: perturbation (process killed at point P, or a second instance) -> end state equals the uninterrupted reference run; each effect counted once
  // @category: e2e
  // @dependency: full-system (AppModule, RuntimeLifecycle, Dispatcher, OutboxRelay, RecoverySweeper, CrashPoints, Postgres, child process harness)
  // @complexity: high
  //
  // Verification items (table-driven by perturbation; every row first runs, or reuses for the same scenario script, the reference run without perturbation and compares to it):
  // - Reference run: B starts after A succeeded; the scenario's end states are fixed by assertion, not only by comparison (A, B, C `succeeded`; subscriber of A notified once; all deliveries `done`)
  // - Rows by crash point (one child process killed with exit code 137, then a fresh child started without RUNTIME_CRASH_AT):
  //     admission.after-commit | dispatch.after-claim | handler.after-evidence | dispatch.before-terminal |
  //     dispatch.after-terminal (events written, not delivered) | relay.before-done (inside the delivery transaction) | relay.after-done |
  //     reaper.after-requeue (second kill: first death leaves a `running` task, the restarted child dies at the reaper point, the third start finishes) |
  //     cancel.after-commit (scenario script includes a cancel of an unrelated active task; its reference run includes the same cancel)
  // - Row "two instances" (no crash): two children, one HandlerRegistry type, 20 ready tasks -> every task has `attempt` = 1 and a single terminal transition, every delivery reached `done` once
  //   (per-delivery attempts bookkeeping and the subscriber's `notified_event_id` carry exactly one eventId), the work was split across both instances (both claimed at least one task - proves the contention was real).
  //   One executor per task is proven by the claim guard: `from: [queued]` in the guarded claim write and the `status = queued` re-check under the row lock in the claim query. Either guard alone
  //   suffices, so the row turns red only when both are removed. SKIP LOCKED is throughput, not single execution; the on-demand latency script (`test:verify`) covers it, not this row.
  // - After every row: final task statuses and failure classes equal the reference; one evidence per (task, evidenceKey); one terminal transition event per task; `state_version` has no gaps beyond the recovered attempts
  //   (`recovery_count` accounts for the extra TaskQueued(recovered)/TaskStarted); every delivery `done`; the subscriber is marked with exactly one eventId; no task remains `running`
  // - A task `running` at the kill is executed again to its end within the recovery harness timeout (AC-08.4); a repeated handler call is allowed
  // - Exception stated by the AC: the deadline-passed-while-down case is not in this table; it is INT-3 row R4
  describe('E2E-1: killing the api process at each runtime crash point, or running a second instance, ends in the same end state as an uninterrupted run with every effect applied exactly once', () => {
    /** Boot of two children, the wait for the crash and the recovery within the PRD target. */
    const ROW_TIMEOUT_MS = 180_000;

    /** A scenario task that ended `succeeded` with its one evidence, each subscriber notified once. */
    const succeededTask = (
      evidenceKey: string,
      subscribers: string[],
    ): TaskEnd => ({
      status: 'succeeded',
      failureClass: null,
      evidenceKeys: [evidenceKey],
      outputRefsAreEvidence: true,
      queuedOverRecoveries: 1,
      startedOverRecoveries: 1,
      evidenceEvents: 1,
      terminalEvents: 1,
      stateVersionOverRecoveries: 2,
      subscribers: Object.fromEntries(
        subscribers.map((key) => [key, 'terminal event' as const]),
      ),
    });

    /** End of the uninterrupted run; every crash row must end exactly so. */
    const REFERENCE_END: EndState = {
      tasks: {
        A: succeededTask('page-A', ['scenario-A', 'scenario-subscriber']),
        B: succeededTask('page-B', ['scenario-B']),
        C: succeededTask('page-C', ['scenario-C']),
      },
      bStartedAfterASucceeded: true,
      // One `runtime.scheduler` delivery per terminal event, each `done`.
      deliveries: { done: 3 },
    };

    afterAll(async () => {
      await closeRuntimeDb();
    });

    it(
      'reference run: B starts after A succeeded, A, B and C succeed, both subscribers of A are notified once, every delivery is done',
      async () => {
        const run = await runScenario();

        expect(run.firstExitCode).toBe(0);
        expect(run.recoveries).toBe(0);
        expect(run.end).toEqual(REFERENCE_END);
      },
      ROW_TIMEOUT_MS,
    );

    /**
     * Early points (available after Flow 3, without cancel). `atKill` proves the child died where
     * the row says: what the dead process left behind, before the restart touches anything.
     */
    const EARLY_POINTS: {
      point: string;
      /** A task was `running` at the kill: the reaper must take it back (AC-08.4). */
      leftRunning: boolean;
      atKill: (state: KillSnapshot) => void;
    }[] = [
      {
        point: 'admission.after-commit',
        leftRunning: false,
        atKill: (state) =>
          expect(state).toMatchObject({ tasks: 1, started: 0, evidence: 0 }),
      },
      {
        point: 'dispatch.after-claim',
        leftRunning: true,
        atKill: (state) => {
          expect(state.running).toBeGreaterThanOrEqual(1);
          expect(state).toMatchObject({ evidence: 0, terminal: 0 });
        },
      },
      {
        point: 'handler.after-evidence',
        leftRunning: true,
        atKill: (state) => {
          expect(state.running).toBeGreaterThanOrEqual(1);
          expect(state.evidence).toBeGreaterThanOrEqual(1);
          expect(state.terminal).toBe(0);
        },
      },
      {
        point: 'dispatch.before-terminal',
        leftRunning: true,
        atKill: (state) => {
          expect(state.running).toBeGreaterThanOrEqual(1);
          expect(state.evidence).toBeGreaterThanOrEqual(1);
          expect(state.terminal).toBe(0);
        },
      },
      {
        // Events written, not delivered.
        point: 'dispatch.after-terminal',
        leftRunning: false,
        atKill: (state) => {
          expect(state.terminal).toBeGreaterThanOrEqual(1);
          expect(state.pendingDeliveries).toBeGreaterThanOrEqual(1);
        },
      },
      {
        // Inside the delivery transaction: its writes roll back with the process.
        point: 'relay.before-done',
        leftRunning: false,
        atKill: (state) => {
          expect(state.pendingDeliveries).toBeGreaterThanOrEqual(1);
          expect(state.doneDeliveries).toBe(0);
        },
      },
    ];

    it.each(EARLY_POINTS)(
      'crash at $point: the child exits 137 there, and a fresh child ends the investigation as the reference run',
      async ({ point, leftRunning, atKill }) => {
        const run = await runScenario({ crashAt: point });

        expect(run.firstExitCode).toBe(137);
        if (!run.atKill) throw new Error('A crash run has a kill snapshot');
        atKill(run.atKill);
        if (leftRunning) expect(run.recoveries).toBeGreaterThanOrEqual(1);
        expect(run.end).toEqual(REFERENCE_END);
      },
      ROW_TIMEOUT_MS,
    );

    /**
     * The other passes of every point, up to the full matrix of PRD metric 2 (point x pass): a
     * point is passed once per task (claim, evidence, outcome, its delivery) and once per
     * proposal (A, the second subscriber of A, B, C), so the dying child of the scenario reaches
     * each pass listed here. `atKill` proves the death came at that pass.
     */
    const LATER_PASSES: {
      point: string;
      passes: number[];
      leftRunning: boolean;
      atKill: (state: KillSnapshot, pass: number) => void;
    }[] = [
      {
        // Passes: A, the second subscriber of A (no new task), B, C; handlers wait for all four.
        point: 'admission.after-commit',
        passes: [2, 3, 4],
        leftRunning: false,
        atKill: (state, pass) =>
          expect(state).toMatchObject({
            tasks: [1, 1, 2, 3][pass - 1],
            evidence: 0,
            terminal: 0,
          }),
      },
      {
        point: 'dispatch.after-claim',
        passes: [2, 3],
        leftRunning: true,
        atKill: (state, pass) => {
          expect(state.started).toBeGreaterThanOrEqual(pass);
          expect(state.running).toBeGreaterThanOrEqual(1);
        },
      },
      {
        point: 'handler.after-evidence',
        passes: [2, 3],
        leftRunning: true,
        atKill: (state, pass) => {
          expect(state.evidence).toBeGreaterThanOrEqual(pass);
          expect(state.running).toBeGreaterThanOrEqual(1);
          expect(state.terminal).toBeLessThanOrEqual(pass - 1);
        },
      },
      {
        point: 'dispatch.before-terminal',
        passes: [2, 3],
        leftRunning: true,
        atKill: (state, pass) => {
          expect(state.evidence).toBeGreaterThanOrEqual(pass);
          expect(state.running).toBeGreaterThanOrEqual(1);
          expect(state.terminal).toBeLessThanOrEqual(pass - 1);
        },
      },
      {
        point: 'dispatch.after-terminal',
        passes: [2, 3],
        leftRunning: false,
        atKill: (state, pass) => {
          expect(state.terminal).toBeGreaterThanOrEqual(pass);
          expect(state.pendingDeliveries).toBeGreaterThanOrEqual(1);
        },
      },
      {
        // One relay delivers one at a time: the earlier deliveries are done, this one rolled back.
        point: 'relay.before-done',
        passes: [2, 3],
        leftRunning: false,
        atKill: (state, pass) => {
          expect(state.doneDeliveries).toBe(pass - 1);
          expect(state.pendingDeliveries).toBeGreaterThanOrEqual(1);
        },
      },
      {
        // After the delivery's commit: it is done and must not be applied again.
        point: 'relay.after-done',
        passes: [1, 2, 3],
        leftRunning: false,
        atKill: (state, pass) => expect(state.doneDeliveries).toBe(pass),
      },
    ];

    it.each(
      LATER_PASSES.flatMap(({ point, passes, ...row }) =>
        passes.map((pass) => ({ crashAt: `${point}:${pass}`, pass, ...row })),
      ),
    )(
      'crash at $crashAt: the child exits 137 there, and a fresh child ends the investigation as the reference run',
      async ({ crashAt, pass, leftRunning, atKill }) => {
        const run = await runScenario({ crashAt });

        expect(run.firstExitCode).toBe(137);
        if (!run.atKill) throw new Error('A crash run has a kill snapshot');
        atKill(run.atKill, pass);
        if (leftRunning) expect(run.recoveries).toBeGreaterThanOrEqual(1);
        expect(run.end).toEqual(REFERENCE_END);
      },
      ROW_TIMEOUT_MS,
    );

    it(
      'crash at reaper.after-requeue: the first child dies with a running task, the restarted child dies right after its reaper requeued it, a third child ends the investigation as the reference run',
      async () => {
        const run = await runScenario({
          crashAt: 'dispatch.after-claim',
          thenCrashAt: 'reaper.after-requeue',
        });

        expect(run.firstExitCode).toBe(137);
        expect(run.atKill?.recovered).toBe(0);
        expect(run.atKill?.running).toBeGreaterThanOrEqual(1);
        expect(run.restartExitCode).toBe(137);
        // The requeue committed before the second death.
        expect(run.atRestartKill?.recovered).toBeGreaterThanOrEqual(1);
        expect(run.end).toEqual(REFERENCE_END);
      },
      // Three children in a row: a hang reports the child's output before vitest's timeout does.
      3 * ROW_TIMEOUT_MS,
    );

    /** End of the unrelated investigation the cancel scenario cancels while its one task runs. */
    const CANCELLED_END = {
      investigationStatus: 'cancelled',
      end: {
        tasks: {
          D: {
            status: 'cancelled',
            failureClass: 'cancelled',
            evidenceKeys: [],
            outputRefsAreEvidence: true,
            queuedOverRecoveries: 1,
            startedOverRecoveries: 1,
            evidenceEvents: 0,
            terminalEvents: 1,
            // Claim, cancel request, cancelled outcome.
            stateVersionOverRecoveries: 3,
            subscribers: { 'scenario-D': 'terminal event' },
          },
        },
        bStartedAfterASucceeded: false,
        // The `TaskCancelled` delivery.
        deliveries: { done: 1 },
      },
    };

    it(
      'crash at cancel.after-commit: the scenario cancels an unrelated investigation whose task is running, as its reference run does, and a fresh child ends both investigations as that reference run',
      async () => {
        const reference = await runScenario({ cancel: true });
        expect(reference.firstExitCode).toBe(0);
        expect(reference.end).toEqual(REFERENCE_END);
        expect(reference.cancelled).toEqual(CANCELLED_END);

        const run = await runScenario({
          cancel: true,
          crashAt: 'cancel.after-commit',
        });

        expect(run.firstExitCode).toBe(137);
        // The cancel request committed, its outcome did not: D was still running, cancel requested.
        expect(run.cancelledAtKill).toEqual({
          status: 'running',
          cancelRequested: true,
        });
        expect(run.end).toEqual(REFERENCE_END);
        expect(run.cancelled).toEqual(CANCELLED_END);
      },
      2 * ROW_TIMEOUT_MS,
    );

    it(
      `two instances: ${TWO_INSTANCE_TASKS} ready tasks of one handler type, each executed by one attempt of one instance, every delivery done once, both instances executed work`,
      async () => {
        const steps = Array.from(
          { length: TWO_INSTANCE_TASKS },
          (_, index) => `T${String(index + 1).padStart(2, '0')}`,
        );
        const perStep = <T>(value: (step: string) => T) =>
          Object.fromEntries(steps.map((step) => [step, value(step)]));

        const run = await runTwoInstances();

        expect(run.exitCodes).toEqual([0, 0]);
        expect(run.end.tasks).toEqual(
          perStep((step) =>
            succeededTask(`page-${step}`, [`scenario-${step}`]),
          ),
        );
        expect(run.attempts).toEqual(perStep(() => 1));
        expect(run.handlerCalls).toEqual(perStep(() => 1));
        // One delivery per terminal event, done by its first attempt.
        expect(run.deliveryAttempts).toEqual({ 'done/1': TWO_INSTANCE_TASKS });
        // The contention was real: each instance executed work.
        expect(Math.min(...run.callsPerInstance)).toBeGreaterThanOrEqual(1);
      },
      ROW_TIMEOUT_MS,
    );
  });

  // ---------------------------------------------------------------------------------------------------------------
  // E2E-2  Boot against database states: migrations and refusal to start
  // ---------------------------------------------------------------------------------------------------------------
  // User journey (operator): deploying onto an empty database creates the `app` schema without touching chat data and a second deploy is a no-op; deploying onto a database where migrations are not applied stops the process before it accepts requests.
  // Covers (original statements):
  // AC-10.1: "Given пустая база из infra/docker-compose.yml, When применяются миграции, Then схема создана; повторное применение ничего не меняет."
  // AC-10.2: "Given база, где Mastra уже создал свои таблицы и лежат беседы, When применяются миграции, Then беседы и их сообщения читаются без изменений."
  // AC-RT-3: "When apps/api стартует при неприменённых миграциях или без схемы app, система завершает старт ошибкой с именами миграций до приёма запросов."
  // AC-RT-8: "Домены CHECK статусов, классов и типов в схеме app совпадают со значениями enum в packages/contracts."
  // Use cases: UC-14, UC-E6, UC-E7 (CHECK-domain half), UC-2 (migration half; the chat-shell suite itself runs at acceptance). EARS: When.
  // Design flow: Migration Strategy (one migrator under advisory lock, startup check of file hashes against app.__drizzle_migrations), KD-2.
  //
  // Primary failure mode (turns red when): the migrator applies partially or twice, touches `public` / `mastra_*` objects, the startup check lets an unapplied or edited migration through (the app serves requests on a schema it was not built for),
  // or a hand-edited custom migration lets a CHECK domain drift from the contract enums.
  // ROI: 2.0 (raw formula: (7 x 10 + 0 + 6) / 38) | Business Value: 7 (blocks every deploy and every later schema feature, `chat-storage` included) | Frequency: 10 (every start) | Legal: false | Defect Detection: 6
  // Behavior: `db:migrate` and `apps/api` start executed as real processes against scratch databases -> exit codes, schema content and untouched `public` data
  // @category: e2e
  // @dependency: full-system (db:migrate from dist, DatabaseModule startup check, Postgres scratch database)
  // @complexity: medium
  //
  // Verification items (table of database states; each row in its own scratch database created with CREATE DATABASE and dropped afterwards):
  // - Row "empty database": pre-create a sentinel table in `public` named like a Mastra table with known rows; run `db:migrate` -> exit 0, schema `app` has every table of the Data Model and the journal `app.__drizzle_migrations`;
  //   run it again -> exit 0 and no new journal rows; sentinel table rows and structure unchanged (AC-10.2); the `apps/api` process then starts and reaches readiness
  // - CHECK domains on that migrated database: for status, class and type columns the `pg_get_constraintdef` value list equals the corresponding enum in `@agent-os/contracts` (task status, failure class, knowledge status, delivery status, dependency kind, investigation status, event type)
  // - Row "schema missing": scratch database with no `app` schema -> `apps/api` exits non-zero before binding its port; stderr names the missing migration files
  // - Row "migration not applied": database migrated up to the previous file, newest file unapplied (and a variant with an edited, already-applied file whose hash differs) -> exits non-zero before binding the port, naming exactly those files
  // - No row asserts that library behaviour (drizzle journal format, advisory lock internals); only the observable exit code, port state, schema content and sentinel data
  describe('E2E-2: migrating an empty database twice creates the app schema once without touching chat tables, and starting the api on a missing or unapplied schema exits before accepting requests, naming the migrations', () => {
    const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
    const MIGRATIONS_DIR = join(API_ROOT, 'migrations');
    /** `nest build` output, part of `pnpm --filter api build:child` that `test:e2e:runtime` runs first. */
    const API_ENTRY = join(API_ROOT, 'dist/main.js');
    /** A migrator run or an api boot, the scratch database included. */
    const PROCESS_MS = 60_000;
    const ROW_TIMEOUT_MS = 3 * PROCESS_MS;
    const POLL_MS = 200;

    /** Tables of the Data Model (design-runtime.md) plus the migration journal. */
    const APP_TABLES = [
      '__drizzle_migrations',
      'research_event_deliveries',
      'research_events',
      'research_evidence',
      'research_evidence_contents',
      'research_investigations',
      'research_task_dependencies',
      'research_task_subscribers',
      'research_tasks',
    ];

    /** Stand-in for chat data: a `public` table named like Mastra's, with known rows. */
    const SENTINEL_TABLE = 'mastra_messages_e2e_sentinel';

    const JournalSchema = z.object({
      entries: z.array(z.object({ tag: z.string(), when: z.number() })),
    });
    /** Migration files in journal order, read here independently of the app's reader. */
    const MIGRATIONS = JournalSchema.parse(
      JSON.parse(
        readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
      ),
    ).entries;
    const fileOf = (tag: string): string => `${tag}.sql`;

    const scratchDatabases: string[] = [];
    const tempDirs: string[] = [];

    afterAll(async () => {
      // FORCE: a killed api may leave its connections behind for a moment.
      for (const name of scratchDatabases) {
        await query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, []);
      }
      await closeRuntimeDb();
      for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    });

    /** `DATABASE_URL` as the app sees it: the process environment first, otherwise `apps/api/.env`. */
    function sharedDatabaseUrl(): string {
      if (!process.env.DATABASE_URL) {
        process.loadEnvFile(join(API_ROOT, '.env'));
      }
      const url = process.env.DATABASE_URL;
      if (!url)
        throw new Error('DATABASE_URL is not set (env or apps/api/.env)');
      return url;
    }

    /** A new empty database on the shared server, dropped in `afterAll`; returns its URL. */
    async function createScratchDatabase(): Promise<string> {
      const name = `e2e_boot_${randomBytes(6).toString('hex')}`;
      await query(`CREATE DATABASE "${name}"`, []);
      scratchDatabases.push(name);
      const url = new URL(sharedDatabaseUrl());
      url.pathname = `/${name}`;
      return url.toString();
    }

    async function withDatabase<T>(
      url: string,
      use: (client: pg.Client) => Promise<T>,
    ): Promise<T> {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        return await use(client);
      } finally {
        await client.end();
      }
    }

    /** Brings the database to "the first `count` files applied" with a copy of the folder cut there. */
    async function applyFirstMigrations(
      url: string,
      count: number,
    ): Promise<void> {
      const folder = mkdtempSync(join(tmpdir(), 'e2e-migrations-'));
      tempDirs.push(folder);
      cpSync(MIGRATIONS_DIR, folder, { recursive: true });
      const journalFile = join(folder, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as {
        entries: unknown[];
      };
      journal.entries = journal.entries.slice(0, count);
      writeFileSync(journalFile, JSON.stringify(journal));
      await withDatabase(url, (client) =>
        migrate(drizzle({ client }), {
          migrationsFolder: folder,
          migrationsSchema: 'app',
          migrationsTable: '__drizzle_migrations',
        }),
      );
    }

    interface Started {
      process: ChildProcess;
      exited: Promise<number | null>;
      output: () => string;
    }

    function startProcess(
      command: string,
      args: string[],
      env: Record<string, string>,
      shell = false,
    ): Started {
      const child = spawn(command, args, {
        cwd: API_ROOT,
        shell,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'test', ...env },
      });
      const chunks: string[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
      return {
        process: child,
        exited: new Promise((resolve) => child.on('exit', resolve)),
        output: () => chunks.join(''),
      };
    }

    interface Finished {
      exitCode: number | null;
      output: string;
    }

    async function untilExit(
      started: Started,
      what: string,
    ): Promise<Finished> {
      try {
        const exitCode = await within(started.exited, PROCESS_MS, what);
        return { exitCode, output: started.output() };
      } catch (error) {
        started.process.kill();
        throw new Error(`${String(error)}; output:\n${started.output()}`);
      }
    }

    /** `pnpm db:migrate` as deployed: the package script itself, from `dist`, against the database. */
    function dbMigrate(url: string): Promise<Finished> {
      const scripts = z
        .object({ scripts: z.object({ 'db:migrate': z.string() }) })
        .parse(
          JSON.parse(readFileSync(join(API_ROOT, 'package.json'), 'utf8')),
        );
      return untilExit(
        startProcess(
          scripts.scripts['db:migrate'],
          [],
          { DATABASE_URL: url },
          true,
        ),
        'db:migrate',
      );
    }

    function startApi(url: string, port: number): Started {
      return startProcess(process.execPath, [API_ENTRY], {
        DATABASE_URL: url,
        PORT: String(port),
      });
    }

    /** A port held by the test: an api that reached `listen` would fail with EADDRINUSE. */
    async function holdPort(): Promise<Server & { port: number }> {
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('The held port has no address');
      }
      return Object.assign(server, { port: address.port });
    }

    async function freePort(): Promise<number> {
      const server = await holdPort();
      await new Promise((resolve) => server.close(resolve));
      return server.port;
    }

    /** Migration file names the output mentions, sorted. */
    function namedMigrations(output: string): string[] {
      return [...new Set(output.match(/\b\d{4}_\w+\.sql\b/g) ?? [])].sort();
    }

    // -------------------------------------------------------------------------------------------
    // Row "empty database": every assertion reads the same scratch database, migrated twice once.
    // -------------------------------------------------------------------------------------------
    describe('empty database', () => {
      interface PublicSnapshot {
        relations: { relname: string; relkind: string }[];
        sentinelColumns: unknown[];
        sentinelRows: unknown[];
      }
      interface AppSnapshot {
        relations: { relname: string; relkind: string }[];
        journal: { id: number; hash: string; created_at: string }[];
      }

      let url: string;
      let firstRun: Finished;
      let secondRun: Finished;
      let publicBefore: PublicSnapshot;
      let publicAfter: PublicSnapshot;
      let appAfterFirst: AppSnapshot;
      let appAfterSecond: AppSnapshot;

      /** Relations of a schema; queries on one client run one after another. */
      const relationsOf = async (client: pg.Client, schema: string) =>
        (
          await client.query<{ relname: string; relkind: string }>(
            `SELECT c.relname, c.relkind::text AS relkind FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 ORDER BY c.relname`,
            [schema],
          )
        ).rows;

      const snapshotPublic = async (
        client: pg.Client,
      ): Promise<PublicSnapshot> => ({
        relations: await relationsOf(client, 'public'),
        sentinelColumns: (
          await client.query(
            `SELECT column_name, data_type, is_nullable, column_default
               FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
            [SENTINEL_TABLE],
          )
        ).rows,
        sentinelRows: (
          await client.query(
            `SELECT * FROM public.${SENTINEL_TABLE} ORDER BY id`,
          )
        ).rows,
      });

      const snapshotApp = async (client: pg.Client): Promise<AppSnapshot> => ({
        relations: await relationsOf(client, 'app'),
        journal: (
          await client.query<{ id: number; hash: string; created_at: string }>(
            'SELECT id, hash, created_at FROM app.__drizzle_migrations ORDER BY id',
          )
        ).rows,
      });

      beforeAll(async () => {
        url = await createScratchDatabase();
        publicBefore = await withDatabase(url, async (client) => {
          await client.query(
            `CREATE TABLE public.${SENTINEL_TABLE} (
               id integer PRIMARY KEY, thread_id text NOT NULL, content jsonb NOT NULL)`,
          );
          await client.query(
            `INSERT INTO public.${SENTINEL_TABLE} (id, thread_id, content) VALUES
               (1, 'thread-1', '{"text":"first"}'), (2, 'thread-1', '{"text":"second"}')`,
          );
          return snapshotPublic(client);
        });

        firstRun = await dbMigrate(url);
        appAfterFirst = await withDatabase(url, snapshotApp);
        secondRun = await dbMigrate(url);
        await withDatabase(url, async (client) => {
          appAfterSecond = await snapshotApp(client);
          publicAfter = await snapshotPublic(client);
        });
      }, ROW_TIMEOUT_MS);

      it('db:migrate twice: both runs exit 0, the first creates every table of the Data Model and journals each file, the second changes nothing, public stays as it was (AC-10.1, AC-10.2)', () => {
        expect(firstRun.exitCode, firstRun.output).toBe(0);
        expect(secondRun.exitCode, secondRun.output).toBe(0);

        const tables = appAfterFirst.relations
          .filter((relation) => relation.relkind === 'r')
          .map((relation) => relation.relname);
        expect(tables).toEqual(APP_TABLES);
        expect(
          appAfterFirst.journal.map((row) => Number(row.created_at)),
        ).toEqual(MIGRATIONS.map((migration) => migration.when));

        expect(appAfterSecond).toEqual(appAfterFirst);

        expect(
          publicBefore.relations.map((relation) => relation.relname),
        ).toContain(SENTINEL_TABLE);
        expect(publicBefore.sentinelRows).toHaveLength(2);
        expect(publicAfter).toEqual(publicBefore);
      });

      it('CHECK domains of statuses and kinds in schema app equal the contract enums (AC-RT-8)', async () => {
        const constraints = await withDatabase(url, (client) =>
          client.query<{ name: string; definition: string }>(
            `SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS definition
               FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
              WHERE n.nspname = 'app' AND con.contype = 'c'`,
          ),
        );
        // `col IN ('a', 'b')` is stored as `col = ANY (ARRAY['a'::text, 'b'::text])`.
        const domains = Object.fromEntries(
          constraints.rows
            .filter((row) => row.definition.includes('= ANY (ARRAY['))
            .map((row) => [
              row.name,
              [...row.definition.matchAll(/'([^']*)'::text/g)]
                .map((match) => match[1])
                .sort(),
            ]),
        );
        const sorted = (values: readonly string[]) => [...values].sort();

        expect(domains).toEqual({
          research_event_deliveries_status_check: sorted(
            DeliveryStatusSchema.options,
          ),
          research_evidence_knowledge_status_check: sorted(
            KnowledgeStatusSchema.options,
          ),
          research_investigations_status_check: sorted(
            InvestigationStatusSchema.options,
          ),
          research_task_dependencies_kind_check: sorted(
            TaskEdgeKindSchema.options,
          ),
          research_tasks_status_check: sorted(TaskStatusSchema.options),
        });
      });

      it(
        'the api starts on the migrated database and serves requests',
        async () => {
          const apiPort = await freePort();
          const api = startApi(url, apiPort);
          try {
            const status = await within(
              (async () => {
                for (;;) {
                  if (api.process.exitCode !== null) {
                    throw new Error(
                      `The api exited ${api.process.exitCode}; output:\n${api.output()}`,
                    );
                  }
                  const response = await fetch(
                    `http://127.0.0.1:${apiPort}/api/threads`,
                    { headers: { 'x-user-id': `e2e-${randomUUID()}` } },
                  ).catch(() => undefined);
                  if (response) return response.status;
                  await delay(POLL_MS);
                }
              })(),
              PROCESS_MS,
              'the api to accept requests',
            );
            expect(status, api.output()).toBe(200);
          } finally {
            api.process.kill();
            await api.exited;
          }
        },
        ROW_TIMEOUT_MS,
      );
    });

    // -------------------------------------------------------------------------------------------
    // Refusal rows: each in its own scratch database, the api's port held by the test.
    // -------------------------------------------------------------------------------------------
    const lastMigration = MIGRATIONS[MIGRATIONS.length - 1];
    const firstMigration = MIGRATIONS[0];
    const REFUSALS: {
      state: string;
      prepare: (url: string) => Promise<void>;
      pending: string[];
    }[] = [
      {
        state: 'schema app missing',
        prepare: async () => {},
        pending: MIGRATIONS.map((migration) => fileOf(migration.tag)),
      },
      {
        state: 'newest migration not applied',
        prepare: (url) => applyFirstMigrations(url, MIGRATIONS.length - 1),
        pending: [fileOf(lastMigration.tag)],
      },
      {
        // The journal keeps the hash of the file as it was applied; the file on disk differs now.
        state: 'applied migration edited afterwards',
        prepare: async (url) => {
          await applyFirstMigrations(url, MIGRATIONS.length);
          const edited = await withDatabase(url, (client) =>
            client.query(
              `UPDATE app.__drizzle_migrations SET hash = 'before-edit-' || hash WHERE created_at = $1`,
              [firstMigration.when],
            ),
          );
          expect(edited.rowCount).toBe(1);
        },
        pending: [fileOf(firstMigration.tag)],
      },
    ];

    it.each(REFUSALS)(
      '$state: the api exits non-zero before binding its port, naming exactly $pending (AC-RT-3)',
      async ({ prepare, pending }) => {
        const url = await createScratchDatabase();
        await prepare(url);
        const held = await holdPort();
        try {
          const run = await untilExit(
            startApi(url, held.port),
            'the api to refuse the start',
          );

          expect(run.exitCode, run.output).not.toBe(0);
          expect(run.exitCode, run.output).not.toBeNull();
          expect(namedMigrations(run.output)).toEqual([...pending].sort());
          // The check ran before `listen`: a listen on the held port would have failed first.
          expect(run.output).not.toContain('EADDRINUSE');
        } finally {
          await new Promise((resolve) => held.close(resolve));
        }
      },
      ROW_TIMEOUT_MS,
    );
  });
});
