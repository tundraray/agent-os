# Overall Design Document: threads-api (chat-shell)

Generation Date: 2026-10-28
Target Plan Document: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (`plan: 1 of 1`, `status: active`)
Design Doc: docs/features/chat-shell/design-threads-api.md v1.8 (Approved); PRD v1.5, UXRD v1.7, `design-web-shell.md` v1.5
Task directory: docs/features/chat-shell/threads-api/20261028-feature-threads-api/

## Project Overview

### Purpose and Goals
Дать клиенту (`web-shell`) серверный контракт бесед над Mastra Memory: список с курсорной пагинацией по 20, явное создание, карточку, историю в формате AI SDK v7 (без текста ошибок инструментов и модели, AC-14.5), переименование, удаление; автозаголовок, не перезаписывающий ручное имя; один ответ после перегенерации ответа, прерванного ошибкой модели или обрывом сети («сброс хвоста», AC-14.6); закрыть «воскрешение» удалённой беседы через `POST /api/chat/:agentId` (AC-16.1).

### Background and Context
Беседы уже сохраняются Mastra (`mastra_threads`, `mastra_messages`), но HTTP-доступа к ним нет; заголовки пустые; `POST /api/chat` создаёт тред с любым клиентским id (удалённый воскресает), чужой тред даёт 500. Кода `apps/api/src/threads`, `apps/api/src/common`, `apps/api/test/support` нет. Новых таблиц и миграций нет.

## Commit Strategy (manual) — действует для всех задач
Стратегия коммитов фичи — `manual`. **Исполнители задач и оркестратор не запускают `git commit`** (а также `git add`/`git push`). Каждая задача завершается в состоянии «готово к коммиту (manual-стратегия)»: изменения в рабочем дереве ветки `feature/chat-shell`, все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе; в сообщениях коммитов нет строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code». Это правило продублировано в каждом task-файле (секция «Commit Strategy (manual)»).

## Task Division Design

### Division Policy
Hybrid (Design Doc): короткий горизонтальный фундамент (Phase 1), затем вертикальные срезы, начиная с самого рискованного (история и «сброс хвоста» — Phase 2, ранняя точка проверки), e2e проверки беседы в чате — последними (Phase 5). 1 задача = 1 единица, готовая к коммиту, **кроме T2.4 + T2.5 — это одна общая единица** (красный кейс AC-14.6 из T2.4 исправляет T2.5, поэтому ни одна из двух не оставляет красное дерево на коммите); T6.2 — только исправления отдельной единицей, T6.3 — без изменений кода. Задач 20 (T1.1–T1.3, T2.1–T2.5, T3.1–T3.5, T4.1–T4.3, T5.1, T6.1–T6.3), единиц, готовых к коммиту, 17–18. ID задач, зависимости, Target Files, гейты и Reference Contract Values сохранены из плана без изменений. Unit-тесты — test-first внутри каждой задачи; интеграционные `it.todo` скелетов наполняются в фазе, где реализуется проверяемое поведение; perf — в Phase 6.

Распределение уровней верификации: L3 — T1.3 (обвязка проверяется типами/сборкой, функционально — в T2.2), L2 — T1.1, T1.2, T2.1–T2.5, T3.1–T3.5, T4.1–T4.3, T5.1, T6.1, T6.2 (часть), L1 — T6.3 и ручные проверки в T1.2/T6.2.

### Execution Order (с учётом зависимостей и гейтов)
1. T1.1 → T1.2 → T1.3 (T1.2 ‖ T1.3 допустимы; T1.3 готова к коммиту после T1.2) → `phase1-completion`
2. T2.1 → T2.2 → T2.3 (**Gate G**) → T2.4 (доказательства AC-14.6, завершена) → T2.5 (**Gate G3**; T2.4 + T2.5 — одна единица коммита) → `phase2-completion` (оба гейта — перед Phase 3 и Phase 4; Gate G2 снят). T2.3, T2.4, T2.5 строго по порядку
3. T3.1, T3.2, T3.5 (параллельно возможны) → T3.3 (после T3.1) → T3.4 (после T3.2, T3.3) → `phase3-completion`
4. T4.1 (после T3.2 **и** Gate G (T2.3) + Gate G3 (T2.5); допустимо параллельно с T3.1/T3.3–T3.5) → T4.2 → T4.3 (после T4.2 и T3.4) → `phase4-completion`
5. T5.1 (только e2e + мутационная проверка; код проверки беседы — T2.5; после T4.3, T3.3, T3.1) → `phase5-completion`
6. T6.1 → T6.2 → T6.3 → `phase6-completion`

