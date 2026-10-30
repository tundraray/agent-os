# Task T7.3: Блок ошибки ответа с «Перегенерировать», выключатель `regenerateAfterError`, слот `DeletedNotice`, классификация 404 `THREAD_NOT_FOUND`; интеграционные `shell.message-error` и `shell.deleted-thread`

Metadata:
- Task type: frontend (apps/web)
- Phase: 7
- Dependencies: task-T7.2 → Deliverable: `thread.aui.tsx` (action bar «Копировать»); также `main-view.tsx`, `thread-notice.tsx` (T3.4/T4.3), `shell-services.ts` (T1.2), `config.ts` (T1.1)
- Provides: `MessageError`, слот `DeletedNotice`, `handleChatError` с классификацией E-8, `regenerateAfterError`
- Size: Large по файлам (9–10): единая единица (блок ошибки, слот и классификация неделимы); при превышении объёма — эскалация оркестратору, не расширять самовольно
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; Postgres 5433 для dev/L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны (**правило 10** — для `shell.message-error` и `shell.deleted-thread`).

## Implementation Content
Блок ошибки ответа (TH-08) с «Перегенерировать» у последнего ответа, выключатель `regenerateAfterError`, слот `ThreadComponents.DeletedNotice` («Беседа удалена», E-8), классификация 404 `THREAD_NOT_FOUND` до SSE. Наполняет `shell.message-error` и `shell.deleted-thread` (интеграционные 10/10). AC-08.5, AC-08.5a–e; Element 2; E-8; IP1 404.

## Target Files
- [x] `apps/web/src/components/assistant-ui/elements/thread.aui.tsx` (`MessageError`, слот `DeletedNotice` в `ThreadComponents`, скрытие композера при слоте)
- [x] `apps/web/src/lib/config.ts` (`regenerateAfterError = true`)
- [x] `apps/web/src/lib/threads/shell-services.ts` (`handleChatError`: `APICallError` 404 + `ApiErrorSchema` `THREAD_NOT_FOUND` → `status.setHistory(remoteId, 'deleted')`)
- [x] `apps/web/src/components/shell/thread-notice.tsx` (вариант `deleted`, экспорт `DeletedNotice`)
- [x] `apps/web/src/components/shell/thread-notice.test.tsx` (строка E-8)
- [x] `apps/web/src/components/shell/main-view.tsx` (`DeletedNotice: deleted ? DeletedNotice : undefined`)
- [x] `apps/web/src/components/assistant-ui/elements/message-error.test.tsx` (new)
- [x] `apps/web/src/lib/threads/shell-services.test.ts` (new)
- [x] `apps/web/src/components/shell/shell.message-error.int.test.tsx`
- [x] `apps/web/src/components/shell/shell.deleted-thread.int.test.tsx`

