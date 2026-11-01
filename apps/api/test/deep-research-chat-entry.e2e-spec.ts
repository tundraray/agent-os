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
// Budget: E2E 2 of 2 for the part - E2E-1 here, E2E-2 the L1 browser scenario written at the end of this file (executed by hand; the repo has no browser runner). The plan moves it to docs/features/deep-research/chat-entry/l1-browser-scenarios.md, the way chat-shell keeps its own.
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

// ---------------------------------------------------------------------------------------------------------------
// E2E-2  L1 browser scenario (manual, real browser, production build) - the web E2E of the part. Not an automated runner: the repo has none (chat-shell keeps its L1 scenarios in
//        docs/features/chat-shell/web-shell/l1-browser-scenarios.md, executed through Claude-in-Chrome). The plan moves this block to docs/features/deep-research/chat-entry/l1-browser-scenarios.md.
// ---------------------------------------------------------------------------------------------------------------
// User journey: explicit research from the composer to the answer in the feed, with the figures that jsdom cannot give.
// Covers (original statements):
// NFR-01: "ответ завершённого расследования появляется в открытой беседе не позже чем через 5 с после завершения. Если в этот момент в беседе стримится обычный ответ главного агента, 5 с отсчитываются от конца этого стрима: посреди стрима ответ расследования не вставляется. Измеряется сквозным тестом `chat-entry`."
// NFR-02: "время до первого токена ответа главного агента не хуже требования проекта, в том числе в ответе, который запускает расследование; измеряется тем же способом, что в `chat-shell`."
// NFR-05: "новые состояния беседы соответствуют целевому уровню `chat-shell` (WCAG 2.1 AA)."
// AC-20.1 / AC-20.3 (timing and no-insert-in-stream), AC-20.7 (footnotes visible, with a source connected), AC-19.7 (second tab, no new messages) - the mechanisms are INT-1 A3, INT-5 P1/P2; here the real browser.
// AC-26.2: "Given в развёртывании не подключён ни один источник данных, When сервис запускается, Then журнал запуска содержит предупреждение, что источники данных не подключены и расследования пойдут на знаниях модели." (L1-7: the log of the real boot)
// AC-26.3: "Given подключён хотя бы один источник, When сервис запускается, Then этого предупреждения в журнале запуска нет." (L1-7)
// AC-27.1 / AC-27.2 / AC-27.3 / AC-27.4 and DC-8, DC-9 (the warning where the research is shown, the mark on every claim after a reload and in the copy, none with a source) - the mechanisms are INT-1 A6, INT-2 D5, INT-4 R1/R2, INT-5 P5; here the real browser and the real boot.
// Use cases: UC-1, UC-3, UC-4, UC-12, UC-13, UC-N1, UC-N2, UC-N3.
// Primary failure mode (turns red when): the answer needs a reload or arrives later than 5 s after the end of the research (or of a streaming reply); it is inserted in the middle of a stream; the first token of a mode message is slower than a
//   plain one; the second tab shows a new message or an error line after a repeated decision; the mode, the card buttons or the confirmation dialog cannot be used from the keyboard or are not announced;
//   a deployment without the fixture package does not boot, boots without the warning in the log, or boots with it when a source is connected; the research without sources runs without a warning on the card, in the answer or on a claim, or with footnotes;
//   a research started without sources loses its warning when the process restarts with a source, or a proposal keeps it; the copied text or the screen-reader reading drops the mark of a claim.
// Environment: pnpm db:up; apps/api on :4000 with RUNTIME_WORKERS=on, real model and keys, engine with the `deep-research` process over the fixture MCP source; `pnpm --filter web build && pnpm --filter web start`; Chrome with DevTools (Console, Network).
//   L1-7 runs apps/api twice more: first without the `@agent-os/mcp-fixture` package installed (the registry stays empty, the engine is created with an empty `connectedSources`), then restarted with it.
// Observations (each ticked with a recorded result when executed):
// - L1-1 mode and first token (UC-1, UC-N2): DR-01 reached by Tab and toggled by Space (`aria-pressed` true, placeholder MC-2, send name MC-3); over 5 mode messages the time to the first token is not worse than over 5 plain ones, measured as chat-shell does;
//   the DR-02 label sits over the sent message, the toggle is off again, the reply carries the card «Идёт» with goal and budget
// - L1-2 plain message while running (AC-19.6): the agent answers as usual, no second research starts, focus stays in the composer
// - L1-3 answer timing, idle composer (UC-4, UC-N1, AC-20.1, AC-20.7): the answer appears at the end of the feed without a reload within 5 s of the controller's end (Network: the GET /research that reports `completed`, and the time of the answer);
//   the card is «Завершён» with «К ответу», focus did not move, MC-18 is announced once, every claim has a footnote that names a source in the list, «К запросу» scrolls to the DR-02 message
// - L1-4 answer timing, streaming reply (AC-20.3, UC-N1): a long plain question sent right after the start so that a reply streams when the research ends -> no insertion during the stream, a separate message after it within 5 s of its end,
//   decision buttons disabled during the stream with MC-30; after F5 the order and the single answer are the same (AC-20.2)
// - L1-5 second tab (UC-3, AC-19.7, DC-1, DC-7): a proposal card open in two tabs; «Запустить» in the first, then «Запустить» and «Не нужно» in the second -> one research, the second card «Идёт» with no error line, no new message in either feed, also after a reload
// - L1-6 keyboard and screen reader (UC-N3, NFR-05): card buttons reached with Tab, «Остановить» confirmed in the dialog (focus trapped and returned), state changes announced once, order and announcements as in the UXRD Accessibility table (NVDA or VoiceOver);
//   in the answer of L1-7 the screen reader reads MC-33 as text right after each claim, and MC-31 and MC-32 are read in place as ordinary text, not announced as alerts
// - L1-7 deployment without sources (UC-12, UC-13, AC-26.1, AC-26.2, AC-26.3, AC-27.1, AC-27.2, AC-27.3, AC-27.4, DC-8, DC-9), in this order:
//   (a) boot without the fixture package: the process starts without an error, the startup log has the warning that the sources are not connected and the research will run on model knowledge (AC-26.2), the chat accepts a plain message (AC-26.1);
//       a question where the agent proposes research -> the proposal card shows MC-31 under the budget before any button is pressed (AC-27.1); after «Запустить» the card keeps MC-31 in «Запуск» and «Идёт»
//   (b) a second thread, mode message -> the card «Идёт» shows MC-31 from its first display and the announcement is the no-source variant of MC-17 (AC-27.2); a proposal is left open in the first thread, and this research is left running
//   (c) restart apps/api with the package installed: the startup log has no such warning (AC-26.3); reload the first thread -> the open proposal no longer shows MC-31, the running research still does (UC-13, DC-8); confirm the proposal -> that research runs without MC-31
//   (d) the running research of (b) ends -> within 5 s the answer opens with MC-32, every claim ends with MC-33, no footnotes, no «не проверено» label and no source list, the announcement is the no-source variant of MC-18 and the card is «Завершён» with MC-31;
//       after F5 the same; «Копировать» puts MC-32 and the marks into the clipboard (AC-27.3, DC-9); a following plain question to the agent is answered without treating those claims as checked
//   (e) the research confirmed in (c) ends -> an answer with footnotes and a source list and none of MC-31, MC-32, MC-33 (AC-27.4)
//   (f) run during the boot of (a), before the restart of (c): a research with a token budget too small for the synthesis (UC-E8) -> the answer «Вывода нет» opens with MC-32, shows the stop reason MC-25 and no claims, and the card is «Завершён»
