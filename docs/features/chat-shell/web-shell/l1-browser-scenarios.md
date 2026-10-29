# L1 browser scenarios — `chat-shell` / `web-shell`

| Field | Value |
|-------|-------|
| Source | [`design-web-shell.md`](../design-web-shell.md) v1.2, Test Strategy → «L1-сценарии (реальный браузер, Claude-in-Chrome)»; Early Verification Point (S-1…S-11) |
| PRD / UXRD | [`prd.md`](../prd.md) v1.2 (FR-01…FR-12, FR-19…FR-22), [`uxrd.md`](../uxrd.md) v1.3 |
| Type | E2E-level acceptance, executed manually by an agent through the Claude-in-Chrome extension. **Not** an automated runner (no Playwright) |
| When | Final phase, after all web-shell tasks are complete and every unit/component/integration test passes |
| Generated | 2026-10-28 (skeleton: every check is unticked; fill in Evidence while executing) |

## How to execute

**Environment (design, L1 section):**

1. `pnpm db:up`
2. `apps/api` running on `http://localhost:4000` (dev mode, `dev-user`, real model)
3. `pnpm --filter web build && pnpm --filter web start` (production build: FOUC and LCP checks are only valid there). L1-8 additionally uses `pnpm --filter web dev` for the console check
4. Chrome tab with DevTools open (Console, Network)

**Tool mapping (Claude-in-Chrome):** `navigate` (open URLs, F5 = navigate to the same URL), `computer` (click, type, keys, screenshots), `find` / `read_page` (accessibility tree: roles, names, `aria-*`), `javascript_tool` (`getBoundingClientRect`, `getComputedStyle`, `document.activeElement`, `location`, `history.length`, `document.title`), `read_network_requests` (request order, bodies, status, `canceled`), `read_console_messages`, `resize_window` (viewport widths), `gif_creator` (L1-6 recording).

**Steps the extension cannot drive** — DevTools-only features: CPU throttling ×4 + Performance frame screenshots (L1-8), `prefers-color-scheme` / `prefers-reduced-motion` emulation (L1-8, L1-9), touch device emulation and swipe (L1-3), Network request blocking (L1-3). Mark these **[DevTools — user]**: the agent stops and asks the user to toggle the setting, or records the check as *not executed* with the reason. A check that was not run is never reported as passed.

**Evidence per scenario:** screenshot(s), console entries, key Network requests (method, URL, status, request body where stated). Paste them under each scenario's **Evidence** line.

**Verdict rule:** a scenario passes only when every expected observation is ticked. Any failed observation → record actual vs expected and stop the final-phase sign-off for the AC it backs.

## Coverage map

| Scenario | ACs (design EARS) | Only acceptance (no automated test) for |
|----------|-------------------|------------------------------------|
| L1-1 | AC-01.2, AC-03.1, AC-03.3, AC-04.1, AC-07.1, AC-08.1, AC-08.2, AC-11.1, AC-11.2, AC-11.4, AC-20.1, AC-21.1 | AC-08.1, AC-11.2, AC-11.4, AC-21.1 |
| L1-2 | AC-05.1, AC-05.2, AC-05.3, AC-05.4 (S-6), AC-06.2, AC-06.3 | — |
| L1-3 | AC-01.5, AC-03.1, AC-10.1…AC-10.4 | AC-10.1…AC-10.4 |
| L1-4 | AC-02.1, AC-02.3, AC-02.4, AC-08.3, markdown policy (Security) | AC-02.3, AC-02.4, AC-08.3 |
| L1-5 | AC-04.2, AC-04.4 (S-2, S-7) | AC-04.2, AC-04.4 |
| L1-6 | AC-02.6, AC-03.4, AC-08.4 (S-1) | **AC-02.6, AC-03.4** (intentionally no autotest — design «Integration Tests»), AC-08.4 |
| L1-7 | AC-04.3, AC-06.4, E-8 | AC-06.4 |
| L1-8 | AC-09.1…AC-09.3, UXRD 7.6 contrast, UXQ-3 font | AC-09.2, AC-09.3 |
| L1-9 | AC-22.1, AC-22.2, UXRD 7.3 / reduced motion | — |