## Investigation Targets
- `@assistant-ui/ai-sdk` `runtime/useAISDKRuntime.js:219-226, 648`
- `@assistant-ui/core` `runtime/utils/external-message-conversion.js:257-285`
- `ai` `dist/index.js:20244-20293` (`APICallError`)
- DD «Action bar и ошибки в ленте», «AC-08.5e, E-8»; UXRD 6.19, 6.20, 7.4
- `apps/web/src/components/shell/shell.message-error.int.test.tsx`, `shell.deleted-thread.int.test.tsx` (перенесены в T2.1)
- `thread.aui.tsx` (T7.2), `lib/focus.ts` (`focusAfterNewChat`)
- `packages/contracts` — `ApiErrorSchema`; `apps/api/src/chat/chat.controller.ts` (`THREAD_NOT_FOUND`) — только чтение

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Action bar и ошибки в ленте) | derived-display | `regenerateAfterError` `true` (поставка): «Не удалось получить ответ. Попробуйте перегенерировать.» · кнопка «Есть у последнего ответа» · `aria-describedby` «У кнопки → `id` текста»; `false`: «Не удалось получить ответ.» · «Нет» · «Нет — нет кнопки» | Y, если тексты и поведение кнопки в обоих значениях выключателя совпадают |
| design-web-shell.md (§ Action bar и ошибки в ленте, «Копировать») | structure-order | «Порядок Tab внутри реплики не меняется: содержимое → «Перегенерировать» (если есть) → «Копировать» (UXRD 7.3).» | Y, если «Перегенерировать» в DOM между содержимым и «Копировать» |
| design-web-shell.md (§ AC-08.5e, E-8) | derived-display | «уведомление «Беседа удалена» / «Её удалили в другой вкладке или окне.» с кнопкой «Новый чат» и без «Перегенерировать» и скрыть композер» | Y, если при `deleted` рендерится именно это, композер скрыт |
| Connection Map плана («Транспорт → 404 чата») | derived-display | `APICallError.isInstance(e) && e.statusCode === 404`, `responseBody` → `ApiErrorSchema`, `errorCode === 'THREAD_NOT_FOUND'` → статус `deleted` | Y, если иные 404/ошибки статус не меняют |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| Блок ошибки | `data-slot="message-error"`, текст в `role="alert"` с `id` из `useId()` (`text-foreground`, рамка/иконка `--destructive`), тексты по выключателю | План T7.3 |
| «Перегенерировать» | `Button variant="outline" size="sm"` через `render` у `ActionBarPrimitive.Reload`, `pressable`, `pointer-coarse:h-11`, `aria-describedby`, только у последнего (`AuiIf` по `s.message.isLast`); после нажатия — `focusAfterNewChat()` | План T7.3 |
| Слот `DeletedNotice` | задан → вместо блока рендерится `DeletedNotice` (`h2` «Беседа удалена», текст в `role="alert"`, «Новый чат», фокус на «Новый чат» только если он был в скрытом композере); композер не рендерится | План T7.3 |
| `responseBody` | в ленту не попадает | План T7.3 |
| Тесты | C `message-error.test.tsx` — случаи 1–6 DD (`useLocalRuntime` с адаптером модели, бросающим ошибку с английским текстом); C `thread-notice.test.tsx` — строка E-8; I `shell.message-error` — 1 тест AC-08.5b (первый ответ «Частичный» + ошибка, новая отправка → у первого ответа нет блока и кнопки, «Частичный» виден, ни одной «Перегенерировать»); I `shell.deleted-thread` — 1 тест AC-08.5e (404 `THREAD_NOT_FOUND` до SSE → уведомление под сообщением, нет TH-08 и «Перегенерировать», нет композера, нет пустой строки ответа и «Копировать»; «Новый чат» → `/` с приветствием и композером); U `shell-services.test.ts` — таблица `handleChatError` | План T7.3 |
| `shell-services.test.ts` | Новый файл вне DD, добавлен планом: ловит дефект «любой 404 превращается в «Беседа удалена»», который I-тест не видит | План, Test Strategy |
| Таблица `handleChatError` | `APICallError` 404 + `errorCode: 'THREAD_NOT_FOUND'` → статус `deleted`; 404 с другим `errorCode`, 404 с неразбираемым `responseBody`, 500, не `APICallError` → статус не меняется | План T7.3 |

## Investigation Notes
(Правило 10: Assert `shell.message-error` («Частичный», «Перегенерировать», блок ошибки) — T7.3; Assert `shell.deleted-thread` («Беседа удалена», «Новый чат», приветствие «Чем могу помочь?» (T3.4), композер «Сообщение» (T3.4), «Копировать» отсутствует (T7.2)) — подтвердить поставку.)

