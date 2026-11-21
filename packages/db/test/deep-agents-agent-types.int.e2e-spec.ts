// deep-agents / agent-types - migration `0003` data skeleton (scratch database migrated in two stages: files 0000-0002, rows seeded, then the generated `0003`)
// Design Doc: docs/features/deep-agents/design-agent-types.md (v1.2, Draft), KD-7, Data Model, Risks ("Миграция теряет граф ресерча"), Test Strategy closing paragraph (AC-08.2)
// PRD: docs/features/deep-agents/prd.md FR-01, FR-07, FR-08 (AC-01.1, AC-07.1, AC-08.2)
// Generated: 2026-11-22 | Part: agent-types | Test type: Integration (database only, no app, no model)
// Implementation timing: written with the migration task that generates `0003` and puts its data rows in front of the new CHECKs; run once, at the end of the part.
//
// File name follows the repo convention of `packages/db/test` (`<feature>-<part>.int.e2e-spec.ts`, `vitest.config.e2e.ts`). The test is `it.todo`: the implementing task replaces it by `it`, adds the imports
// and fills the body.
//
// Deviation from the Design Doc, on purpose and for the plan to confirm: the Test Strategy leaves AC-08.2 to the owner ("applies the migration to the development database with the research graph and the flag on;
// in CI there is no graph before the migration"). The part's main risk is exactly this migration (a deleted-and-reinserted research row cascades the graph away; a missed data row leaves a CHECK that cannot be
// created or an old conversation that cannot be read). A scratch database that is migrated up to `0002`, seeded with those rows and then migrated by `0003` makes the check repeatable in CI at the cost of one
// helper; the owner's check on the development database stays as the last word (the design's wording) and is not replaced.
//
// Harness: `ScratchDatabases` and `withDatabase` of `support/scratch-db.ts` (own database per test, dropped after). The two stages need the migrator on a folder that holds only the first three files:
//   Support the implementation task adds (not a skeleton): `applyMigrationsUpTo(url, tag)` - copies `MIGRATIONS_FOLDER` to a temp directory with `meta/_journal.json` cut after `tag` and runs drizzle's `migrate`
//   on it (not `applyMigrations`: its `assertNoPendingMigrations` would fail on the cut folder); the second stage is the real `applyMigrations(url)`.
//   The seed rows are written with plain SQL in the pre-`0003` shape (`kind = 'workflow'`, `chat_drafts`, `agent_sessions.executor`), independent of the schema code of the repo, which already holds the new shape.
//
// Budget: Integration 1 here (INT-4). With INT-1, INT-2 (apps/api) and INT-3 (agents) the part uses 4 of 3, through the "up to 5" allowance: its defect is named below and no other test can catch it
// (CI databases do not hold pre-`0003` rows, so no other test applies the data rows to real data).
//
// Proven elsewhere (not repeated here):
// - existing, packages/db/test/migrations.e2e-spec.ts E2E-2 rows: the migrator applies the empty database twice and the CHECK domains equal the contract enums. `agent_run_tasks` is added to its `APP_TABLES`
//   and `chat_drafts` is removed from it (an edit of that list, not a new test); its CHECK-domain row then covers the new `RecordKindSchema` (`agent`, `deep_agent`), `RunTaskStatusSchema` and the extended
//   `ToolRefusalReasonSchema` - DC-1 (the CHECK half), KD-7 (`agent_code_calls` CHECK rebuilt)
// - build, not a test: a `workflow` member left in `RecordKindSchema` or a route that still takes it fails the type check and the CHECK-domain row - DC-1
// - existing, apps/api custom-agents-runtime INT-3 A (rewritten): on an empty database the seeder inserts the built-in records with the new content, the research record is `deep_agent`, and an edited row is
//   not touched - AC-07.1 (record side). The migration test below covers only the existing-database half the seeder cannot reach.
// - unit, builtin content: the literals of `builtinRecords()` pass `CreateRecordBodySchema` of their kind (the existing builtin-records spec)
//
// acProof of this file: AC-08.2: INT-4 row A (and the owner's manual check); AC-01.1 (stored half: no `workflow` row remains): INT-4 row B

import { describe, it } from 'vitest';

