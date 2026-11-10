import {
  InvestigationStatusSchema,
  TaskStatusSchema,
} from '@agent-os/contracts';
import {
  applyMigrations,
  createDatabase,
  type Database,
  type DatabaseConnection,
  researchInvestigations,
  researchTasks,
} from '@agent-os/db';
import {
  type Clock,
  createRuntime,
  type InvestigationService,
  type Runtime,
  type RuntimeConfig,
  type ThreadOwnership,
} from '@agent-os/runtime';
import { and, count, eq, inArray } from 'drizzle-orm';
import { removeExpiredCopies } from './copies.js';
import { SELF_CHECK_OWNER } from '../auth/system-owners.js';
import type { SelfCheckLogger } from './scenario-assembly.js';

/** What the start of every command needs. */
export interface StartupInput {
  /** `DATABASE_URL`: the database the program shares with the server (design-self-check.md, KD-3). */
  readonly databaseUrl: string;
  /** The retention term of the employees' transcripts (`TRANSCRIPT_RETENTION_DAYS`): a copy of an older original is removed. */
  readonly transcriptRetention: { readonly days: number };
  readonly runtime: RuntimeConfig;
  readonly clock: Clock;
  readonly logger: SelfCheckLogger;
}

/** A task of these statuses may still run: a leftover is cleared only when its investigations have none. */
const UNFINISHED_TASK_STATUSES = [
  TaskStatusSchema.enum.queued,
  TaskStatusSchema.enum.waiting,
  TaskStatusSchema.enum.running,
] as const;

/**
 * The ownership port of the start-up runtime: it only cancels and removes, so no conversation is ever entered through
 * it.
 */
const noThreads: ThreadOwnership = {
  withOwnedThread(threadId) {
    throw new Error(
      `Thread ${threadId}: the start of the self-check program starts no investigation`,
    );
  },
};

/**
 * The start of the program (design-self-check.md, C3 self-check, «Перед первым сценарием»), in this order:
 *
 * 1. `applyMigrations` to the database of `DATABASE_URL`, as `migrate-cli` does;
 * 2. the employee-data copies whose original is deleted or past the retention term (DC-4): see
 *    {@link removeExpiredCopies}.
 *
 * The program does not check that the server's runtime workers are off on this database and that no employee
 * investigation is unfinished: that is the developer's condition of running it (KD-3).
 *
 * The leftovers of an earlier run are not touched here: only `run` and `replay` cancel them, before their first
 * investigation (DC-18, {@link cancelLeftoverInvestigations}); `show` starts nothing and leaves them as they are.
 */
export async function startUp(input: StartupInput): Promise<void> {
  await applyMigrations(input.databaseUrl);
  input.logger.log('self-check migrations applied');
  await withStartupRuntime(input, { workers: false }, (database, runtime) =>
    removeExpiredCopies({
      db: database.db,
      investigations: runtime.investigations,
      retention: input.transcriptRetention,
      logger: input.logger,
    }),
  );
}

/**
 * A runtime of the start over its own pool, with the program's Runtime Settings and no handlers. Its workers start
 * only when `workers` is set: then the dispatcher claims nothing and the recovery sweeper reaps — over the whole shared
 * database, so only the leftover cancel of `run` and `replay` asks for them; the common start (every command, `show`
 * included) uses the investigation service alone (DC-17, DC-18). Stopped and closed after `fn`, whatever its outcome.
 */
async function withStartupRuntime(
  input: StartupInput,
  options: { readonly workers: boolean },
  fn: (database: DatabaseConnection, runtime: Runtime) => Promise<void>,
): Promise<void> {
  const database = createDatabase({
    connectionString: input.databaseUrl,
    poolMax: input.runtime.dbPoolMax,
  });
  try {
    const runtime = createRuntime({
      database,
      config: input.runtime,
      threads: noThreads,
      logger: input.logger,
      clock: input.clock,
    });
    if (options.workers) runtime.start();
    try {
      await fn(database, runtime);
    } finally {
      await runtime.stop();
    }
  } finally {
    await database.close();
  }
}

/**
 * Before the first investigation of `run` or `replay` (DC-18, UC-E9), after all their refusals that need no assembly:
 * every `active` investigation of `system:self-check` — say, of a run that fell mid-scenario — is cancelled through
 * `InvestigationService.cancel`, and the command waits until none of them has a task queued, waiting or running, so no
 * task of an earlier run executes on the fixture of the next scenario. An investigation of another owner — an
 * employee's — or one that is no longer `active` is not touched (DC-17, UC-E7).
 *
 * It runs on a runtime of its own without handlers ({@link withStartupRuntime}) and before any scenario assembly: an
 * assembly's dispatcher would claim a leftover queued task at once.
 */
export function cancelLeftoverInvestigations(
  input: StartupInput,
): Promise<void> {
  return withStartupRuntime(input, { workers: true }, (database, runtime) =>
    cancelLeftovers(database.db, runtime.investigations, input),
  );
}

/**
 * The cancel ends the queued and waiting tasks at once; a running one gets `cancel_requested_at` and is ended by its
 * own worker's heartbeat or, when that worker is gone, by the reaper of the start-up runtime once its lease runs out.
 * The wait polls every `RUNTIME_POLL_MS` of the program clock.
 */
async function cancelLeftovers(
  db: Database,
  investigations: Pick<InvestigationService, 'cancel'>,
  input: StartupInput,
): Promise<void> {
  const { clock, logger } = input;
  const leftovers = await db
    .select({ investigationId: researchInvestigations.investigationId })
    .from(researchInvestigations)
    .where(
      and(
        eq(researchInvestigations.resourceId, SELF_CHECK_OWNER),
        eq(
          researchInvestigations.status,
          InvestigationStatusSchema.enum.active,
        ),
      ),
    );
  for (const { investigationId } of leftovers) {
    await investigations.cancel(investigationId, SELF_CHECK_OWNER);
  }
  const investigationIds = leftovers.map((row) => row.investigationId);
  while ((await unfinishedTasks(db, investigationIds)) > 0) {
    await new Promise<void>((resolve) => {
      clock.setTimer(input.runtime.pollMs, resolve);
    });
  }
  logger.log('self-check leftovers cancelled', {
    investigations: investigationIds.length,
  });
}

async function unfinishedTasks(
  db: Database,
  investigationIds: readonly string[],
): Promise<number> {
  if (investigationIds.length === 0) return 0;
  const [row] = await db
    .select({ unfinished: count() })
    .from(researchTasks)
    .where(
      and(
        inArray(researchTasks.investigationId, [...investigationIds]),
        inArray(researchTasks.status, [...UNFINISHED_TASK_STATUSES]),
      ),
    );
  return row?.unfinished ?? 0;
}
