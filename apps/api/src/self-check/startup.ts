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
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { removeExpiredCopies } from './copies.js';
import {
  checkSelfCheckDatabase,
  type DatabaseGuardResult,
  SELF_CHECK_SUFFIX,
} from './database-guard.js';
import type { SelfCheckLogger } from './scenario-assembly.js';

/** What the start of every command needs; the steps after the migrations work over the self-check database only. */
export interface StartupInput {
  /** `SELF_CHECK_DATABASE_URL`. */
  readonly selfCheckDatabaseUrl: string | undefined;
  /**
   * `DATABASE_URL`: compared by the guard, by URL and then by the name the server reports; read — only read — when a
   * copy of a main original has to be checked.
   */
  readonly mainDatabaseUrl: string | undefined;
  /** The retention term of the main database (`TRANSCRIPT_RETENTION_DAYS`): a copy of an older original is removed. */
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

const READ_ONLY_OPTION = '-c default_transaction_read_only=on';

/** The URL with `default_transaction_read_only=on` added to the session options it may already carry. */
function readOnlyUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const options = url.searchParams.get('options');
  url.searchParams.set(
    'options',
    options === null || options === ''
      ? READ_ONLY_OPTION
      : `${options} ${READ_ONLY_OPTION}`,
  );
  return url.toString();
}

/**
 * Opens the main database with every transaction read-only on the server side (`default_transaction_read_only`): the
 * program never writes there (invariant 5). Throws when `DATABASE_URL` is not set.
 */
export function openMainDatabase(
  mainDatabaseUrl: string | undefined,
  poolMax: number,
): DatabaseConnection {
  if (mainDatabaseUrl === undefined || mainDatabaseUrl === '') {
    throw new Error(
      'DATABASE_URL is not set: the main database cannot be read',
    );
  }
  return createDatabase({
    connectionString: readOnlyUrl(mainDatabaseUrl),
    poolMax,
  });
}

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
 * The start of the program (design-self-check.md, C3 self-check, «Перед первым сценарием»; DC-17), in this order:
 *
 * 1. the guard over the URLs — a refusal `database_not_self_check` is returned before any connection is opened, so the
 *    main database gets neither a migration nor an investigation (UC-E7);
 * 2. the guard over the opened connection: the name the server reports for the self-check database ends with
 *    `_self_check` and, when `DATABASE_URL` is set, differs from the one the main server reports — the URL alone may
 *    hide the real database behind a service name or a connection option (see {@link checkConnectedDatabases});
 * 3. `applyMigrations` to the self-check database;
 * 4. the employee-data copies whose main original is deleted or past the main retention term (DC-4): see
 *    {@link removeExpiredCopies}.
 *
 * The leftovers of an earlier run are not touched here: only `run` and `replay` cancel them, before their first
 * investigation (DC-18, {@link cancelLeftoverInvestigations}); `show` starts nothing and leaves them as they are.
 *
 * Returns the guard's result: on success the self-check database URL every assembly connects to.
 */
export async function startUp(
  input: StartupInput,
): Promise<DatabaseGuardResult> {
  const guard = checkSelfCheckDatabase(input);
  if (!guard.ok) return guard;
  const connected = await checkConnectedDatabases(guard.databaseUrl, input);
  if (!connected.ok) return connected;
  await applyMigrations(guard.databaseUrl);
  input.logger.log('self-check database migrated');
  await withStartupRuntime(
    guard.databaseUrl,
    input,
    async (database, runtime) => {
      const opened: DatabaseConnection[] = [];
      try {
        await removeExpiredCopies({
          selfCheckDb: database.db,
          investigations: runtime.investigations,
          mainDb: () => {
            const main = openMainDatabase(
              input.mainDatabaseUrl,
              input.runtime.dbPoolMax,
            );
            opened.push(main);
            return main.db;
          },
          retention: input.transcriptRetention,
          logger: input.logger,
        });
      } finally {
        await Promise.all(opened.map((connection) => connection.close()));
      }
    },
  );
  return guard;
}

const CurrentDatabaseRowsSchema = z
  .array(z.object({ name: z.string() }))
  .length(1);

/** The database name the server reports for the connection: `current_database()`. */
async function currentDatabase(db: Database): Promise<string> {
  const result = await db.execute(sql`select current_database() as name`);
  const [row] = CurrentDatabaseRowsSchema.parse(result.rows);
  return row.name;
}

/**
 * Step 2 of the start: the self-check connection is opened and asked which database it is in; the name must end with
 * `_self_check` and, when `DATABASE_URL` is set, differ from what the main connection (read-only) reports. A refusal
 * names databases only — never credentials. Both connections are closed before the result is returned.
 */
async function checkConnectedDatabases(
  databaseUrl: string,
  input: StartupInput,
): Promise<DatabaseGuardResult> {
  const refused = (reason: string): DatabaseGuardResult => ({
    ok: false,
    code: 'database_not_self_check',
    reason,
  });
  const selfCheck = createDatabase({
    connectionString: databaseUrl,
    poolMax: 1,
  });
  const opened: DatabaseConnection[] = [selfCheck];
  try {
    const name = await currentDatabase(selfCheck.db);
    if (!name.endsWith(SELF_CHECK_SUFFIX)) {
      return refused(
        `the connected database "${name}" does not end with ${SELF_CHECK_SUFFIX}`,
      );
    }
    if (input.mainDatabaseUrl !== undefined && input.mainDatabaseUrl !== '') {
      const main = openMainDatabase(input.mainDatabaseUrl, 1);
      opened.push(main);
      const mainName = await currentDatabase(main.db);
      if (mainName === name) {
        return refused(
          `the connected database "${name}" is the DATABASE_URL database`,
        );
      }
    }
    return { ok: true, databaseUrl };
  } finally {
    await Promise.all(opened.map((connection) => connection.close()));
  }
}

/**
 * A runtime of the start over its own pool, with the program's Runtime Settings and no handlers: its dispatcher claims
 * nothing, its recovery sweeper reaps. Stopped and closed after `fn`, whatever its outcome.
 */
async function withStartupRuntime(
  databaseUrl: string,
  input: StartupInput,
  fn: (database: DatabaseConnection, runtime: Runtime) => Promise<void>,
): Promise<void> {
  const database = createDatabase({
    connectionString: databaseUrl,
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
    runtime.start();
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
 * every `active` investigation of the self-check database — say, of a run that fell mid-scenario — is cancelled through
 * `InvestigationService.cancel`, and the command waits until none of them has a task queued, waiting or running, so no
 * task of an earlier run executes on the fixture of the next scenario. An investigation that is no longer `active` is
 * not touched.
 *
 * It runs on a runtime of its own without handlers ({@link withStartupRuntime}) and before any scenario assembly: an
 * assembly's dispatcher would claim a leftover queued task at once.
 */
export function cancelLeftoverInvestigations(
  databaseUrl: string,
  input: StartupInput,
): Promise<void> {
  return withStartupRuntime(databaseUrl, input, (database, runtime) =>
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
    .select({
      investigationId: researchInvestigations.investigationId,
      resourceId: researchInvestigations.resourceId,
    })
    .from(researchInvestigations)
    .where(
      eq(researchInvestigations.status, InvestigationStatusSchema.enum.active),
    );
  for (const { investigationId, resourceId } of leftovers) {
    await investigations.cancel(investigationId, resourceId);
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
