// deep-agents / agent-types - E2E journey skeleton (real AppModule + real Postgres + real SessionGuard + real MCP fixture, runtime workers ON, scripted model)
// Design Doc: docs/features/deep-agents/design-agent-types.md (v1.2, Draft), Flow 1, Flow 2, KD-3, KD-6, Test Strategy UC-4 and UC-6 (the chain only)
// PRD: docs/features/deep-agents/prd.md FR-01, FR-03, FR-04, FR-05, FR-06, FR-27, FR-28 (AC-01.2, AC-03.1, AC-04.1, AC-05.2, AC-06.1, AC-27.1, AC-28.1, AC-28.3)
// Generated: 2026-11-22 | Part: agent-types | Test type: End-to-end (HTTP routes of the API; the browser is not in it)
// Implementation timing: in the phase that completes the journey - the last phase of the part, after the chat tools, `start_deep_agent`, the plan and the routes exist; first run is the feature's full run.
//
// File name: `<feature>-<part>.e2e-spec.ts` under apps/api/test (picked up by `vitest.config.e2e.ts`; the E2E file is separate from the integration file next to it). The test is `it.todo`: the
// implementing task replaces it by `it`, adds the imports and fills the body.
//
// Harness: as the integration file next to it, plus `RUNTIME_WORKERS` on for the test so the deep agent and its subagents run; the scripted model answers the chat root, the deep agent and the subagents
// (the scripted task is chosen by the first user text, as `scriptTask` of agent-platform-chat). Decisions go through the existing decision route of the conversation; the stream is not read, the
// conversation view and the new `GET /api/agents/:agentId/tasks` are polled with `waitFor`.
//
// Budget: E2E 1 of 1-2. The journey is the main path of the part named in the PRD ("описывает в чате глубокого агента с двумя сабагентами, одобряет карточку, видит схему, запускает, следит за планом").
// The web half (the panel opening, the card variants) is a web test and is named in the report, not here.
//
// Not repeated here (proven at a lower level; this file asserts only what the chain adds):
// - the card refusals, the stale version and the administrator edit: INT-1, INT-2 of deep-agents-agent-types.int.e2e-spec.ts
// - the plan surviving a restart, the notice at open items, the block after compaction: INT-3 of packages/agents
// - the brief's own lifecycle (nothing starts before the decision, an invalid edit keeps it open, a decline starts nothing): the rewritten agent-platform-chat INT-2 D; the research team's run (early answer
//   notice, report as answer, the one-task history of a subagent): the rewritten agent-platform-workflows INT-2 A / INT-3 B in packages/agents
// - the schema rule of 11 subagents (unit, contracts): this journey only shows that the record tool's arguments ARE that schema (row 1)
//
// acProof of this file: AC-06.1, AC-01.2, AC-28.1 (the `focus` half), AC-27.1 (wiring): E2E-1 steps 1-3; AC-03.1 (a record made by the chat starts after a brief), AC-04.1 (read route), AC-05.2, AC-28.3 (the
// `started` focus): E2E-1 steps 4-6

import { describe, it } from 'vitest';

describe('deep-agents / agent-types - a deep agent made in chat is the same record the runtime starts, and its plan and report come back through the API', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1: describe a deep agent in chat -> confirm the card -> it is in the library and in focus -> start it by brief -> the plan is readable -> the report is the answer
  // ---------------------------------------------------------------------------------------------------------------
  // User Journey: employee asks the chat for a deep agent with two subagents ("gather" and "answer", the second final) -> the chat's first attempt has eleven subagents and is refused with the limit -> the
  //   chat makes the right one -> the card waits and the library is empty -> the employee approves -> the record is in the library and in focus -> the employee asks for a run, the chat starts it with a
  //   brief, the employee confirms -> the deep agent writes a plan, calls "gather", marks items done, "answer" reports -> the employee reads the plan and the answer.
  // Verification: the record the chat tool saved is runnable as it is stored (the snapshot of a created `deep_agent` resolves, its team and flag defaults are valid), and each API read the screen depends on
  //   (library, conversation `focus`, agent tasks, conversation answer) shows the journey's state at its step.
  // Catches: a deep agent that the chat creates but the runtime cannot start (the create tool's saved content differs from what `resolveStart` snapshots - missing default for `selfLearning`, a team field the
  //   snapshot rejects), a `focus` that does not move from `created` to `started`, a plan route that answers an empty list or 404 to the owner of a running deep agent, an answer that is not the final subagent's
  //   report. Each of these passes every lower-level test, because those start records written by test helpers, not by the chat tool.
  // @category: e2e
  // @dependency: full-system (AppModule, record tools, start_deep_agent, runtime workers, agent_run_tasks route, ConversationView.focus), MCP fixture, scripted model, Postgres
  // @complexity: high
  //
  // Verification items (literal question, names and texts; one employee with a role that holds the chat's model):
  // 1. (AC-27.1 wiring) Scripted chat call 1: `create_record` for a deep agent with eleven subagents -> `tool_result` `refused invalid_arguments` whose text names `subagents` and the limit 10; the conversation view
  //    has no waiting `library.record` request and `GET /api/library` has no such record.
  // 2. (AC-06.1) Scripted chat call 2: `create_record` for deep agent "Разбор логов" with subagents "сбор" and "ответ", `finalSubagent` "ответ" -> one waiting request of kind `library.record` with the whole
  //    definition in it; `GET /api/library` of the employee still has no record of that name.
  // 3. (AC-01.2, AC-28.1) The employee approves. Then: the library lists the record with kind `deep_agent`, version 1, `selfLearning` false, the id the card carried; `GET /api/threads/:threadId` has
  //    `focus` = { recordId: that id, action: 'created', at: a time after step 2 }.
  // 4. (AC-03.1) The employee asks "запусти его по логам за ночь"; the scripted chat calls `start_deep_agent` for that id with a brief -> a waiting request of kind `agents.brief`, no deep agent session exists;
  //    the employee confirms -> exactly one deep agent session of the record's version, first history entry the brief JSON.
  // 5. (AC-04.1, AC-28.3) The scripted deep agent calls `task_list` (two items), starts "сбор" and later sets item 1 `done`; polling `GET /api/agents/:agentId/tasks` returns the two items with numbers 1-2 and the
  //    statuses of that moment (`running` / `waiting`, then `done`); `ConversationView.focus.action` is `started` with the deep agent's record id; another employee gets 404 `AGENT_NOT_FOUND` on the same route.
  // 6. (AC-05.2) "ответ" reports; the conversation's answer is that report text as the scripted subagent wrote it (literal), and the deep agent's session is finished.
  it.todo('E2E-1: a deep agent described in chat is created through the card, is the record the runtime starts by brief, and shows its plan and its final subagent\'s report through the API');
});
