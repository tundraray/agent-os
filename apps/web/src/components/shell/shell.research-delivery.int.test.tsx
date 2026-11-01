// deep-research / chat-entry (web) Integration Test Skeletons - Design Doc: docs/features/deep-research/design-chat-entry.md (C3 web: «опрос и ответ», KD-6, Flow 3, Flow 5)
// PRD: docs/features/deep-research/prd.md v1.12 (FR-20, FR-21, FR-27). UXRD: docs/features/deep-research/uxrd.md v1.7 (DR-03, DR-04, KD-5, KD-9, MC-10, MC-11, MC-12, MC-18, MC-23, MC-31, MC-32, MC-33).
// Generated: 2026-11-01 | Updated: 2026-11-01 for the no-source mode (Design Doc v1.6: KD-8, DC-8, DC-9, UC-4, UC-12, UC-13, UC-E8) | Part: chat-entry | Test type: Integration (Vitest + RTL + MSW 2 + fake timers, jsdom, REAL useChatRuntime / AI SDK Chat) | Budget slot: INT-5 of the part (extra: see the unique defect below)
// Implementation timing: created alongside the web slice that adds useThreadResearch, ResearchAnswer and the append of missing answers.
//
// File name and placement follow the sibling files `shell.<topic>.int.test.tsx` in this folder. The measured figure of NFR-01 (5 s, with and without a streaming reply) is the L1 scenario (E2E-2): jsdom with fake timers proves the
// mechanism (which requests are made, when, and what is drawn), not wall-clock time.
//
// Why integration and not the component test: the answer reaches the feed without a turn, so it is added to the messages the real runtime holds while a chat may be streaming into the same list. Whether the runtime accepts a message added
//   this way, keeps the order, and does not start a turn is a property of useChatRuntime and the AI SDK that only the real runtime shows; a store test with a fake runtime cannot turn red when an upgrade breaks it.
//
// Harness (src/test/): as shell.research-decisions.int.test.tsx; polling is driven by vi.useFakeTimers() with `shouldAdvanceTime` off and the period of `useThreadResearch` (2 000 ms, a constant of apps/web next to the title polling settings).
// Mock boundary: network only (MSW) + next/navigation + timers (+ a `navigator.clipboard.writeText` stub in P5, a browser API boundary). useThreadResearch, ThreadsApiClient, ResearchCard, ResearchAnswer, ThreadMessage, runtime - real.
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
  // AC-20.7 (web half): "Given в развёртывании подключён хотя бы один источник данных, и ответ дописан, Then у каждого его утверждения в беседе видно, на какое evidence оно опирается (AC-09.2)." (footnotes and the source list drawn from the appended message)
  // AC-27.3 (web half): "Given в беседу дописан ответ расследования в режиме без источников, Then беседа показывает предупреждение ответа и пометку знаний модели у каждого утверждения (AC-25.1, AC-25.2), в том числе после перезагрузки."
  // AC-27.4 (web half): "Given подключён хотя бы один источник, Then беседа не показывает предупреждения режима без источников ни в предложении, ни в идущем расследовании, ни в ответе."
  // DC-8 (FR-27, web half): "Пока у запуска нет расследования, карточка показывает MC-31 по режиму развёртывания в момент чтения; после старта — по режиму своего расследования, и рестарт с другим набором источников её не меняет." (here: one thread, two launches of different modes)
  // DC-9 (FR-27, web half): "Текстовая часть ответа в режиме без источников начинается с MC-32 и несёт MC-33 после каждого утверждения, поэтому «Копировать» и модель в следующих ходах получают ту же оговорку." (the stored text is INT-2 D5; here what the copy action takes from the appended message)
  // DC-5 (web half): "...этот ответ дописывается снова после перегенерированного ответа, а его карточка остаётся «Завершён»."
  // NFR-01 (mechanism only): "ответ ... появляется в открытой беседе не позже чем через 5 с после завершения. Если в этот момент в беседе стримится обычный ответ ..., 5 с отсчитываются от конца этого стрима."
  // Use cases: UC-4 (with a fixture connected), UC-E3, UC-E4 (card side), UC-E7 (web side), UC-E8 (web side), UC-9 (open tab), UC-12 (answer half), UC-13, UC-N1 (mechanism). Flow 3 (last two arrows), Flow 5 (outcome). KD-5 and KD-9 of the UXRD (scroll and focus rules, and what a claim looks like without a source, are component concerns).
  //
  // Primary failure mode (turns red when): the poll runs when no launch is pending, or does not run while one is `running` or `completed` with `answerPending`; a completed launch whose answer is missing from the feed is never fetched, or is fetched
  // and inserted in the middle of the streaming reply, or starts a chat turn; the answer is appended twice (a poll and a later history read); the card says «Завершён» with a link to a missing message; a failed or stopped launch draws an answer;
  // the poll is not read once after a turn that ended in a `deepResearch` call or after a failed decision turn;
  // an answer appended by the poll in a thread without sources is drawn with footnotes or «не проверено» labels (the message loses `sourceMode` on the way from GET /messages to the runtime), or differently from the same message restored from history;
  // one thread-wide mode replaces the mode of each launch (a card of a research that started without sources loses MC-31 after a restart with a source, or a card started with one gains it); an answer with a source shows MC-32 or MC-33;
  // the copy action takes something other than the stored text (the caveat is lost).
  // Behavior: thread opened with a `running` card -> useThreadResearch reads GET /api/threads/:id/research every period -> a launch turns `completed` with `answerMessageId` that the feed lacks -> the tab waits for the end of its own stream,
  //   reads GET /api/threads/:id/messages and appends the missing answer messages to the end of the feed -> the card shows «Завершён» with «К ответу»; no POST /api/chat is made; the poll stops when nothing is pending
  // @category: core-functionality
  // @dependency: useThreadResearch, ThreadsApiClient (research and messages), ResearchCard, ResearchAnswer, ThreadMessage, useChatRuntime (real, message append), MSW, fake timers
  // @complexity: high
  //
  // Verification items (table; each row counts the requests MSW received per period):
  // - P1 lifecycle (UC-4, AC-20.1, AC-20.4, AC-21.1 card half): `running` card -> GET /research once per period; the launch turns `completed` with an `answerMessageId` that the feed lacks -> one GET /messages, the answer is the last message of the feed
  //   (its `researchAnswer` rendered as DR-04: goal, outcome, groups, footnotes, source list), the card is «Завершён» with «К ответу» and the answer's header has «К запросу» pointing at the launch message; no POST /api/chat; after that no more
  //   GET /research; a second launch ending `failed` shows «Не удался» and `stopped` shows «Остановлен», and neither fetches messages;
  //   with `sourceMode` `sources` (UC-4, AC-20.7, AC-27.4) the card and the answer carry none of MC-31, MC-32, MC-33, every claim has its footnote, and the `status` announcement is the plain MC-18
  // - P2 running stream (UC-E3, AC-20.3, UC-N1 mechanism): a reply is streaming (the SSE body is held by a latch) when the poll reports the launch `completed` -> no GET /messages and no insertion until the stream ends; after it ends the answer is
  //   appended after the finished reply as a separate message (the text of the reply and of the answer are not merged); a reload (the history with both) draws the same order
  // - P3 answer taken away and returned (UC-9 open tab, DC-5): a launch `completed` with `answerPending: true` -> polling continues, the card is «Завершён» without «К ответу»; when the server reports `answerMessageId`, the answer is appended
  //   once after the regenerated reply; a launch that turns `failed` while pending shows «Не удался» (MC-12)
  // - P4 decision turn that left no reply (UC-E7 web side): thread whose stored tail is a decision message with no reply -> the decision message is not drawn; the answer that arrives is drawn at the end of the feed; and one GET /research is
  //   read after each turn that ended in a `deepResearch` call or in a failed decision turn even when nothing is pending
  // - P5 answers without sources (UC-12 answer half, UC-13, UC-E8, AC-27.3, AC-27.4, DC-8, DC-9; unique defect: the mode lost between the server message and the drawn answer, or one mode for the whole thread - both visible only when the message arrives
  //   through the poll into the real runtime and a second launch of another mode sits in the same list): GET /research lists a `running` launch with `sourceMode` `model_knowledge`; it turns `completed` and GET /messages returns its answer
  //   (`researchAnswer.sourceMode` `model_knowledge`, two claims without footnote numbers, text opening with MC-32 and carrying MC-33 after each claim) -> the answer is the last message, drawn with MC-32 under the goal line, MC-33 after each claim, no footnotes,
  //   no «не проверено» label and no source list; the card is «Завершён» with MC-31; the `status` announcement is the no-source variant of MC-18; the copy action of the answer hands the clipboard stub the stored text with MC-32 and both MC-33;
  //   a thread restored from history with the same message draws the same (AC-27.3 after a reload).
  //   Mixed thread (UC-13, DC-8): the same list holds a `proposed` launch with `sourceMode` `sources` (the process was restarted with a source) beside the `model_knowledge` running one -> the proposal card has no MC-31, the running card has it, and once that
  //   launch is answered its answer has MC-32 and MC-33 while a later `sources` answer of the proposal confirmed afterwards has footnotes and none of the three.
  //   UC-E8 row: the answer message is a stop before the synthesis ended (outcome `inconclusive`, stop reason, no claims) -> it is appended last, opens with MC-32, shows the stop reason MC-25 and no claim, and the card is «Завершён»
  describe('INT-5', () => {
    it.todo('INT-5 P1: a running card is polled each period, a finished launch whose answer is missing is fetched and appended last without starting a turn, polling then stops, and failed or stopped launches add no answer');
    it.todo('INT-5 P2: an answer that completes while another reply streams is appended only after that stream ends, as a separate message, in the same order after a reload');
    it.todo('INT-5 P3: a launch whose answer was removed by a regenerate keeps polling without «К ответу», and its answer returns once after the new reply or the card turns failed');
    it.todo('INT-5 P4: a decision message with no reply stays hidden, the answer is still appended, and the state is read once after each deepResearch turn and each failed decision turn');
    it.todo('INT-5 P5: an answer without sources appended by the poll is drawn with the warning and the mark on every claim and no footnotes, the same after a reload and in the copy, each card and answer follows its own launch\'s mode when modes are mixed, and a stop before the synthesis shows the warning, the reason and no claim');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Proven at unit level (named for the plan; generated as component specs next to the code, not here). One table-driven spec per rule, cases as rows.
// ---------------------------------------------------------------------------------------------------------------
// - ResearchAnswer (component, table over `researchAnswer` metadata): header with goal, outcome label (MC-24) and stop reason (MC-25), groups MC-26 with the unverified label MC-27, a footnote per source number with the accessible name «Источник {n}»,
//   the source list with truncation mark MC-28, no text part drawn from the message text. AC-20.7, AC-20.1 (draw).
//   Rows added for `sourceMode` (UC-12, UC-E8, UC-N3): `model_knowledge` with claims -> MC-32 first under the goal line, MC-33 as plain text right after each claim (not `aria-hidden`, not a tooltip, no footnote, no MC-27 label, no source list); `model_knowledge`
//   with no claim -> MC-32, MC-25 and no claim; `sources` -> none of MC-32, MC-33; MC-32 is ordinary text, not `role="alert"`. AC-27.3 (draw), AC-27.4, NFR-05 (reading order).
// - ResearchCard (component, table over state x action): every state of UXRD DR-03 draws its title, rows, buttons and message (MC-5..MC-16, MC-29), «Остановить» asks for confirmation (MC-9) and sends nothing on «Продолжить», buttons are `disabled`
//   with MC-30 when a reply streams, the accessible name MC-14. AC-19.2 (draw), AC-19.3, AC-19.4, AC-21.1 (draw).
//   Rows added for `sourceMode`: `model_knowledge` -> MC-31 under the budget in every state (`proposed`, launching, `running`, `completed`, `not_launched`, `failed`, `stopped`), as ordinary text and not `role="alert"`; `sources` -> never. The variants of the
//   announcements MC-17 and MC-18 by mode. AC-27.1 (draw), AC-27.2 (draw), AC-27.4 (draw), DC-8 (draw).
// - ResearchModeToggle (component): `aria-pressed` follows the state, placeholder MC-2 and send name MC-3 in the mode, Enter/Space toggles, focus stays on the toggle. NFR-05 (aria half), UXRD Accessibility.
// - ThreadMessage hiding rule (table): a user message with `researchDecision` and an assistant message with `researchDecisionReply` are not drawn, a message with `researchAnswer` is always drawn, the last visible message for TH-10 ignores hidden ones
//   while TH-08 stays with the runtime's last message. DC-7 (rule).
// - Block of the errored reply (extends message-error.test.tsx): MC-21 over «Перегенерировать» when the reply carries a `proposed` or `running` card. AC-22.2 (draw).
// - DeleteThreadDialog (extends delete-thread-dialog.test.tsx, MSW for GET /research): the dialog reads the launches of its thread on open and shows MC-22 in the singular or plural for one or several `running`, and nothing otherwise, also when the read
//   fails. DC-6, AC-22.1 (warning).
// - useThreadResearch (store, fake timers, no runtime): which launch states keep the poll alive (`running`, `completed` with `answerPending`), the 404 case, the unmount cleanup.
// - Message-metadata handling of ChatRuntimeProvider (`toCreateMessage`, `sendAutomaticallyWhen`): the mode passes from `runConfig` to the metadata of the message, a turn that ends in a `deepResearch` call is not re-sent while other tool turns still are.
