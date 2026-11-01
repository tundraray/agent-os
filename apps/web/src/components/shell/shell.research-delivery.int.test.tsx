// deep-research / chat-entry (web) Integration Test Skeletons - Design Doc: docs/features/deep-research/design-chat-entry.md (C3 web: «опрос и ответ», KD-6, Flow 3, Flow 5)
// PRD: docs/features/deep-research/prd.md (FR-20, FR-21). UXRD: docs/features/deep-research/uxrd.md (DR-03, DR-04, KD-5, MC-10, MC-11, MC-12, MC-18, MC-23).
// Generated: 2026-11-01 | Part: chat-entry | Test type: Integration (Vitest + RTL + MSW 2 + fake timers, jsdom, REAL useChatRuntime / AI SDK Chat) | Budget slot: INT-5 of the part (extra: see the unique defect below)
// Implementation timing: created alongside the web slice that adds useThreadResearch, ResearchAnswer and the append of missing answers.
//
// File name and placement follow the sibling files `shell.<topic>.int.test.tsx` in this folder. The measured figure of NFR-01 (5 s, with and without a streaming reply) is the L1 scenario (E2E-2): jsdom with fake timers proves the
// mechanism (which requests are made, when, and what is drawn), not wall-clock time.
//
// Why integration and not the component test: the answer reaches the feed without a turn, so it is added to the messages the real runtime holds while a chat may be streaming into the same list. Whether the runtime accepts a message added
//   this way, keeps the order, and does not start a turn is a property of useChatRuntime and the AI SDK that only the real runtime shows; a store test with a fake runtime cannot turn red when an upgrade breaks it.
//
// Harness (src/test/): as shell.research-decisions.int.test.tsx; polling is driven by vi.useFakeTimers() with `shouldAdvanceTime` off and the period of `useThreadResearch` (2 000 ms, a constant of apps/web next to the title polling settings).
// Mock boundary: network only (MSW) + next/navigation + timers. useThreadResearch, ThreadsApiClient, ResearchCard, ResearchAnswer, ThreadMessage, runtime - real.
//
// Unique defect no other test catches (why this is an extra slot): the api rows prove that the answer is stored and listed; nothing else proves that an open tab fetches the missing answer, appends it at the end of the feed without a turn
// and not in the middle of a stream, keeps polling exactly as long as something is pending, and shows the card states without a reload. Without it the user sees «Завершён» with a link to a message that is not in the feed.

import { describe, it } from 'vitest';

