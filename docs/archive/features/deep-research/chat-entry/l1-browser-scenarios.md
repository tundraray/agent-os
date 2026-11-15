# L1 browser scenarios — `deep-research` / `chat-entry`

| Field | Value |
|-------|-------|
| Source | [`design-chat-entry.md`](../design-chat-entry.md) v1.6, Test Strategy → «Main Use Cases» (UC-1, UC-3, UC-4, UC-12, UC-13, UC-E8) and «Non-Functional Use Cases» (UC-N1, UC-N2, UC-N3) |
| PRD / UXRD | [`prd.md`](../prd.md) v1.12 (FR-19, FR-20, FR-26, FR-27; NFR-01, NFR-02, NFR-05), [`uxrd.md`](../uxrd.md) v1.7 (DR-01…DR-03, MC-2, MC-3, MC-17, MC-18, MC-25, MC-30…MC-33, Accessibility) |
| Upstream | [`design-engine.md`](../design-engine.md) v1.14, implemented and committed; plan [`engine/20261101-feature-deep-research-engine.md`](../engine/20261101-feature-deep-research-engine.md) |
| Type | E2E-level acceptance (E2E-2 of the part), executed manually by an agent through the Claude-in-Chrome extension. **Not** an automated runner (the repo has no browser runner) |
| When | Phase 7, T7.3 of the plan [`20261102-feature-deep-research-chat-entry.md`](./20261102-feature-deep-research-chat-entry.md), after all chat-entry tasks are complete and every unit, integration and E2E-1 test passes |
| Generated | 2026-11-02 (T1.1: moved from the comment block «E2E-2 L1 browser scenario» at the end of `apps/api/test/deep-research-chat-entry.e2e-spec.ts`; observations copied verbatim) |
| Executed | 2026-11-05, agent (T7.3), Chrome via Claude-in-Chrome, window 996×902, light theme (dark — visual check only). Branch `feat/research-runtime` at `025ca27` + README. `apps/api` built `dist` (`node dist/main.js`), `RUNTIME_WORKERS=on`, `ASSISTANT_MODEL` = `anthropic/claude-haiku-5-5` from `.env`, `REASONING_EFFORT` from `.env`; web — production build, `pnpm --filter web start`; Postgres `localhost:5433`. L1-6 screen reader — **not executed, pending the user** |

### Run notes (2026-11-05)

- **Order of the run.** Boot 1 — `apps/api` without the fixture package (the link `apps/api/node_modules/@agent-os/mcp-fixture` was moved out for this boot and put back afterwards): L1-7 (a), L1-4, L1-7 (f), L1-1, L1-2, L1-7 (b). Boot 2 — with the package: L1-7 (c), L1-5, L1-7 (e), L1-7 (d), L1-3, L1-6 keyboard. NFR-02 was measured before both boots on a separate start with `RUNTIME_WORKERS=off`, so the bench investigations never ran.
- **Real-model spend of the whole T7.3:** about $0.48 (cap $1.00). NFR-02 bench ≈ $0.005; model switch ≈ $0.05; 8 investigations ≈ $0.41 (engine journal `research_llm_calls.cost_usd`); chat and title turns on Haiku 5.5 ≈ $0.02 (from the `usage` log lines).
- **Threads kept for the user** (`dev-user`): `c6130ca7-aaa5-4bdf-9be0-05264e2ea79d` («Рост ошибок 5xx у payment-api в логах» — L1-4, L1-5, L1-7 (a, c, e)) and `5f999272-a25a-44de-a999-769f2b97e154` («Причины роста ошибок 5xx после релиза платёжного API» — L1-1, L1-2, L1-7 (b, d)); the answer of L1-7 (d) for the screen-reader half of L1-6 is there. The other L1 and bench threads were deleted through `DELETE /api/threads/:id`.
- **Logs (rule 13).** The `apps/api` logs of all boots and of the five Postgres suites hold launch lines with `launchKey`, `threadId`, `investigationId` and states only; a search for the goals, answer words and key prefixes found nothing.

