# Task T2.4: Проверка AC-14.6 — доказательства и характеризация (ошибка модели посреди стрима → перегенерация)

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 2, T2.4)
- Dependencies: T2.3 (G3 проверяется после прохождения гейта G; общих файлов нет) → Deliverable: `maskToolErrorText`/`listMessages` с маскированием, `test/support/db.ts` (чтение сырого `mastra_messages`), исход гейта G
- Provides: доказательства для гейта G3 (сам гейт G3 принадлежит T2.5); `partialTextThenErrorStep` и красный кейс AC-14.6 — владение переходит T2.5; пункты «Повторный прогон гейта G» и «Проверка AC-14.6, гейт G3» (первый прогон) в Notes плана; наблюдение о хранимом состоянии после ошибки модели — записано в DD «Контракт для `web-shell`», п. 6, и передано для закрытия UXRD UXQ-7 (D-14, AC-08.5)
- Size: Small (2 тестовых файла + пункты Notes плана)
- Covers: AC-14.6 (доказательства и характеризация); Certainty: low (проверка выполняется до шагов 4–8 DD — строже таблицы Certainty DD)
- **Статус: завершена как задача доказательств и характеризации** (исполнитель выполнил её полностью; Investigation Notes и Evidence ниже не меняются). Красный кейс AC-14.6 принадлежит T2.5 (`task-T2.5.md`) и остаётся красным (не `it.skip`/`it.todo`) только до T2.5.
- **Единица коммита: T2.4 + T2.5** — одна общая единица, готовая к коммиту (manual-стратегия). T2.4 сама **не** готова к коммиту: её изменения в рабочем дереве (`partialTextThenErrorStep`, красный кейс AC-14.6) коммитятся вместе с T2.5, чтобы ни одна из двух задач не оставляла красное дерево. Гейты качества единицы (lint/tsc/prettier/e2e/build, `app.e2e-spec.ts`) проверяются в T2.5.
- Следующая задача: T2.5 (гейт G3) — зависит от T2.4

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в составе единицы T2.4 + T2.5 «готово к коммиту (manual-стратегия)»: гейты качества единицы проходят в T2.5, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
Проверка AC-14.6 на реальном пути записи Mastra в Postgres: ошибка модели посреди стрима, затем перегенерация тем же сообщением пользователя. Задача создала e2e AC-14.6 (новый, вне скелета) как доказательство и закрепила существующий зелёный характеризационный кейс regenerate/edit (без изменений в T2.4). После выбора пользователем варианта «оставить действие с исправлением хранения» красный кейс AC-14.6 и новые литералы характеризации принадлежат T2.5.

1. **Сценарий mock-модели** в `apps/api/test/support/mockModels.ts` — «часть текста, затем ошибка стрима»: первый вызов — часть текста `'Частичный'`, затем ошибка стрима; второй — `'Ответ 2'`.
2. **e2e AC-14.6** (`chat-threads.e2e-spec.ts`, новый, вне скелета): `AC-14.6: regenerating a reply that failed mid-stream leaves exactly one assistant reply after the user message`. Arrange: беседа через `seed` (как в T2.2); mock-модель из п. 1. Act/Assert: шаг 1 — отправка `'Вопрос'` (`trigger: 'submit-message'`) → SSE содержит чанк `error`; литералы `/messages` и число строк `mastra_messages` **записываются** (характеризация хранимого состояния после ошибки); шаг 2 — отправка `trigger: 'regenerate-message'`, `messageId` = id ответа ассистента из SSE (или из истории, если сохранён), `messages = [то же сообщение 'Вопрос']` → `/messages` равно `[['user', ['Вопрос']], ['assistant', ['Ответ 2']]]`, строк в `mastra_messages` — 2.
3. **Характеризация перегенерации и правки обычного ответа** (существующий зелёный кейс `characterizes /messages after a regenerate-style and an edit-style resend`) — остаётся без изменений.
4. **Запись в Notes плана** — пункты «Повторный прогон гейта G» (исход T2.3) и «Проверка AC-14.6, гейт G3»: хранимое состояние после ошибки модели без перегенерации фиксируется до любой перегенерации и **не регенерируется** — записывается один раз и передаётся оркестратору.
5. **Бюджет тестов**: кейс AC-14.6 — дополнительный e2e вне скелетов; ловит дефект, который не видит ни один unit: склейку или дубли при перегенерации после ошибки на реальном пути записи Mastra в Postgres.

