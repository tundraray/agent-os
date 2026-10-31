// research-runtime / runtime: migrations of schema `app` against real Postgres (E2E-2, migration rows).
// Design Doc: docs/features/research-runtime/design-runtime.md (Migration Strategy, KD-2).
// Moved from apps/api/test/research-runtime-runtime.e2e-spec.ts; the rows that boot the api stay with apps/api.
// The migrator is called directly (`applyMigrations`); the exit code of `pnpm db:migrate` is proven by the
// operational verification of the deploy, not here.
//
// Covers:
// AC-10.1: "Given пустая база из infra/docker-compose.yml, When применяются миграции, Then схема создана; повторное применение ничего не меняет."
// AC-10.2: "Given база, где Mastra уже создал свои таблицы и лежат беседы, When применяются миграции, Then беседы и их сообщения читаются без изменений."
// AC-RT-8: "Домены CHECK статусов, классов и типов в схеме app совпадают со значениями enum в packages/contracts."
//
// Primary failure mode: the migrator applies twice or partially, touches `public`, or a CHECK domain drifts from the contract enums.
// Isolation: the row runs in its own scratch database, created with CREATE DATABASE and dropped afterwards.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeliveryStatusSchema,
  InvestigationStatusSchema,
  KnowledgeStatusSchema,
  TaskEdgeKindSchema,
  TaskStatusSchema,
} from '@agent-os/contracts';
import type pg from 'pg';
import { z } from 'zod';
import { applyMigrations, MIGRATIONS_FOLDER } from '../src/index.js';
import { ScratchDatabases, withDatabase } from './support/scratch-db.js';

/** Two migrator runs with their scratch database. */
const ROW_TIMEOUT_MS = 120_000;

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
/** Migration files in journal order, read here independently of the package's reader. */
const MIGRATIONS = JournalSchema.parse(
  JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ),
).entries;

describe('E2E-2: migrating an empty database twice creates the app schema once without touching chat tables', () => {
  const scratch = new ScratchDatabases();

  afterAll(() => scratch.dropAll());

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
    let firstRunError: unknown;
    let secondRunError: unknown;
    let publicBefore: PublicSnapshot;
    let publicAfter: PublicSnapshot;
    let appAfterFirst: AppSnapshot;
    let appAfterSecond: AppSnapshot;

    /** The error a migrator run threw, `undefined` when it completed. */
    const migrateOnce = (target: string): Promise<unknown> =>
      applyMigrations(target).then(
        () => undefined,
        (error: unknown) => error,
      );

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
        await client.query(`SELECT * FROM public.${SENTINEL_TABLE} ORDER BY id`)
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
      url = await scratch.create();
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

      firstRunError = await migrateOnce(url);
      appAfterFirst = await withDatabase(url, snapshotApp);
      secondRunError = await migrateOnce(url);
      await withDatabase(url, async (client) => {
        appAfterSecond = await snapshotApp(client);
        publicAfter = await snapshotPublic(client);
      });
    }, ROW_TIMEOUT_MS);

    it('applyMigrations twice: both runs complete without an error, the first creates every table of the Data Model and journals each file, the second changes nothing, public stays as it was (AC-10.1, AC-10.2)', () => {
      expect(firstRunError).toBeUndefined();
      expect(secondRunError).toBeUndefined();

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
  });
});
