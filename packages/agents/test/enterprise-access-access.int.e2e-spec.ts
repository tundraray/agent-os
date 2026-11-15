// enterprise-access / access - agents-package integration skeleton (real Postgres, real `createRuntime` + `createAgents`, test `AccessGate`)
// Design Doc: docs/features/enterprise-access/design-access.md (v1.1), KD-5, KD-6, Flow 2, Flow 3, State Transitions, Test Strategy UC-8 (expiry),
//   UC-9 (without the restart), UC-E1, UC-E2; PRD: docs/features/enterprise-access/prd.md FR-22 (AC-22.1 (queue), AC-22.5, AC-22.9, AC-22.10).
// Generated: 2026-11-15 | Budget Used: 1 integration skeleton here (INT-4) + 3 API integration skeletons
//   (apps/api/test/enterprise-access-access.int.e2e-spec.ts: INT-1, INT-2, INT-3) + 1 web integration skeleton
//   (apps/web/src/components/shell/enterprise-access-access.int.test.tsx: INT-5) = 5/5 for the part (over the 3-test default, at the 5-test
//   ceiling, as the two earlier parts: each skeleton names a defect no other test catches, see "Catches"), 2 E2E in
//   apps/api/test/enterprise-access-access.e2e-spec.ts.
// Test Type: Integration. Case is `it.todo` - skeleton only, no implementation.
//
// Why this is the lowest level: `QuotaPauses`, the `quota` kind of `Decisions`, `decision.cancelled` and the audit hook belong to this package and need
//   a real runtime, real workers and two instances over one database, but not the tables of `access_*`. The verdict is the port's answer, so the
//   test supplies the port; that the real `AccessService` gives those verdicts from real rights and a real ledger is INT-3 (apps/api), and the rules
//   behind the verdict are unit tables. Nothing here re-proves a verdict.
//
// Harness (follows packages/agents/test/support/agentsHarness.ts): the package's own `createRuntime` + `createAgents` over their own pool, no `apps/api`;
//   a second instance is a second harness over the same database (as in agent-platform-agents.int.e2e-spec.ts INT-3 C and the mcp-connect agents
//   skeleton). Only the model (`createScriptedModel`) and the two ports of this design are doubles:
//   - `testAccessGate`: `tools` allows everything; `model(ownerId, model)` answers what the test last set for that pair - `allowed` with a price,
//     `quota_exhausted` with `month`, `spentUsd`, `quotaUsd`, `waitUntil`, or `refused` with a reason - and can be flipped between steps;
//   - `audit(tx, entry)`: writes the entry, inside the transaction it is given, to a table the harness creates, so an entry of a rolled-back step
//     leaves no row and a second instance's entries are visible.
//   Support the implementation tasks add (not skeletons): both doubles, `access` and `audit` options in `agentsHarness` replacing `access` (the
//   `MCP_ACCESS_TABLE` option) and `modelPrices`; a helper `openPauses(db, ownerId)` that reads `runtime_decisions` of kind `quota`; `moveDecision(db, id,
//   { waitUntil, month })` that sets the stored fields of one pause (time is set by editing rows, as in the identity and API skeletons - the clock is
//   not faked).
// Mock boundary: the model and the two ports only. Do NOT mock `Decisions`, `TaskControl`, the runtime, the workers, the outbox or the database.
//
// Replaced / adapted by this design (not duplicated here):
//   - packages/agents/test/agent-platform-agents.int.e2e-spec.ts INT-1 rows on model resolution (`UNKNOWN_MODEL`) lose their premise: `chooseModel`
//       no longer checks prices, the refusal is the port's verdict (proved by API INT-2). INT-3 A / INT-3 F are the ones the mcp-connect skeleton
//       already adapts; INT-4 (other owner answers as missing) gains no row: a pause is a decision of the same owner-scoped operations.
//   - packages/agents/test/support/agentsHarness.ts: the `access` option (table) and `TEST_MODEL_PRICES` are replaced by `testAccessGate`.
//
// `provenAt: unit`: the choice of the outcome from a verdict (`quota_raised` / `new_month` / `model_not_allowed` / `model_not_connected` / `expired` /
//   stays open) is a pure function of (verdict, pause's month, `waitUntil`, now) - a table next to `QuotaPauses` if the implementation extracts it; this
//   skeleton keeps one row per outcome only to prove each outcome reaches the agent, the history and the audit through the real runtime.

import { describe, it } from 'vitest';