## How to execute

**Environment (from the skeleton block):**

1. `pnpm db:up`
2. `apps/api` running on `http://localhost:4000` with `RUNTIME_WORKERS=on`, real model and keys (`apps/api/.env`), engine with the `deep-research` process over the fixture MCP source
3. `pnpm --filter web build && pnpm --filter web start` (production build)
4. Chrome with DevTools (Console, Network)
5. L1-7 runs `apps/api` twice more: first without the `@agent-os/mcp-fixture` package installed (the registry stays empty, the engine is created with an empty `connectedSources`), then restarted with it

**Measurements:** NFR-01 is read from Network — the time of the `GET /api/threads/<id>/research` that reports `completed` (or of the end of the streaming reply in L1-4) and the time the answer appears in the feed. NFR-02 (time to the first token) is measured as `chat-shell` does (see «Deferred from `threads-api` T6.3» in [`chat-shell/web-shell/l1-browser-scenarios.md`](../../chat-shell/web-shell/l1-browser-scenarios.md)). The screen-reader checks of L1-6 need NVDA or VoiceOver: **[screen reader — user]** — the agent asks the user to run them or records them as *not executed* with the reason. A check that was not run is never reported as passed.

**Evidence per observation:** screenshot(s), console entries, key Network requests (method, URL, status, time), startup log lines for L1-7. Paste them under the observation's **Evidence** line. The real model's prompts and replies and the keys are not pasted.

**Verdict rule:** a scenario passes only when every observation is ticked. Any failed observation → record actual vs expected and stop the final-phase sign-off for the AC it backs.

## Covers (original statements)

- NFR-01: "ответ завершённого расследования появляется в открытой беседе не позже чем через 5 с после завершения. Если в этот момент в беседе стримится обычный ответ главного агента, 5 с отсчитываются от конца этого стрима: посреди стрима ответ расследования не вставляется. Измеряется сквозным тестом `chat-entry`."
- NFR-02: "время до первого токена ответа главного агента не хуже требования проекта, в том числе в ответе, который запускает расследование; измеряется тем же способом, что в `chat-shell`."
- NFR-05: "новые состояния беседы соответствуют целевому уровню `chat-shell` (WCAG 2.1 AA)."
- AC-20.1 / AC-20.3 (timing and no-insert-in-stream), AC-20.7 (footnotes visible, with a source connected), AC-19.7 (second tab, no new messages) - the mechanisms are INT-1 A3, INT-5 P1/P2; here the real browser.
- AC-26.2: "Given в развёртывании не подключён ни один источник данных, When сервис запускается, Then журнал запуска содержит предупреждение, что источники данных не подключены и расследования пойдут на знаниях модели." (L1-7: the log of the real boot)
- AC-26.3: "Given подключён хотя бы один источник, When сервис запускается, Then этого предупреждения в журнале запуска нет." (L1-7)
- AC-27.1 / AC-27.2 / AC-27.3 / AC-27.4 and DC-8, DC-9 (the warning where the research is shown, the mark on every claim after a reload and in the copy, none with a source) - the mechanisms are INT-1 A6, INT-2 D5, INT-4 R1/R2, INT-5 P5; here the real browser and the real boot.
- Use cases: UC-1, UC-3, UC-4, UC-12, UC-13, UC-N1, UC-N2, UC-N3.

**Primary failure mode (turns red when):** the answer needs a reload or arrives later than 5 s after the end of the research (or of a streaming reply); it is inserted in the middle of a stream; the first token of a mode message is slower than a
plain one; the second tab shows a new message or an error line after a repeated decision; the mode, the card buttons or the confirmation dialog cannot be used from the keyboard or are not announced;
a deployment without the fixture package does not boot, boots without the warning in the log, or boots with it when a source is connected; the research without sources runs without a warning on the card, in the answer or on a claim, or with footnotes;
a research started without sources loses its warning when the process restarts with a source, or a proposal keeps it; the copied text or the screen-reader reading drops the mark of a claim.

## Coverage map

