// deep-research / chat-entry (web) Integration Test Skeletons - Design Doc: docs/features/deep-research/design-chat-entry.md (C3 web: «отправка и решения», KD-1, KD-2)
// PRD: docs/features/deep-research/prd.md v1.12 (FR-19, FR-27). UXRD: docs/features/deep-research/uxrd.md v1.7 (DR-01..DR-03, KD-1, KD-4, KD-8, KD-9, MC-7, MC-13, MC-15, MC-16, MC-17, MC-29, MC-30, MC-31).
// Generated: 2026-11-01 | Updated: 2026-11-01 for the no-source mode (Design Doc v1.6: KD-8, DC-8) | Part: chat-entry | Test type: Integration (Vitest + RTL + MSW 2, jsdom, REAL useChatRuntime / AI SDK Chat - not useLocalRuntime) | Budget slot: INT-4 of the part (extra: see the unique defect below)
// Implementation timing: created alongside the web slice that adds ResearchModeToggle, ResearchCard and the metadata handling in ChatRuntimeProvider / ThreadMessage.
//
// File name and placement follow the sibling files `shell.<topic>.int.test.tsx` in this folder (include 'src/**/*.test.{ts,tsx}' of vitest.config.ts). The web part has no browser E2E runner:
// the real-browser journey is the L1 scenario E2E-2, written at the end of apps/api/test/deep-research-chat-entry.e2e-spec.ts (the plan moves it to docs/features/deep-research/chat-entry/l1-browser-scenarios.md, as chat-shell does).
//
// Why integration and not the component test: whether the decision turn is invisible and is not sent a second time depends on three things that only the real runtime combines - what `useChatRuntime` stores and re-sends,
//   the `sendAutomaticallyWhen` rule, and which messages `ThreadMessage` draws. A component test on useLocalRuntime has none of them. The AI SDK resets the chat error on every send (design KD-2): only the real runtime shows it.
//
// Harness (src/test/): renderWithRuntime({ pathname }) from '@/test/render-with-runtime' mounts ChatRuntimeProvider + ChatShell with mocked next/navigation. MSW server from '@/test/msw-server' (onUnhandledRequest: 'error');
//   fixtures from '@/test/fixtures' (sseFromChunks builds SSE v7 from a chunk list; `historyMessages` builds the restored thread; the plan adds fixtures for a `deepResearch` tool part, a `researchAnswer` message and a
//   ResearchLaunchView list). API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test'. TZ = 'Europe/Berlin'.
// Mock boundary: network only (MSW) + next/navigation (framework boundary). Runtime, adapters, ResearchCard, ResearchModeToggle, ThreadMessage, MessageError, useThreadResearch - real.
//   Do NOT mock lib/threads/*, lib/config.ts or @assistant-ui/*.
//
// Unique defect no other test catches (why this is an extra slot): the api rows (INT-1 A3, INT-3 T1) prove the stored marks and the state; none proves that the browser draws no message for a decision turn, sends no second automatic turn after a
// `deepResearch` call, keeps the error block off the old reply after the decision, or shows the card's error line (not an error stub in the feed) when the turn fails before streaming. A regression there is visible to every user of the cards.

import { describe, it } from 'vitest';

