// agent-quality / web Integration Test Skeletons - Design Doc: docs/features/agent-quality/design-web.md v1.2 (Test Strategy; KD-1..KD-8; DC-1..DC-13)
// PRD: docs/features/agent-quality/prd.md (FR-14, FR-15, FR-16, FR-21: AC-15.1, AC-15.3, AC-21.1 card side, AC-21.2 card side). UXRD: docs/features/agent-quality/uxrd.md v1.3 (KD-1..KD-7, MC-1..MC-4, «Остановка» steps 1-3, Error Flows),
//   docs/features/deep-research/uxrd.md (MC-16, MC-19, MC-21, MC-30), chat-shell UXRD (TH-08).
// Generated: 2026-11-07 | Part: web | Test type: Integration (Vitest + RTL + MSW 2, jsdom, REAL useChatRuntime / AI SDK Chat, real ThreadResearchProvider / ThreadResearch store / threadsApiClient / @agent-os/contracts schemas)
// Implementation timing: created alongside the web slice each INT names (INT-1 answer rendering through the schema; INT-2/INT-3 `stopResearch` + provider + store; INT-4 TH-08 after a button stop).
//
// File name and placement. Same as the sibling files `shell.<topic>.int.test.tsx` of this folder (vitest.config.ts include `src/**/*.test.{ts,tsx}`, environment jsdom). The part has NO browser runner and
// no E2E file: a `*.e2e.test.tsx` would be picked up by the same include and run in the default suite, and the repo has no Playwright. The real-browser journeys are the L1 scenarios L1-1..L1-4 of the
// Design Doc ("Проверка в настоящем браузере"), executed by an agent through Claude-in-Chrome as chat-entry did (docs/features/deep-research/chat-entry/l1-browser-scenarios.md); the plan writes the
// l1-browser-scenarios.md of this part from that table. Skeletons are `it.todo`: nothing here passes before the slice exists.
//
// Harness (src/test/): renderWithRuntime({ pathname }) from '@/test/render-with-runtime' mounts ChatRuntimeProvider + ChatShell with mocked next/navigation. MSW server from '@/test/msw-server' (onUnhandledRequest: 'error');
//   fixtures from '@/test/fixtures' (`researchLaunchView`, `threadResearch`, `deepResearchToolPart`, `historyMessages`, `sseFromChunks`, `assistantTextChunks`, `deferred`). API base URL: NEXT_PUBLIC_API_URL = 'http://api.test'. TZ = 'Europe/Berlin'.
//   New in the harness (add with the slices, not created here): an MSW handler for `POST /api/threads/:threadId/research/:launchKey/stop` that records its calls (count, URL) and answers per test.
//   WARNING for INT-1: `researchAnswerMessage` in fixtures.ts runs `ResearchAnswerMetadataSchema.parse`, which fills the new fields with their defaults. An "old" message built with it is not old. The old row serves the RAW JSON
//   of a pre-update message (no `summaryItems`, no `confidence`, no `causal`) straight from the MSW history handler, so the schema in @agent-os/contracts, not the fixture, is what meets it.
// Mock boundary: network only (MSW) + next/navigation (framework boundary). Runtime, adapters, ResearchCard, ResearchAnswer, ThreadResearchProvider, ThreadResearch, threadsApiClient, MessageError - real.
//   Do NOT mock lib/threads/*, lib/config.ts or @assistant-ui/*. Time: a held response is a `deferred`, never a sleep; INT-3 R1/R2 poll reads are ordered by deferreds on the GET /research handler.
//
// Budget (part): Integration 4 (limit 3; up to 5 only when each extra names the defect no other test catches), E2E 0 (limit 1-2: no runner, see above; the four L1 scenarios are manual).
//   Core: INT-1 (answer through the real schema), INT-2 (stop while the agent writes, the whole wiring), INT-3 (the stop outcomes the provider turns into a line or a state).
//   Extra: INT-4 (TH-08 block after a button stop) - unique defect: only the real runtime owns the chat error that a hidden decision turn used to reset, and only the real store feeds `useReplyCarriesActiveResearch`; no unit
//   level and none of INT-1..INT-3 sees a stop that wrongly removes the error block or leaves MC-21 behind. Rows of one rule or one flow are table rows of one INT, not tests.
//
// Proven elsewhere (not in this file) - unit tests named for the plan, each one table-driven, no skeleton here:
// - U-1 `research-answer.test.tsx` (extend; replaces the cases that pin `summary` and MC-34): the summary is drawn iff `summaryItems` is non-empty. Rows: UC-1 two items (caption MC-2 under the goal, bulleted list, item text + group words, no footnotes,
//   no other labels) / UC-E1 empty items and only «Предположения»+«Не выяснено» (no caption, no list, no gap, the first heading follows the goal line) / UC-E2 `model_knowledge` (MC-32 then groups, MC-33 on claims, no summary, no labels) /
//   UC-E3 forced stop (stop reason under the goal, no summary, `medium` words on the established claim) / old shape: empty items AND a non-empty `summary` string -> no paragraph, no MC-34, no MC-2 (DC-5 render half). Covers DC-3, DC-4, DC-5, AC-15.3.
// - U-2 `research-answer.test.tsx` (same file): the label after a claim's footnotes. Rows: UC-2 `very_high|high|medium|low` -> «уверенность очень высокая|высокая|средняя|низкая», in this order, after "Источник 1, Источник 2" in reading order,
//   no digits or % next to them / `confidence` null (old message) -> no word (DC-2) / `causal` true -> «причинная связь не доказана» in a frame and NO «не проверено» (DC-1) / `verified` false and `causal` false -> «не проверено»,
//   no MC-3 / both sourceless modes -> no labels. Covers AC-15.1, DC-1, DC-2, KD-6.
// - U-3 `research-card.test.tsx` (extend; the case "the confirmed «Остановить» is unavailable while «Продолжить» still works" must be inverted): with `replyStreaming` the row «Остановить» and the confirmation «Остановить» and «Продолжить» work
//   and have no `aria-disabled` and no MC-30; «Запустить» and «Не нужно» stay disabled, keep Tab order, and describe themselves with MC-30 (DC-7); Esc and «Продолжить» return the action row and focus to «Остановить» (UC-E10);
//   `decisionError` `still_launching` draws MC-4 in the «Ещё запускается» form without `role="alert"`, hides it when «Остановить» of the row is pressed and shows it again only on a new prop value; `stop_failed` draws MC-16 with `role="alert"`;
//   both lines only while `running` (invariant 2). Covers DC-7, DC-9, DC-10 (card half).
// - U-4 `thread-research-store.test.ts` (extend): `stop(launchKey)` outcomes with the client faked at its boundary (MSW). Rows: 200 `stopped` -> «применено», view replaces the launch, one `stopped` event in `announcements`, the next read with the same
//   `stopped` adds no event (invariant 5, UC-3 tail) / the 200 view per state table (UC-E6): `completed` with answer, `completed` + `answerPending`, `failed`, `proposed`, `not_launched` (`declined`), `running` -> the view stands, events only for
//   completed|failed|stopped, none for the rest, `running` is «применено» too (MC-4 is the provider's) / network error, 404, 400, 500, body outside `ResearchStopResponseSchema` -> «отказ» and EXACTLY ONE state read afterwards (DC-10) /
//   no open thread -> «устарело» at once, no request / thread switched or store closed before the answer -> «устарело», nothing applied, no event (UC-E9, store half) / a read started before the answer and returned after it is discarded and the store
//   reads again, the card stays `stopped` and «Ресерч запущен» is never announced (UC-E8, invariant 4) / UC-E11: the state changed by a read alone (`stopped`, or `running`) - event once, no `decisionError` concept involved (DC-11).
//   Covers DC-8, DC-10, DC-11, KD-3, KD-4, invariants 4, 5.
// - U-5 `threads-api-client.test.ts` (extend): `stopResearch` sends `POST` without a body, with the session cookie, both ids URL-encoded in `/api/threads/:threadId/research/:launchKey/stop`, and returns `launch` parsed by
//   `ResearchStopResponseSchema`. Rows (error classification, one rule): no connection -> `network`; no answer within the default 20 s (fake timers, request aborted) -> `network`; an explicit shorter limit is honoured; 404 with either code
//   and 400 -> `not_found`; 500 and other statuses -> `http`; non-JSON body or body outside the schema -> `invalid_response`; the error body's `code` is not read. Covers DC-10, KD-4 (the 20 s limit lives only here).
// - Existing tests the plan keeps green or changes: `shell.research-decisions.int.test.tsx` INT-4 R3 loses its `stop` row (stop no longer goes through a decision turn; the same defect class is INT-3 R1 here); `research-answer.test.tsx` cases
//   that pin `summary`/MC-34 are replaced by U-1; `shell.research-delivery.int.test.tsx` INT-5 P1 keeps the stopped/failed-adds-no-answer rows and INT-5 P4 / INT-4 R2 keep proving DC-12 (a stored `researchDecision` `stop` message and its reply stay hidden, the
//   hiding rule reads the metadata mark, not the action) - NO new skeleton for DC-12 (UC-E12); `ResearchLaunchView`-to-card-state rules stay in `research-card.test.tsx` (STATES table).
// - Not automated: UC-6 / KD-6 "a long label moves whole to the next line, muted text colour in light and dark" is layout and colour, which jsdom does not compute -> L1-1. L1-2 (stop while streaming in a real browser), L1-3 (blocked stop address, retry works),
//   L1-4 (pre-update answer in a real browser with a clean console) are the manual journeys over INT-2, INT-3 R1, INT-1.

