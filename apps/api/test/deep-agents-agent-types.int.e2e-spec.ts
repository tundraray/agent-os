// deep-agents / agent-types - API integration skeletons (real AppModule + real Postgres + real SessionGuard, scripted model, workers on only where a row needs a run)
// Design Doc: docs/features/deep-agents/design-agent-types.md (v1.2, Draft), Test Strategy UC-2, UC-2a, UC-3, UC-4 (the refusal and confirmation halves), KD-3, KD-4, DC-5, DC-6, DC-7, Invariants 3 and 4
// PRD: docs/features/deep-agents/prd.md FR-06, FR-26 (AC-06.2, AC-06.3, AC-06.4, AC-06.6, AC-26.1 by the tool answer only)
// Generated: 2026-11-22 | Part: agent-types | Test type: Integration (the journey is in deep-agents-agent-types.e2e-spec.ts)
// Implementation timing: written alongside the slice each test names and run once, at the end of the part (project rule "Tests only at the end"):
//   INT-1 with `LibraryService`'s check-without-write operation, `review` of the five record tools and `IdentityDirectory.isAdmin`;
//   INT-2 with the save operation under the row lock (`version_conflict`) and the `confirmed` content of the card.
//
// File name follows the repo convention of `apps/api/test` (`<feature>-<part>.int.e2e-spec.ts`, picked up by `vitest.config.e2e.ts`). Every test is `it.todo`: the comments above it are
// its specification; the implementing task replaces `it.todo` by `it`, adds the imports and fills the body (a skeleton that passes on day one proves nothing).
//
// Harness (follows custom-agents-runtime.int.e2e-spec.ts INT-4 and custom-agents-library.int.e2e-spec.ts, which this file replaces for chat-driven record changes):
//   one `createTestApp()`, the real AppModule with the real library, `IdentityDirectory`, `Agents.mcp` and `AuditLog`; the only double is the scripted model of the chat root
//   (`scriptTask`-style helper of the runtime file, now with `create_record`, `edit_record`, `delete_record`, `read_record`, `list_records` calls). Servers `jira` and `logs` of the design are the
//   run's `LOGS_SERVER` and `BACKOFFICE_SERVER` of the MCP fixture, made available to a role through `allowRole`. Employees from `insertEmployee` + `signInWithPassword`, the administrator
//   from `seedSuperAdmin`. Every row makes its own employees, role and records (names carry `recordName`'s run suffix), so the order of the rows decides nothing.
//   Support the implementation tasks add (not skeletons): `test/support/library.ts` replaces `workflowBody` by `deepAgentBody(subagents)` and `drafts.ts` is deleted with the drafts route;
//   a helper `recordToolCall(...)` that builds the scripted call and `pendingCardOf(thread)` that reads the open `library.record` request of the conversation.
//
// Budget: Integration 2 here (INT-1, INT-2); with INT-3 (agents package) and INT-4 (db) the part uses 4 of 3, the fourth through the "up to 5" allowance: each of the four names a defect no other test catches.
//
// Proven elsewhere (the plan reads this to avoid a second test for an AC already proven). The unit tests are written by the implementation phases, one table-driven test per rule, none skeletoned here:
// - unit, contracts, deep-agent content schema (UC-1): 11 subagents, `finalSubagent` outside the team, empty subagent prompt, repeated name -> error path and rule, the first naming the limit 10 - AC-27.1, AC-01.1
//   (the integration side of AC-27.1 is one row of the journey: the wiring of `runner.check` is the part `agent-harness/core` already proves for every tool, so no row here)
// - unit, apps/api/src/library/save-rules.spec.ts (extend the existing `decideSave` table): server without a right -> `server_not_allowed` with path `subagents.1.servers` and the value `jira`;
//   `*` in an employee record; name taken; invisible agent - UC-2, AC-06.4 (rule). INT-1 row D proves only that the chat tool passes the employee's real rights into that table.
// - unit, `chatListing` / list_records text builder (pure-decision): record rows, the "own / opened to your role / system" marker, the cut with a note at the code constant - UC-2a (text), AC-26.1 (rule)
// - existing, packages/agents tool-registry spec: the five tools are `rootOnly` and a sub-agent or deep agent gets `tool_not_in_definition` - AC-06.5
// - existing, packages/agents/test/agent-platform-agents.int.e2e-spec.ts INT-3 A and custom-agents-runtime INT-1: a call to a server the owner may not use is refused by the owner's rights at call time - AC-26.2, AC-02.3
// - existing, custom-agents-library INT-1, INT-2, INT-5 (rewritten onto `deep_agent` bodies): visibility of foreign and role-shared records to the library routes, stale save refused by the library's own `PUT`,
//   one prompt-free audit event per action. INT-1 and INT-2 here do not repeat the library routes; they prove the same rules for the CHAT door, which is a second door into `LibraryService`.
// - not automated here (web, left to the plan): the card "Запись" with the marks "изменено / новый / Убрано", the line "Не сохранено:" with the platform text (UC-10, AC-28.1 view side, AC-29.1)
//
// Existing tests this part deletes or rewrites rather than duplicates (so no skeleton below restates them):
// - deleted with the drafts route and `draft_record`: apps/api/test/custom-agents-runtime.int.e2e-spec.ts INT-4 A-D (draft saved once, role-shared and system refusals before a card, administrator row)
//   and apps/api/test/support/drafts.ts. INT-1 here is their replacement for the chat door: same defects (foreign, role-shared, system), now `read_only` / `shared` / `admin_only` from the tools.
// - rewritten onto `deep_agent` / `start_deep_agent` / `agents.brief`: custom-agents-runtime INT-3 A (the built-in records seeded once, the research record starts), agent-platform-chat INT-2 D (brief
//   waits, invalid edit keeps it open, confirmed edit starts one run) and INT-2 B (a run view exists only for a deep agent), custom-agents-library rows that build `workflowBody`.
//
// acProof of this file:
// - AC-06.3: INT-1 rows A and B; AC-06.4: INT-1 row D (wiring), unit (rule); AC-26.1: INT-1 row C (tool answer), manual (the model's choice, PRD)
// - AC-06.2: INT-2 row A; AC-06.6: INT-2 row B; DC-5 (`version_conflict`): INT-2 row C; DC-6 (`builtin`): INT-1 row A; Invariant 4: INT-1 row A and INT-2 row B