describe('Shell: the research mode and the decisions on a research card (FR-19, KD-1, KD-2)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-4  Mode turn and decision turns: the mode is sent once, a decision turn leaves no trace in the feed and is not re-sent
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-19.1 (web half): "Given пользователь явно выбрал глубокое исследование для сообщения, When он его отправил, Then по нему запущено расследование этого пользователя в этой беседе, а беседа показывает, что оно идёт."
  // AC-19.3 (web half): "Given предложение показано, When пользователь подтвердил, Then запущено расследование с показанной целью и в пределах показанного бюджета, а беседа показывает, что оно идёт."
  // AC-19.4 (web half): "Given предложение показано, When пользователь отклонил его, Then расследование не запущено, а беседа продолжается как обычно."
  // AC-19.7 (web half): "Given предложение уже подтверждено, When пользователь подтверждает его повторно, Then новое расследование не запускается, и у этого предложения остаётся ровно одно расследование."
  // DC-1 (card half): "...ход решения ничего не меняет, а карточка переходит в текущее состояние запуска без строки ошибки."
  // DC-7: "Когда пользователь нажимает кнопку карточки, лента ни в одной вкладке и после перезагрузки не получает ни сообщения пользователя, ни реплики ассистента; меняется только карточка. Пока во вкладке стримится ответ, кнопки решений неактивны (UXRD KD-8)."
  // AC-27.1 (card half): "Given в развёртывании не подключён ни один источник данных, When агент предлагает глубокое исследование, Then вместе с целью и оценкой бюджета предложение предупреждает, что источники данных не подключены и ответ будет опираться на знания модели." (MC-31 on the proposal card)
  // AC-27.2 (card half): "Given в развёртывании не подключён ни один источник данных, When пользователь явно выбрал глубокое исследование и отправил сообщение, Then беседа показывает то же предупреждение там же, где показывает, что расследование идёт (AC-19.1), с момента запуска."
  // AC-27.4 (card half): "Given подключён хотя бы один источник, Then беседа не показывает предупреждения режима без источников ни в предложении, ни в идущем расследовании, ни в ответе."
  // DC-8 (FR-27, card half): "Пока у запуска нет расследования, карточка показывает MC-31 по режиму развёртывания в момент чтения; после старта — по режиму своего расследования, и рестарт с другим набором источников её не меняет." (the mode comes in the view; one thread with two cards of different modes is INT-5 P5)
  // Use cases: UC-1 (label and reset of the mode), UC-2 (second half, card side), UC-3 (second tab's card), UC-12 (card half), UC-E1 (card errors and the follow-up read). Flow 1 (card side), Flow 2, Flow 4 (card side). UXRD KD-1, KD-4, KD-8, KD-9, Error Flows (MC-15, MC-16, MC-29).
  //
  // Primary failure mode (turns red when): the mode is not in the sent message's metadata, or stays on for the next message; a button press adds a visible user message or a visible assistant reply, in this tab or after a reload; the turn that ended in a
  // `deepResearch` call is sent a second time by `sendAutomaticallyWhen`; a decision on a settled card shows an error line instead of the settled state; a turn that failed before the first chunk leaves an error stub in the feed or a disabled
  // button instead of MC-15 / MC-29 / MC-16; the TH-08 block stays on the errored reply after a decision turn; a research answer message is hidden by the rule that hides the decision reply; buttons stay active while an answer streams;
  // the card of a launch without sources loses MC-31 when the view passes from the tool result to the server read, or in a state of the decision turn (the warning is drawn only in the first state), or the explicit launch shows it only after the first
  // poll; the announcement of the start in that mode is the plain MC-17; a card with a source shows MC-31.
  // Behavior: user toggles DR-01 and sends -> POST /api/chat/assistant whose last message carries `deepResearch: true` -> reply with the `deepResearch` tool part -> card «Идёт»; user presses a card button -> the runtime appends a user message with
  //   `researchDecision` {action, launchKey} and the button's label -> POST /api/chat/assistant -> reply with the tool result (a ResearchLaunchView, or `decisionError`) -> only the card changes; GET /api/threads/:id/research is read once after the turn
  // @category: core-functionality
  // @dependency: ChatRuntimeProvider (toCreateMessage, sendAutomaticallyWhen), AssistantChatTransport, useChatRuntime (real), ResearchModeToggle, ResearchCard, useThreadResearch, ThreadMessage (hiding by metadata), MessageError, MSW (SSE v7)
  // @complexity: high
  //
  // Verification items (table; each row asserts the request bodies MSW received, the DOM, and the number of POST /api/chat requests):
  // - R1 mode (UC-1, AC-19.1): DR-01 pressed (`aria-pressed` true), message sent -> the last message of the body has `deepResearch: true` and a plain text part; the toggle is off again and the next body has no `deepResearch`; the sent message shows
  //   the DR-02 label and, after the thread is restored from history with that metadata, still shows it; the card of the reply is «Идёт»;
  //   with the tool result's view `sourceMode` `model_knowledge` the card carries MC-31 under the budget from its first display (before any GET /research) and the `status` announcement is the no-source variant of MC-17 (AC-27.2); with `sources` neither appears (AC-27.4)
  // - R2 decision turn leaves no trace (UC-2, DC-7, AC-19.3, AC-19.4): thread with a card «Ждёт подтверждения» -> «Запустить» -> exactly one more POST whose last message has `researchDecision` {confirm, launchKey of the card} and the text of the
  //   button label; the feed shows no new user message and no new reply; the card goes «Запуск» (button label «Запускаем…») while the turn runs and «Идёт» after; no second POST follows the reply; «Не нужно» on another card -> «Отклонение» then
  //   «Не запущен» with «Вы отказались.»; the thread restored from history with both hidden pairs (decision messages and replies marked `researchDecisionReply`) draws neither, and draws an answer message that follows a pair;
  //   with `sourceMode` `model_knowledge` in the history's view the proposal card shows MC-31 before «Запустить» (AC-27.1) and keeps it through «Запуск», «Идёт» and after the one GET /research that follows the turn; the declined card «Не запущен» keeps it too
  //   (the mode is read from the view each time, not from the first state); with `sources` none of the three states shows it (AC-27.4)
  // - R3 settled, failed and busy cards (UC-3, UC-E1, DC-1, AC-19.7): the tool result for a launch already running / not launched / failed -> the card shows that state, no error line (MC-15, MC-16, MC-29 absent); a decision turn answered with an HTTP 500
  //   before the first chunk -> no error stub and no TH-08 block in the feed, the card shows the line of its action (MC-15 / MC-29 / MC-16), buttons enabled again, and one GET /research afterwards moves the card to the applied state if the server reports it;
  //   a turn aborted from the composer behaves the same; an errored last reply loses its TH-08 block when the decision turn is sent; while a reply streams every decision button is disabled with the description MC-30 and no request is queued
  describe('INT-4', () => {
    it.todo('INT-4 R1: the research mode is sent once in the message metadata, resets after the send, the launch label survives a reload, and a launch without sources shows its warning from the first display with the no-source announcement');
    it.todo('INT-4 R2: confirm and decline send one hidden decision turn each, add nothing to the feed in the tab or after a reload, do not re-send the turn that ended in deepResearch, and move only the card, which keeps its no-source warning in every state and shows none when a source is connected');
    it.todo('INT-4 R3: settled cards show their state without an error line, a decision turn that fails before streaming shows the card error and no stub or error block in the feed, the old error block goes away, and buttons are disabled while a reply streams');
  });
});