---

## L1-1 — Desktop 1440 px, sidebar expanded, new chat

**Backs:** AC-08.1, AC-11.1, AC-08.2, AC-04.1, AC-03.3, AC-01.2, AC-20.1, AC-11.2, AC-11.4, AC-07.1, AC-21.1 (S-2, S-4, S-10)
**Preconditions:** light theme; at least one existing thread; window 1440 px wide.

Steps:

1. `resize_window` 1440 px; `navigate` `http://localhost:3000/`.
2. Measure the message column and composer: `getBoundingClientRect()` of the feed column.
3. Click suggestion №1 on the welcome screen.
4. Wait for the reply to finish; then wait up to 15 s more.
5. Click header button «Рабочая область» (HD-04).
6. `resize_window` 1280 px; drag the separator «Изменить ширину рабочей области» to both extremes.
7. `resize_window` 1000 px, then back to 1440 px.
8. Press `Ctrl+B`.
9. F5 (reload the same URL).

Expected observations:

- [ ] Step 2: column width = 768 px, horizontally centered in the free area (`left` margin = `right` margin ± 1 px); no `complementary` «Рабочая область» in the tree (AC-08.1, AC-11.1)
- [ ] Welcome shows «Чем могу помочь?», a subtitle and exactly 4 suggestions in a 2×2 grid (AC-08.2)
- [ ] Step 3, Network: `POST /api/threads` (201) **before** `POST /api/chat/assistant`; chat request body `id` equals the `id` from the `POST /api/threads` response; **no** document request and no RSC refetch of the layout (AC-04.1)
- [ ] Address bar shows `/chat/<id>` with that same id (AC-04.1)
- [ ] Sidebar group «Сегодня» lists the new thread first as «Новая беседа» with shimmer, link has `aria-current="page"` (AC-03.3, AC-01.2)
- [ ] Within 15 s after the reply ends the generated title replaces «Новая беседа» in the sidebar, the header `h1` and the tab title «{Название} — Agent OS»; Network shows `GET /api/threads/<id>` about once per second and **no** `PATCH` (AC-20.1, S-4)
- [ ] Step 5: panel opens at 40 % of the main area; HD-04 has `aria-expanded="true"` (AC-11.2)
- [ ] Step 6 at 1280 px: panel never narrower than 360 px; feed never narrower than 480 px (AC-11.2)
- [ ] Step 7: at 1000 px neither HD-04 nor the panel exists; back at 1440 px the panel is open again (AC-11.4)
- [ ] Step 8: sidebar collapses to a 48 px strip; «Боковая панель» has `aria-expanded="false"` (AC-07.1, AC-22.1)
- [ ] Step 9: the first painted frame already shows the 48 px strip, no expand animation (AC-21.1)
- [ ] Console: no errors

Evidence: _screenshots, Network rows (POST /api/threads → POST /api/chat/assistant with bodies), measured widths_

---

## L1-2 — Rename and delete

**Backs:** AC-05.1, AC-05.2, AC-05.3, AC-05.4 (S-6), AC-06.2, AC-06.3
**Preconditions:** at least 3 threads; one of them open.

Steps:

1. On the open thread's row: «⋯» («Действия с беседой «{название}»») → «Переименовать» → type «Отчёт Q3» → Enter.
2. Again «⋯» → «Переименовать» → type «Черновик» → Esc.
3. Again «⋯» → «Переименовать» → clear the field (spaces only) → Enter.
4. F5.
5. Delete a thread that is **not** open: «⋯» → «Удалить» → «Удалить».
6. Delete the **open** thread: «⋯» → «Удалить» → «Удалить»; then press browser Back.
7. (S-6, optional) with a temporary API error on `PATCH` (ask the user to enable it) rename to «Ошибка» → Enter.

Expected observations:

- [ ] Step 1: «Отчёт Q3» in the sidebar, the header `h1` and the tab «Отчёт Q3 — Agent OS», without reload; Network `PATCH /api/threads/<id>` body `{"title":"Отчёт Q3"}` (AC-05.1)
- [ ] Step 2: title stays «Отчёт Q3»; no `PATCH` request (AC-05.2)
- [ ] Step 3: field stays open, `aria-invalid="true"`, text «Введите название»; no `PATCH` request (AC-05.3)
- [ ] Step 4: «Отчёт Q3» persists after reload (AC-05.1)
- [ ] Delete dialog: role `alertdialog`, title «Удалить беседу?», the thread name in «ёлочках», focus on «Отмена» (AC-06.1)
- [ ] Step 5: row gone; URL unchanged; focus on the next thread link in the list; toast «Беседа удалена» (AC-06.3)
- [ ] Step 6: row gone; URL `/`; welcome «Чем могу помочь?»; focus in the composer (fine pointer); Back does **not** return to the deleted thread (AC-06.2)
- [ ] Step 7 (if executed): title reverts to the previous one; toast «Не удалось переименовать беседу. Попробуйте ещё раз.» (AC-05.4)

Evidence: _…_

---

## L1-3 — Mobile 375 px (touch device emulation)

**Backs:** AC-10.1, AC-10.2, AC-10.3, AC-10.4, AC-03.1 (coarse pointer), AC-01.5 (alert role) (S-11)
**Preconditions:** **[DevTools — user]** device emulation with touch, 375 px wide; a thread containing a code block with a 120-character line.

Steps:

1. `navigate` `/chat/<id>`.
2. Tap «Меню».
3. Choose another thread in the drawer.
4. «Меню» → Esc.
5. «Меню» → swipe left on the drawer **[DevTools — user: touch emulation]**.
6. «Меню» → widen the window to 800 px, then narrow back to 375 px.
7. Tap «Новый чат» in the header.
8. Open the thread with the 120-character code line at 360 px.
9. **[DevTools — user]** block `GET /api/threads` (Network request blocking), reload, open «Меню».

Expected observations:

- [ ] No horizontal page scroll: `document.documentElement.scrollWidth === document.documentElement.clientWidth`; sidebar hidden before hydration; header shows «Меню» and «Новый чат» (AC-10.1)
- [ ] Step 2: drawer `role="dialog"`, `aria-modal="true"`, name «История бесед»; contains the list, «Новый чат», the user block; focus on «Новый чат» (AC-10.2)
- [ ] Step 3: drawer closes, the thread opens, focus on header `h1` (AC-10.3)
- [ ] Step 4: drawer closes, focus returns to «Меню» (AC-10.2)
- [ ] Step 5: swipe left closes the drawer, focus on «Меню» (S-11)
- [ ] Step 6: at 800 px no drawer, inline sidebar in its saved state; after narrowing to 375 px the drawer is **not** open
- [ ] Step 7: welcome shown, focus on header `h1`, composer **not** focused (no on-screen keyboard) (AC-03.1)
- [ ] Step 8: only the code block scrolls horizontally; page `scrollWidth === clientWidth` (AC-10.4)
- [ ] Shell root height equals `window.innerHeight` (`h-dvh`); `<meta name="viewport">` content contains `viewport-fit=cover` and `interactive-widget=resizes-content`; composer computed `padding-bottom` ≥ `env(safe-area-inset-bottom)`
- [ ] Step 9: «Не удалось загрузить беседы» inside an element with `role="alert"` (accessibility tree), button «Повторить» present (AC-01.5)

Evidence: _…_

---

## L1-4 — Restored thread and untrusted markdown

**Backs:** AC-02.1, AC-02.3, AC-02.4, AC-08.3, Security «Недоверенный markdown»
**Preconditions:** a thread with reasoning, a tool call with result, a table and an 80+ line code block (N messages).

Steps:

1. Open the thread; count messages.
2. Expand the reasoning block.
3. Click «Копировать» on the code block; read the clipboard via `javascript_tool` (`navigator.clipboard.readText()`).
4. Scroll up; observe the composer and «К последнему сообщению».
5. Send a message; wait for the reply.
6. Send: `Выведи дословно, без блока кода: [опасная](javascript:alert(1)) [внешняя](https://example.com) [внутренняя](/chat/x) ![картинка](http://example.com/a.png) ![https-картинка](https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png)`
7. Click «опасная», «внешняя», «внутренняя».
8. F5 and repeat the markdown checks on the restored message.