describe('enterprise-access / access - agents integration (real Postgres + createRuntime + createAgents + testAccessGate)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-4: a pause is a durable decision: it ends exactly once, by the right outcome, whoever ends it
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-22.5 "агент Ани на паузе, Аня его останавливает: агент получает статус «остановлен»"; AC-22.9 "пауза началась и закончилась: в аудите
  //   есть запись начала и запись конца с тем, как пауза кончилась"; AC-22.10 "предел ожидания - 24 часа, агент Ани на паузе, проходят 24 часа без
  //   решения администратора: агент получает статус «сбой» с причиной «квота исчерпана», родитель получает уведомление"; AC-22.1 (the queue half)
  //   "сообщения встают в очередь и не будят задачу"; FR-22 "если во время паузы модель сотруднику больше не разрешена, пауза кончается, а агент
  //   завершается сбоем «модель не разрешена»; сотрудник не может закрыть паузу сам; главный чат на паузе нельзя остановить, удаление беседы
  //   удаляет её вместе с паузой". Design: DC-8 (ending), DC-9 (the stored deadline), DC-10, DC-11, DC-12; UC-E1, UC-E2, UC-9 (stop, delete),
  //   UC-8 (expiry).
  // Behavior: the test gate answers `quota_exhausted` -> agents open `quota` decisions in their step commit (`quota_paused`, `quota_pause_started`)
  //   -> the verdict, a stored field, an administrator-style refusal, a stop, a second instance or a deleted conversation ends each pause ->
  //   `runtime_decisions`, the agent's status, its history events, the parent's `child_finished` and the harness audit table.
  // Steps (fresh agents per row, so no row depends on another; Аня owns all; `A` is her model; each row reads status, history, the decision row
  //   and the audit entries of that pause only):
  //   1. Setup: gate says `quota_exhausted` for Аня and A (`waitUntil` in 24 h). Two background agents `a1`, `a2` (each with a parent), and the
  //      conversation's root chat `r1`, all reach their pause: each is `awaiting_quota`, each has exactly one open `quota` decision, one
  //      `quota_pause_started` entry exists per pause.
  //   2. DC-11 / UC-E1: `sessions.confirmations` of the conversation does not list the pauses and reads without error; `resolveConfirmation` with
  //      the id of `a1`'s pause answers `DECISION_NOT_FOUND`, as for another owner's decision; the pause is still open and `a1` still waits.
  //   3. DC-8 ending exactly once: the gate flips to `allowed`; both instances run `quotaPauses.review()` at the same moment (10 repetitions with
  //      fresh pauses) -> the two calls' returned counts sum to the number of pauses, each `quota` decision is closed once with `quota_raised`,
  //      exactly one `quota_pause_ended` entry per pause (the loser got `already_resolved`, wrote nothing and logged it), each agent's history has
  //      one `quota_pause_ended` event and the agent takes its next step once; the message sent to `a1` during the pause is delivered to that step
  //      once; a still-exhausted verdict leaves a pause open and returns 0 for it.
  //   4. Outcome rows (each: set the gate and/or the stored fields, run `review()`, read the end):
  //      - AC-22.10: gate still `quota_exhausted`, `moveDecision(waitUntil: past)` -> outcome `expired`; the agent is `failed` with
  //        `quota_exhausted`, the parent has exactly one `child_finished` with the reason; DC-9: a second pause stored with a later `waitUntil` while
  //        the first expired stays open (the deadline is the stored one, not a fresh read).
  //      - DC-10 / UC-E2: gate `refused` `model_not_allowed` -> outcome `model_not_allowed`, the agent `failed` with `model_not_allowed` (never
  //        `quota_exhausted`); gate `refused` `model_not_connected` -> outcome and failure `model_not_connected`.
  //      - AC-22.8 shape: gate `allowed`, `moveDecision(month: previous month)` -> outcome `new_month`; with the month unchanged -> `quota_raised`.
  //      - `quotaPauses.refuse(ownerId, A)` -> returns the number of agents ended, outcome `refused`, failure `quota_exhausted`; for another employee or
  //        another model it returns 0 and changes nothing.
  //   5. AC-22.5, AC-22.9, KD-6: `a2` is stopped by Аня while paused -> status `stopped`, its `quota` decision cancelled, and the consumer of
  //      `decision.cancelled` writes exactly one `quota_pause_ended` with outcome `stopped` in the delivery transaction; a stop and a `review()` run at the
  //      same moment (50 repetitions) leave exactly one end entry per pause, and `stopped` is never followed by an agent step.
  //   6. DC-12: the chat root `r1` on its pause: a message to it lands in its queue and the task does not wake; it cannot be stopped (the root rule
  //      of agent-platform); after the gate flips and `review()`, the message is delivered once with the next step. A second root `r2` on a pause
  //      has its tree deleted through `runtime.tasks.deleteTree` -> no open `quota` decision, no entry in the list, and the audit holds the start
  //      entry of `r2`'s pause and no end entry.
  // Catches: a pause closed twice by two instances (two history events, two audit ends, the agent resumed twice or its message delivered twice); a
  //   pause that ends without the audit record (the stop path bypasses `QuotaPauses`, so only the `decision.cancelled` consumer writes it) or with a
  //   wrong outcome - an agent whose model was withdrawn reported as «квота исчерпана», an expired pause reading the live limit instead of the stored
  //   deadline; an employee who can answer his own pause through the confirmations route and so spend past the quota; a chat message that wakes a
  //   paused task so the step pauses again in a loop; a deleted conversation's pause that stays in the administrator's list or gets an end record.
  // @category: core-functionality
  // @dependency: QuotaPauses, Decisions (listOpen, resolve with the caller's write), TaskControl (decision.cancelled), ModelStep, sessions.confirmations / resolveConfirmation, runtime workers, outbox, two createAgents instances, scripted model, testAccessGate, harness audit table, Postgres
  // @complexity: high
  it.todo('INT-4: a pause ends exactly once with the outcome that matches why - raise, new month, expiry, refusal, withdrawn model or stop - and is never closable by the employee');
});