| Scenario | ACs and use cases | Only acceptance (no automated test) for |
|----------|-------------------|------------------------------------|
| L1-1 | UC-1, UC-N2, NFR-02; DR-01, DR-02, MC-2, MC-3 | **NFR-02** (time to the first token of a mode message) |
| L1-2 | AC-19.6 | — |
| L1-3 | UC-4, UC-N1, AC-20.1, AC-20.7, NFR-01 | **NFR-01 in seconds** (idle composer) |
| L1-4 | AC-20.3, AC-20.2, UC-N1, NFR-01, MC-30 | **NFR-01 in seconds** (after a streaming reply) |
| L1-5 | UC-3, AC-19.7, DC-1, DC-7 | — |
| L1-6 | UC-N3, NFR-05; MC-31…MC-33 read by the screen reader | **NFR-05 with a screen reader** |
| L1-7 | UC-12, UC-13, UC-E8, AC-26.1, AC-26.2, AC-26.3, AC-27.1, AC-27.2, AC-27.3, AC-27.4, DC-8, DC-9 | **AC-26.2, AC-26.3 on the live startup log** (the real boot without the fixture package) |

---

## L1-1 — Mode and first token

**Backs:** UC-1, UC-N2, NFR-02

- [x] L1-1 mode and first token (UC-1, UC-N2): DR-01 reached by Tab and toggled by Space (`aria-pressed` true, placeholder MC-2, send name MC-3); over 5 mode messages the time to the first token is not worse than over 5 plain ones, measured as chat-shell does;
  the DR-02 label sits over the sent message, the toggle is off again, the reply carries the card «Идёт» with goal and budget

  **Evidence:**
  - Keyboard: from the composer text field one Tab focuses `BUTTON` «Глубокий ресерч» with `aria-pressed="false"`; Space → `aria-pressed="true"`, placeholder «Опишите, что нужно исследовать…» (MC-2), send button `aria-label` «Запустить ресерч» (MC-3). Repeated three times in the run (threads of L1-7 (b), L1-3, L1-6).
  - After Enter: the user message carries the label «Глубокий ресерч» above it (DR-02), the composer is back to «Спросите что-нибудь…» (toggle off), the reply holds only the card «Ресерч идёт» with «Цель» and «Бюджет до 60 000 токенов» (thread `5f999272…`, 19:35). Focus stays in `TEXTAREA`.
  - **NFR-02 — time to the first token**, method of `chat-shell` T8.4 (direct HTTP from a Node 22 script, `fetch` + `performance.now()`, «first token» = the first SSE chunk whose `type` ends with `-delta`, each stream read to the end, 3 s pause, one warm-up per side, runs interleaved), built `apps/api` with `RUNTIME_WORKERS=off`, `x-user-id: ttft-bench-ce`, the same question on both sides, a new thread per run. All 12 responses HTTP 200, no `error` chunks.

    | Side | 5 measured runs, ms | Median, ms | First delta |
    |---|---|---|---|
    | plain message | 1552, 1421, 1882, 1624, 1944 | **1624** | `reasoning-delta` (the plain turn proposed a research each time: reasoning → `deepResearch` → text) |
    | mode message | 602, 558, 553, 557, 526 | **557** | `tool-input-delta` (forced `deepResearch`, no reasoning — KD-9) |

    The mode message is not slower than a plain one (median −1067 ms). Response headers: plain 477–526 ms, mode 526–600 ms.

---

## L1-2 — Plain message while running

**Backs:** AC-19.6

- [x] L1-2 plain message while running (AC-19.6): the agent answers as usual, no second research starts, focus stays in the composer

  **Evidence:**
  - Thread `5f999272…`, 3 s after the mode message of L1-1 (card «Ресерч идёт»): a one-sentence question about HTTP codes. The agent answered with text only; `GET /api/threads/5f999272…/research` lists one launch (`…ieTsSL`, `explicit`); the feed has one card. `document.activeElement` — `TEXTAREA` after the send.

---

## L1-3 — Answer timing, idle composer

