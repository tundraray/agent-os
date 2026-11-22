// Migrations of schema `app` against real Postgres (E2E-2, migration rows).
// Design Doc: docs/features/agent-platform/design-runtime.md (Data Model, KD-7; Invariants 3, 7, 8 — schema constraints).
// The migrator is called directly (`applyMigrations`); the exit code of `pnpm db:migrate` is proven by the
// operational verification of the deploy, not here.
//
// Covers:
// AC-10.1: "Given пустая база из infra/docker-compose.yml, When применяются миграции, Then схема создана; повторное применение ничего не меняет."
// AC-10.2: "Given база, где Mastra уже создал свои таблицы и лежат беседы, When применяются миграции, Then беседы и их сообщения читаются без изменений."
// AC-RT-8: "Домены CHECK статусов в схеме app совпадают со значениями enum в packages/contracts" — the `runtime_*` tables
// (task status, wait reason, message status, decision status, delivery status from packages/contracts/src/runtime.ts).
// One baseline migration creates the whole schema `app` with its seed rows and the `vector` extension
// (self-learning/design-core.md, Data Model): after it, only the tables of the Data Models are in `app`.
// The `agent_*` CHECK domains (history kind, tool call state, outcome, refusal reason) come from
// packages/contracts/src/agents.ts.
//
// Primary failure mode: the migrator applies twice or partially, touches `public`, or a CHECK domain drifts from the contract enums.
// Isolation: the row runs in its own scratch database, created with CREATE DATABASE and dropped afterwards.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CALL_RECORD_KINDS,
  DecisionStatusSchema,
  DeliveryStatusSchema,
  EmbeddingFailureReasonSchema,
  GrantEffectSchema,
  GrantTargetKindSchema,
  HistoryEntryKindSchema,
  KnowledgeItemKindSchema,
  KnowledgeItemTypeSchema,
  LanguageSchema,
  LastExtractionReasonSchema,
  LastExtractionStatusSchema,
  McpServerModeSchema,
  MessageStatusSchema,
  ModelProviderKindSchema,
  ModelPurposeSchema,
  ProviderTypeSchema,
  RecordKindSchema,
  SessionTaskStatusSchema,
  TaskStatusSchema,
  ToolOutcomeSchema,
  ToolRefusalReasonSchema,
  UserStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import type pg from 'pg';
import { z } from 'zod';
import { applyMigrations, MIGRATIONS_FOLDER } from '../src/index';
import { ScratchDatabases, withDatabase } from './support/scratch-db';

/** Two migrator runs with their scratch database. */
const ROW_TIMEOUT_MS = 120_000;

/** Tables of the Data Models (agent-platform/design-runtime.md, design-agents.md, design-chat.md, agent-quality/design-lifecycle.md) plus the migration journal. */
const APP_TABLES = [
  '__drizzle_migrations',
  'access_grants',
  'access_model_defaults',
  'access_models',
  'agent_code_calls',
  'agent_knowledge_embedding',
  'agent_knowledge_entities',
  'agent_knowledge_questions',
  'agent_knowledge_relations',
  'agent_knowledge_runs',
  'agent_knowledge_settings',
  'agent_knowledge_vectors',
  'agent_mcp_accounts',
  'agent_mcp_servers',
  'agent_messages',
  'agent_model_providers',
  // '_' (0x5f) before 's' (0x73), as below.
  'agent_session_tasks',
  'agent_sessions',
  // `name` sorts bytewise: '_' (0x5f) before 's' (0x73).
  'agent_tool_result_settings',
  'agent_tool_results',
  'audit_events',
  'identity_login_requests',
  'identity_providers',
  'identity_role_members',
  'identity_roles',
  'identity_sessions',
  'identity_settings',
  'identity_users',
  'library_records',
  'library_settings',
  'library_shares',
  'runtime_decisions',
  'runtime_event_deliveries',
  'runtime_events',
  'runtime_inbox',
  'runtime_model_calls',
  'runtime_tasks',
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
        runtime_tasks_status_check: sorted(TaskStatusSchema.options),
        runtime_tasks_wait_reason_check: sorted(WaitReasonSchema.options),
        runtime_inbox_status_check: sorted(MessageStatusSchema.options),
        runtime_decisions_status_check: sorted(DecisionStatusSchema.options),
        runtime_event_deliveries_status_check: sorted(
          DeliveryStatusSchema.options,
        ),
        agent_messages_kind_check: sorted(HistoryEntryKindSchema.options),
        agent_messages_call_id_check: sorted(CALL_RECORD_KINDS),
        agent_code_calls_outcome_check: sorted(ToolOutcomeSchema.options),
        agent_code_calls_refusal_reason_check: sorted(
          ToolRefusalReasonSchema.options,
        ),
        identity_users_status_check: sorted(UserStatusSchema.options),
        identity_users_language_check: sorted(LanguageSchema.options),
        identity_providers_type_check: sorted(ProviderTypeSchema.options),
        agent_mcp_servers_mode_check: sorted(McpServerModeSchema.options),
        agent_model_providers_kind_check: sorted(ModelProviderKindSchema.options),
        access_models_purpose_check: sorted(ModelPurposeSchema.options),
        access_grants_effect_check: sorted(GrantEffectSchema.options),
        access_grants_target_kind_check: sorted(GrantTargetKindSchema.options),
        library_records_kind_check: sorted(RecordKindSchema.options),
        agent_session_tasks_status_check: sorted(SessionTaskStatusSchema.options),
        agent_knowledge_relations_kind_check: sorted(KnowledgeItemKindSchema.options),
        agent_knowledge_runs_last_status_check: sorted(LastExtractionStatusSchema.options),
        agent_knowledge_runs_last_reason_check: sorted(LastExtractionReasonSchema.options),
        agent_knowledge_embedding_last_reason_check: sorted(EmbeddingFailureReasonSchema.options),
        agent_knowledge_vectors_key_kind_check: sorted(KnowledgeItemTypeSchema.options),
      });
    });
  });
});