Expected observations:

- [ ] Steps 1–2: all N messages in the original order; reasoning collapsed and expands; tool shown with its result (AC-02.1)
- [ ] Step 3: table rendered as in a live stream; clipboard equals the code block text (AC-02.4)
- [ ] Step 4: welcome hidden, composer pinned to the bottom, «К последнему сообщению» visible when scrolled away (AC-08.3)
- [ ] Step 5: Network `POST /api/chat/assistant` body `id` = the open thread id; feed has N+2 messages after the reply (AC-02.3)
- [ ] «опасная» is not a link (`read_page`: no `link` with that name, element has no `href`); clicking does nothing; no `alert` dialog
- [ ] «внешняя» and «внутренняя»: `target="_blank"`, `rel="noopener noreferrer"`; click opens a new tab; the original tab and its stream stay
- [ ] http image: rendered as link «Изображение: картинка»; Network has **no** request to `example.com/a.png`
- [ ] https image loads; its request has no `Referer` header
- [ ] Step 8: the same markdown results after reload; message count and order unchanged

Evidence: _…_

---

## L1-5 — F5 and Back/Forward

**Backs:** AC-04.2, AC-04.4 (S-2, S-7)
**Preconditions:** threads A, B, C in the first page.

Steps:

1. Click A, then B, then C in the sidebar.
2. F5 on C.
3. Browser Back ×2.
4. Browser Forward ×1.

Expected observations:

- [ ] Step 2: C with the same messages; its link has `aria-current="page"` (AC-04.2)
- [ ] Step 3: first Back → B, second Back → A; URL, highlighted link, header `h1` and tab title change together (AC-04.4)
- [ ] Step 4: Forward → B, all in sync (AC-04.4)
- [ ] `document.title` matches the open thread after every step (S-7)

Evidence: _…_

---

## L1-6 — Streaming while switching (background streaming)

**Backs:** **AC-02.6, AC-03.4** (only acceptance for these; spike S-1), AC-08.4
**Preconditions:** threads X and Y exist; production build; `gif_creator` recording on.

Steps:

1. Open X; send a long request (e.g. «Напиши подробный план на 1500 слов»).
2. While the reply streams, click Y in the sidebar.
3. While X is still streaming, click «Новый чат».
4. Return to X before the stream finishes.
5. Return to X again after it finished (or wait and reopen).
6. F5 on X.

Expected observations:

- [ ] Step 1: «Остановить» shown instead of «Отправить» while streaming (AC-08.4)
- [ ] Network: the `POST /api/chat/assistant` of X is **not** `canceled` (pending, then 200) through steps 2–4 (AC-02.6)
- [ ] Step 2: Y shows only Y's messages; no fragment of X's reply (AC-02.6)
- [ ] Step 3: `/` with «Чем могу помочь?»; no fragment of X's reply; X's stream continues (AC-03.4)
- [ ] Step 4: X shows the continuing stream with «Остановить», or the complete reply (AC-02.6)
- [ ] Step 6: X's reply is persisted after reload
- [ ] If any of the above fails → **stop and escalate to the user** (design Early Verification Point: background streaming would require variant B — a design change)

Evidence: _GIF, Network row of X's chat request with final status_

---

## L1-7 — Deleted and non-existent thread

**Backs:** AC-04.3, AC-06.4, E-8
**Preconditions:** a disposable thread D; two tabs.

Steps:

1. Copy D's URL; delete D; `navigate` to the copied URL.
2. `navigate` `/chat/does-not-exist`.
3. Open thread E in tab 1; in tab 2 delete E; in tab 1 send «Ещё вопрос».

Expected observations:

- [ ] Steps 1–2: h1 «Беседа не найдена», text «Возможно, её удалили или ссылка указана неверно.», button «Новый чат»; `document.activeElement` is that `h1`; tab title «Беседа не найдена — Agent OS» (AC-04.3, AC-06.4)
- [ ] Step 3: the composer is replaced by «Беседа удалена» / «Её удалили в другой вкладке или окне.» / «Новый чат»; «Ещё вопрос» remains visible in the feed; no English server text (E-8)

