# Task T7.2: Action bar — только «Копировать» у ответов и сообщений пользователя, видимость CSS, пустые ответы, удаление `BranchPicker` и `EditComposer`

Metadata:
- Task type: frontend (apps/web)
- Phase: 7
- Dependencies: task-T4.3 → Deliverable: `thread.aui.tsx` (после T4.3; обе задачи правят один файл)
- Provides: action bar «Копировать», `role="status"` «Скопировано», Reference-видимость; база для T7.3
- Size: Small (2 файла)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; Postgres 5433 для dev/L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны.

## Implementation Content
Action bar сообщений: у ответов и сообщений пользователя только «Копировать» (без `Reload`, `ActionBarMorePrimitive`, `ExportMarkdown`, `autohide`, `hideWhenRunning`), видимость через CSS (без `display:none`/`visibility:hidden`), пустые ответы не рендерят строку, удалены `BranchPicker`, `EditComposer`, ветка `isEditing`. AC-08.6; D-13, TH-10.

## Target Files
- [ ] `apps/web/src/components/assistant-ui/elements/thread.aui.tsx`
- [ ] `apps/web/src/components/assistant-ui/elements/message-actions.test.tsx` (new)

## Investigation Targets
- DD «Action bar и ошибки в ленте» (таблица видимости); UXRD 6.26 (TH-10), 7.3
- `apps/web/src/components/assistant-ui/elements/thread.aui.tsx` (после T4.3), `apps/web/src/components/surfaces.tsx` (`pressable`)

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Action bar и ошибки в ленте, видимость) | derived-display | «Последнее сообщение (`s.message.isLast`) — Видна всегда; Не последнее, точный указатель — Проявляется при `:hover` реплики и при `:focus-within`; Грубый указатель (`pointer: coarse`) — Видна всегда у каждого сообщения; Идёт прогон: ответ, который сейчас генерируется (`s.message.status?.type === 'running'`) — Не рендерится у этого ответа»; «`display: none` и `visibility: hidden` запрещены» | Y, если видимость реализована прозрачностью/CSS, а во время прогона панель не рендерится у генерируемого ответа |
| design-web-shell.md (§ Action bar и ошибки в ленте, «Копировать») | structure-order | «Порядок Tab внутри реплики не меняется: содержимое → «Перегенерировать» (если есть) → «Копировать» (UXRD 7.3).» | Y, если «Копировать» следует за содержимым в DOM-порядке (кнопка «Перегенерировать» добавится в T7.3 перед ней) |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| `AssistantActionBar` | `Copy` (+ условный отзыв каркаса); без `Reload`, `ActionBarMorePrimitive`, `ExportMarkdown`, без `autohide` и `hideWhenRunning`; `AuiIf` по `s.message.status?.type === 'running'`; «Копировать» только при непробельной текстовой части | План T7.2 |
| `UserActionBar` | `Copy` вместо `Edit` | План T7.2 |
| `AssistantMessage` | без частей и не в прогоне — без строки | План T7.2 |
| Удаление | `BranchPicker`, `EditComposer`, ветка `isEditing` удалены | План T7.2 |
| Статус копирования | постоянно смонтированный sr-only `role="status"` «Скопировано» | План T7.2 |
| «Перегенерировать» | Не здесь — T7.3 | План |

## Investigation Notes
(Правило 10 неприменимо — I-тестов нет. Зафиксировать структуру DOM до/после.)

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать Investigation Targets
- [ ] C `message-actions.test.tsx`: «Копировать» у каждого сообщения без наведения, запрещённых кнопок и «1 / 2» нет, двойной клик не открывает правку; порядок Tab к первому сообщению пользователя и первому ответу; во время прогона — «Копировать» у прежних есть и в Tab, у генерируемого нет, после завершения появляется; клик → `navigator.clipboard.writeText` + `status` «Скопировано» (оба типа); ответ только с инструментом / только с рассуждением — без «Копировать»; ответ без частей — без строки; ошибка до первого токена — только блок ошибки (последний кейс уточнить с T7.3: если блок ошибки поставляет T7.3 — этот кейс переносится в T7.3 через эскалацию, не заглушается)
- [ ] Запустить, увидеть падение

### 2. Green Phase
- [ ] Правки `thread.aui.tsx`; тесты зелёные

### 3. Refactor Phase
- [ ] Упростить; тесты зелёные

## Quality Assurance Mechanisms
- Vitest + RTL, ESLint, `tsc`, `next build` — Type: `executable_check`
- Движение/нажатия — `surfaces.tsx`; WCAG 2.1 AA — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: C-тесты + гейты. Браузер (L1-10 A, T8.3; Phase 7 Operational 2): Tab по ленте — у каждого сообщения только «Копировать»; во время стрима «Копировать» прежних остаётся в Tab.
- **Success criteria**: тесты зелёные; lint/tsc/build — 0.
- **Failure response**: кейс «ошибка до первого токена» требует блока T7.3 — эскалация (правило 10 по духу).
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-08.6 — только «Копировать», доступен с клавиатуры, не скрыт `display:none`
- **Claim**: «Копировать» у каждого сообщения без наведения (в Tab); запрещённых кнопок нет; во время прогона у генерируемого ответа нет, у прежних есть.
- **Primary failure mode**: возврат `autohide="not-last"` краснит порядок Tab; `hideWhenRunning` краснит кейс «во время прогона».
- **Boundary to exercise**: компонентный (`useLocalRuntime` + фейковый адаптер модели).
- **State assertion**: прогон идёт → прежние «Копировать» в DOM/Tab, у генерируемого нет → завершение → появляется.
- **Mock boundary rationale**: адаптер модели — фейк; `navigator.clipboard` — шпион.
- **Proven by**: `new: message-actions.test.tsx` (единственный тест правила; дефект — скрытая/недоступная панель — не ловит иной тест).
- **Residual**: L1-10 A.

### Obligation: Failure Mode: empty input — пустые ответы
- **Claim**: ответ только с инструментом/рассуждением — без «Копировать»; ответ без частей — без строки.
- **Primary failure mode**: пустая строка ответа / «Копировать» пустого текста.
- **Boundary to exercise**: компонентный.
- **State assertion**: N/A.
- **Mock boundary rationale**: фейковый адаптер.
- **Proven by**: `new: message-actions.test.tsx — пустые ответы`.
- **Residual**: нет.

## Completion Criteria
- [ ] Тесты зелёные (содержательно)
- [ ] lint, tsc, build — 0 ошибок
- [ ] Мутации (`autohide="not-last"` возвращён; `hideWhenRunning`) краснят кейсы (записано)
- [ ] Reference Contracts — `Y`

## Notes
- Impact scope: `thread.aui.tsx` далее правят T7.3, T7.5.
- Scope boundary: вне Target Files не менять.
