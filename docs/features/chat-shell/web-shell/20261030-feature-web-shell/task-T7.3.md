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
- [ ] `apps/web/src/components/assistant-ui/elements/thread.aui.tsx` (`MessageError`, слот `DeletedNotice` в `ThreadComponents`, скрытие композера при слоте)
- [ ] `apps/web/src/lib/config.ts` (`regenerateAfterError = true`)
- [ ] `apps/web/src/lib/threads/shell-services.ts` (`handleChatError`: `APICallError` 404 + `ApiErrorSchema` `THREAD_NOT_FOUND` → `status.setHistory(remoteId, 'deleted')`)
- [ ] `apps/web/src/components/shell/thread-notice.tsx` (вариант `deleted`, экспорт `DeletedNotice`)
- [ ] `apps/web/src/components/shell/thread-notice.test.tsx` (строка E-8)
- [ ] `apps/web/src/components/shell/main-view.tsx` (`DeletedNotice: deleted ? DeletedNotice : undefined`)
- [ ] `apps/web/src/components/assistant-ui/elements/message-error.test.tsx` (new)
- [ ] `apps/web/src/lib/threads/shell-services.test.ts` (new)
- [ ] `apps/web/src/components/shell/shell.message-error.int.test.tsx`
- [ ] `apps/web/src/components/shell/shell.deleted-thread.int.test.tsx`

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

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать Investigation Targets; сверить Assert I-кейсов (правило 10)
- [ ] C `message-error.test.tsx` — случаи 1–6 DD
- [ ] C `thread-notice.test.tsx` — строка E-8 (тексты, «Новый чат»)
- [ ] U `shell-services.test.ts` — таблица `handleChatError`
- [ ] I `shell.message-error.int.test.tsx` — AC-08.5b
- [ ] I `shell.deleted-thread.int.test.tsx` — AC-08.5e
- [ ] Запустить, увидеть падение

### 2. Green Phase
- [ ] `config.ts` (`regenerateAfterError`), `shell-services.ts` (`handleChatError`), `thread.aui.tsx` (`MessageError`, слот), `thread-notice.tsx`, `main-view.tsx`; тесты зелёные

### 3. Refactor Phase
- [ ] Упростить; интеграционные 10/10 (todo: 0)

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
- [ ] C, U, I зелёные; интеграционные 10/10
- [ ] lint, tsc, build — 0 ошибок
- [ ] Мутации (классификация только по `statusCode`; выключатель не влияет на кнопку) краснят тесты (записано)
- [ ] Reference Contracts — `Y`; Resolved decisions применены

## Notes
- Impact scope: `thread.aui.tsx` далее правит T7.5; `shell-services.ts`, `main-view.tsx`, `thread-notice.tsx`, `config.ts` — последние правки.
- Scope boundary: `apps/api` не менять (404 `THREAD_NOT_FOUND` уже реализован в `threads-api`).