**Backs:** UC-4, UC-N1, AC-20.1, AC-20.7, NFR-01

- [x] L1-3 answer timing, idle composer (UC-4, UC-N1, AC-20.1, AC-20.7): the answer appears at the end of the feed without a reload within 5 s of the controller's end (Network: the GET /research that reports `completed`, and the time of the answer);
  the card is «Завершён» with «К ответу», focus did not move, MC-18 is announced once, every claim has a footnote that names a source in the list, «К запросу» scrolls to the DR-02 message

  **Evidence:**
  - Timing (boot 2, sources, foreground tab, idle composer; thread deleted after the run): research with budget 30 000. Controller task finished `17:41:55.091` UTC (`research_chat_launches.finished_at`), answer written `17:41:56.086`; in the page (wrapped `fetch` + 100 ms DOM probe): `GET /research` → `completed` with `answerMessageId` at `17:41:57.644`, `GET /messages` at `17:41:57.661`, the answer in the feed at `17:41:57.696` — **2.6 s** after the controller's end, no reload. Focus at that moment — `TEXTAREA` (did not move). The polite region changed once: «Ресерч завершён. Ответ добавлен в конец беседы.» (MC-18). The card is «Ресерч завершён» with «К ответу ↓». The run ended `budget_exhausted` without claims, so footnotes were checked on the answer below.
  - Footnotes (thread `c6130ca7…`, research `…dV94Gn` of L1-5): «Частичный ответ», «Остановлен: исчерпан бюджет», «Установлено» with 4 claims, each with footnotes ([1] [2], [3] [4], [5], [6] [7]); «Источники (7)» opens the list `fixture aggregate_logs fx-v1-…`, `fixture search_logs …`; `researchAnswer.sources` 7, claims without a footnote 0.
  - «К запросу ↑» (keyboard-reachable link) moves focus to the DR-02 message root («Глубокий ресерч / Сколько ошибок записал payment-api…»).
  - **Fact vs expectation (open, needs a decision):** the answer of `…dV94Gn` reached a tab that was **in the background** (a second tab of L1-5 was active): `GET /research` reported `completed` with `answerMessageId` at `17:38:59.854`, the controller ended `17:38:58.325`, but the answer appeared in that tab's feed only at `17:39:12.831` (14.5 s after the end), when the agent next acted on the tab. In a foreground tab the same path took 2.6 s. Probably browser throttling of hidden tabs; the cause was not isolated. AC-20.1 does not say whether a hidden tab counts.

---

## L1-4 — Answer timing, streaming reply

**Backs:** AC-20.3, AC-20.2, UC-N1, NFR-01

- [x] L1-4 answer timing, streaming reply (AC-20.3, UC-N1): a long plain question sent right after the start so that a reply streams when the research ends -> no insertion during the stream, a separate message after it within 5 s of its end,
  decision buttons disabled during the stream with MC-30; after F5 the order and the single answer are the same (AC-20.2)

  **Evidence:**
  - Boot 1 (no sources), thread `c6130ca7…`, research `…i95nSB` launched from the proposal of L1-7 (a). Right after «Запустить» a request for a ~1500-word essay was sent (`POST /api/chat/assistant` 19:31:36 local). The controller finished `17:31:46.44` UTC — during the stream. The log line `research launch moved … state=answer_pending` at 19:31:46, then nothing until the chat run ended; `research answer written` at 19:32:02.
  - In the page: `streaming=false` at `17:32:02.193`, `GET /research` → `completed` with `answerMessageId` at `17:32:02.442`, the answer in the feed at `17:32:02.490` — **0.30 s after the end of the stream**, as a separate message after the essay. The answer count stayed 0 for the whole stream (no insertion mid-stream). Server held the answer 15.7 s behind the stream.
  - F5: question → card «Ресерч завершён» (MC-31, «К ответу») → reply → essay question → essay → one «Ответ ресерча» (one `[aria-label="К запросу ресерча"]` in the DOM). Same order, one answer (AC-20.2).
  - **Not observed:** «decision buttons disabled during the stream with MC-30» — the card was «Идёт» (only «Остановить») and its state during the essay stream was not inspected. The rule is covered by INT-4 R3 («buttons are disabled with MC-30 while a reply streams»).