### Inter-task Relationship Map
```
T1.1 Контракты → Deliverable: packages/contracts (dist)
 ├─ T1.2 configureApp + ZodValidationPipe → Deliverable: app.setup.ts, common/zod-validation.pipe.ts
 └─ T1.3 test/support (createTestApp, mockModels, seed, db)   [готова к коммиту после T1.2]
      ↓
T2.1 THREAD_MEMORY, errors, mapper, ThreadsModule → Deliverable: threads.errors.ts, thread.mapper.ts
 ↓
T2.2 GET :id, GET :id/messages + e2e → Deliverable: ThreadsService.getOwnedThread, ThreadsController
 ↓
T2.3 EVP: маскирование, стрим ↔ история (Gate G) → Deliverable: `stream-error-text.ts`, `maskToolErrorText`
 ↓
T2.4 AC-14.6: доказательства и характеризация → Deliverable: красный кейс AC-14.6, `partialTextThenErrorStep`, исход первого прогона и хранимое состояние в Notes плана
 ↓ (одна единица коммита T2.4 + T2.5)
T2.5 «Сброс хвоста», `maskHistoryErrors`, `getOwnedThread` в чате (Gate G3) → Deliverable: `ChatMessageRefSchema`, `discardRepliesAfter`, `threads.service.spec.ts`, `chat.module.ts`
 ├─ [Gate G+G3] → T3.1 Курсор + GET /api/threads ──→ T3.3 POST/DELETE ──┐
 ├─ [Gate G+G3] → T3.2 ThreadWriteLock ─────────────────────────────────┴→ T3.4 PATCH rename + 13.2a + 13.3
 ├─ [Gate G+G3] → T3.5 AuditInterceptor
 └─ [Gate G+G3, после T3.2] → T4.1 Агент заголовков → T4.2 ThreadTitleService → T4.3 onFinish + e2e 17.x (+ T3.4)
                                                                                        ↓
                                                                      T5.1 e2e проверки беседы в чате + мутация (код — T2.5)
                                                                                        ↓
                                                                    T6.1 Perf → T6.2 Итоговые гейты (+ T3.5) → T6.3 L1 вручную
```

### Gates
- **Gate G (T2.3 → T2.4, T2.5 и Phase 3)**: сравнение «живой стрим ↔ история» по правилу Output Comparison (исключены `step-start`, `providerMetadata`, `reasoning.id`, `text.state`) после маскирования `errorText` (`'Agent error'` с обеих сторон, AC-14.5) расходится вне правила или теряет содержимое → стоп, эскалация пользователю как изменение PRD; собственный конвертер не писать.
- **Gate G3 (T2.5 → Phase 3, стоп всей реализации)**: первый прогон AC-14.6 (T2.4) дал склейку; пользователь выбрал вариант (1) — «сброс хвоста» (DD v1.8). G3 пройден, когда в T2.5 зелёные: e2e AC-14.6 (неизменный литерал `[['user', ['Вопрос']], ['assistant', ['Ответ 2']]]`, 2 строки `mastra_messages`, плюс утверждения шага 1: типы частей `['text']`, `safeValidateUIMessages`, нет `'mock stream failure'`), вариант «обрыв сети» и характеризация с новыми литералами. **Стоп и эскалация** пользователю с литералами `/messages` и числом строк `mastra_messages` после обрыва (или ошибки) и после перегенерации, если вариант «обрыв сети» показывает хранимое состояние, которое «сброс хвоста» не обрабатывает (частичный ответ записан после повторной отправки, нет сообщения пользователя, лишние строки), либо AC-14.6 остаётся красным; красный кейс не превращается в `it.skip`/`it.todo`; единица T2.4 + T2.5 не готова к коммиту. Phase 4, включая T4.1 при параллельном выполнении с Phase 3, не начинается без G и G3.
- **Gate G2 снят**: `web-shell` скрывает правку, переключение веток и перегенерацию обычных ответов; характеризационный e2e остаётся (в T2.4 зафиксирован, литералы ветки перегенерации меняет T2.5).

