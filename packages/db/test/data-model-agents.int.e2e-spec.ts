// data-model / agents - integration (real Postgres, one scratch database migrated by the initial set)
// Design Doc: docs/features/data-model/design-agents.md, Test Strategy UC-6 (covers DC-21, and the row part of DC-22).
// No PRD and no UXRD for this feature (owner's decision): the Design Doc's acceptance criteria are the source.
// Test Type: Integration. Budget of the part: 4 of 3 integration skeletons (this file 1, apps/api 2, packages/agents 1), 0 E2E.
//   The fourth skeleton of the part; it names a defect no other test catches: the default agents are rows of a migration, the start-up parse that
//   used to catch a broken row is deleted with the seeder (Design Doc, KD-4), so this case is the only guard of those rows.
//
// File name and place follow the package convention: `test/*.e2e-spec.ts`, picked up by `vitest.config.e2e.ts` (no migration setup: the case migrates its own
// scratch database through `ScratchDatabases`, as `data-model-schema.int.e2e-spec.ts` and `migrations.e2e-spec.ts` do); the `.int.` infix marks it as integration.
// Do NOT run it against the development database (packages/db/CLAUDE.md).
//
// Already proven elsewhere and NOT repeated here:
// - DC-28 (the tables are named `agents`, `agent_versions`, `agent_shares`): `migrations.e2e-spec.ts`.
// - DC-22, the three defaults are visible to an employee without roles, the administrator cannot delete or share one: INT-1 of
//   `apps/api/test/custom-agents-library.int.e2e-spec.ts` and the unit rows of `audience-rules.spec.ts` / `save-rules.spec.ts`; this file checks only
//   the rows exist and parse.
//
// Mock boundary: none. Real Postgres, the real migrator, the schemas of `@agent-os/contracts` applied to the rows read back.

import { CreateRecordBodySchema } from '@agent-os/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/index';
import { ScratchDatabases, withDatabase } from './support/scratch-db';

/** Creating, migrating and dropping a scratch database. */
const ROW_TIMEOUT_MS = 120_000;

/** Ids the root of a conversation and the temporary agent rely on (the migration keeps today's ids). */
const CHAT_ID = '6a74a70b-e4b9-4b01-9750-20fa789b3b6c';
const GENERAL_PURPOSE_ID = 'd8992d6d-6ff0-4dc6-9b33-df4f88f00b7d';
const DEEP_RESEARCH_ID = 'fb06f3c1-a1be-4167-9896-f0d0fba21a89';

interface MigratedAgent {
  id: string;
  kind: string;
  name: string;
  description: string;
  builtin_key: string | null;
  owner_id: string | null;
  deleted_at: Date | null;
  number: number | null;
  author_id: string | null;
  content: unknown;
  everyone: boolean;
}

describe('data-model / agents: a freshly migrated database holds the default agents, each valid for its kind', () => {
  // AC (DC-21): "Новая база содержит по одному агенту на ключи `chat`, `agent`, `deep_agent` и агента `deep-research` без ключа; каждый вместе с активной
  //   версией проходит схему своего вида."
  // Catches: a broken or missing default row - `chat` without the rules the root needs, a `deep_agent` content the schema refuses, two agents for one key,
  //   a `deep-research` that still carries a key, an agent whose pointer names no version or a version without the active number 1.
  const scratch = new ScratchDatabases();
  let url: string;

  beforeAll(async () => {
    url = await scratch.create();
    await applyMigrations(url);
  }, ROW_TIMEOUT_MS);

  afterAll(() => scratch.dropAll(), ROW_TIMEOUT_MS);

  it(
    'DC-21: a migrated database holds one agent per key chat / agent / deep_agent / trainer and deep-research without a key, each with its active version 1 valid for its kind',
    async () => {
      // Given: an empty database migrated by the initial set; When: every agent is read with its active version and its "everyone" holder
      const agents = await withDatabase(url, async (client) => {
        const { rows } = await client.query<MigratedAgent>(
          `SELECT a.id, a.kind, a.name, a.description, a.builtin_key, a.owner_id, a.deleted_at,
                  v.number, v.author_id, v.content,
                  EXISTS (SELECT 1 FROM app.agent_shares s WHERE s.agent_id = a.id AND s.everyone) AS everyone
             FROM app.agents a
             LEFT JOIN app.agent_versions v ON v.id = a.active_version_id
            ORDER BY a.builtin_key NULLS LAST`,
        );
        return rows;
      });

      // Then: the keys and the ids are as the migration names them
      expect(agents.map((agent) => [agent.builtin_key, agent.id])).toEqual([
        ['agent', GENERAL_PURPOSE_ID],
        ['chat', CHAT_ID],
        ['deep_agent', expect.any(String)],
        ['trainer', expect.any(String)],
        [null, DEEP_RESEARCH_ID],
      ]);
      // Then: every agent is a system agent shown to everyone, not deleted, active in version 1 written by no person
      for (const agent of agents) {
        expect(agent, agent.name).toMatchObject({
          owner_id: null,
          deleted_at: null,
          number: 1,
          author_id: null,
          everyone: true,
        });
      }
      // Then: each agent with its active version passes the schema of its kind
      const parsed = agents.map((agent) =>
        CreateRecordBodySchema.safeParse({
          kind: agent.kind,
          name: agent.name,
          description: agent.description,
          content: agent.content,
        }),
      );
      expect(parsed.map((result) => result.error?.issues ?? [])).toEqual([
        [],
        [],
        [],
        [],
        [],
      ]);
      // Then: the default deep agent has its one subagent; the chat prompt no longer starts a record by its id
      const [, chat, deepAgent] = parsed.map((result) => result.data);
      expect(
        deepAgent?.kind === 'deep_agent'
          ? deepAgent.content.subagents.map((subagent) => subagent.name)
          : deepAgent,
      ).toEqual(['researcher']);
      expect(chat?.content.prompt).not.toContain('Start a record by its id');
    },
    ROW_TIMEOUT_MS,
  );
});