- Правило 10 сверено: все строки Assert обоих I-кейсов поставлены T3.4/T7.2/T7.3; отрицательные утверждения («Перегенерировать», «Не удалось получить ответ», `[data-slot="message-error"]`, `textbox`) проверены против поставленных в этой задаче элементов — мутации их краснят.
- `ai` 7.0.155 `createUIApiCallError`: не-ok ответ чата → `APICallError { statusCode, responseBody, message: responseBody }` — сырой JSON попадает в `error.message`, поэтому лента читает только фиксированный текст, а лог — только `{ remoteId, name, statusCode }`.
- Классификация вынесена в экспорт `reportChatError({ error, remoteId, status })` (`shell-services.ts`); `handleChatError` вызывает его с `remoteIdOf(aui)` — U-тест работает с реальным `ShellStatusStore` и реальным `APICallError` без подделки `AssistantClient`.
- `MainView`: `DeletedNotice` передаётся отдельной константой `DELETED_THREAD_COMPONENTS` (`view.kind === 'thread' && view.deleted`), `Thread` остаётся одним элементом (композер не перемонтируется в `switching`/`thread`).
- `DeletedNotice` (вариант `deleted` у `ThreadNotice`): `section` с `h2` «Беседа удалена», текст в `role="alert"`, «Новый чат» `size="sm"`, `pointer-coarse:h-11`, `aria-describedby` → текст (UXRD 7.2 TH-07 Deleted while open). Фокус переносится на «Новый чат» при монтировании, только если активен `<body>` — фокус выпал из скрытого композера; при фокусе в другом месте (сайдбар) не трогается.
- «Перегенерировать»: класс `pressable` в проекте не определён (только локальная константа в `tool-fallback.aui.tsx` со scale 0.98) — использован `active:scale-[0.96]` по UXRD 6.20 + `motion-reduce` + `pointer-coarse:h-11`.
- Отклонения от текста скелета `shell.deleted-thread` (по DD v1.10, который старше скелета v1.9): (1) скелет требовал «нет heading» — DD `ThreadNotice` `deleted` задаёт `h2` «Беседа удалена»; ассерт заменён на «нет `h1` „Беседа удалена“, есть `h2`»; (2) скелет требовал `[data-role="assistant"]` ровно 1 — заглушка ошибки по T7.2 остаётся корнем `data-role="assistant"` без строки (на этом стоит `message-actions.test.tsx`, его не менять), поэтому «нет строки у заглушки» проверяется как ровно один `aui_assistant-message-content` и один `aui_assistant-message-footer`.
- Случай «ошибка до первого токена — только блок ошибки» (перенесён из T7.2) — `message-error.test.tsx` case 1a.
- Мутации (записано): `isThreadNotFound` → `return true` (классификация только по `statusCode`/любой ошибке) — 4 из 9 тестов `shell-services.test.ts` красные; `regenerateAfterError || true` (выключатель не влияет на кнопку) — case 4 `message-error.test.tsx` красный. Возвращено.
- Reference Contracts: строка 1 (тексты/кнопка/`aria-describedby` в обоих значениях выключателя) — Y (case 1, 2, 4); строка 2 (DOM: «Перегенерировать» между содержимым и «Копировать») — Y (case 2, `compareDocumentPosition`); строка 3 (E-8, композер скрыт) — Y (case 6, I `shell.deleted-thread`); строка 4 (только 404 + `THREAD_NOT_FOUND` → `deleted`) — Y (`shell-services.test.ts`).
- Гейты: eslint 0, `tsc --noEmit` 0, `vitest run` 36 файлов / 251 тест зелёные (первые два прогона дали таймауты 5 с у 6–8 I-тестов, в том числе не связанных с задачей, — нагрузка машины; третий прогон зелёный), `next build` — успешно. Интеграционные 10/10, `it.todo` — 0.

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [x] Прочитать Investigation Targets; сверить Assert I-кейсов (правило 10)
- [x] C `message-error.test.tsx` — случаи 1–6 DD
- [x] C `thread-notice.test.tsx` — строка E-8 (тексты, «Новый чат»)
- [x] U `shell-services.test.ts` — таблица `handleChatError`
- [x] I `shell.message-error.int.test.tsx` — AC-08.5b
- [x] I `shell.deleted-thread.int.test.tsx` — AC-08.5e
- [x] Запустить, увидеть падение

### 2. Green Phase
- [x] `config.ts` (`regenerateAfterError`), `shell-services.ts` (`handleChatError`), `thread.aui.tsx` (`MessageError`, слот), `thread-notice.tsx`, `main-view.tsx`; тесты зелёные

### 3. Refactor Phase
- [x] Упростить; интеграционные 10/10 (todo: 0)