---

## L1-5 — Second tab

**Backs:** UC-3, AC-19.7, DC-1, DC-7

- [x] L1-5 second tab (UC-3, AC-19.7, DC-1, DC-7): a proposal card open in two tabs; «Запустить» in the first, then «Запустить» and «Не нужно» in the second -> one research, the second card «Идёт» with no error line, no new message in either feed, also after a reload

  **Evidence:**
  - Boot 2, thread `c6130ca7…`, proposal `…dV94Gn` (budget 150 000) open in two tabs. «Запустить» in tab 1; then «Запустить» on the still-open proposal in tab 2 → tab 2's card became «Ресерч идёт» with «Остановить», no error line (`[role=alert]` empty), feed roots 9 → 9.
  - **Deviation:** after its «Запустить» tab 2 no longer offers «Не нужно» (the card turned «Идёт»), so the click could not be made. The same decision was sent as the hidden turn the button sends (`POST /api/chat/assistant`, `metadata.researchDecision = {action: decline, launchKey: …dV94Gn}`): HTTP 200, no `error` chunk, the launch stayed `running`.
  - One investigation for the launch (`research_engine_runs` by `launch_key` — 1), sources mode. Stored messages: the three decision turns are hidden pairs (`user` with `researchDecision` + `assistant` with `researchDecisionReply`), none of them is drawn; after reloads the feed has no new message in either tab.

---

## L1-6 — Keyboard and screen reader

**Backs:** UC-N3, NFR-05
**Preconditions:** **[screen reader — user]** NVDA or VoiceOver; the second half needs the answer of L1-7 (d).

- [ ] L1-6 keyboard and screen reader (UC-N3, NFR-05): card buttons reached with Tab, «Остановить» confirmed in the dialog (focus trapped and returned), state changes announced once, order and announcements as in the UXRD Accessibility table (NVDA or VoiceOver);
  in the answer of L1-7 the screen reader reads MC-33 as text right after each claim, and MC-31 and MC-32 are read in place as ordinary text, not announced as alerts

  **Evidence:**
  - **Keyboard half — passed (agent).** Mode research (budget 60 000) in a sources thread: from the composer Shift+Tab reaches the card's «Остановить» (text button, not the composer's stop). Enter → the confirmation in the card (UXRD KD-3, MC-9 «Остановить ресерч? Ответа не будет, потраченный бюджет не вернётся.», buttons «Остановить» / «Продолжить»), focus on «Продолжить». Esc → confirmation closed, focus back on «Остановить». Enter, Shift+Tab to the red «Остановить», Enter → card «Ресерч остановлен», focus on the card container; the polite region changed once: «Ресерч остановлен». Cost of the stopped run $0.035.
  - The confirmation is inline in the card, as UXRD (Accessibility: «"Продолжить" в подтверждении; "Продолжить" и Esc возвращают на "Остановить"»), not a modal dialog — the wording «dialog (focus trapped)» of this observation is older than the UXRD.
  - **Fact vs expectation (minor):** in an earlier attempt the research (budget 20 000) settled while the confirmation was open; the card became «Ресерч завершён», and Esc left focus on `BODY` instead of the card.
  - Announcements seen in the polite region (text, not as heard): MC-17 «Ресерч запущен. Источники данных не подключены — ответ будет из знаний модели.» (no-source variant), MC-18 «Ресерч завершён. Ответ из знаний модели добавлен в конец беседы.» / «Ресерч завершён. Ответ добавлен в конец беседы.», «Ресерч остановлен».
  - **Screen-reader half — not executed, pending the user** (no NVDA/VoiceOver available to the agent): reading order and announcements per the UXRD Accessibility table; MC-33 read right after each claim, MC-31 and MC-32 read in place, not as alerts — in the answer of L1-7 (d), thread `5f999272…`.

---

## L1-7 — Deployment without sources