describe('deep-agents / agent-types - migration 0003 rewrites the built-in research in place and leaves a database the new schema and the old conversations can use', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-4: the built-in research keeps its id, graph and flag; other workflow rows go; old conversations and task inputs stay readable
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-08.2 "Given у встроенного глубокого ресерча был граф до фичи, when сотрудник открывает граф после фичи, then видит те же записи."
  //   AC-01.1 "Given сотрудник открывает библиотеку или просит чат создать запись, then видами записей названы только «агент» и «глубокий агент»." (the stored half)
  //   KD-7 "Строка встроенного глубокого ресерча переписывается на месте ... id, адресаты и `selfLearning` остаются; версия растёт на 1. Граф знаний висит на id записи с каскадом, поэтому он остаётся."
  //   KD-7 "Остальные записи вида `workflow` удаляются вместе с их адресатами и графами." / "`agent_sessions.record_kind` со значением `workflow` становится `deep_agent`." /
  //   "Во входе каждой задачи агента ключ происхождения снимка `executor` переименовывается в `subagent`."
  //   Design: KD-7, Data Model, Risks.
  // Behavior: a scratch database at `0002` holds the research row as a `workflow` with a graph and the flag on, an employee's workflow with a share and a graph, a conversation whose run row has
  //   `record_kind = 'workflow'` and a task input with the old origin key, the built-in `chat` row and a `chat_drafts` row -> the real `0003` is applied -> the rows are as the design says and the new CHECKs stand.
  // Catches: (1) the research row deleted and reinserted, or given a new id: the graph cascades away and every share and `builtinKey` link breaks - the owner loses the learned knowledge of the platform's main
  //   agent; (2) `selfLearning` taken from the literal instead of the stored row: an administrator's enabled flag silently turns off and learning stops; (3) an employee's `workflow` row left behind, so the
  //   new `kind` CHECK cannot be created (the whole migration fails on the first database that has one) or `recordBody` throws on every list read; (4) an old conversation's `record_kind = 'workflow'` or a task
  //   input with `executor` left as it was - `originOf` / `sessionInputOf` throw when an employee opens a conversation that ran a workflow; (5) the built-in `chat` row keeping its old prompt, so a deployed
  //   database never learns of `start_deep_agent` and the record tools (the seeder does not touch an existing row).
  // @category: core-functionality
  // @dependency: drizzle migrator, the generated `0003` file with its data rows, scratch Postgres database, pgvector extension
  // @complexity: high
  //
  // Verification items (seed with plain SQL at `0002`, read back with plain SQL after `0003`; literal ids, versions and counts written in the test):
  // - Row A "research in place" (AC-08.2, KD-7): the `deep-research` row (its fixed id from `builtinRecords()`, `builtinKey` 'deep-research', version 4, an audience of one role, `selfLearning: true` inside the stored
  //   content of the old `workflow` shape) with two knowledge entities and a relation in `agent_knowledge_*` hung on its id. After `0003`: the row has the same id, the same `builtinKey` and the same audience rows; `kind` is
  //   `deep_agent`; version 5; the content has the new subagents (read from the literal, e.g. the number of subagents is the literal's, written out) and `selfLearning` is still true; the two entities and the relation are
  //   still there with the same ids; a second database with the flag off ends with it off (the flag comes from the row, not from the migration).
  // - Row B "other rows" (AC-01.1, KD-7): an employee's `workflow` record with a share and a graph row is gone after `0003`, with its share and graph rows (no row of `library_shares` or `agent_knowledge_*` with its id);
  //   an employee's `agent` record next to it is untouched (version, content, shares); `library_records` holds no row whose kind is `workflow`; inserting a row with `kind = 'workflow'` is refused by the new CHECK;
  //   `chat_drafts` no longer exists; `agent_sessions` has a `subagent` column and no `executor` one.
  // - Row C "old conversations" (KD-7, Risks): an `agent_sessions` row with `record_kind = 'workflow'` is `deep_agent` after `0003`; the input of its `runtime_tasks` row held the snapshot's origin key `executor` (read the real
  //   input shape from the pre-`0003` `sessionInputOf` in git history) and holds `subagent` with the same value, other keys of the input unchanged; a row whose snapshot is an `agent` is untouched. (Reading them through the app is the rewritten agent-platform-chat tests; here the stored shape only.)
  // - Row D "chat prompt" (KD-7 fifth row): the built-in `chat` row has the id and audience it had, version +1 and the new content (it names `start_deep_agent`, checked as a literal substring of the literal), and a
  //   `chat` row an administrator had edited at version 7 ends at version 8 with the new content too (the migration rewrites by `builtinKey`, as the pattern says).
  it.todo('INT-4: migration 0003 rewrites the built-in research and chat in place keeping id, graph, audience and the self-learning flag, removes every other workflow row and renames the stored origin keys');
});
