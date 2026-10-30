# L1 browser scenarios — `chat-shell` / `web-shell`

| Field | Value |
|-------|-------|
| Source | [`design-web-shell.md`](../design-web-shell.md) v1.5, Test Strategy → «L1-сценарии (реальный браузер, Claude-in-Chrome)» and «Performance Tests»; Early Verification Point (S-1…S-11) |
| PRD / UXRD | [`prd.md`](../prd.md) v1.5 (FR-01…FR-12, FR-19…FR-22; metrics № 7, № 10), [`uxrd.md`](../uxrd.md) v1.7 |
| Upstream | [`design-threads-api.md`](../design-threads-api.md) v1.9, implemented and committed; plan [`threads-api/20261028-feature-threads-api.md`](../threads-api/20261028-feature-threads-api.md), task T6.3 (deferred into the two «T6.3» checks below) |
| Type | E2E-level acceptance, executed manually by an agent through the Claude-in-Chrome extension. **Not** an automated runner (no Playwright) |
| When | Final phase, after all web-shell tasks are complete and every unit/component/integration test passes |
| Generated | 2026-10-30 (regenerated from design v1.5; every check is unticked; fill in Evidence while executing) |

## How to execute

**Environment (design, L1 section):**

1. `pnpm db:up` (on this machine with `POSTGRES_PORT=5433`, see the threads-api plan notes)
2. `apps/api` running on `http://localhost:4000` (dev mode, `dev-user`, real model, real provider keys in `apps/api/.env`)
3. `pnpm --filter web build && pnpm --filter web start` (production build: FOUC and LCP checks are only valid there). L1-8 additionally uses `pnpm --filter web dev` for the console check
4. Chrome tab with DevTools open (Console, Network)