import { describe, it } from 'vitest';

describe('deep-agents / agent-types - the chat is a second door into the library and opens it only as far as the employee could', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: record tools act only within the asking employee's rights - foreign, shared, system and built-in records are refused before any card, the data is not leaked
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-06.3 "Given запись чужая или открыта ролям, when чат вызывает её правку или удаление, then инструмент отказывает с причиной до карточки подтверждения, и запись не меняется. То же для системной записи, когда сотрудник не администратор."
  //   AC-06.4 "Given в записи назван сервер, к которому у сотрудника нет права, when чат её создаёт, then инструмент отказывает с той же причиной, что библиотека сегодня, и записи нет."
  //   AC-26.1 (the tool answer) "...у сабагента сбора в схеме сервер логов, а серверов, не нужных для сбора, нет." - here only: `list_records` names the servers the employee may use and their tools
  //   DC-6 "Администратор не может удалить встроенную запись: отказ `builtin` до карточки."
  //   DC-7 "Ответ `list_records` называет каждый сервер, на инструмент которого у сотрудника есть право, с именами этих инструментов, и не называет других."
  //   Invariant 4 "Инструменты записей не меняют записей с адресатами, записей других сотрудников и флажка самообучения."
  //   Design: UC-2, UC-2a, UC-3; KD-3; Flow 1 (the refusal branch).
  // Behavior: the scripted chat root of employee A calls the record tools on records A may not change -> `review` of the tool asks `LibraryService`, which refuses -> `tool_result: refused <reason>` with the
  //   path/rule text, no `library.record` request is created, the record's version and content are as before; the same calls on a record A cannot see answer as for a missing one.
  // Catches: (1) the chat edits or deletes a colleague's record, a record opened to a role, or a system record for a non-administrator - the chat door skipping the ownership checks the library routes have
  //   (isolation between users, rights); (2) the refusal arriving AFTER a card (the employee confirms a change the save will refuse), or the check living only in `execute`; (3) the administrator deleting a built-in
  //   record (the id the graph, the shares and the seeder hang on); (4) `read_record` / `list_records` leaking a private record or a server the employee has no right to (the model would then put it into a record
  //   the employee confirms); (5) `edit_record` resetting the stored self-learning flag, or `create_record` setting it - no other test reads the flag after a chat edit.
  // @category: core-functionality
  // @dependency: AppModule (record tools, LibraryService review, IdentityDirectory.isAdmin, Agents.mcp usable servers, decideSave), MCP fixture, scripted model, Postgres
  // @complexity: high
  //
  // Verification items (one scripted root per row, literal expected values; the refusal text is read from the first implementation run and written as a literal):
  // - Row A "rights" (AC-06.3, DC-6, Invariant 4): employees A (no admin) and B, administrator C. Records: B's private R1; A's own R2 opened to role «SRE»; a system record S; the built-in `deep-research` record
  //   with the self-learning flag turned on by C through `PUT`. A's chat calls `edit_record` and `delete_record` on R1, R2, S and `deep-research`; C's chat calls `delete_record` on `deep-research`.
  //   Then: R1 -> `refused read_only`, R2 -> `refused shared`, S and `deep-research` for A -> `refused admin_only`, `deep-research` delete for C -> `refused builtin`; every result has a text naming the record;
  //   `agents.confirmations(root)` is empty for every call (no card); `GET /api/library/:id` for each record shows the version and content as before; the audit table has no `library_record` event after the start.
  // - Row B "no leak" (isolation): A's chat calls `read_record` on B's private R1 and on a random uuid, and `list_records`. Then: both reads answer `refused record_unavailable` with the same text apart from the id the
  //   model sent (no hint that R1 exists); `list_records` holds A's own records, the records opened to A's role and the built-in ones, and not R1; for A (non-admin) it holds no system record S that is not opened
  //   to everyone; for C it does hold S.
  // - Row C "servers" (DC-7, AC-26.1): the role of A may use server `jira` with only the tool `search_issues` and has no grant on `logs`. `list_records` of A ends with a servers part that names `jira`
  //   and `search_issues`, and does not contain `logs` nor any other tool name of `jira`; after granting A the second tool the next call names both (read at call time, not cached in the root).
  // - Row D "rule wiring" (AC-06.4): A's chat calls `create_record` for a deep agent whose second subagent has `servers: ['logs']`. Then: `refused server_not_allowed`, the text contains the literal
  //   `subagents.1.servers` and `logs`, no card, `list_records` has no record of that name. One row only: the rule's other cases are the unit table.
  it.todo('INT-1: record tools refuse foreign, role-shared, system and built-in records before any card, leak no private record or server, and leave the self-learning flag alone');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: nothing is saved without the approved card, and what is saved is what the employee saw - reject, stale version, administrator edit of the built-in research
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-06.2 "Given сотрудник отклонил карточку, then запись не создана и не изменена, а чат получает отказ и может предложить другой вариант."
  //   AC-06.6 "Given администратор просит чат поправить промпт системного глубокого ресерча, when он одобрил карточку, then запись изменена, а сотрудники с доступом к ней видят новую версию."
  //   DC-5 "Если запись изменилась между карточкой и одобрением, запись не меняется, а чат получает отказ `version_conflict`."
  //   Invariant 3 "Записи меняются из чата только после одобренной карточки, и сохранение проверяет то же, что проверка до карточки, на версии, которую видел сотрудник."
  //   Design: UC-3 (administrator half), UC-4 (reject and stale halves); KD-3 (`review`, `confirmed`); Flow 1.
  // Behavior: the chat calls `create_record` / `edit_record` -> a `library.record` request waits (nothing saved) -> the employee rejects, or the record is changed outside the card and the employee approves, or
  //   the administrator approves an edit -> no record / `version_conflict` with the version of the outside change / one new version visible to the employees of the record, with one audit event written in the save's transaction.
  // Catches: (1) a record created or changed before the decision, or after a rejection (the tool writing in `review` or `execute` without checking the card's outcome); (2) a lost update - the approval of an old card
  //   overwriting an edit made in the library after the card was shown (the version in `previous` not checked under the row lock); (3) a chat edit by the administrator that does not bump the version, writes no
  //   audit event, or is not what the other employees' next read returns (the built-in research the whole platform runs); (4) the stored `selfLearning: true` of the research lost by the chat edit.
  // @category: core-functionality
  // @dependency: AppModule (record tools, runtime decisions, LibraryService save under row lock, AuditLog), BuiltinRecordsSeeder, scripted model, Postgres
  // @complexity: high
  //
  // Verification items (one scripted root per row; the decision is sent through the existing decision route of the conversation, as `agent-platform-chat` INT-2 D does):
  // - Row A "reject" (AC-06.2): A's chat calls `create_record` (a deep agent with two subagents). While the request waits: `GET /api/library` of A has no record of that name, `agents.confirmations(root)` holds one
  //   request of kind `library.record` with `action: 'create'`, `previous: null` and a chosen `recordId`. A rejects. Then: no record of that name, no audit event, the call result in the root's next input is
  //   the rejected outcome ("отклонено пользователем"); the scripted root calls `create_record` again with another name and A approves: exactly one record exists, its id is the `recordId` of the SECOND card,
  //   `selfLearning` is false, version 1, owner A; the first card's `recordId` does not exist.
  // - Row B "administrator edit" (AC-06.6, Invariant 4): C's chat calls `edit_record` on `deep-research` with a changed prompt (the full content, without `selfLearning`); the card carries `previous.version` N and the changed
  //   `next`; C approves. Then: version N+1, the prompt is the new text, `selfLearning` is still true, one `library_record` audit event of action update with C as actor and no prompt in it; employee B (everyone sees the
  //   built-in record) reads `GET /api/library/:id` and sees version N+1 and the new prompt.
  // - Row C "stale version" (DC-5): A's chat calls `edit_record` on A's own deep agent R (version 3); the card waits with `previous.version` 3; A saves a different change of R through `PUT /api/library/:id`
  //   (version 4); then A approves the card. Then: the call closes `refused version_conflict` with a text, the stored record is the `PUT`'s version 4 with its content (not the card's), the audit table has no event for the card.
  it.todo('INT-2: a rejected card saves nothing, an approved one saves what was shown once, a card made stale by another edit is refused as version_conflict, and the administrator\'s edit of the built-in research bumps its version and keeps its self-learning flag');
});