### Interface Change Impact Analysis
| Existing Interface | New Interface | Conversion Required | Corresponding Task |
|---|---|---|---|
| `main.ts` (инлайн-настройка HTTP) | `configureApp(app)` в `app.setup.ts` | Yes (перенос без изменения поведения) | T1.2 |
| `index.ts` контрактов | + `export * from './threads.js';` | Yes (одна строка) | T1.1 |
| — | `GET /api/threads`, `POST /api/threads`, `GET/PATCH/DELETE /api/threads/:threadId`, `GET /api/threads/:threadId/messages` | None (новые маршруты) | T2.2, T3.1, T3.3, T3.4 |
| `AuditInterceptor` (`threadId` из тела) | `params.threadId ?? (params.agentId ? body.threadId ?? body.id : undefined)` | Yes | T3.5 |
| `ChatController.onFinish` | + `ThreadTitleService.schedule(...)` (конструктор получает только `ThreadTitleService`) | Yes | T4.3 |
| `POST /api/chat/:agentId` (чужая/удалённая беседа: 500/воскрешение) | 404 `THREAD_NOT_FOUND` до стрима (код — `getOwnedThread` в `ChatController.chat`) | Yes (смена поведения) | T2.5 (код), T5.1 (e2e) |
| `POST /api/chat/:agentId` с тем же последним сообщением пользователя (перегенерация) | хранимый ответ удаляется до `agent.stream` («сброс хвоста»: `ChatMessageRefSchema.safeParse` → `ThreadsService.discardRepliesAfter`), новый ответ — отдельное сообщение; обычная отправка и правка ничего не удаляют | Yes (смена поведения) | T2.5 |
| `maskToolErrorText(messages)` | `maskHistoryErrors(messages)` — та же сигнатура; + удаление частей `type === 'error'` | Yes (переименование; потребители `threads.service.ts`, `thread.mapper.spec.ts`) | T2.5 |
| `packages/contracts/src/threads.ts` | + `ChatMessageRefSchema` / `ChatMessageRef` (`z.looseObject`); `ChatRequestSchema` не меняется | None (добавление) | T2.5 |
| `ChatRequestSchema` | без изменений | None | T1.1 (проверка), T6.2 |

### Common Processing Points
- `ThreadsService.getOwnedThread` — единая точка проверки владельца (T2.2); используется в `GET`, `DELETE`, `PATCH` и в `ChatController` (код — T2.5, e2e — T5.1). Не дублировать проверку.
- `threadNotFound()` (T2.1) — единственное место построения тела 404.
- `ZodValidationPipe` (T1.2) — общая валидация параметров/тела/query по схемам `@agent-os/contracts`.
- `stream-error-text.ts` (T2.3) — единый источник текста ошибки для `onError` чата и `maskToolErrorText` → `maskHistoryErrors` в истории (AC-14.5); не дублировать литерал `'Agent error'`.
- `maskHistoryErrors` (T2.3 как `maskToolErrorText`, T2.5) — единственное место, где история освобождается от сырого текста ошибок инструментов (маскирование) и модели (удаление частей `error`).
- `ThreadsService.discardRepliesAfter` (T2.5) — единственное место «сброса хвоста»; в `deleteMessages` уходят только `id` из `recall`.
- Строка `usage agent=thread-title thread=<id> input=<n> output=<n>` (T4.2) — тот же формат, что строка `usage` чата; только id и числа.
- `ThreadWriteLock` (T3.2) — общий lock записи для `rename` (T3.4) и `ThreadTitleService` (T4.2).
- `test/support/*` (T1.3, расширяется в T4.3) — общая обвязка всех e2e; `seed` с `prefix = randomUUID()` на тест.

### Shared-file Ordering (пересечения — только последовательно)
- `threads.service.ts`: T2.2 → T2.3 (`listMessages`) → T2.5 (`discardRepliesAfter`, `listMessages`) → T3.1 → T3.3 → T3.4; `threads.service.spec.ts`: T2.5 (создание) → T3.4; `threads.controller.ts`: T2.2 → T3.1 → T3.3 → T3.4
- `packages/contracts/src/threads.ts`: T1.1 → T2.5
- `thread.mapper.ts` / `thread.mapper.spec.ts`: T2.1 → T2.3 → T2.5
- `createTestApp.ts`: T1.3 → T4.3; `mockModels.ts`: T1.3 → T2.4 (сценарий «часть текста, затем ошибка») → T2.5 (сценарий «поток не завершается») → T4.3; `db.ts`: T1.3 → T2.3
- `threads.module.ts`: T2.1 → T2.2 → T3.2 → T4.1 → T4.2
- `chat.controller.ts`: T2.3 (только `onError`) → T2.5 (`ThreadsService`, `getOwnedThread`, «сброс хвоста») → T4.3 (`onFinish`, `ThreadTitleService`); T5.1 production-код не меняет (мутационная проверка — временная, с восстановлением)
- `chat.module.ts`: T2.5 (единственная правка; T4.3 не трогает)
- `threads.e2e-spec.ts`: T2.2 → T2.3 → T3.1 → T3.3 → T3.4
- `chat-threads.e2e-spec.ts`: T2.4 → T2.5 → T4.3 → T5.1
- файл плана (Notes): T2.4 («Повторный прогон гейта G», «Проверка AC-14.6, гейт G3» — первый прогон) → T2.5 («Гейт G3 после «сброса хвоста»», «Хранимое состояние после обрыва сети») → T6.1 («Решение о `test:perf`») → T6.3 («L1 / метрики»)
- T2.4 и T2.5 делят `mockModels.ts` и `chat-threads.e2e-spec.ts` и образуют одну единицу коммита

