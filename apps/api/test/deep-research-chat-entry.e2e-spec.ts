// deep-research / chat-entry E2E Test Skeletons (api process) - Design Doc: docs/features/deep-research/design-chat-entry.md
// PRD: docs/features/deep-research/prd.md v1.12 (NFR-03, FR-19, FR-20; FR-26 and FR-27 in the L1 scenario only). Verification Strategy of the runtime: "Correctness Proof Method", kill matrix (design-runtime.md).
// Generated: 2026-11-01 | Updated: 2026-11-01 for the no-source mode (Design Doc v1.6: KD-8, DC-8, DC-9, UC-12, UC-13; E2E-1 unchanged, L1-6 extended, L1-7 added) | Part: chat-entry | Test type: End-to-End (the built api process `dist/main.js` + real runtime + real Postgres; scripted chat model and engine double behind the composition root), CI job `e2e` of apps/api
// Implementation timing: after all chat-entry slices land (final phase only). E2E-1 needs the chat-entry crash points, which the plan adds with the launch and delivery slices.
// Counterpart in-process file: deep-research-chat-entry.int.e2e-spec.ts. The runtime's own kill matrix (packages/runtime/test/research-runtime-runtime.e2e-spec.ts) proves the primitives; the engine's E2E-2 proves the engine on top of them;
// this file proves the part's two writes that span a process death.
//
// File name follows the project convention (`*.e2e-spec.ts` under apps/api/test, run by vitest.config.e2e.ts; no config is created here). The api child is booted as research-runtime-boot.e2e-spec.ts does it
// (`nest build` first, scratch database per row, `dist/main.js`); `RUNTIME_CRASH_AT=<point>[:n]` is ignored when NODE_ENV=production, as for the runtime's points.
//
// Environment:
// - Postgres 16 from infra/docker-compose.yml. Each row runs in its own scratch database (CREATE DATABASE, dropped afterwards), so a killed process leaves no row for a neighbour; migrations applied with the entry of @agent-os/db.
// - The only doubles are the model boundary (a scripted chat model: one `deepResearch` call) and the engine port (a test Engine over the real runtime whose controller task finishes when the test releases it), both selected by a test-only
//   composition module the child loads when `E2E_CHAT_ENTRY_DOUBLES=1`; the plan adds it with the support files below. No network, no API key.
// - Crash points added by the plan to the part's code (named in the Design Doc's flows, registered in the same crash-point registry as the runtime's):
//   `chat-entry.launch.after-launching` (row written `launching`, `startInvestigation` not yet called - Flow 1, Flow 2),
//   `chat-entry.append.after-save` (answer message saved, row not yet `answered` - Flow 3, NFR-03, UC-5).
// - Isolation: a unique user per row (`x-user-id`); the file runs with fileParallelism false (the project config).
// - Time: `RUNTIME_POLL_MS`, `RESEARCH_LAUNCH_RECOVERY_MS` short for this file; "within the target" for recovery is the harness timeout of the wait for the end state. No latency assertions.
// - Support to add with the slice (not created here): test/support/chatEntryChild.ts (spawn, wait for readiness, kill, restart without the crash point), test/support/chatEntryDoubles.module.ts, test/support/researchChatDb.ts.
//
// Budget: E2E 2 of 2 for the part - E2E-1 here, E2E-2 the L1 browser scenario in docs/features/deep-research/chat-entry/l1-browser-scenarios.md (executed by hand; the repo has no browser runner), the way chat-shell keeps its own.
// E2E-1 stays because nothing at a lower level can prove a real process death: the in-process rows prove the rule (INT-2 D1 redelivery, INT-2 D4 retry), not that the state a dying process leaves is the one the loop expects.
// ROI uses the raw skill formula like the sibling parts; no E2E test reaches a ">50" threshold with it. The PRD names this test: NFR-03 "проверяется тестом с убийством процесса".
// The no-source mode (PRD 1.12) adds no process-kill row: the mode is a stored value copied once (INT-1 A6) and stored in the answer message (INT-2 D5), and a restart changes neither (the kill rows below keep the same launch and answer rows).
// It adds observations to the L1 scenario (L1-6 extended, L1-7 new), which is where the real boot without the fixture package, the log lines and the screen-reader reading can be seen.