**Backs:** UC-12, UC-13, UC-E8, AC-26.1, AC-26.2, AC-26.3, AC-27.1, AC-27.2, AC-27.3, AC-27.4, DC-8, DC-9
**Preconditions:** `apps/api` started without the `@agent-os/mcp-fixture` package (How to execute, item 5).

L1-7 deployment without sources (UC-12, UC-13, AC-26.1, AC-26.2, AC-26.3, AC-27.1, AC-27.2, AC-27.3, AC-27.4, DC-8, DC-9), in this order:

- [x] (a) boot without the fixture package: the process starts without an error, the startup log has the warning that the sources are not connected and the research will run on model knowledge (AC-26.2), the chat accepts a plain message (AC-26.1);
      a question where the agent proposes research -> the proposal card shows MC-31 under the budget before any button is pressed (AC-27.1); after «Запустить» the card keeps MC-31 in «Запуск» and «Идёт»

  **Evidence:**
  - Startup log (boot 1, 19:30:43): `WARN [Sources] @agent-os/mcp-fixture is not installed: no sources are connected package=@agent-os/mcp-fixture`; `WARN [ResearchEngine] no data source is connected: investigations will run on model knowledge, without evidence (sourceMode model_knowledge)`; `LOG [ResearchEngine] Research engine handlers registered (…), sourceMode model_knowledge`; `Runtime workers started concurrency=4`; `Nest application successfully started`. No error.
  - A plain question about 5xx of payment-api was answered (AC-26.1); the reply carries the proposal card «Ждёт подтверждения / Запустить глубокий ресерч?», «Бюджет до 3 000 000 токенов», under it «⚠ Источники данных не подключены — ответ будет из знаний модели.» (MC-31) before any press (AC-27.1). After «Запустить»: «Запускаем…» with MC-31, then «Ресерч идёт» with MC-31 and «Остановить».

- [x] (b) a second thread, mode message -> the card «Идёт» shows MC-31 from its first display and the announcement is the no-source variant of MC-17 (AC-27.2); a proposal is left open in the first thread, and this research is left running

  **Evidence:**
  - Thread `5f999272…`, mode message (budget 60 000): the first display of the card is «Ресерч идёт» with MC-31; polite region «Ресерч запущен. Источники данных не подключены — ответ будет из знаний модели.» (MC-17, no-source variant) (AC-27.2).
  - In thread `c6130ca7…` a new log question left the proposal `…exzYGC` open; a further question with «Бюджет ресерча — 150000 токенов» superseded it (card «Не запущен», DC-2) and left the proposal `…dV94Gn` open. The research of (b) was left running: `apps/api` was stopped while its `plan` call was reserved.

- [x] (c) restart apps/api with the package installed: the startup log has no such warning (AC-26.3); reload the first thread -> the open proposal no longer shows MC-31, the running research still does (UC-13, DC-8); confirm the proposal -> that research runs without MC-31

  **Evidence:**
  - Boot 2 (19:35:58): `Research engine handlers registered (…), sourceMode sources`, workers started, application started; `no data source is connected` — 0 lines in the log (AC-26.3).
  - Thread `c6130ca7…` after reload: proposal `…dV94Gn` without MC-31. Thread `5f999272…` after reload: the research of (b) still «Ресерч идёт» **with** MC-31 (DC-8); the runtime recovered its task after the restart and it finished on model knowledge.
  - «Запустить» on `…dV94Gn` (L1-5): card «Ресерч идёт» without MC-31; launch `source_mode = sources`.