## Implementation Considerations

### Principles to Maintain Throughout
1. Один task-файл = одна единица, готовая к коммиту; исполнители не коммитят (стратегия `manual`).
2. Файлы вне Target Files задачи не меняются; нужда в них — эскалация, а не расширение объёма.
3. Перед vitest после правки `packages/contracts`: `pnpm --filter @agent-os/contracts build`; перед e2e: `pnpm db:up` и `apps/api/.env` с `DATABASE_URL`.
4. Скелеты `it.todo` наполняются по комментариям Arrange/Act/Assert; пустые заглушки запрещены; ожидаемые значения — литералы.
5. `apps/api/test/app.e2e-spec.ts` и `ChatRequestSchema` не меняются (AC-18.3).
6. Без `as`-обхода для `toAISdkMessages`; без молчаливых fallback; логи без `error.message`, текстов сообщений и заголовков.
7. Без миграций и новых таблиц.

### Risks and Countermeasures
- Risk: `toAISdkMessages` теряет данные, видимые в стриме.
  Countermeasure: EVP в T2.2–T2.3, маскирование из `stream-error-text.ts`, Gate G; без собственного конвертера.
- Risk: перегенерация ответа, завершившегося ошибкой модели или обрывом сети, склеивает частичный ответ с новым или дублирует сообщения (AC-14.6, Certainty: low; первый прогон T2.4 дал склейку).
  Countermeasure: «сброс хвоста» в T2.5 до шагов 4–8; Gate G3 — e2e AC-14.6 с литералом, вариант «обрыв сети» и характеризация; стоп и эскалация, если хранимое состояние после обрыва не обрабатывается.
- Risk: правка обычного ответа оставляет реплики отброшенной ветки; «сброс хвоста» не отличает ответ с ошибкой от успешного.
  Countermeasure: `web-shell` скрывает правку, ветвление и перегенерацию обычных ответов; характеризация в T2.4/T2.5 краснеет при смене поведения Mastra (Gate G2 снят).
- Risk: новые провайдеры ломают загрузку `AppModule` в неизменяемом `app.e2e-spec.ts`.
  Countermeasure: фабрики без сети при создании; `app.e2e-spec.ts` в гейтах T2.1, T4.1, T4.3, T5.1.
- Risk: параллельные e2e-файлы на общей БД сталкиваются по PK; perf шумит.
  Countermeasure: `prefix = randomUUID()` в `seed`, уникальный `resourceId`; perf-правило T6.1.
- Risk: после T2.5 (проверка беседы в чате перенесена из T5.1) прототип `apps/web/src/components/assistant.tsx` получает 404 на каждую отправку.
  Countermeasure: решение пользователя — обе части на `feature/chat-shell`, слияние в `main` вместе с `web-shell`; T5.1 — последняя задача реализации (только e2e).
- Risk: устаревший `dist` contracts при прямом запуске vitest.
  Countermeasure: правило № 2 плана; в T6.2 — `pnpm test` (turbo, `^build`).

### Impact Scope Management
- Allowed change scope: `packages/contracts/src/{threads,index}.ts`, `apps/api/src/{app.setup,main,app.module}.ts`, `apps/api/src/common/**`, `apps/api/src/threads/**`, `apps/api/src/audit/audit.interceptor*.ts`, `apps/api/src/chat/{chat.controller,chat.module}.ts` (`chat.module.ts` — только T2.5), `apps/api/test/**` (кроме `app.e2e-spec.ts`), `apps/api/package.json`, `pnpm-lock.yaml`, `apps/api/.env.example`, пункты Notes плана (T2.4, T2.5, T6.1, T6.3).
- No-change areas: `apps/api/test/app.e2e-spec.ts`; `ChatRequestSchema`; `apps/api/src/audit/audit.service.ts`; `apps/api/src/mastra/**`; `apps/web/**`; миграции/схема БД.