import { describe, it } from 'vitest';

describe('deep-research / chat-entry - E2E (built api process, real Postgres, scripted model)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1  Restart in the middle of a launch or of an answer: one investigation, one answer, no lost row
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: the user sends a question in research mode (or confirms a card) and the api process dies - once right after the launch row was written and before the investigation was started, once after the answer was saved and
  //   before it was marked delivered. The process is started again without the crash point; the user reloads the thread and finds one running or finished research and, at the end, one answer, having repeated nothing.
  // Verification: process-level recovery of the part on top of the runtime's recovery, across the launch row, the engine call and the answer write.
  // Covers (original statements):
  // NFR-03 (PRD, Reliability): "рестарт процесса посреди расследования не теряет и не дублирует его: расследование доходит до ответа, и ответ дописан в беседу ровно один раз; проверяется тестом с убийством процесса."
  // AC-19.1: "Given пользователь явно выбрал глубокое исследование для сообщения, When он его отправил, Then по нему запущено расследование этого пользователя в этой беседе, а беседа показывает, что оно идёт." (after the restart)
  // AC-20.2: "Given ответ дописан, When беседа перезагружена или открыта позже, Then ответ стоит в ней ровно один раз, на позиции, которую получил при завершении расследования."
  // Use cases: UC-5, UC-E6. Flow 1 (failure bullet "Процесс падает между launching и running"), Flow 3 (failure bullet "Сбой процесса между записью сообщения и отметкой answered"). KD-3, KD-4, Risks ("Процесс падает во время хода после старта расследования").
  //
  // Primary failure mode (turns red when): a row stuck in `launching` is never completed, or is completed with a second investigation; the restarted loop writes the answer a second time (a different id, or the same id moved to a later position);
  // the row is left `answer_pending` forever after the message was saved; the answer lands before the messages that were stored while the process was down.
  // Behavior: kill at crash point -> the process is started again without it -> the delivery loop finds the stale `launching` row after `RESEARCH_LAUNCH_RECOVERY_MS` and repeats `startInvestigation` with the same `launchKey`
  //   (the engine answers `existing` or `created`), or finds the `answer_pending` row whose message already exists and overwrites the same message id -> GET /research and GET /messages show the end state
  // @category: e2e
  // @dependency: full-system (built api, runtime, chat-entry module, Postgres, crash points)
  // @complexity: high
  //
  // Verification items (table of crash points; the end state of each is compared with an uninterrupted reference run of the same scripted journey):
  // - K1 after `launching`, before `startInvestigation` (UC-E6, AC-19.1): after the restart and `RESEARCH_LAUNCH_RECOVERY_MS` the thread has exactly one investigation of the user, the row is `running` and then `answered` when the controller is released,
  //   the answer is stored once; the stored reply of the killed turn may be missing (accepted residual risk of the Design Doc) and the test does not require it
  // - K2 after the answer was saved, before `answered` (UC-5, NFR-03, AC-20.2): after the restart one message `research-answer-<investigationId>` exists in the thread, at the position and with the `createdAt` it had before the kill
  //   (compare the pre-kill snapshot, read from the database while the process is down), the row is `answered`, GET /messages after a reload shows it once, and a message the user stored while the process was down is before it only if it was stored before the answer
  // - Both rows: final launch row and message list equal those of the reference run apart from ids and times; no launch row of the user remains in `launching` or `answer_pending`
  describe('E2E-1', () => {
    it.todo('E2E-1 K1: a kill after the launch row and before the engine call leaves one investigation and one delivered answer after the restart');
    it.todo('E2E-1 K2: a kill after the answer message was saved and before the row was marked leaves the answer once, at its original position, after the restart');
  });
});
