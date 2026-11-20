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
// Migration 0010 drops the research tables, 0011 creates the six `runtime_*` tables, 0012 the three `agent_*`
// tables (design-agents.md, Data Model), 0014 `chat_conversations` (design-chat.md, Data Model) and 0015 drops
// `chat_thread_runs`, 0016 adds `agent_tool_results` and `agent_code_calls` (code-execution/design-code-execution.md,
// Data Model), the identity migrations add `identity_*` and `audit_events` (enterprise-access/design-identity.md),
// 0021 adds `library_records` and `library_shares` (custom-agents/design-library.md, Data Model), 0023 adds
// `chat_drafts` (custom-agents/design-runtime.md, Data Model), 0026 the seven `agent_knowledge_*` tables and
// the `vector` extension (self-learning/design-core.md, Data Model): after them, only these are in `app`.
// AC-19.1 (custom-agents/design-runtime.md, Test Strategy UC-12): the migrations after 0021 remove the
// conversations with their tasks, sessions and messages and leave users, roles, grants and the token ledger.
// The `agent_*` CHECK domains (history kind, tool call state, outcome, refusal reason) come from
// packages/contracts/src/agents.ts.
//
// Primary failure mode: the migrator applies twice or partially, touches `public`, or a CHECK domain drifts from the contract enums.
// Isolation: the row runs in its own scratch database, created with CREATE DATABASE and dropped afterwards.

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DecisionStatusSchema,
  DeliveryStatusSchema,
  DraftStateSchema,
  GrantEffectSchema,
  GrantTargetKindSchema,
  HistoryEntryKindSchema,
  KnowledgeItemKindSchema,
  KnowledgeItemTypeSchema,
  LastExtractionReasonSchema,
  LastExtractionStatusSchema,
  McpServerModeSchema,
  MessageStatusSchema,
  ModelProviderKindSchema,
  ModelPurposeSchema,
  ProviderTypeSchema,
  RecordKindSchema,
  SaveOwnRefusalSchema,
  TaskStatusSchema,
  ToolCallStateSchema,
  ToolOutcomeSchema,
  ToolRefusalReasonSchema,
  UserStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { z } from 'zod';