describe('Shell: polling the research state and appending the answer in the open thread (FR-20, FR-21, KD-6)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-5  Polling and answer append: the card follows the server, the answer joins the feed after any running stream, and polling stops with the last pending launch
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-20.1 (web half): "Given беседа открыта, When расследование завершено, Then ответ появляется в беседе без перезагрузки страницы (NFR-01), и беседа больше не показывает, что это расследование идёт."
  // AC-20.3 (web half): "Given в момент завершения расследования в беседе стримится другой ответ, Then ответ расследования показан отдельным сообщением и не склеен со стримящимся ни вживую, ни после перезагрузки."
  // AC-20.4 (web half): "Given расследование завершилось ошибкой, Then беседа показывает, что оно не удалось, и больше не показывает, что оно идёт."
  // AC-21.1 (card half): "...беседа показывает, что расследование остановлено, а ответ не дописывается."
  // AC-20.6 (links): "...каждый ответ ссылается на своё сообщение-запуск." (the «К запросу» anchor of each answer points at its own launch message)
  // DC-5 (web half): "...этот ответ дописывается снова после перегенерированного ответа, а его карточка остаётся «Завершён»."
  // NFR-01 (mechanism only): "ответ ... появляется в открытой беседе не позже чем через 5 с после завершения. Если в этот момент в беседе стримится обычный ответ ..., 5 с отсчитываются от конца этого стрима."
  // Use cases: UC-4, UC-E3, UC-E4 (card side), UC-E7 (web side), UC-9 (open tab), UC-N1 (mechanism). Flow 3 (last two arrows), Flow 5 (outcome). KD-5 of the UXRD (scroll and focus rules are a component concern).
  //
  // Primary failure mode (turns red when): the poll runs when no launch is pending, or does not run while one is `running` or `completed` with `answerPending`; a completed launch whose answer is missing from the feed is never fetched, or is fetched
  // and inserted in the middle of the streaming reply, or starts a chat turn; the answer is appended twice (a poll and a later history read); the card says «Завершён» with a link to a missing message; a failed or stopped launch draws an answer;
  // the poll is not read once after a turn that ended in a `deepResearch` call or after a failed decision turn.
  // Behavior: thread opened with a `running` card -> useThreadResearch reads GET /api/threads/:id/research every period -> a launch turns `completed` with `answerMessageId` that the feed lacks -> the tab waits for the end of its own stream,
  //   reads GET /api/threads/:id/messages and appends the missing answer messages to the end of the feed -> the card shows «Завершён» with «К ответу»; no POST /api/chat is made; the poll stops when nothing is pending
  // @category: core-functionality
  // @dependency: useThreadResearch, ThreadsApiClient (research and messages), ResearchCard, ResearchAnswer, ThreadMessage, useChatRuntime (real, message append), MSW, fake timers
  // @complexity: high
  //
  // Verification items (table; each row counts the requests MSW received per period):
  // - P1 lifecycle (UC-4, AC-20.1, AC-20.4, AC-21.1 card half): `running` card -> GET /research once per period; the launch turns `completed` with an `answerMessageId` that the feed lacks -> one GET /messages, the answer is the last message of the feed
  //   (its `researchAnswer` rendered as DR-04: goal, outcome, groups, footnotes, source list), the card is «Завершён» with «К ответу» and the answer's header has «К запросу» pointing at the launch message; no POST /api/chat; after that no more
  //   GET /research; a second launch ending `failed` shows «Не удался» and `stopped` shows «Остановлен», and neither fetches messages
  // - P2 running stream (UC-E3, AC-20.3, UC-N1 mechanism): a reply is streaming (the SSE body is held by a latch) when the poll reports the launch `completed` -> no GET /messages and no insertion until the stream ends; after it ends the answer is
  //   appended after the finished reply as a separate message (the text of the reply and of the answer are not merged); a reload (the history with both) draws the same order
  // - P3 answer taken away and returned (UC-9 open tab, DC-5): a launch `completed` with `answerPending: true` -> polling continues, the card is «Завершён» without «К ответу»; when the server reports `answerMessageId`, the answer is appended
  //   once after the regenerated reply; a launch that turns `failed` while pending shows «Не удался» (MC-12)
  // - P4 decision turn that left no reply (UC-E7 web side): thread whose stored tail is a decision message with no reply -> the decision message is not drawn; the answer that arrives is drawn at the end of the feed; and one GET /research is
  //   read after each turn that ended in a `deepResearch` call or in a failed decision turn even when nothing is pending
  describe('INT-5', () => {
    it.todo('INT-5 P1: a running card is polled each period, a finished launch whose answer is missing is fetched and appended last without starting a turn, polling then stops, and failed or stopped launches add no answer');
    it.todo('INT-5 P2: an answer that completes while another reply streams is appended only after that stream ends, as a separate message, in the same order after a reload');
    it.todo('INT-5 P3: a launch whose answer was removed by a regenerate keeps polling without «К ответу», and its answer returns once after the new reply or the card turns failed');
    it.todo('INT-5 P4: a decision message with no reply stays hidden, the answer is still appended, and the state is read once after each deepResearch turn and each failed decision turn');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Proven at unit level (named for the plan; generated as component specs next to the code, not here). One table-driven spec per rule, cases as rows.
// ---------------------------------------------------------------------------------------------------------------
// - ResearchAnswer (component, table over `researchAnswer` metadata): header with goal, outcome label (MC-24) and stop reason (MC-25), groups MC-26 with the unverified label MC-27, a footnote per source number with the accessible name «Источник {n}»,
//   the source list with truncation mark MC-28, no text part drawn from the message text. AC-20.7, AC-20.1 (draw).
// - ResearchCard (component, table over state x action): every state of UXRD DR-03 draws its title, rows, buttons and message (MC-5..MC-16, MC-29), «Остановить» asks for confirmation (MC-9) and sends nothing on «Продолжить», buttons are `disabled`
//   with MC-30 when a reply streams, the accessible name MC-14. AC-19.2 (draw), AC-19.3, AC-19.4, AC-21.1 (draw).
// - ResearchModeToggle (component): `aria-pressed` follows the state, placeholder MC-2 and send name MC-3 in the mode, Enter/Space toggles, focus stays on the toggle. NFR-05 (aria half), UXRD Accessibility.
// - ThreadMessage hiding rule (table): a user message with `researchDecision` and an assistant message with `researchDecisionReply` are not drawn, a message with `researchAnswer` is always drawn, the last visible message for TH-10 ignores hidden ones
//   while TH-08 stays with the runtime's last message. DC-7 (rule).
// - Block of the errored reply (extends message-error.test.tsx): MC-21 over «Перегенерировать» when the reply carries a `proposed` or `running` card. AC-22.2 (draw).
// - DeleteThreadDialog (extends delete-thread-dialog.test.tsx, MSW for GET /research): the dialog reads the launches of its thread on open and shows MC-22 in the singular or plural for one or several `running`, and nothing otherwise, also when the read
//   fails. DC-6, AC-22.1 (warning).
// - useThreadResearch (store, fake timers, no runtime): which launch states keep the poll alive (`running`, `completed` with `answerPending`), the 404 case, the unmount cleanup.
// - Message-metadata handling of ChatRuntimeProvider (`toCreateMessage`, `sendAutomaticallyWhen`): the mode passes from `runConfig` to the metadata of the message, a turn that ends in a `deepResearch` call is not re-sent while other tool turns still are.