## Target Files
- [x] `apps/api/test/support/mockModels.ts` (сценарий «часть текста, затем ошибка стрима»)
- [x] `apps/api/test/chat-threads.e2e-spec.ts` (отметка — файл затронут первым прогоном EVP: характеризационный кейс; в нём добавляется кейс AC-14.6)
- [x] `docs/features/chat-shell/threads-api/20261028-feature-threads-api.md` (только пункты «Повторный прогон гейта G» и «Проверка AC-14.6, гейт G3» в разделе Notes)

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации. В файле плана правятся только два указанных пункта Notes; остальные разделы плана не трогать. Продуктовый код не менялся. Серверная правка хранения («сброс хвоста», `maskHistoryErrors`) — задача T2.5, не T2.4.

## Investigation Targets
- `docs/features/chat-shell/design-threads-api.md` (§ Early Verification Point; § AC-14.6; § Test Strategy, AC-14.6; § Контракт для `web-shell`, п. 6)
- `apps/api/test/chat-threads.e2e-spec.ts` (характеризационный кейс первого прогона EVP — тела запросов как у AI SDK transport)
- `apps/api/test/support/*` (`mockModels.ts`, `createTestApp.ts`, `db.ts` — T1.3, T2.3)
- `docs/features/chat-shell/threads-api/20261028-feature-threads-api/task-T2.3.md` (Investigation Notes: Evidence первого прогона EVP, литералы характеризации (a), (b))

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ Test Strategy, AC-14.6) | state-lifecycle-negative | «mock-модель первым ответом выдаёт часть текста `'Частичный'` и затем ошибку стрима, вторым — `'Ответ 2'`. Шаг 1: отправка `'Вопрос'` (`trigger: 'submit-message'`) → SSE содержит чанк `error`; записываются литералы `/messages` и число строк `mastra_messages` (характеризация). Шаг 2: отправка с `trigger: 'regenerate-message'`, `messageId` = id сообщения ассистента из SSE (или из истории, если оно сохранено), `messages = [то же сообщение 'Вопрос']` → `/messages` равно литералу `[['user', ['Вопрос']], ['assistant', ['Ответ 2']]]`, строк в `mastra_messages` — 2.» | Y, если e2e выполняет оба шага и проверяет эти литералы |
| design-threads-api.md (§ AC-14.6) | state-lifecycle-negative | «вернуть в `GET /api/threads/:threadId/messages` после этого сообщения пользователя ровно одно сообщение ассистента, содержащее только текст перегенерированного ответа; сообщение пользователя не дублируется, текст неудавшейся попытки не возвращается.» | Y, если в ответе нет `'Частичный'`, нет дубля user, одно сообщение ассистента |

## Decisions and Unresolved Items
Resolved decisions:

| Item | Decision | Source / Rule |
|---|---|---|
| Arrange бесед | `seed`, не `POST /api/threads` (маршрут появляется в T3.3) | work plan T2.4, Notes «Отклонения Arrange» |
| Gate G2 (перегенерация и правка обычного ответа) | **снят**: `web-shell` скрывает правку, переключение веток и перегенерацию обычных ответов; характеризационный кейс фиксирует поведение Mastra и краснеет при его смене; задача удаления отброшенных сообщений не планируется | PRD Won't Have, `design-web-shell.md` |

Blocking unresolved items — гейт (исход определяется результатом тестов этой задачи):