- [x] (d) the running research of (b) ends -> within 5 s the answer opens with MC-32, every claim ends with MC-33, no footnotes, no «не проверено» label and no source list, the announcement is the no-source variant of MC-18 and the card is «Завершён» with MC-31;
      after F5 the same; «Копировать» puts MC-32 and the marks into the clipboard (AC-27.3, DC-9); a following plain question to the agent is answered without treating those claims as checked

  **Evidence:**
  - Research `…ieTsSL` finished `17:36:48.754` UTC, answer written `17:36:49.757` (1.0 s, server). No tab had the thread open at that moment, so the time in a feed and the announcement were not observed for this run; the no-source MC-18 text was seen for L1-7 (f) (`Ресерч завершён. Ответ из знаний модели добавлен в конец беседы.`), and the 5 s window is measured in L1-3 and L1-4.
  - Opened after the end and again after F5 (same both times): «Ответ ресерча · Есть ответ», goal line, MC-32 box «Источники данных не подключены — ответ опирается только на знания модели и не проверен по данным.», the summary with MC-34 «Краткий пересказ — основания в утверждениях ниже», «Предположения» with 10 claims, each followed by the mark «из знаний модели, без источника» (MC-33); no footnotes, no «не проверено» label, no «Источники» list. Card «Ресерч завершён» with MC-31 and «К ответу».
  - Copy: the stored text part of the answer (what «Копировать» copies) starts with MC-32, has 10 MC-33 marks for 10 claims and MC-34. **The clipboard itself was not verified:** after clicking «Копировать» `navigator.clipboard.readText()` in the page returned an empty string to the agent — pending the user (paste after «Копировать»).
  - Follow-up plain question «Какие из причин в ответе ресерча подтверждены данными наших логов?» → the agent: none is confirmed by the logs, the research ran without connected sources, all points are general knowledge.

- [x] (e) the research confirmed in (c) ends -> an answer with footnotes and a source list and none of MC-31, MC-32, MC-33 (AC-27.4)

  **Evidence:**
  - Research `…dV94Gn` (sources, budget 150 000) ended `budget_exhausted` after 18 model calls ($0.217): «Частичный ответ», «Остановлен: исчерпан бюджет», 4 established claims, each with footnotes, «Источники (7)» — `fixture` `aggregate_logs` / `search_logs` with snapshots `fx-v1-…`. None of MC-31, MC-32, MC-33 on the card or in the answer.

- [x] (f) run during the boot of (a), before the restart of (c): a research with a token budget too small for the synthesis (UC-E8) -> the answer «Вывода нет» opens with MC-32, shows the stop reason MC-25 and no claims, and the card is «Завершён»

  **Evidence:**
  - Boot 1, mode message with «Бюджет — 12000 токенов» (card «до 12 000 токенов», MC-31): only `plan` ran ($0.014), then `budget_exhausted`. Controller end `17:34:39.794`, answer written `17:34:40.79`. Answer: «Ответ ресерча · Вывода нет», MC-32 box, «Остановлен: исчерпан бюджет» (MC-25), no claims, no summary; card «Ресерч завершён» with MC-31 and «К ответу». Polite region: «Ресерч завершён. Ответ из знаний модели добавлен в конец беседы.»
  - Related observation: the no-source research of L1-4 (`…i95nSB`, budget 3 000 000) asked a question about specific logs; its synthesis returned no claims and only a summary (144 output tokens), so the answer is «Вывода нет» without a stop reason and without the summary (DC-10 drops it). This is consistent with the design for an answer without claims.

---

## Model switch in a thread (KD-9, Risks) — real models

**Backs:** design-chat-entry.md KD-9, Risks «Провайдер не принимает ход одной модели после ходов другой».

