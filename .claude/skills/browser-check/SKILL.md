---
name: browser-check
description: Start api and web locally, sign in as the dev user and check the screens of the improvements feature in a real browser (chrome-devtools MCP) at three widths and both themes, with screenshots. Load before any visual check of apps/web.
---

# Browser check

Recipes for checking the UI by hand in a real browser. Labels are quoted as they appear on screen. The screens and their states are in `docs/features/improvements/uxrd.md` (IM-01…IM-13).

## Start

Run from the repository root, each server as a background process.

1. `pnpm --filter api build`, then `pnpm --filter api start` — API on `http://localhost:4000`, database from `apps/api/.env` (the dev database `agent_os`).
2. `pnpm --filter web dev` — web on `http://localhost:3000`; it proxies `/api/...` to port 4000.
3. Only when a recipe needs a changing action (decision card, «Без вас»): `pnpm --filter @agent-os/mcp-fixture start` — the MCP fixture on `http://localhost:4100` (prints `fixture listening 4100`).

Vitest never runs against the dev database: no `vitest` command (`test`, `test:e2e`, `test:verify`, `vitest list`) is part of this check. Anything that loads a vitest config migrates the database in `DATABASE_URL`.

## Sign in

The dev user is `ui-check`. Set a fresh password each session, through stdin, and keep it only in the shell variable — never in a file, a command argument or a report:

```sh
PW=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")
printf '%s' "$PW" | pnpm --filter api identity:super-admin --login ui-check --name "UI check" --email ui-check@example.com
```

It creates `ui-check` as super-administrator or, if it exists, sets the new password and enables it. Then open `http://localhost:3000/login`, fill «Логин» and «Пароль», press «Войти».

## MCP server `backoffice`

With the fixture running and the API started, register the fixture servers (`logs`, `tracker`, `backoffice`) and connect `ui-check`'s account on `backoffice`:

```sh
printf '%s' "$PW" | pnpm --filter api seed:mcp --login ui-check
```

`seed:mcp` registers `backoffice` in personal OAuth mode at `http://localhost:4100/backoffice/oauth/mcp`. A name already taken is skipped. Its changing tools (`create_incident_note`) are what the decision card and «Без вас» need. To register it by hand at `http://localhost:4100/backoffice/mcp` instead, use the user menu → «Панель администратора» → «MCP-серверы» → «Зарегистрировать сервер», name `backoffice`, mode «Общая учётная запись», «Токен доступа» = `FIXTURE_SHARED_TOKEN` from `packages/mcp-fixture/src/http/http-server.ts`.

## Browser

- Use chrome-devtools MCP (`mcp__chrome-devtools__*`) in an isolated context: `new_page` with an isolated context, so no personal session or cookies mix in.
- Never trigger a JS `alert`/`confirm`/`prompt`: it blocks the page and the tool. Do not click anything that opens a native dialog.
- Widths, by `resize_page` or `emulate`: ≥1280 (right panel beside the feed), ~900 (right panel is a drawer), 360 (phone; no horizontal page scroll).
- Both themes: the user menu → «Тема» → «Светлая» / «Тёмная», or `emulate` with `prefers-color-scheme` light and dark.
- Screenshots go to `D:\git\github\ai\agent-os-ui-check\<feature>\`, named `<screen>-<width>-<theme>.png` (for example `D:\git\github\ai\agent-os-ui-check\improvements\edit-1280-dark.png`).

## Recipes

Each recipe starts in a chat with at least one agent answer unless it says otherwise.

- **Editing a message (IM-13).** Hover your own message → the pencil «Изменить» left of «Копировать». Press it: the bubble turns into a field with the text, the line «Ответ придёт в новой ветке — эта беседа не изменится.», «Отмена» and «Отправить». Esc returns the bubble. Change the text and press «Отправить»: you are in a new branch — inherited history, the branch divider, the edited message and a new answer. Not shown on messages from a schedule or from agents.
- **«Спросить в стороне» and the «В стороне» tab (IM-05, IM-06).** On an agent answer press «Спросить в стороне» (right of «Копировать»). The right panel opens on the last tab «В стороне»: the branch name as a link, the feed at the branch divider, a quote of the answer in the field, focus at its end. The main chat stays active; the branch appears at the top of «Сегодня» in the sidebar. At ~900 and 360 the tab is a drawer over the chat. The button is missing while the chat is busy and in test and training chats.
- **«В основной чат» (IM-07).** In the «В стороне» tab select text in a message → a popover with «В основной чат». Press it: the text is sent as the next message of the main chat, the button shows a check and «Отправлено» for 2 s. On agent answers in the tab the same button in the action bar sends the whole answer.
- **Thread states in the sidebar (IM-09).** Start a long request in one chat and open another. The sidebar row shows an icon before «⋯»: «Работает» (spinner), «Ждёт вас» (hand, on a pending confirmation), «Новый ответ» (dot, after it finishes unseen), «Сбой». Four distinct shapes; the open chat never shows «Новый ответ» or «Сбой». At 360 check the row in the mobile drawer.
- **The «Новые сообщения» divider (IM-10).** Let a chat get an answer while another chat is open, then open it: the divider «Новые сообщения» stands before the first unread message, in the upper third of the feed. Reopen it with nothing unread: no divider, the feed opens at the last message.
- **The agents strip (IM-11).** Ask the chat agent to start an agent (for example a deep agent from the library) whose work needs a confirmation. Above the composer: «Агенты · N» with each agent's status, waiting ones first («Ждёт подтверждения» before «Работает»). Click an agent: the feed scrolls to its decision card or run card and focus moves there. When no agent runs or waits, there is no strip. At 360 the strip is one line that scrolls sideways.
- **The decision card's third answer (IM-04).** Needs `backoffice`. Ask the chat to create an incident note in backoffice. The card «Ждёт подтверждения» has «Подтвердить», «Разрешить в этой беседе», «Отклонить» in this order. Press «Разрешить в этой беседе»: the line «Разрешено в этой беседе: «…» без подтверждения · {время}»; the next such call in this chat runs without a card. At 360 the three buttons stack full width.
- **The schedule dialog's «Без вас» and the schedule page (IM-01, IM-02).** Needs `backoffice`. In a chat «+» → «Запланировать». The last field «Без вас» lists changing actions grouped by system, each with its technical name, nothing checked; no reading actions. Check one, press «Создать расписание». Open «Расписания» → the schedule: the pair «Без вас» shows «{действие} · {система}» («Только читает» when nothing is checked); change it only through «Изменить». At 360 the technical name sits under the action name.
- **«Отправить позже» (IM-08).** In a chat with messages, type text: the clock button «Отправить позже» left of «Отправить» (not shown with an empty field or an action chip). Press it: the dialog «Отправить позже» with the instruction = your text, «Один раз» at the next whole hour, «В эту беседу», «Без вас» empty, main button «Запланировать». Close it: nothing changed in the chat.
- **`@` in the message field (IM-12).** Type `@` at the start of the field or after a space: a list above the field with the same agent rows as «+» → «Агенты». Typing narrows it by name; ↑/↓ move, Enter picks: an agent chip appears and `@…` leaves the field. Esc closes the list and keeps the text. No match: «Агентов не нашлось». At 360 the list spans the field, at most 5 rows.

## Stop

Stop every process you started — web, api and the fixture — by their background task or PID, and check that ports 3000, 4000 and 4100 are free. Delete chats, schedules and agents made only for the check, or list what was left in the report.