import {
  applyMigrations,
  MIGRATIONS_FOLDER,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
} from '../src/index.js';
import { ScratchDatabases, withDatabase } from './support/scratch-db.js';

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
  'agent_sessions',
  'agent_tool_calls',
  'agent_tool_results',
  'audit_events',
  'chat_conversations',
  'chat_drafts',
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
        agent_tool_calls_state_check: sorted(ToolCallStateSchema.options),
        agent_tool_calls_outcome_check: sorted(ToolOutcomeSchema.options),
        agent_tool_calls_refusal_reason_check: sorted(
          ToolRefusalReasonSchema.options,
        ),
        agent_code_calls_outcome_check: sorted(ToolOutcomeSchema.options),
        agent_code_calls_refusal_reason_check: sorted(
          ToolRefusalReasonSchema.options,
        ),
        identity_users_status_check: sorted(UserStatusSchema.options),
        identity_providers_type_check: sorted(ProviderTypeSchema.options),
        agent_mcp_servers_mode_check: sorted(McpServerModeSchema.options),
        agent_model_providers_kind_check: sorted(ModelProviderKindSchema.options),
        access_models_purpose_check: sorted(ModelPurposeSchema.options),
        access_grants_effect_check: sorted(GrantEffectSchema.options),
        access_grants_target_kind_check: sorted(GrantTargetKindSchema.options),
        library_records_kind_check: sorted(RecordKindSchema.options),
        chat_drafts_kind_check: sorted(RecordKindSchema.options),
        chat_drafts_state_check: sorted(DraftStateSchema.options),
        chat_drafts_refusal_check: sorted(SaveOwnRefusalSchema.options),
        agent_knowledge_relations_kind_check: sorted(KnowledgeItemKindSchema.options),
        agent_knowledge_runs_last_status_check: sorted(LastExtractionStatusSchema.options),
        agent_knowledge_runs_last_reason_check: sorted(LastExtractionReasonSchema.options),
        agent_knowledge_vectors_key_kind_check: sorted(KnowledgeItemTypeSchema.options),
      });
    });
  });

  // -------------------------------------------------------------------------------------------
  // Row "database with conversations" (custom-agents/design-runtime.md, Test Strategy UC-12, AC-19.1):
  // a scratch database migrated up to 0021 gets a conversation with its root task, session and message
  // beside a user, a role with a member, a grant and a model call; the remaining migrations take the
  // first away and leave the rest as they were.
  // -------------------------------------------------------------------------------------------
  describe('database with conversations at 0021', () => {
    const LAST_BEFORE_RUNTIME = '0021_secret_luminals';
    const USER_ID = '6f1c2a3b-4d5e-4f60-8a71-0b2c3d4e5f61';
    const ROLE_ID = '7a2b3c4d-5e6f-4a70-8b81-1c2d3e4f5a62';
    const GRANT_ID = '8b3c4d5e-6f7a-4b80-9c91-2d3e4f5a6b73';
    const MODEL_CALL_ID = '9c4d5e6f-7a8b-4c90-8da1-3e4f5a6b7c84';
    const TASK_ID = 'ad5e6f7a-8b9c-4da0-9eb1-4f5a6b7c8d95';
    const CONVERSATION_ID = 'be6f7a8b-9c0d-4eb0-8fc1-5a6b7c8d9ea6';

    /** Tables whose rows stay, each read whole in a fixed order. */
    const KEPT = {
      identity_users: 'id',
      identity_roles: 'id',
      identity_role_members: 'role_id, user_id',
      access_grants: 'id',
      runtime_model_calls: 'call_id',
    } as const;
    /** Tables the migration empties. */
    const GONE = ['chat_conversations', 'runtime_tasks', 'agent_sessions', 'agent_messages'] as const;

    let keptBefore: Record<string, unknown[]>;
    let keptAfter: Record<string, unknown[]>;
    let goneBefore: Record<string, number>;
    let goneAfter: Record<string, number>;

    /** A copy of the migrations folder whose journal ends at `lastTag`. */
    const migrationsThrough = (lastTag: string): string => {
      const journal = JSON.parse(
        readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
      ) as { entries: { tag: string }[] };
      const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
      if (last < 0) throw new Error(`Migration ${lastTag} is not in the journal`);
      const entries = journal.entries.slice(0, last + 1);
      const folder = mkdtempSync(join(tmpdir(), 'db-migrations-'));
      mkdirSync(join(folder, 'meta'));
      writeFileSync(
        join(folder, 'meta', '_journal.json'),
        JSON.stringify({ ...journal, entries }),
      );
      for (const { tag } of entries) {
        copyFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
      }
      return folder;
    };

    const readKept = async (client: pg.Client) =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(KEPT).map(async ([table, order]) => [
            table,
            (await client.query(`SELECT * FROM app.${table} ORDER BY ${order}`)).rows,
          ]),
        ),
      ) as Record<string, unknown[]>;

    const countGone = async (client: pg.Client) =>
      Object.fromEntries(
        await Promise.all(
          GONE.map(async (table) => [
            table,
            Number(
              (await client.query<{ rows: string }>(`SELECT count(*) AS rows FROM app.${table}`))
                .rows[0]?.rows,
            ),
          ]),
        ),
      ) as Record<string, number>;

    beforeAll(async () => {
      const url = await scratch.create();
      const folder = migrationsThrough(LAST_BEFORE_RUNTIME);
      try {
        await withDatabase(url, (client) =>
          migrate(drizzle({ client }), {
            migrationsFolder: folder,
            migrationsSchema: MIGRATIONS_SCHEMA,
            migrationsTable: MIGRATIONS_TABLE,
          }),
        );
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }

      await withDatabase(url, async (client) => {
        await client.query(
          `INSERT INTO app.identity_users (id, email, name) VALUES ($1, 'anya@example.test', 'Аня')`,
          [USER_ID],
        );
        await client.query(`INSERT INTO app.identity_roles (id, name) VALUES ($1, 'Аналитики')`, [
          ROLE_ID,
        ]);
        await client.query(
          'INSERT INTO app.identity_role_members (role_id, user_id) VALUES ($1, $2)',
          [ROLE_ID, USER_ID],
        );
        await client.query(
          `INSERT INTO app.access_grants (id, role_id, effect, target_kind, server)
             VALUES ($1, $2, 'allow', 'server', 'logs')`,
          [GRANT_ID, ROLE_ID],
        );
        await client.query(
          `INSERT INTO app.runtime_model_calls (call_id, owner_id, task_id, model, input_tokens,
             output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
             VALUES ($1, $2, $3, 'anthropic/claude-haiku-5-5', 120, 40, 0, 0, 0.000321)`,
          [MODEL_CALL_ID, USER_ID, TASK_ID],
        );
        await client.query(
          `INSERT INTO app.runtime_tasks (task_id, type, owner_id, root_id, depth, input)
             VALUES ($1, 'agent', $2, $1, 0, '{}')`,
          [TASK_ID, USER_ID],
        );
        await client.query(
          `INSERT INTO app.chat_conversations (id, owner_id, title, root_id)
             VALUES ($1, $2, 'Разбор оплат', $3)`,
          [CONVERSATION_ID, USER_ID, TASK_ID],
        );
        await client.query(
          `INSERT INTO app.agent_sessions (task_id, owner_id, definition, description, model, prompt)
             VALUES ($1, $2, 'chat', 'Главный чат', 'anthropic/claude-haiku-5-5', 'Помоги.')`,
          [TASK_ID, USER_ID],
        );
        await client.query(
          `INSERT INTO app.agent_messages (task_id, seq, kind, content)
             VALUES ($1, 1, 'task', '{"text":"Почему упали оплаты?"}')`,
          [TASK_ID],
        );
        keptBefore = await readKept(client);
        goneBefore = await countGone(client);
      });

      await applyMigrations(url);
      await withDatabase(url, async (client) => {
        keptAfter = await readKept(client);
        goneAfter = await countGone(client);
      });
    }, ROW_TIMEOUT_MS);

    it('the remaining migrations remove conversations, tasks, sessions and messages and keep users, roles, members, grants and model calls unchanged (AC-19.1)', () => {
      expect(goneBefore).toEqual({
        chat_conversations: 1,
        runtime_tasks: 1,
        agent_sessions: 1,
        agent_messages: 1,
      });
      expect(goneAfter).toEqual({
        chat_conversations: 0,
        runtime_tasks: 0,
        agent_sessions: 0,
        agent_messages: 0,
      });
      expect(Object.values(keptBefore).map((rows) => rows.length)).toEqual([1, 2, 1, 1, 1]); // two roles: the built-in administrator role from 0017 and the test one
      expect(keptAfter).toEqual(keptBefore);
    });
  });
});