- [x] (a) an ordinary Opus 5.5 turn with reasoning right after a decision pair is accepted and answers; (b) a Haiku 5.5 decision turn and a mode turn after Opus 5.5 turns with reasoning are accepted

  **Evidence:**
  - Separate start of the built `apps/api` with `ASSISTANT_MODEL=anthropic/claude-opus-5-5` (process env over `.env`; `TITLE_MODEL=anthropic/claude-haiku-5-5`), `RUNTIME_WORKERS=off` (no investigation ran). One thread, turns sent over HTTP (`POST /api/chat/assistant`, only the new message; the history comes from Mastra memory, as for the web).

    | Turn | Model (by KD-9) | Result |
    |---|---|---|
    | T1 plain question about 5xx | Opus 5.5 | 200, reasoning parts present, `deepResearch` proposal + text, no `error` chunk |
    | T2 decision «Не нужно» on that proposal | Haiku 5.5, after an Opus turn with reasoning | 200, one `deepResearch` call, no text, launch → `not_launched` |
    | T3 plain question | Opus 5.5, right after the decision pair | 200, reasoning + text, no `error` chunk |
    | T4 mode message | Haiku 5.5, after Opus turns with reasoning | 200, one forced `deepResearch` call, launch `explicit` `running` |
    | T5 decision «Остановить» | Haiku 5.5 | 200, launch → `stopped` |
    | T6 plain question | Opus 5.5, right after the decision pair | 200, reasoning + text, no `error` chunk |

  - No provider rejection in either sequence. `usage` lines of the three Opus turns: input 1964 / 1983 / 3559 (mostly cache read and write), output 505 / 737 / 121 — about $0.046; Haiku turns below $0.001. The thread was deleted afterwards.

---

## Extra checks (T7.3)

- **Resent turn is not two bubbles (task-19 review residual).** Not reachable with the current tools: the chat agent has one tool, `deepResearch`, and `shouldResendTurn` never resends a turn that ended with it, so `sendAutomaticallyWhen` did not fire once in the run (no second `POST /api/chat` after any turn in the `fetch` probe). Checked instead: a multi-step turn (reasoning → `deepResearch` → reasoning → text) renders as one assistant root with one card and one «Копировать» (thread `c6130ca7…`: roots `user, assistant(card), user, assistant, assistant(answer), user, assistant(card), user, assistant(card), assistant(answer)`); hidden decision pairs are not drawn. The resend case stays with the INT guard in `shell.open-thread.int.test.tsx` until a second tool exists.
- **Visual check, light and dark.** Card, answer, MC-31/MC-32 boxes, MC-33 marks and MC-34 read well in both themes; measured contrast in dark: MC-32 text 11.2:1, MC-33 and MC-34 (12 px) 8.3:1. Notes (not defects of the part's UI): the goal the chat agent writes is often in English for a Russian question, and the answer of a sources run follows the goal's language (claims of `…dV94Gn` are in English); the chat agent's replies and one claim of the no-source answer mention the internal value `model_knowledge`; the 3 000 000-token default budget is proposed when the user names none.

## Sign-off

| Scenario | Result (pass / fail / not executed + reason) | Executed by | Date |
|----------|-----------------------------------------------|-------------|------|
| L1-1 | pass | agent (T7.3) | 2026-11-05 |
| L1-2 | pass | agent (T7.3) | 2026-11-05 |
| L1-3 | pass (foreground tab 2.6 s); open fact vs expectation: 14.5 s in a hidden tab — needs a user decision | agent (T7.3) | 2026-11-05 |
| L1-4 | pass, except «buttons disabled with MC-30 during the stream» — not observed (INT-4 R3 covers it) | agent (T7.3) | 2026-11-05 |
| L1-5 | pass; «Не нужно» in the second tab sent as the hidden turn over HTTP — the button is gone once the card turns «Идёт» | agent (T7.3) | 2026-11-05 |
| L1-6 | keyboard half pass; **screen-reader half not executed — pending the user** (NVDA or VoiceOver) | agent (T7.3); user — pending | 2026-11-05 |
| L1-7 | pass (a)–(f); the clipboard after «Копировать» in (d) not readable by the agent — pending the user | agent (T7.3) | 2026-11-05 |
| NFR-01 (seconds, L1-3 and L1-4) | pass: idle composer 2.6 s from the controller's end; after a streaming reply 0.30 s from the end of the stream | agent (T7.3) | 2026-11-05 |
| NFR-02 (time to the first token, L1-1) | pass: median mode 557 ms vs plain 1624 ms (5 + 5 runs) | agent (T7.3) | 2026-11-05 |
| Model switch (KD-9) | pass: both sequences accepted by the provider | agent (T7.3) | 2026-11-05 |
| User sign-off (L1-6 screen reader, L1-7 (d) clipboard, L1-3 hidden-tab decision) | | | |