**Seed data (needed because the stand's assistant has no tools — `assistant.agent.ts` has `tools: {}` — and no way to reproduce a failed tool):** a throwaway script (not committed, in the scratchpad) that writes format-2 messages through `Memory.saveThread` / `Memory.saveMessages` for resource `dev-user`, modeled on `apps/api/test/support/seed.ts` (which only emits text parts; the script adds the other part types):

| Thread | Content | Used by |
|--------|---------|---------|
| `SEED-RICH` | 12 messages; one reply with a reasoning part; one with a tool part `output-available` and a result; one with a table; one with an 80+ line code block | L1-4 |
| `SEED-TOOL-ERROR` | user message, then a reply with a tool part in state `output-error`, `errorText: 'boom'`; user message, then a reply that has **only** a tool part (no text); user message, then a reply that has **only** a reasoning part | L1-10 A (tool-only and reasoning-only replies) and C |

**Tool mapping (Claude-in-Chrome):** `navigate` (open URLs, F5 = navigate to the same URL), `computer` (click, type, keys including Tab / Enter / Space, screenshots), `find` / `read_page` (accessibility tree: roles, names, `aria-*`), `get_page_text`, `javascript_tool` (`getBoundingClientRect`, `getComputedStyle`, `document.activeElement`, `location`, `history.length`, `document.title`, `navigator.clipboard.readText()`, installing the fetch wrapper in L1-10), `read_network_requests` (request order, status, bodies where exposed), `read_console_messages`, `resize_window` (viewport widths), `gif_creator` (L1-6 recording).

**Steps the extension cannot drive** — DevTools-only features: CPU throttling ×4 + Performance frame screenshots (L1-8), `prefers-color-scheme` / `prefers-reduced-motion` emulation (L1-8, L1-9), touch device emulation, `pointer: coarse` and swipe (L1-3, L1-10), Network request blocking (L1-3), the Network «Offline» switch (fallback in L1-10), and request details the extension does not expose (`canceled` status in L1-6, the `Referer` header in L1-4). Mark these **[DevTools — user]**: the agent stops and asks the user to toggle the setting, or records the check as *not executed* with the reason. A check that was not run is never reported as passed.

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
| L1-7 | AC-04.3, AC-06.4, AC-08.5e (E-8) | AC-06.4 |
| L1-8 | AC-09.1…AC-09.3, UXRD 7.6 contrast, UXQ-3 font | AC-09.2, AC-09.3 |
| L1-9 | AC-22.1, AC-22.2, UXRD 7.3 / reduced motion | — |
| L1-10 | AC-08.5, AC-08.5a, AC-08.5b (return to the thread), AC-08.5c, AC-08.6, AC-14.5 (client), AC-14.6 (client side) | **AC-08.5b second sentence** (return to the thread in the same tab), AC-14.6 client side |
| T6.3-a | PRD metric № 10 (no regression of the first token) | metric № 10 |
| T6.3-b | PRD metric № 7, AC-17.1 / AC-20.1 on the real model | metric № 7 |

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

**Backs:** AC-05.1, AC-05.2, AC-05.3, AC-05.4 (S-6), AC-06.1, AC-06.2, AC-06.3
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
**Preconditions:** thread `SEED-RICH` (see Seed data): 12 messages with reasoning, a tool call with result, a table and an 80+ line code block.

Steps:

1. Open `SEED-RICH`; count messages (N = 12).
2. Expand the reasoning block.
3. Click «Копировать» on the code block; read the clipboard via `javascript_tool` (`navigator.clipboard.readText()`).
4. Scroll up; observe the composer and «К последнему сообщению».
5. Send a message; wait for the reply.
6. Send: `Выведи дословно, без блока кода: [опасная](javascript:alert(1)) [внешняя](https://example.com) [внутренняя](/chat/x) ![картинка](http://example.com/a.png) ![https-картинка](https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png)`
7. Click «опасная», «внешняя», «внутренняя».
8. F5 and repeat the markdown checks on the restored message.

Expected observations:

- [ ] Steps 1–2: all 12 messages in the original order; reasoning collapsed and expands; tool shown with its result (AC-02.1)
- [ ] Step 3: table rendered as in a live stream; clipboard equals the code block text (AC-02.4)
- [ ] Step 4: welcome hidden, composer pinned to the bottom, «К последнему сообщению» visible when scrolled away (AC-08.3)
- [ ] Step 5: Network `POST /api/chat/assistant` body `id` = the open thread id; feed has N+2 = 14 messages after the reply (AC-02.3)
- [ ] «опасная» is not a link (`read_page`: no `link` with that name, element has no `href`); clicking does nothing; no `alert` dialog
- [ ] «внешняя» and «внутренняя»: `target="_blank"`, `rel="noopener noreferrer"`; click opens a new tab; the original tab and its stream stay
- [ ] http image: rendered as link «Изображение: картинка»; Network has **no** request to `example.com/a.png`
- [ ] https image loads; its request has no `Referer` header (**[DevTools — user]** if the extension does not expose request headers)
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
- [ ] Network: the `POST /api/chat/assistant` of X is **not** `canceled` (pending, then 200) through steps 2–4 (AC-02.6); **[DevTools — user]** if the extension does not expose `canceled`
- [ ] Step 2: Y shows only Y's messages; no fragment of X's reply (AC-02.6)
- [ ] Step 3: `/` with «Чем могу помочь?»; no fragment of X's reply; X's stream continues (AC-03.4)
- [ ] Step 4: X shows the continuing stream with «Остановить», or the complete reply (AC-02.6)
- [ ] Step 6: X's reply is persisted after reload
- [ ] If any of the above fails → **stop and escalate to the user** (design Early Verification Point: background streaming would require variant B — a design change)

Evidence: _GIF, Network row of X's chat request with final status_

---

## L1-7 — Deleted and non-existent thread

**Backs:** AC-04.3, AC-06.4, AC-08.5e (E-8)
**Preconditions:** a disposable thread D; two tabs.

Steps:

1. Copy D's URL; delete D; `navigate` to the copied URL.
2. `navigate` `/chat/does-not-exist`.
3. Open thread E (with at least one exchange) in tab 1; in tab 2 delete E; in tab 1 send «Ещё вопрос».
4. In tab 1 click «Новый чат» inside the notice.

Expected observations:

- [ ] Steps 1–2: h1 «Беседа не найдена», text «Возможно, её удалили или ссылка указана неверно.», button «Новый чат»; `document.activeElement` is that `h1`; tab title «Беседа не найдена — Agent OS» (AC-04.3, AC-06.4)
- [ ] Step 3: the feed stays; «Ещё вопрос» stays visible; directly under it an inline notice «Беседа удалена» / «Её удалили в другой вкладке или окне.» with button «Новый чат» (`read_page`: the text is announced as `alert`, the button's description is the second line; **no** heading with that name); the composer (`textbox` «Сообщение») is **not** in the tree (AC-08.5e)
- [ ] Step 3: no «Перегенерировать», no «Не удалось получить ответ…», no English server text («Thread not found»); no empty assistant row and no «Копировать» under the notice; Network shows one `POST /api/chat/assistant` → 404 and **no** `POST /api/threads` (AC-08.5e)
- [ ] Step 4: `/` with «Чем могу помочь?» and the composer back (AC-08.5e, FR-03)

Evidence: _screenshot of the notice, Network rows_

---

## L1-8 — Dark theme, FOUC, font, contrast

**Backs:** AC-09.1, AC-09.2, AC-09.3, AC-09.4, UXRD 7.6, UXQ-3
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
**Preconditions:** ≥ 2 date groups in the list; a thread with at least two exchanges open; **[DevTools — user]** emulate `prefers-reduced-motion: reduce` for the last step.

Steps:

1. From the address bar press Tab: first stop is the skip link «Перейти к сообщению»; Enter.
2. Tab through: brand → «Новый чат» → thread links (link → its «⋯» → next link) → «Показать ещё беседы» → user block → «Боковая панель» → «Рабочая область» → feed (inside every user message «Копировать»; inside every reply the content, then «Перегенерировать» if the error block is present, then «Копировать») → composer.
3. On a thread link press ↓ / ↑ across a group boundary, then Home / End; press Enter.
4. `Ctrl+Shift+O`; `Ctrl+B` (twice).
5. Open «⋯» with keyboard; navigate the menu; open the delete dialog; Esc.
6. Open the rename field and press `Ctrl+Shift+O` inside it; open a menu and press `Ctrl+Shift+O`.
7. Hover «Новый чат» and «Боковая панель» to see tooltips.
8. Enable reduced motion; toggle sidebar and workspace; look at a «Новая беседа» shimmer.

Expected observations:

- [ ] Step 1: skip link visible on focus and moves focus to the composer
- [ ] Step 2: Tab order matches UXRD 7.3 (including «Копировать» of non-last messages); focus is always visible
- [ ] Step 3: ↓/↑ move to next/previous loaded thread across group headings; Home/End to first/last; Enter opens the thread and focus stays on the link (AC-22.2)
- [ ] Step 4: `Ctrl+Shift+O` opens a new chat at `/`; `Ctrl+B` toggles the sidebar (AC-22.1)
- [ ] Step 5: menu and dialog fully operable by keyboard; Esc closes and returns focus to «⋯»
- [ ] Step 6: shortcuts do **not** fire inside the rename field or with a menu open (AC-22.1)
- [ ] Step 7: tooltips show the shortcut with the platform symbol (Ctrl on Windows/Linux, ⌘ on macOS) (AC-22.1)
- [ ] Step 8: panels change without animation; shimmer is off

Evidence: _…_

---

## L1-10 — Message actions, error → regenerate → F5, tool error

**Backs:** AC-08.5, AC-08.5a, AC-08.5b (second sentence: return to the thread), AC-08.5c, AC-08.6, AC-14.5 (client side), AC-14.6 (client side: what the user sees after regeneration and F5)
**Preconditions:** thread M with at least 3 exchanges (real model); thread Y (any other); thread `SEED-TOOL-ERROR` (see Seed data); production build.

### Fetch wrapper (used by part B to produce a mid-stream failure)

Run in the page with `javascript_tool` right before sending; it cuts the chat stream after the first text chunk and cancels the real reader, so the server sees a client disconnect (the AC-14.6 «network drop» path):

```js
(() => {
  if (window.__origFetch) return 'already installed';
  window.__origFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const res = await window.__origFetch(input, init);
    if (!url.endsWith('/api/chat/assistant') || !res.body) return res;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let cut = false;
    const body = new ReadableStream({
      async pull(ctrl) {
        const { done, value } = await reader.read();
        if (done) return ctrl.close();
        ctrl.enqueue(value);
        if (!cut && dec.decode(value, { stream: true }).includes('"text-delta"')) {
          cut = true;
          setTimeout(() => { reader.cancel(); ctrl.error(new TypeError('network error')); }, 0);
        }
      },
    });
    return new Response(body, { status: res.status, headers: res.headers });
  };
  return 'installed';
})()
```

Restore with `window.fetch = window.__origFetch; delete window.__origFetch;`. If the chat request does not go through the wrapper (Network shows it, but the stream is not cut), fall back to **[DevTools — user]**: Network → Offline switched on while the reply streams. Record which method was used.

### Part A — action bar (AC-08.6)

Steps:

1. In M, walk the feed with Tab only (no mouse movement; record `document.activeElement`'s accessible name and its message after every Tab).
2. Move the mouse over a non-last user message and a non-last reply; then away.
3. Send a long request (e.g. «Напиши подробный план на 1500 слов»); while the reply streams, walk the feed with Tab only again; wait for the reply to finish.
4. **[DevTools — user]** emulate `pointer: coarse` (touch device); screenshot the feed.
5. Click «Копировать» on a user message; read `navigator.clipboard.readText()`; read `[role="status"]` text.
6. Double-click a user bubble.
7. Open `SEED-TOOL-ERROR`: look at the reply with only a tool part and the reply with only a reasoning part.

Expected observations:

- [ ] Every message has exactly one action: «Копировать». No «Изменить», «Перегенерировать», «Ещё», «Экспорт в Markdown», no «‹ 1/2 ›» branch picker anywhere in the feed (`find` / `read_page`) (AC-08.6)
- [ ] Step 1: Tab reaches «Копировать» of the first (not last) user message and of the first (not last) reply without hover; when focused the button is visible (computed `opacity` 1) (AC-08.6)
- [ ] Step 2: the last message's action bar is visible without hover; a non-last message's bar is transparent (`opacity` 0) until hover or focus inside the message; never `display: none` / `visibility: hidden` (`getComputedStyle`) (AC-08.6)
- [ ] Step 3: while streaming, «Копировать» of every earlier message stays in the accessibility tree and in the Tab order; the reply being generated has none until it finishes, then it appears (AC-08.6)
- [ ] Step 4 (**[DevTools — user]**): with a coarse pointer «Копировать» is visible on every message
- [ ] Step 5: clipboard equals the message text; a `role="status"` element with text «Скопировано» appears (AC-08.6)
- [ ] Step 6: no edit field opens (no `textbox` in the feed besides the composer) (AC-08.6)
- [ ] Step 7: the tool-only and reasoning-only replies are rendered (tool block / «Рассуждения» visible) and have no «Копировать»; a reply with no parts is not rendered as a row (AC-08.6)

### Part B — model error → regenerate → F5 (AC-08.5, AC-08.5a, AC-08.5b, AC-08.5c, AC-14.6)

Steps:

1. In M install the fetch wrapper; send «Расскажи подробно о Токио». Read the error block.
2. Tab into the reply: record the order of stops inside it.
3. Open Y from the sidebar, then return to M (same tab, no reload).
4. Restore `window.fetch`. Tab to «Перегенерировать»; press Enter. Wait for the reply to finish.
5. Wait 3 s; F5.
6. Install the wrapper again; send «Расскажи о Париже»; when the error block appears, **do not** regenerate: restore `window.fetch` and send «Ещё вопрос»; wait for the reply.
7. Wait 3 s; F5.
8. **Error before the first token** (user action: restart `apps/api` with an invalid `ANTHROPIC_API_KEY`): in M send «Привет». Afterwards restore the valid key and restart the API.

Expected observations:

- [ ] Step 1: under the reply a block (`data-slot="message-error"`) with ⚠ and the text «Не удалось получить ответ. Попробуйте перегенерировать.» in an element with `role="alert"`; the partial text stays above it; no text from the server or the model («network error», «Agent error», any English) anywhere (AC-08.5)
- [ ] Step 1: block border colour equals `--destructive`; the text colour equals `--foreground` (computed `color` of the text equals that of body text); the sidebar, the header and the composer stay operable (AC-08.5)
- [ ] Step 1: button «Перегенерировать» is inside the block; its `aria-describedby` points to the `id` of the alert text; no «Перегенерировать» in the action bar (AC-08.5a)
- [ ] Step 2: Tab order inside the reply: content → «Перегенерировать» → «Копировать» (UXRD 7.3)
- [ ] Step 3: after returning, the block with «Перегенерировать» is visible again on the failed reply (AC-08.5b, second sentence; UXRD A-1). If it is not: record it and note the discrepancy to the UX owner (design: «расхождение фиксируется заметкой UX-владельцу»), this is not a blocker for the other items
- [ ] Step 4, Network: `POST /api/chat/assistant` with `trigger: 'regenerate-message'` and the last item of `messages` being the same user message (same `id` as in the failed turn) (AC-08.5a)
- [ ] Step 4: the new reply takes the place of the failed one; no «‹ 1/2 ›»; block and button are gone; focus is in the composer with a fine pointer (AC-08.5a). With a coarse pointer focus goes to the header `h1`, without the on-screen keyboard (**[DevTools — user]**, optional)
- [ ] Step 5: after F5 there is exactly one assistant reply after that user message; no block, no button, no error text (AC-14.6, AC-08.5c)
- [ ] Step 6: right after the new message the failed reply shows only its partial text: no block, no button; there is no «Перегенерировать» anywhere in the feed (AC-08.5b)
- [ ] Step 7: after F5 the failed reply is shown as an ordinary reply with its saved partial text, with «Копировать», without block, without button, without any model error text; order: «Расскажи о Париже», partial text, «Ещё вопрос», its reply (AC-08.5c, AC-14.5)
- [ ] Step 8: only the block appears under the user message «Привет»; no empty assistant row and no «Копировать» for it; after F5 no assistant reply follows «Привет» (AC-08.6, AC-08.5c defensive case)

### Part C — tool error (AC-14.5)

Steps:

1. Open `SEED-TOOL-ERROR`; look at the failed tool block; F5 and look again.
2. Network: read the body of `GET /api/threads/<id>/messages`.

Expected observations:

- [ ] The failed tool block shows the tool's trigger label, «Ошибка:» and «Не удалось выполнить инструмент.»; there is no «Result:» / result section; neither «boom» nor `{"error"` appears anywhere on the page (`get_page_text`); the block is not announced as `alert` (`read_page`) (AC-14.5)
- [ ] The same after F5 (AC-14.5)
- [ ] The `/messages` response has no `boom` (server-side masking, owned by `threads-api`; a free cross-check)
- [ ] Live-stream half of AC-14.5 (a tool failing during a stream): **not executable on this stand** — the assistant has no tools. Record as *not executed* with that reason (covered by the component test `tool-fallback-error.test.tsx`), unless the user adds a throwaway failing tool to the agent locally

Evidence: _screenshots of the action bar states, the error block (with computed colours), Network rows of the regenerate request, `/messages` after F5, console_

---

## Deferred from `threads-api` T6.3 (metrics № 10 and № 7)

These two checks need real provider keys and were moved by the user from `threads-api` task T6.3 into the browser verification after `web-shell`. Results go back into the `threads-api` plan, Notes, section «L1 / метрики № 7, № 10» (and tick the three Completion boxes of T6.3 there).

### T6.3-a — time to first token, before / after (PRD metric № 10, threads-api Verification)

**Criterion:** the time to the first token of `POST /api/chat/assistant` is not worse than the current skeleton + 50 ms. The difference measures the whole work added to each send: `getOwnedThread` (one SELECT by PK) and `recall` of ≤ 20 rows of the tail reset.

**Method:** 5 runs on the same prompt on each side, servers started one after another on port 4000.

Steps (shell steps are done by the agent in Bash or by the user; the measurement runs in the browser):

1. **«Before»** — `main` commit `83fd532` in a separate git worktree outside the repository: `git worktree add <dir outside repo> 83fd532`; in it `pnpm install` and copy `apps/api/.env`; stop any other API on port 4000; `pnpm --filter api dev` **from the worktree**.
2. In a tab opened on `http://localhost:3000` (the allowed CORS origin; the web app itself is not under test), run the measurement below once as a warm-up (discard it), then 5 times; record the 5 values. With the «before» API, `id` is any fresh string.
3. Stop the «before» API. **«After»** — the working tree of `feature/chat-shell`: `pnpm --filter api dev`; warm-up once (discarded), then 5 runs. With the «after» API each run first creates a thread (`POST /api/threads`) and sends the chat request with the returned `id`; only the chat request is timed.
4. Remove the worktree: `git worktree remove <dir>`.

The warm-up request per server start is an addition to the plan, so that a cold start is not compared with a warm server; apply it to both sides.

Measurement (`javascript_tool`; the same prompt on both sides; `x-user-id` keeps the benchmark threads out of the `dev-user` list; «first token» = the first SSE chunk whose `type` ends with `-delta`, text or reasoning, on both sides):

```js
(async (after) => {
  const api = 'http://localhost:4000';
  const headers = { 'content-type': 'application/json', 'x-user-id': 'ttft-bench' };
  let id = crypto.randomUUID();
  if (after) id = (await (await fetch(api + '/api/threads', { method: 'POST', headers })).json()).id;
  const body = JSON.stringify({ id, messages: [{ id: crypto.randomUUID(), role: 'user',
    parts: [{ type: 'text', text: 'Назови три столицы Европы одним предложением.' }] }] });
  const t0 = performance.now();
  const res = await fetch(api + '/api/chat/assistant', { method: 'POST', headers, body });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { ms: null, note: 'stream ended without a delta chunk', status: res.status };
    buf += dec.decode(value, { stream: true });
    if (/"type"\s*:\s*"[a-z-]*-delta"/.test(buf)) { const ms = Math.round(performance.now() - t0); reader.cancel(); return { ms, status: res.status }; }
  }
})(/* false for «before», true for «after» */ true)
```

Expected observations:

- [ ] 5 values «before» (`83fd532`) recorded, each with HTTP status 200
- [ ] 5 values «after» recorded, each with HTTP status 200
- [ ] median(after) − median(before) ≤ 50 ms (the PRD does not fix the aggregation; the median is used and all ten values are kept). If the difference is above 50 ms, **escalate to the user** with the ten values; do not decide by repeating runs
- [ ] The worktree is removed (`git worktree list` shows only the main one)

Evidence: _ten values, medians, worktree commit and branch HEAD_

### T6.3-b — automatic titles on the real model (PRD metric № 7, AC-17.1, AC-20.1)

**Criterion:** ≥ 95 % of 20 new conversations (≥ 19 of 20) get a non-empty title of 1…80 characters, without quotes or line breaks, in the language of the first message, visible in the sidebar within 15 s after the reply ends (10 s server generation, AC-17.1 + up to 5 s client refresh, AC-20.1).

Steps:

1. In the production build create 20 new chats (new chat → first message → wait for the reply to end): 10 in Russian, 10 in English; vary the first message: a short question, a long request over 200 characters, a request with code, a request with quotes in the text, a one-word message.
2. For each chat, right after the reply ends poll with `javascript_tool` every 500 ms until the sidebar link of the thread (and `document.title`) stops reading «Новая беседа», up to 20 s; record the elapsed seconds and the title text.
3. In the `apps/api` log (user) check for each chat that the title was written within 10 s after the reply ended (AC-17.1 server side).

Expected observations (record a table: № · language · first message (short) · title · length · seconds to appear):

- [ ] ≥ 19 of 20 titles are non-empty, 1…80 characters, without quotes or line breaks
- [ ] ≥ 19 of 20 titles are written in the language of the first message
- [ ] ≥ 19 of 20 titles are visible in the sidebar, the header `h1` and the tab title within 15 s after the reply ends
- [ ] The `apps/api` log shows the title written within 10 s for ≥ 19 of 20 chats (AC-17.1)
- [ ] If the criterion fails: record the failing chats and **escalate to the user**; the planned remedies are a faster `TITLE_MODEL` or sharper title instructions through `update` of the threads-api plan

Evidence: _the 20-row table, API log excerpt_

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
| L1-10 | | | |
| T6.3-a (metric № 10) | | | |
| T6.3-b (metric № 7) | | | |