Evidence: _…_

---

## L1-8 — Dark theme, FOUC, font, contrast

**Backs:** AC-09.1, AC-09.2, AC-09.3, UXRD 7.6, UXQ-3
**Preconditions:** production build; a thread open so the active SB-06 row exists.

Steps:

1. User menu («Меню пользователя dev-user») → «Тёмная».
2. **[DevTools — user]** Performance with CPU ×4 and screenshots; F5.
3. «Системная» + **[DevTools — user]** emulate `prefers-color-scheme: dark`, then `light`.
4. `javascript_tool`: `getComputedStyle(document.body).fontFamily`; `document.fonts.check('14px Geist', 'Жё')`.
5. `javascript_tool`: computed `color` / `background-color` (or outline color) of the focus ring, the «Удалить» button in DLG-01, the active SB-06 link text on `--sidebar-accent`, and a hovered row — in both themes; compute contrast ratios.
6. Run `pnpm --filter web dev`, F5, read console.

Expected observations:

- [ ] Step 1: dark tokens applied to the whole UI without reload (AC-09.1)
- [ ] Step 2: no light-theme frame in the recorded frames (AC-09.2)
- [ ] Step 3: UI follows the emulated OS theme both ways (AC-09.3)
- [ ] Step 4: font family resolves to Geist; `document.fonts.check` returns `true`
- [ ] Step 5: focus ring ≥ 3:1; «Удалить» ≥ 4.5:1; active/hovered SB-06 text on `--sidebar-accent` ≥ 4.5:1 — in both themes
- [ ] Step 6: no warnings about rendering `<script>` and no hydration warnings
- [ ] Menu shows «dev-user», «Режим разработки», group «Тема» (Светлая / Тёмная / Системная); no «Выйти», no «Настройки» (AC-09.4)

Evidence: _…_

---

## L1-9 — Keyboard only and reduced motion

**Backs:** AC-22.1, AC-22.2, UXRD 7.3, reduced motion
**Preconditions:** ≥ 2 date groups in the list; **[DevTools — user]** emulate `prefers-reduced-motion: reduce` for the last step.

Steps:

1. From the address bar press Tab: first stop is the skip link «Перейти к сообщению»; Enter.
2. Tab through: brand → «Новый чат» → thread links (link → its «⋯» → next link) → «Показать ещё беседы» → user block → «Боковая панель» → «Рабочая область» → feed → composer.
3. On a thread link press ↓ / ↑ across a group boundary, then Home / End; press Enter.
4. `Ctrl+Shift+O`; `Ctrl+B` (twice).
5. Open «⋯» with keyboard; navigate the menu; open the delete dialog; Esc.
6. Open the rename field and press `Ctrl+Shift+O` inside it; open a menu and press `Ctrl+Shift+O`.
7. Hover «Новый чат» and «Боковая панель» to see tooltips.
8. Enable reduced motion; toggle sidebar and workspace; look at a «Новая беседа» shimmer.

Expected observations:

- [ ] Step 1: skip link visible on focus and moves focus to the composer
- [ ] Step 2: Tab order matches UXRD 7.3; focus is always visible
- [ ] Step 3: ↓/↑ move to next/previous loaded thread across group headings; Home/End to first/last; Enter opens the thread and focus stays on the link (AC-22.2)
- [ ] Step 4: `Ctrl+Shift+O` opens a new chat at `/`; `Ctrl+B` toggles the sidebar (AC-22.1)
- [ ] Step 5: menu and dialog fully operable by keyboard; Esc closes and returns focus to «⋯»
- [ ] Step 6: shortcuts do **not** fire inside the rename field or with a menu open (AC-22.1)
- [ ] Step 7: tooltips show the shortcut with the platform symbol (Ctrl on Windows/Linux, ⌘ on macOS) (AC-22.1)
- [ ] Step 8: panels change without animation; shimmer is off

Evidence: _…_

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
| L1-8 | | | |
| L1-9 | | | |