import { describe, it } from 'vitest';

describe('Shell: agent-quality web part (answer labels and the direct stop)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  Restored history reaches the screen through the real schema: new fields arrive, old messages still parse
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-15.1: "Given ответ выдан, Then у каждого вывода в «Установлено» указана группа уверенности её постоянными словами и без процента."
  // AC: AC-15.3: "Given в сводке стоят выводы из разных групп, Then каждый вывод сводки стоит со словами своей группы."
  // DC-1: "Когда у вывода в «Предположениях» `causal` равен true, после его сносок стоит метка «причинная связь не доказана» (MC-3) в рамке, а метки «не проверено» у него нет."
  // DC-3: "Когда в `summaryItems` есть пункты, под строкой цели стоит подпись MC-2 и под ней маркированный список: текст пункта и слова его группы, без сносок и без других меток."
  // DC-5: "Ответ, записанный до этой части, показывается без сводки - ни прежнего абзаца с подписью MC-34, ни подписи MC-2 - и без меток уверенности и причинной связи; группы, сноски, «не проверено» и источники - как раньше."
  // Use cases: UC-1, UC-5. Risk: design-web.md "Risks and Mitigation", first item (high impact). Real browser: L1-1, L1-4.
  //
  // Behavior: a thread is opened -> GET /messages returns a research answer message -> AssistantMessage parses `researchAnswer` with the contracts schema -> ResearchAnswer / Claim draw it
  //   rows (one open of the thread each, one table):
  //   N  new message (raw JSON with `summaryItems` [high, medium], established claims with `confidence` high / medium and footnotes, an assumed causal claim `causal` true + `verified` true, an assumed claim `verified` false):
  //      caption «Главное из установленного» under the goal line and a list of two items with «уверенность высокая» / «уверенность средняя» and no footnote; the same words after the footnotes of the established claims;
  //      «причинная связь не доказана» after the causal claim's footnotes and no «не проверено» on it; «не проверено» and no MC-3 on the other; the MC-34 caption nowhere; the answer is drawn from metadata (the text version is not on screen)
  //   O  OLD message (raw JSON as stored before the update: no `summaryItems`, `confidence`, `causal`; a `summary` paragraph; one unverified claim): drawn from metadata, NOT as the text version; no summary paragraph, no MC-34, no MC-2; the first group
  //      heading follows the goal line; no confidence word and no MC-3; groups, footnotes, «не проверено» and the source list as before; `console.warn` is not called with a metadata warning (L1-4)
  // Catches: (N) the contracts schema strips or mistypes `summaryItems`, `confidence` or `causal`, so ResearchAnswer receives nothing and the screen shows no summary or labels although every direct-props test is green; (O) the extended schema rejects
  //   messages stored before the update, so every earlier answer falls back to plain text - high impact, the highest-ranked risk of the design. No other test parses a pre-update message with the real schema.
  // @category: core-functionality
  // @dependency: @agent-os/contracts (ResearchAnswerMetadataSchema), AssistantMessage (metadata parse + fallback), ResearchAnswer, Claim, MSW (history)
  // @complexity: medium
  it.todo('INT-1: a restored research answer draws its summary and labels from the new fields, and a pre-update answer still parses and draws without summary or labels');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  Stop while the agent writes: one stop request, no chat turn, composer untouched, card «Остановлен» announced once
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-21.1 (card side): "Given провайдер модели недоступен, When сотрудник подтверждает остановку на карточке, Then сотрудник видит расследование остановленным, и новые вызовы модели не начинаются."
  // DC-6: "Когда сотрудник подтверждает остановку, карточка сразу переходит в «Остановку», и вкладка отправляет один запрос к операции остановки и ни одного хода беседы; композер и другие карточки не меняются."
  // DC-7: "Пока агент пишет ответ, «Остановить» в ряду действий, «Остановить» и «Продолжить» в подтверждении и Esc работают, а «Запустить» и «Не нужно» неактивны с описанием MC-30."
  // DC-8 (stopped): "...карточка показывает состояние из `launch` ... Перемену состояния экран объявляет один раз, как после чтения: для `stopped` - MC-19."
  // Use case: UC-3 (UC-E10 is U-3). Flow 1. KD-1, KD-2, KD-3. Real browser: L1-2.
  //
  // Behavior: thread with a «Идёт» card (call-a) and a proposal card (call-b); the user sends a new message -> the chat reply is held open (SSE not finished) -> «Остановить» -> confirmation -> «Остановить» ->
  //   POST /api/threads/a/research/call-a/stop (held, then 200 `launch` `stopped`) -> card «Останавливаем…» and focus on the card -> «Ресерч остановлен» with «Ответа не будет.» -> the reply finishes
  // Verification items:
  // - while the stop request is held: status «Останавливаем…» on the card, focus stays on it; the composer is in the streaming state; «Запустить» of call-b is disabled and described by MC-30; the stop route was called exactly once
  // - the number of POST /api/chat/assistant equals the number before the press plus none (only the user's own new message): no `researchDecision` body, no new message in the feed
  // - after the 200: «Ресерч остановлен» and «Ответа не будет.», no MC-16 and no MC-4; the live region holds «Ресерч остановлен» once; the next GET /research that returns `stopped` adds no second announcement (KD-3)
  // - the held chat reply finishes afterwards and is drawn to the end (the stop did not abort it)
  // Catches: the button still goes through a hidden decision turn (a chat request appears, the composer changes, the button waits for the stream and is dead exactly when the model is unavailable); the stop request is sent twice; the same
  //   `stopped` is announced twice (once from the answer, once from the next read). The unit rows U-3/U-4/U-5 each prove one link; only this test proves the links are connected to one button in a streaming tab.
  // @category: core-functionality
  // @dependency: ResearchCard, ThreadResearchProvider, ThreadResearch, threadsApiClient.stopResearch, ChatRuntimeProvider (real useChatRuntime), MSW (SSE v7 held by a deferred, stop route)
  // @complexity: high
  it.todo('INT-2: confirming «Остановить» while the agent writes sends one stop request and no chat turn, leaves the composer streaming, and announces «Ресерч остановлен» once');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  Outcomes of the stop request that the provider turns into a card line or a state: refusal, still starting, tab moved away
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-21.1 (card side), see INT-2.
  // DC-9: "Когда операция отвечает 200, а запуск всё ещё `running`, карточка возвращается в «Идёт» со строкой пояснения MC-4, «Остановить» доступна, и экран вежливо объявляет MC-4; строка уходит при следующей смене состояния карточки или при следующем нажатии «Остановить»."
  // DC-10: "Когда операция отказывает или не отвечает за 20 секунд, карточка возвращается в «Идёт» со строкой MC-16, которую программа чтения экрана слышит как `alert`, и «Остановить» снова доступна; затем вкладка один раз читает состояние."
  // DC-6 (tab moved): UC-E9 - "в другой беседе ничего не объявлено; в прежней карточка показывает состояние из чтения, а не «Остановку»."
  // Use cases: UC-E4, UC-E7, UC-E9 (UC-E5 and the 20 s limit: U-5; the per-state 200 table UC-E6: U-4 + `research-card.test.tsx`). Invariants 1, 2. UXRD KD-6, Error Flows. Real browser: L1-3.
  //
  // Behavior: card «Идёт» -> «Остановить» -> confirm -> the stop route answers per row -> provider ends «Остановку» and sets the line -> card / live region
  //   rows (table: the stop route's answer and what follows):
  //   R1 refusal: the stop route answers 500 -> «Ресерч идёт», MC-16 «Не удалось остановить ресерч. Попробуйте ещё раз.» with `role="alert"`, «Остановить» enabled, exactly one GET /research after the failure (it still reports `running`, so the line stays);
  //      pressing «Остановить» again, confirming, with the route now 200 `stopped` -> «Ресерч остановлен», MC-16 gone, one announcement
  //   R2 still starting: 200 with `launch` `running` -> «Ресерч идёт» and MC-4 «Ресерч ещё запускается. Остановите его через несколько секунд.» without `role="alert"`, «Остановить» enabled, MC-4 is in the polite live region once, MC-16 absent;
  //      «Остановить» pressed in the row -> the line is hidden; the next read returns `stopped` -> «Ресерч остановлен» with no line and «Ресерч остановлен» announced once
  //   R3 tab moved away: the stop request is held; the user opens another thread (the other thread's research list has nothing), the answer arrives -> nothing announced in the other thread, no «Остановка» left on any card;
  //      returning to the first thread shows the state its own read reports (`stopped`), not «Останавливаем…» and not a second announcement of the stop
  // Catches: (R1) a refusal leaves the card stuck in «Останавливаем…» or without «Остановить», or drops the error to the console only; the retry is blocked by a stale pending state. (R2) a still-starting launch is shown as «Остановлен» or as a failure
  //   (the operation did not touch it), MC-4 is announced as an alert, or the line survives the next press or a state change. (R3) the late answer of a closed thread is applied to the thread now on screen, announces its stop there, or leaves
  //   the old card in «Остановке». Provider-level wiring across store, client and card that no unit row sees.
  // @category: core-functionality
  // @dependency: ThreadResearchProvider (live region, decide('stop')), ThreadResearch, ResearchCard, threadsApiClient, MSW (stop route per row, GET /research per read), next/navigation mock (thread switch)
  // @complexity: high
  it.todo('INT-3: a refused stop shows MC-16 and allows a retry, a stop of a launch that is still starting shows MC-4 and no error, and an answer that arrives after the tab moved to another thread is not applied');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4  Button stop leaves the error block of the reply in place and takes MC-21 away only from the stopped reply's own card
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-21.1 (card side): the model is unavailable.
  // DC-13: "Когда сотрудник останавливает ресерч кнопкой, а в ленте стоит блок ошибки ответа (chat-shell UXRD, TH-08), блок остаётся на месте с «Перегенерировать»: остановка не начинает хода беседы. Строка MC-21 над «Перегенерировать» уходит, только если остановлена карточка из самой упавшей реплики."
  // DC-6 (no chat turn). Use case: UC-4. UXRD «Остановка», step 3. Flow 1, failure handling "Модель недоступна". Invariant 3.
  //
  // Behavior: the last chat turn failed (500 before streaming) and the errored reply shows the TH-08 block; the user stops a «Идёт» card -> POST stop (200 `stopped`) -> card «Ресерч остановлен»; no chat request
  //   rows (two runs of one scenario, the card's reply differs):
  //   E  the stopped card sits in an EARLIER reply: the TH-08 block and «Перегенерировать» stay; the MC-21 line over «Перегенерировать» was not there before and is not there after
  //   S  the stopped card sits in the ERRORED reply itself: the TH-08 block and «Перегенерировать» stay; MC-21 «Перегенерация остановит ресерч из этого ответа.» is visible before the press and gone after the 200
  // Verification items (both rows): the feed has the same number of messages before and after; the number of POST /api/chat/assistant is unchanged by the press; «Перегенерировать» is still enabled.
  // Catches: the stop still travels as a chat turn, so the AI SDK resets the chat error and the TH-08 block vanishes (the old hidden-turn behaviour, the stale-error removal of the decision turn); or MC-21 stays above «Перегенерировать» after the research
  //   it warned about is already stopped, or disappears when the stopped card belongs to another reply. Only the real runtime owns the chat error, and only the real store feeds `useReplyCarriesActiveResearch`.
  // @category: integration
  // @dependency: ChatRuntimeProvider (real chat error state), MessageError (TH-08, MC-21), useReplyCarriesActiveResearch, ThreadResearch, ResearchCard, MSW (failed chat turn, stop route)
  // @complexity: medium
  it.todo('INT-4: stopping a research by the button keeps the error block of a failed reply with «Перегенерировать», and MC-21 leaves only when the stopped card is in that reply');
});
