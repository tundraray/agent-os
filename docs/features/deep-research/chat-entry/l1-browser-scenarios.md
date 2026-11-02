# L1 browser scenarios — `deep-research` / `chat-entry`

| Field | Value |
|-------|-------|
| Source | [`design-chat-entry.md`](../design-chat-entry.md) v1.6, Test Strategy → «Main Use Cases» (UC-1, UC-3, UC-4, UC-12, UC-13, UC-E8) and «Non-Functional Use Cases» (UC-N1, UC-N2, UC-N3) |
| PRD / UXRD | [`prd.md`](../prd.md) v1.12 (FR-19, FR-20, FR-26, FR-27; NFR-01, NFR-02, NFR-05), [`uxrd.md`](../uxrd.md) v1.7 (DR-01…DR-03, MC-2, MC-3, MC-17, MC-18, MC-25, MC-30…MC-33, Accessibility) |
| Upstream | [`design-engine.md`](../design-engine.md) v1.14, implemented and committed; plan [`engine/20261101-feature-deep-research-engine.md`](../engine/20261101-feature-deep-research-engine.md) |
| Type | E2E-level acceptance (E2E-2 of the part), executed manually by an agent through the Claude-in-Chrome extension. **Not** an automated runner (the repo has no browser runner) |
| When | Phase 7, T7.3 of the plan [`20261102-feature-deep-research-chat-entry.md`](./20261102-feature-deep-research-chat-entry.md), after all chat-entry tasks are complete and every unit, integration and E2E-1 test passes |
| Generated | 2026-11-02 (T1.1: moved from the comment block «E2E-2 L1 browser scenario» at the end of `apps/api/test/deep-research-chat-entry.e2e-spec.ts`; observations copied verbatim) |
| Executed | — |

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

- [ ] L1-1 mode and first token (UC-1, UC-N2): DR-01 reached by Tab and toggled by Space (`aria-pressed` true, placeholder MC-2, send name MC-3); over 5 mode messages the time to the first token is not worse than over 5 plain ones, measured as chat-shell does;
  the DR-02 label sits over the sent message, the toggle is off again, the reply carries the card «Идёт» with goal and budget

  **Evidence:**

---

## L1-2 — Plain message while running

**Backs:** AC-19.6

- [ ] L1-2 plain message while running (AC-19.6): the agent answers as usual, no second research starts, focus stays in the composer

  **Evidence:**

---

## L1-3 — Answer timing, idle composer

**Backs:** UC-4, UC-N1, AC-20.1, AC-20.7, NFR-01

- [ ] L1-3 answer timing, idle composer (UC-4, UC-N1, AC-20.1, AC-20.7): the answer appears at the end of the feed without a reload within 5 s of the controller's end (Network: the GET /research that reports `completed`, and the time of the answer);
  the card is «Завершён» with «К ответу», focus did not move, MC-18 is announced once, every claim has a footnote that names a source in the list, «К запросу» scrolls to the DR-02 message

  **Evidence:**

---

## L1-4 — Answer timing, streaming reply

**Backs:** AC-20.3, AC-20.2, UC-N1, NFR-01

- [ ] L1-4 answer timing, streaming reply (AC-20.3, UC-N1): a long plain question sent right after the start so that a reply streams when the research ends -> no insertion during the stream, a separate message after it within 5 s of its end,
  decision buttons disabled during the stream with MC-30; after F5 the order and the single answer are the same (AC-20.2)

  **Evidence:**

---

## L1-5 — Second tab

**Backs:** UC-3, AC-19.7, DC-1, DC-7

- [ ] L1-5 second tab (UC-3, AC-19.7, DC-1, DC-7): a proposal card open in two tabs; «Запустить» in the first, then «Запустить» and «Не нужно» in the second -> one research, the second card «Идёт» with no error line, no new message in either feed, also after a reload

  **Evidence:**

---

## L1-6 — Keyboard and screen reader

**Backs:** UC-N3, NFR-05
**Preconditions:** **[screen reader — user]** NVDA or VoiceOver; the second half needs the answer of L1-7 (d).

- [ ] L1-6 keyboard and screen reader (UC-N3, NFR-05): card buttons reached with Tab, «Остановить» confirmed in the dialog (focus trapped and returned), state changes announced once, order and announcements as in the UXRD Accessibility table (NVDA or VoiceOver);
  in the answer of L1-7 the screen reader reads MC-33 as text right after each claim, and MC-31 and MC-32 are read in place as ordinary text, not announced as alerts

  **Evidence:**

---

## L1-7 — Deployment without sources

**Backs:** UC-12, UC-13, UC-E8, AC-26.1, AC-26.2, AC-26.3, AC-27.1, AC-27.2, AC-27.3, AC-27.4, DC-8, DC-9
**Preconditions:** `apps/api` started without the `@agent-os/mcp-fixture` package (How to execute, item 5).

L1-7 deployment without sources (UC-12, UC-13, AC-26.1, AC-26.2, AC-26.3, AC-27.1, AC-27.2, AC-27.3, AC-27.4, DC-8, DC-9), in this order:

- [ ] (a) boot without the fixture package: the process starts without an error, the startup log has the warning that the sources are not connected and the research will run on model knowledge (AC-26.2), the chat accepts a plain message (AC-26.1);
      a question where the agent proposes research -> the proposal card shows MC-31 under the budget before any button is pressed (AC-27.1); after «Запустить» the card keeps MC-31 in «Запуск» and «Идёт»

  **Evidence:**

- [ ] (b) a second thread, mode message -> the card «Идёт» shows MC-31 from its first display and the announcement is the no-source variant of MC-17 (AC-27.2); a proposal is left open in the first thread, and this research is left running

  **Evidence:**

- [ ] (c) restart apps/api with the package installed: the startup log has no such warning (AC-26.3); reload the first thread -> the open proposal no longer shows MC-31, the running research still does (UC-13, DC-8); confirm the proposal -> that research runs without MC-31

  **Evidence:**

- [ ] (d) the running research of (b) ends -> within 5 s the answer opens with MC-32, every claim ends with MC-33, no footnotes, no «не проверено» label and no source list, the announcement is the no-source variant of MC-18 and the card is «Завершён» with MC-31;
      after F5 the same; «Копировать» puts MC-32 and the marks into the clipboard (AC-27.3, DC-9); a following plain question to the agent is answered without treating those claims as checked

  **Evidence:**

- [ ] (e) the research confirmed in (c) ends -> an answer with footnotes and a source list and none of MC-31, MC-32, MC-33 (AC-27.4)

  **Evidence:**

- [ ] (f) run during the boot of (a), before the restart of (c): a research with a token budget too small for the synthesis (UC-E8) -> the answer «Вывода нет» opens with MC-32, shows the stop reason MC-25 and no claims, and the card is «Завершён»

  **Evidence:**

---

## Sign-off

| Scenario | Result (pass / fail / not executed + reason) | Executed by | Date |
|----------|-----------------------------------------------|-------------|------|
| L1-1 | | | |
| L1-2 | | | |
| L1-3 | | | |
| L1-4 | | | |
| L1-5 | | | |
| L1-6 | | | |
| L1-7 | | | |
| NFR-01 (seconds, L1-3 and L1-4) | | | |
| NFR-02 (time to the first token, L1-1) | | | |