## Quality Assurance Mechanisms
- Vitest + RTL + MSW, ESLint, `tsc`, `next build` — Type: `executable_check`
- Политика фокуса; WCAG 2.1 AA — Type: `passive_constraint`
- Интеграция с `unstable_` API изолирована в `lib/threads/*` — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: C, U, I + гейты. Браузер (L1-7, L1-10, T8.3; Phase 7 Operational 1): во второй вкладке удалить беседу, открытую в первой, отправить — сообщение видно, «Беседа удалена» / «Её удалили в другой вкладке или окне.», «Новый чат», нет «Перегенерировать», нет композера.
- **Success criteria**: C, U, I зелёные; интеграционные 10/10; lint/tsc/build — 0.
- **Failure response**: расхождение с `useAISDKRuntime` — эскалация со ссылкой на строки; кейс требует элемента вне поставки — эскалация.
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-08.5b — блок ошибки и «Перегенерировать» у нового, не у старого ответа
- **Claim**: после новой отправки у первого ответа нет блока и кнопки; «Частичный» виден; ни одной «Перегенерировать».
- **Primary failure mode**: блок/кнопка остаются у старого ответа.
- **Boundary to exercise**: интеграционный.
- **State assertion**: ответ 1 (ошибка) → новая отправка → у ответа 1 нет блока/кнопки.
- **Mock boundary rationale**: сеть — MSW (SSE v7).
- **Proven by**: `new: shell.message-error.int.test.tsx — AC-08.5b`.
- **Residual**: L1-10 B.

### Obligation: AC-08.5e / E-8 — «Беседа удалена» вместо блока ошибки
- **Claim**: 404 `THREAD_NOT_FOUND` до SSE → уведомление под сообщением, нет TH-08 и «Перегенерировать», нет композера, нет пустой строки и «Копировать»; «Новый чат» → `/` с приветствием и композером.
- **Primary failure mode**: 404 без `responseBody` классифицирован как обычная ошибка TH-08.
- **Boundary to exercise**: интеграционный.
- **State assertion**: ошибка → «Беседа удалена» → «Новый чат» → `/`.
- **Mock boundary rationale**: сеть — MSW; `next/navigation` — мок.
- **Proven by**: `new: shell.deleted-thread.int.test.tsx — AC-08.5e`.
- **Residual**: L1-7.

### Obligation: classification `handleChatError`
- **Claim**: только 404 + `THREAD_NOT_FOUND` ставит статус `deleted`.
- **Primary failure mode**: классификация только по `statusCode` — любой 404 даёт «Беседа удалена».
- **Boundary to exercise**: in-process unit (таблица).
- **State assertion**: `ShellStatus.history[remoteId]` после вызова.
- **Mock boundary rationale**: `APICallError` — реальный из `ai`.
- **Proven by**: `new: shell-services.test.ts — таблица handleChatError` (дефект, не видимый I-тесту).
- **Residual**: нет.

### Obligation: AC-08.5 / 08.5a / 08.5c / 08.5d — тексты блока и выключатель
- **Claim**: тексты и поведение кнопки при `regenerateAfterError` true/false; английский текст ошибки модели не выводится.
- **Primary failure mode**: выключатель не влияет на кнопку (краснит случай 4 `message-error.test.tsx`); текст ошибки провайдера протекает.
- **Boundary to exercise**: компонентный (`useLocalRuntime` + бросающий адаптер).
- **State assertion**: N/A.
- **Mock boundary rationale**: адаптер модели — фейк.
- **Proven by**: `new: message-error.test.tsx — случаи 1–6`; `thread-notice.test.tsx` — E-8.
- **Residual**: L1-10.

## Completion Criteria
- [x] C, U, I зелёные; интеграционные 10/10
- [x] lint, tsc, build — 0 ошибок
- [x] Мутации (классификация только по `statusCode`; выключатель не влияет на кнопку) краснят тесты (записано)
- [x] Reference Contracts — `Y`; Resolved decisions применены

## Notes
- Impact scope: `thread.aui.tsx` далее правит T7.5; `shell-services.ts`, `main-view.tsx`, `thread-notice.tsx`, `config.ts` — последние правки.
- Scope boundary: `apps/api` не менять (404 `THREAD_NOT_FOUND` уже реализован в `threads-api`).
