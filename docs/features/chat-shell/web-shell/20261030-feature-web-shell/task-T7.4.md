# Task T7.4: Ошибка инструмента — ветвление `ToolFallbackImpl` по `isError`, фиксированный текст `ToolFallbackError`, строки `tool-fallback.aui.tsx`

Metadata:
- Task type: frontend (apps/web)
- Phase: 7
- Dependencies: task-T2.1 (Vitest-обвязка); может идти параллельно с Phase 3–6 (не делит файлов)
- Provides: безопасный вывод ошибки инструмента (AC-14.5 клиент), русские строки `tool-fallback.aui.tsx`
- Size: Small (2 файла)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; Postgres 5433 для dev/L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны.

## Implementation Content
При `isError: true` часть инструмента показывается как неудавшийся инструмент с фиксированным текстом (без утечки `status.error`/результата); `cancelled` — прежняя причина; все пользовательские строки файла — на русском. AC-14.5 (клиент); D-15; IP8; Cross-Layer Assumption 8.

## Target Files
- [x] `apps/web/src/components/assistant-ui/elements/tool-fallback.aui.tsx`
- [x] `apps/web/src/components/assistant-ui/elements/tool-fallback-error.test.tsx` (new)

## Investigation Targets
- DD «AC-14.5, `ToolFallbackError`» (таблица), «Локализация»
- `apps/web/src/components/assistant-ui/elements/tool-fallback.aui.tsx`
- `@assistant-ui/react` — форма `ToolCallMessagePart` (`isError`, `status`)

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ AC-14.5, `ToolFallbackError`) | derived-display | «Для статуса `incomplete` с причиной, отличной от `cancelled`, — «Ошибка:» и «Не удалось выполнить инструмент.» независимо от `status.error`»; «отмена (`cancelled`) — прежний вывод причины под «Причина отмены:»» | Y, если ветвление совпадает дословно |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| `isError: true` | статус `incomplete`/`error` для триггера и `ToolFallbackError`, без `ToolFallbackResult` | План T7.4 |
| Текст | «Ошибка:» + «Не удалось выполнить инструмент.» независимо от `status.error`; `cancelled` — «Причина отмены:» и исходная причина; без `role="alert"` | План T7.4 |
| Нетронутое | локальный `pressable` не трогать | План T7.4 |
| Локализация | Все пользовательские строки файла (`Reply queued, not sent yet`, `Cancelled tool`/`Failed tool`, `Approved by user`, `Allow`/`Always allow`/`Deny`/`Always deny`, `Answered`/`Allowed`/`Dismissed`/`Denied` и др.) — на русском | План T7.4 |

## Investigation Notes
- Форма части (`@assistant-ui/core` 0.3.x, `utils/normalizePartStatus.js`): у части `tool-call` с `result` статус всегда `complete`, даже при `isError: true`; без `result` — статус сообщения. Поэтому ветвление по `isError` делается в `ToolFallbackImpl`: `displayStatus = isError ? { type: 'incomplete', reason: 'error' } : status` уходит в триггер и `ToolFallbackError`; `ToolFallbackResult` при `isError` не рендерится. Блок подтверждения получает исходный `status` (его поведение не меняется).
- `ToolFallbackError`: `incomplete` с любой причиной, кроме `cancelled`, — «Ошибка:» + «Не удалось выполнить инструмент.» (константа `TOOL_ERROR_TEXT`), `status.error` не читается; `cancelled` — «Причина отмены:» + исходная причина (пустая → блока нет, как в каркасе). `role="alert"` не добавлен.
- Reference Contract (DD § AC-14.5 / `ToolFallbackError`): `Y` — ветвление совпадает дословно (тесты 1–4).
- Тест — `Thread` на `useLocalRuntime` с `initialMessages`; части инструмента лежат в свёрнутой группе (`tool-group-trigger`), тест раскрывает группу и блок. Для статусных случаев `MessageError` каркаса выводит `Agent error` сообщения, поэтому проверки ограничены `tool-fallback-root` (это зона T7.2).
- Локальный `pressable` не тронут.

| Было | Стало |
|---|---|
| `Reply queued, not sent yet` | Ответ в очереди, ещё не отправлен |
| `Running tool` / `Waiting on tool` / `Used tool` | Выполняется инструмент / Ожидание инструмента / Использован инструмент (UXRD 14.4) |
| `Cancelled tool` / `Failed tool` | Отменён инструмент / Сбой инструмента |
| `<1s`, `1.2s`, `12s`, `1m 5s` | `<1 с`, `1,2 с`, `12 с`, `1 мин 5 с` |
| `Result:` | Результат: |
| `[Unserializable value]` | [Значение не сериализуется] |
| `Error:` / `Cancelled reason:` | Ошибка: / Причина отмены: |
| `Approved by user` / `User denied tool execution` | Одобрено пользователем / Пользователь запретил выполнение инструмента |
| `Allow` / `Always allow` / `Deny` / `Always deny` | Разрешить / Всегда разрешать / Запретить / Всегда запрещать |
| `Cancelled before a decision` / `Expired before a decision` | Отменено до решения / Истекло до решения |
| `Answered` / `Allowed` / `Dismissed` / `Denied` (+ ` automatically`) | Отвечено / Разрешено / Отклонено / Запрещено (+ « автоматически») |
| `Or type an answer` / `Type your answer` | Или введите ответ / Введите ответ |
| `Send` / `Dismiss` / `Confirm` / `Back` | Отправить / Отклонить / Подтвердить / Назад |
| `Answer` / `Note` (aria) / `Add a note to your decision` | Ответ / Примечание / Добавьте примечание к решению |

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [x] Прочитать Investigation Targets
- [x] C `tool-fallback-error.test.tsx` — часть с `isError: true` и `{ error: 'boom' }`: подпись неудавшегося инструмента, «Ошибка:», «Не удалось выполнить инструмент.»; нет «boom», `"error"`, «Result:» и перевода; нет `alert`; `incomplete`/`error` с `'Agent error'` и с пустой ошибкой → тот же текст; `cancelled` → «Причина отмены:»
- [x] Запустить, увидеть падение

### 2. Green Phase
- [x] Правки `tool-fallback.aui.tsx`; тесты зелёные

### 3. Refactor Phase
- [x] Упростить; тесты зелёные

## Quality Assurance Mechanisms
- Vitest + RTL, ESLint, `tsc` — Type: `executable_check`
- Локализация (стоп-лист в `i18n.test.tsx`, T7.5) — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: C-тест + гейты. Браузер (L1-10 C, T8.3) со seed `SEED-TOOL-ERROR` (T8.2).
- **Success criteria**: тест зелёный; lint/tsc — 0.
- **Failure response**: расхождение формы части — эскалация.
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-14.5 — клиент не показывает текст ошибки инструмента
- **Claim**: при `isError: true` выводится только фиксированный текст; `boom`/`"error"`/«Result:» отсутствуют.
- **Primary failure mode**: `status.error` или результат протекает в ленту.
- **Boundary to exercise**: компонентный (часть сообщения → `ToolFallback`).
- **State assertion**: N/A.
- **Mock boundary rationale**: фикстура части сообщения; сеть не задействована.
- **Proven by**: `new: tool-fallback-error.test.tsx`.
- **Residual**: серверная маска `errorText` — `threads-api`; L1-10.

## Completion Criteria
- [x] Тест зелёный (содержательно)
- [x] lint, tsc — 0 ошибок
- [x] Reference Contract — `Y`; Resolved decisions применены

## Notes
- Impact scope: `tool-fallback.aui.tsx`.
- Scope boundary: локальный `pressable` и вне Target Files не менять.
