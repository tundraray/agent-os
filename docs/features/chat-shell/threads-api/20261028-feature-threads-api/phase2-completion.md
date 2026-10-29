# Phase 2 Completion: Ранняя точка проверки — карточка, история, «сброс хвоста» (шаг 3 DD и код шага 8)

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 2)
- Dependencies: T2.1, T2.2, T2.3, T2.4, T2.5 завершены; Gate G (T2.3) и Gate G3 (T2.5) пройдены (иначе эскалация и остановка)
- Provides: переход к Phase 3 (T3.1, T3.2, T3.5); Phase 4 (включая T4.1) — тоже только после G и G3; Gate G2 снят

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

Это проверочная задача фазы: кода не пишет и файлов не меняет (кроме отметок в Progress Tracking плана, если оркестратор это требует). Исполнитель выполняет проверки и отмечает чек-листы; `git commit` не запускает. Процедуры скопированы из «Operational Verification Procedures» плана (источник — E2E-проверки Design Doc, Integration Points).

## Task Completion Checklist
- [ ] T2.1 `THREAD_MEMORY`, errors, mapper, `ThreadsModule` — готова к коммиту
- [ ] T2.2 `GET :id`, `GET :id/messages` + e2e — готова к коммиту
- [ ] T2.3 Маскирование ошибок + сравнение со стримом (Gate G) — готова к коммиту
- [ ] T2.4 Проверка AC-14.6 — доказательства и характеризация (завершена как задача доказательств; красный кейс AC-14.6 передан T2.5); **готова к коммиту только в составе единицы T2.4 + T2.5**; исходы G и первого прогона G3 и хранимое состояние после ошибки модели записаны в Notes плана
- [ ] T2.5 «Сброс хвоста» + `maskHistoryErrors` + `getOwnedThread` в чате (Gate G3) — единица T2.4 + T2.5 готова к коммиту (manual-стратегия); исход G3 и хранимое состояние после обрыва сети записаны в Notes плана

## Phase Completion Criteria
- [ ] Интеграционные тесты: скелеты 4/21 (`threads.e2e-spec.ts` 3/14, `chat-threads.e2e-spec.ts` 1/7) + доп. 3/5 (T2.2 empty input, T2.4 AC-14.6, T2.5 «обрыв сети»)
- [ ] Unit `stream-error-text.spec.ts`, `thread.mapper.spec.ts` (вкл. `maskHistoryErrors`), `threads.service.spec.ts` (`discardRepliesAfter`) зелёные
- [ ] Success criteria EVP выполнены (схема + `safeValidateUIMessages`, литералы, одинаковый 404, сравнение со стримом по правилу Output Comparison, `errorText` — `'Agent error'` с обеих сторон)
- [ ] Гейты G (T2.3) и G3 (T2.5) пройдены. При провале — эскалация отправлена, Phase 2 не завершена до решения пользователя
- [ ] Хранимое состояние после ошибки модели (T2.4) и после обрыва сети (T2.5) записано в Notes плана и передано оркестратору
- [ ] lint, tsc, format, unit, e2e, build — без ошибок; единицы T2.1, T2.2, T2.3, T2.4 + T2.5 готовы к коммиту

## E2E / Operational Verification Procedures (Integration Point 2 DD)
1. Засеять беседу, отправить через `POST /api/chat/assistant` сообщение mock-модели с reasoning и двумя инструментами.
2. `GET /api/threads/:id/messages` → `safeValidateUIMessages` успешен, части совпадают с литералами: `reasoning` (`state: "done"`), `tool-getWeather` (`output-available`, `output`), `tool-failing` (`output-error`, `errorText: 'Agent error'`).
3. Тот же запрос от другого `x-user-id` и для несуществующего id → одинаковое тело 404 `THREAD_NOT_FOUND`.
4. `UIMessage` из SSE того же ответа совпадает с историей по правилу Output Comparison; в `mastra_messages` — `'boom'`.

(Integration Point 2a DD)
5. AC-14.6: ошибка модели посреди стрима → `/messages` — ответ только с частью `text 'Частичный'`, без `'mock stream failure'` → перегенерация тем же сообщением пользователя → `[['user', ['Вопрос']], ['assistant', ['Ответ 2']]]`, 2 строки.
6. То же после обрыва SSE клиентом (вариант «обрыв сети») → тот же литерал, 2 строки.

## Failure Response
Расхождение вне правила Output Comparison или потеря данных (Gate G) — стоп и эскалация пользователю как изменение PRD; Phase 3 не начинать. Провал AC-14.6 (Gate G3, T2.5) — стоп всей реализации и эскалация пользователю с литералами `/messages` и числом строк `mastra_messages` после обрыва (или ошибки) и после перегенерации; то же, если вариант «обрыв сети» показывает хранимое состояние, которое «сброс хвоста» не обрабатывает. Красный кейс не превращается в `it.skip`/`it.todo`; единица T2.4 + T2.5 не готова к коммиту. Остальные провалы — вернуть задачу исполнителю.