| Item | Required Input | Escalation Condition |
|---|---|---|
| **Gate G3 — исход первого прогона (гейт принадлежит T2.5)**: AC-14.6 | e2e AC-14.6 | e2e AC-14.6 зелёный → G3 пройден. Красный → **стоп реализации**; оркестратор эскалирует пользователю с доказательствами (литералы `/messages` после шагов 1 и 2, число строк `mastra_messages`) и тремя вариантами PRD Undetermined Items: (1) оставить действие с исправлением хранения — серверная мера «сброс хвоста» DD; (2) скрыть и это действие; (3) принять ограничение. Варианты (2) и (3) меняют PRD (AC-08.5, AC-14.6); вариант (1) добавляет задачу в Phase 5 через `update` плана (условная заметка там). Красный кейс остаётся в рабочем дереве красным (не `it.skip`/`it.todo`) до T2.5. **Исход**: первый прогон красный (склейка), эскалация отправлена, пользователь выбрал вариант (1) (DD v1.8: «сброс хвоста» обязателен); реализация и проход гейта G3 — T2.5 в Phase 2. |

## Investigation Notes
(Заполняется исполнителем. Литералы характеризации regenerate/edit первого прогона — в `task-T2.3.md`, Investigation Notes.)

- План подхода: порядок — сценарий mock-модели «часть текста, затем ошибка» в `mockModels.ts` → e2e AC-14.6 (убедиться, что падает/выполняется по правильной причине) → запись литералов шага 1 до перегенерации → исход шага 2; результат каждого Compliance Check и литералы шага 1 AC-14.6 — сюда.
- **Исполнение (2026-10-29; `ai` 7.0.148, `@mastra/ai-sdk` 1.11.2, `@mastra/core` 1.80.0; Postgres `localhost:5433`)**:
  - Гейт G (T2.3): пройден — e2e сравнения «стрим ↔ история» зелёный под правилом v1.7; `errorText` `'Agent error'` в стриме и истории, в сыром `mastra_messages` — `'boom'`. Повторно подтверждено полным прогоном `test:e2e` в этой задаче (кейс зелёный).
  - Сценарий mock-модели: `partialTextThenErrorStep('Частичный')` — `stream-start`, `text-start`, `text-delta 'Частичный'`, стрим-часть `{ type: 'error', error: Error('mock stream failure') }` (без `text-end` и `finish`); второй вызов — `textStep('Ответ 2')`. Mastra повторов модели не делал (очередь израсходована ровно на 2 вызова).
  - Шаг 1 — литералы (зафиксированы ассертами в кейсе, до перегенерации): SSE `[start(messageId=X), start-step, text-start, text-delta 'Частичный', error('Agent error'), finish-step, finish('error')]`; `/messages` → `[['user', ['Вопрос']], ['assistant', ['Частичный']]]`, id ассистента = X; строк `mastra_messages` — 2. Сырой `content` строки ассистента: `{"format":2,"parts":[{"type":"text","text":"Частичный",...},{"type":"error","error":{"name":"Error","message":"mock stream failure"},...}],"content":"Частичный",...}`. Хранимое состояние — **частичное**; сообщение пользователя сохранено.
  - Шаг 2 — исход: `/messages` → `[['user', ['Вопрос']], ['assistant', ['Частичный', 'Ответ 2']]]` (части: `text 'Частичный'`, `error`, `text 'Ответ 2'`; id = X), строк — 2. **G3 НЕ пройден (склейка)**. Кейс красный на `chat-threads.e2e-spec.ts:337` (Assert 2); шаг 1 зелёный.
  - Reference Contracts: строка 1 (Test Strategy) — **Y** по построению теста (оба шага, литералы проверяются); строка 2 (§ AC-14.6) — **N** по поведению системы: в ответе есть `'Частичный'` (дубля user нет, сообщение ассистента одно, но склеенное). Продукт не правился («сброс хвоста» не авторизован) — эскалация.
  - Смежная находка (вне Target Files, для ревью/оркестратора): `/messages` после ошибки модели возвращает часть `{ type: 'error', error: { name: 'Error', message: 'mock stream failure' } }` — сырой текст ошибки модели, тогда как стрим показывает `'Agent error'`. `maskToolErrorText` (T2.3) маскирует только `errorText` частей инструментов; та же категория дефекта, что AC-14.5, но для ошибки модели. Не исправлялось (файлы T2.3 вне области).
  - Гейты: oxlint — 0; tsc — 0; build — OK; prettier — изменённые файлы чистые, 8 предупреждений в неизменённых закоммиченных файлах (`src/audit/*`, `src/auth/session.guard.ts`, `src/mastra/*`) — существовали до задачи; `test:e2e` — 1 failed (AC-14.6, ожидаемо) | 7 passed | 19 todo, `app.e2e-spec.ts` зелёный без правок, характеризационный кейс зелёный без изменений.

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [x] Прочитать все Investigation Targets; убедиться, что гейт G (T2.3) пройден и его исход известен; записать наблюдения в Investigation Notes
- [x] Сверить контракты (Reference Contracts) с Design Doc, записать план подхода в Investigation Notes
- [x] e2e `chat-threads.e2e-spec.ts`: кейс AC-14.6 (сценарий mock-модели «`'Частичный'`, затем ошибка стрима» → `'Ответ 2'` в `mockModels.ts`); убедиться, что он выполняется и падает по правильной причине (Proof Obligations), если поведение не соответствует

