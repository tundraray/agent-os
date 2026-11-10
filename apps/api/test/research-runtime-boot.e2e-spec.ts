// research-runtime / runtime — E2E-2, the rows that boot the api: the composition root's start against database states.
// Design Doc: docs/features/research-runtime/design-runtime.md (Migration Strategy, KD-2, "Функции сборки и порты"). Moved from
// research-runtime-runtime.e2e-spec.ts with their assertions unchanged; the migration rows (applyMigrations twice, CHECK domains) live in
// packages/db/test/migrations.e2e-spec.ts with the code they prove.
// Covers (original statements):
// AC-RT-3: "When apps/api стартует при неприменённых миграциях или без схемы app, система завершает старт ошибкой с именами миграций до приёма запросов."
// Use cases: UC-14, UC-E6. EARS: When.
// Primary failure mode (turns red when): the startup check of ResearchModule lets an unapplied migration through, does not name the files,
// or runs after the api binds its port; or the api does not start on a migrated database. Which files count as pending (an edited applied
// file, a file timestamped before the last applied one) is the rule of packages/db/src/pending-migrations.spec.ts.
// Environment: each row in its own scratch database created with CREATE DATABASE and dropped afterwards; the refusal rows run the api from
// `dist/main.js`. The "api starts" row runs the test entry `test/support/apiBootChildMain.ts` (`dist/test-child/`): it starts the api as
// `main.ts` does, with the test group table in `ENGINE_GROUP_TABLES`, because the server start requires the table of its verifier
// (`Engine.checkCalibration`, DC-10) and the shipped one comes from the owner's calibration. The refusal rows stay on `dist/main.js`: the
// migration check of `ResearchModule.onModuleInit` refuses before `EngineModule` looks for a table. `pnpm --filter api test:e2e:runtime`
// builds both first. Migrations come from the entry of @agent-os/db, not from a path into the package (ADR-0004).

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
  applyMigrations,
  MIGRATIONS_FOLDER,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
} from '@agent-os/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { closeRuntimeDb, query, within } from './support/wiring-handlers.js';

describe('research-runtime / runtime - E2E-2 boot of the api (real Postgres, child processes)', () => {
  describe('E2E-2: starting the api on a missing or unapplied schema exits before accepting requests, naming the migrations; on a migrated database it serves requests', () => {
    const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
    /** `nest build` output, built by `test:e2e:runtime` first. */
    const API_ENTRY = join(API_ROOT, 'dist/main.js');
    /** `main.ts` with the test group table (`pnpm build:child`, run by `test:e2e:runtime` first). */
    const BOOT_ENTRY = join(
      API_ROOT,
      'dist/test-child/test/support/apiBootChildMain.js',
    );
    /** A migrator run or an api boot, the scratch database included. */
    const PROCESS_MS = 60_000;
    const ROW_TIMEOUT_MS = 3 * PROCESS_MS;
    const POLL_MS = 200;

    const JournalSchema = z.object({
      entries: z.array(z.object({ tag: z.string() })),
    });
    /** Migration files in journal order, read here independently of the app's reader. */
    const MIGRATIONS = JournalSchema.parse(
      JSON.parse(
        readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
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
      cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
      const journalFile = join(folder, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as {
        entries: unknown[];
      };
      journal.entries = journal.entries.slice(0, count);
      writeFileSync(journalFile, JSON.stringify(journal));
      await withDatabase(url, (client) =>
        migrate(drizzle({ client }), {
          migrationsFolder: folder,
          migrationsSchema: MIGRATIONS_SCHEMA,
          migrationsTable: MIGRATIONS_TABLE,
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

    function startApi(
      url: string,
      port: number,
      entry: string = API_ENTRY,
      env: Record<string, string> = {},
    ): Started {
      return startProcess(process.execPath, [entry], {
        DATABASE_URL: url,
        PORT: String(port),
        ...env,
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

    it(
      'the api starts on the migrated database and serves requests',
      async () => {
        const url = await createScratchDatabase();
        await applyMigrations(url);
        const apiPort = await freePort();
        const api = startApi(url, apiPort, BOOT_ENTRY);
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

    // -------------------------------------------------------------------------------------------
    // Refusal rows: each in its own scratch database, the api's port held by the test.
    // -------------------------------------------------------------------------------------------
    const lastMigration = MIGRATIONS[MIGRATIONS.length - 1];
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

    // agent-runtime / agent-core — design-agent-core.md, Runtime Settings, DC-27: «Сборка `apps/api` при старте сверяет
    // запас с суммой `leaseMs` runtime и `AGENT_TURN_MS` и не стартует, если он меньше».
    // Catches: the server starts with a margin that leaves no room for the last turn's tool calls, or the message does
    // not name the three settings. The database is migrated, so the migration check passes and the engine's check refuses.
    it(
      'a deadline margin below the lease plus a turn: the api exits non-zero before binding its port, naming the three settings',
      async () => {
        const url = await createScratchDatabase();
        await applyMigrations(url);
        const held = await holdPort();
        try {
          const run = await untilExit(
            startApi(url, held.port, API_ENTRY, {
              RUNTIME_LEASE_MS: '30000',
              AGENT_TURN_MS: '60000',
              AGENT_DEADLINE_MARGIN_MS: '89999',
            }),
            'the api to refuse the start',
          );

          expect(run.exitCode, run.output).not.toBe(0);
          expect(run.exitCode, run.output).not.toBeNull();
          expect(run.output).toContain(
            'AGENT_DEADLINE_MARGIN_MS (89999) must not be less than RUNTIME_LEASE_MS (30000) + AGENT_TURN_MS (60000)',
          );
          expect(run.output).not.toContain('EADDRINUSE');
        } finally {
          await new Promise((resolve) => held.close(resolve));
        }
      },
      ROW_TIMEOUT_MS,
    );
  });
});