## Verification Strategy Summary
- Correctness: (а) каждый AC проходит автоматический тест на реальном Postgres; (б) `/messages` эквивалентна живому стриму v7 (кроме `step-start`, `providerMetadata`); (в) ни один маршрут не раскрывает и не изменяет беседу другого `resourceId`.
- Early Verification Point: срез `GET /api/threads/:id/messages` — Phase 2 (T2.2–T2.5): сравнение со стримом (G), AC-14.5 (a)/(b), AC-14.6 после «сброса хвоста» (G3).
- Quality gates задачи (ноль ошибок): `pnpm --filter api lint`; `pnpm --filter api exec tsc --noEmit -p tsconfig.json`; `pnpm --filter api exec prettier --check "src/**/*.ts" "test/**/*.ts"`; `pnpm --filter api test`; `pnpm --filter api test:e2e` (если затронут e2e/HTTP); `pnpm --filter api build`.
- Среда: Postgres на хост-порту **5433**; `DATABASE_URL=postgres://agent:agent@localhost:5433/agent_os` в `apps/api/.env`; перед e2e — `pnpm db:up`.

## Task File Index
| ID | File | Depends on | Phase |
|---|---|---|---|
| T1.1 | task-T1.1.md | — | 1 |
| T1.2 | task-T1.2.md | T1.1 | 1 |
| T1.3 | task-T1.3.md | T1.1 (готова после T1.2) | 1 |
| — | phase1-completion.md | T1.1–T1.3 | 1 |
| T2.1 | task-T2.1.md | T1.2, T1.3 | 2 |
| T2.2 | task-T2.2.md | T2.1 | 2 |
| T2.3 | task-T2.3.md | T2.2 | 2 |
| T2.4 | task-T2.4.md | T2.3 (Gate G); завершена как задача доказательств; единица коммита T2.4 + T2.5 | 2 |
| T2.5 | task-T2.5.md | T2.4, T2.3 (Gate G3 проходит здесь) | 2 |
| — | phase2-completion.md | T2.1–T2.5 (Gate G, G3) | 2 |
| T3.1 | task-T3.1.md | T2.3 (G), T2.5 (G3) | 3 |
| T3.2 | task-T3.2.md | T2.3 (G), T2.5 (G3) | 3 |
| T3.3 | task-T3.3.md | T3.1 | 3 |
| T3.4 | task-T3.4.md | T3.2, T3.3 (дополняет `threads.service.spec.ts` из T2.5) | 3 |
| T3.5 | task-T3.5.md | T2.3 (G), T2.5 (G3) | 3 |
| — | phase3-completion.md | T3.1–T3.5 | 3 |
| T4.1 | task-T4.1.md | T2.1, T3.2, T2.3 (Gate G), T2.5 (Gate G3) | 4 |
| T4.2 | task-T4.2.md | T3.2, T4.1 | 4 |
| T4.3 | task-T4.3.md | T4.2, T3.4, T2.5 (`ChatController` с `ThreadsService`, `ChatModule.imports`) | 4 |
| — | phase4-completion.md | T4.1–T4.3 (G, G3) | 4 |
| T5.1 | task-T5.1.md | T4.3, T2.5 (код проверки), T3.3 (`DELETE`), T3.1 (список) | 5 |
| — | phase5-completion.md | T5.1 | 5 |
| T6.1 | task-T6.1.md | T5.1 | 6 |
| T6.2 | task-T6.2.md | T3.5, T6.1 | 6 |
| T6.3 | task-T6.3.md | T6.2 | 6 |
| — | phase6-completion.md | T6.1–T6.3 | 6 |

## Plan Coverage Notes
- Все 20 задач плана (T1.1–T1.3, T2.1–T2.5, T3.1–T3.5, T4.1–T4.3, T5.1, T6.1–T6.3) покрыты task-файлами; 6 phase-completion файлов сгенерированы по слову «Phase» в плане.
- Намеренные пробелы плана (задач нет): потребление контракта `web-shell` п. 1–9; Future Extensibility (SQL keyset, `titlePinned`, advisory lock, `data-thread-title`); риски гонки удаления между `getOwnedThread` и `agent.stream` и осиротевших сообщений — приняты Design Doc.
- Дополнительные e2e вне скелетов (5): T2.2 (empty input), T2.4 (AC-14.6: ошибка модели → перегенерация; зелёным его делает T2.5), T2.5 (AC-14.6, вариант «обрыв сети»), T3.1 (курсор 513 символов), T4.3 (`PATCH` во время генерации). Скелеты: 21 интеграционный `it.todo` + 2 perf.