### 2. Green Phase
- [x] Запустить добавленный тест и характеризационный кейс
- [x] ~~Гейт G3~~ — исход первого прогона: красный (склейка), СТОП и эскалация выполнены, продукт не правился, тест не заглушён; **гейт G3 передан T2.5** (зелёный кейс — там)
- [x] Записать литералы `/messages` и число строк `mastra_messages` после шага 1 AC-14.6 (до перегенерации) и исход шага 2 в Investigation Notes
- [x] Записать в Notes плана «Повторный прогон гейта G» (исход T2.3) и «Проверка AC-14.6, гейт G3» (литералы `/messages`; строк `mastra_messages`; сообщение пользователя сохранено; исход перегенерации)

### 3. Refactor Phase
- [x] Улучшение тестового кода не потребовалось (рефакторинг нового кода выполняется в T2.5 над общими файлами `mockModels.ts` и `chat-threads.e2e-spec.ts`)
- [x] Добавленные тесты запущены в Green Phase

### 4. Gates (все — ноль ошибок; перед vitest после правки `packages/contracts` — `pnpm --filter @agent-os/contracts build`; перед e2e — `pnpm db:up` и `apps/api/.env` с `DATABASE_URL`)
- [x] `pnpm --filter api lint`
- [x] `pnpm --filter api exec tsc --noEmit -p tsconfig.json`
- [x] `pnpm --filter api exec prettier --check "src/**/*.ts" "test/**/*.ts"` (изменённые файлы чистые; предупреждения — в неизменённых файлах, см. Investigation Notes)
- [ ] `pnpm --filter api test:e2e` — полный зелёный прогон единицы проверяется в T2.5 (в T2.4 красный кейс AC-14.6 ожидаем)
- [x] `pnpm --filter api build`

## Quality Assurance Mechanisms
- oxlint type-aware (`typescript/no-floating-promises: error`) — Enforces: нет висящих промисов — Config/Source: `apps/api/.oxlintrc.json` — Type: `executable_check`
- TypeScript `strict`, `nodenext` — Enforces: строгие типы тестовых файлов — Config/Source: `apps/api/tsconfig.json` — Type: `executable_check`
- Prettier — Enforces: форматирование — Config/Source: `apps/api/.prettierrc` — Type: `executable_check`
- Vitest e2e (реальный Postgres) — Enforces: поведение AC-14.6 — Config/Source: `apps/api/vitest.config.e2e.ts` — Type: `executable_check`
- Без миграций и новых таблиц — Enforces: система записи — `mastra_threads`/`mastra_messages` — Config/Source: Design Doc «Agreement Checklist» — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: e2e на реальном Postgres с mock-моделью (ошибка посреди стрима, затем `'Ответ 2'`); два `POST /api/chat/assistant` в ту же беседу (`submit-message`, затем `regenerate-message`) + `GET /messages` + число строк `mastra_messages`.
- **Success criteria**: кейс написан, шаг 1 зелёный с закреплёнными литералами, исход шага 2 записан; литерал шага 2 `[['user', ['Вопрос']], ['assistant', ['Ответ 2']]]` и 2 строки становятся приёмкой **гейта G3 в T2.5**; характеризационный кейс зелёный без изменений.
- **Failure response (G3)**: стоп реализации, эскалация с доказательствами и тремя вариантами PRD Undetermined Items (см. Decisions).
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-14.6 (Certainty: low)
- **Claim**: перегенерация ответа, завершившегося ошибкой модели, оставляет ровно одно сообщение ассистента с текстом `'Ответ 2'`; сообщение пользователя не дублируется.
- **Primary failure mode**: после перегенерации остаётся `'Частичный'`; ответ склеен в одно сообщение с двумя частями `text`; сообщение пользователя продублировано; допущение «ничего не сохранилось» без проверки.
- **Boundary to exercise**: HTTP (два `POST /api/chat/assistant` в ту же беседу, `trigger: 'submit-message'`, затем `'regenerate-message'`) + `GET /messages` + число строк `mastra_messages`.
- **State assertion**: литералы `/messages` и число строк после шага 1 записаны; после шага 2 — `[['user', ['Вопрос']], ['assistant', ['Ответ 2']]]` и 2 строки.
- **Mock boundary rationale**: мокается только модель (очередь: частичный текст + ошибка, затем `'Ответ 2'`).
- **Residual**: решение по варианту (1)–(3) при красном исходе — за пользователем.

### Obligation: характеризация перегенерации и правки обычного ответа
- **Claim**: поведение Mastra зафиксировано литералами; при его смене тест краснеет.
- **Primary failure mode**: смена поведения Mastra незамечена.
- **Boundary to exercise**: HTTP (повторные `POST /api/chat/assistant` + `GET /messages`).
- **State assertion**: литералы (a) и (b) из Evidence первого прогона (`task-T2.3.md`); кейс не меняется.
- **Mock boundary rationale**: мокается только модель.
- **Residual**: скрытие действий — в `web-shell`.

## Completion Criteria
- [x] e2e AC-14.6 написан и прогнан; красный исход (склейка) зафиксирован, стоп и эскалация отправлены, красный кейс не заглушён; владение кейсом и гейтом G3 передано T2.5 (зелёный кейс и Gate G3 — Completion T2.5)
- [x] Характеризационный кейс зелёный без изменений
- [x] Наблюдаемое хранимое состояние после ошибки модели без перегенерации (частичное / пустое / нет сообщения ассистента; сохранено ли сообщение пользователя; число строк `mastra_messages`) записано в Notes плана («Проверка AC-14.6, гейт G3») и передано оркестратору для записи в DD «Контракт для `web-shell`», п. 6 (через `technical-designer`, `update` DD), и для закрытия UXRD UXQ-7 (D-14, AC-08.5) через `ux-designer`; записывается один раз, без регенерации
- [x] Исход гейта G (из T2.3) и первого прогона G3 записаны в Notes плана
- [x] `app.e2e-spec.ts` зелёный без правок (подтверждено в Investigation Notes); повторная проверка — в T2.5
- [x] lint/tsc/build — ноль ошибок на момент T2.4; полный набор гейтов единицы (lint/tsc/prettier/e2e/build) — в T2.5
- [ ] Готово к коммиту — **только в составе единицы T2.4 + T2.5** (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: Phase 3 и Phase 4 (включая T4.1) открываются только при пройденных G (T2.3) и G3 (T2.5); T2.4 гейт G3 не закрывает.
- Owner handoff: красный кейс AC-14.6, `partialTextThenErrorStep` и характеризационный кейс (новые литералы) передаются T2.5; ссылка — `task-T2.5.md`.
- Scope boundary: продуктовый код не менялся; `apps/api/test/app.e2e-spec.ts` не меняется; в файле плана правятся только два пункта Notes.
