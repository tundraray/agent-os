# Phase 4 Completion: Автозаголовок (шаг 7 DD)

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 4)
- Dependencies: T4.1, T4.2, T4.3 завершены (каждая — «готова к коммиту»); гейты G (T2.3) и G3 (T2.5) пройдены
- Provides: переход к Phase 5 (T5.1)

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

Это проверочная задача фазы: кода не пишет и файлов не меняет. Исполнитель выполняет проверки и отмечает чек-листы; `git commit` не запускает. Процедуры скопированы из «Operational Verification Procedures» плана (источник — Integration Point 3 Design Doc).

## Task Completion Checklist
- [ ] T4.1 Агент заголовков + normalize + `TITLE_MODEL` — готова к коммиту
- [ ] T4.2 `ThreadTitleService` (вкл. шаг 5 и лог `usage agent=thread-title`) — готова к коммиту
- [ ] T4.3 `onFinish` → `schedule` (конструктор получает только `ThreadTitleService`; `chat.module.ts` не правится) + e2e 17.x — готова к коммиту

## Phase Completion Criteria
- [ ] Интеграционные тесты: скелеты 18/21 (`chat-threads.e2e-spec.ts` 4/7) + доп. 5/5 (T2.2, T2.4, T2.5, T3.1, T4.3)
- [ ] Unit `thread-title.agent`, `thread-title.service` (вкл. кейс таймаута с обёрнутой ошибкой, обрезку 2 500 → 2 000 и строку `usage agent=thread-title`) зелёные
- [ ] lint, tsc, format, unit, e2e, build — без ошибок

## E2E / Operational Verification Procedures (Integration Point 3 DD)
1. e2e: после стрима `GET /api/threads/:id` возвращает заголовок ≤ 10 с (опрос 100 мс).
2. `PATCH` до генерации (AC-17.2) и во время генерации (доп. e2e T4.3: задержка 1 500 мс, `'Ручной'` на +2 с и +5 с) → ручной заголовок сохраняется (Integration Verification Points: фоновая запись параллельно с `PATCH` на реальной БД).
3. Лог предупреждения содержит `Title generation failed thread=<id> reason=` и не содержит текста сообщения.
4. После генерации в логе есть строка `usage agent=thread-title thread=<id> input=<n> output=<n>`; строка `usage` чата не изменилась.

## Failure Response
Любой провал — вернуть соответствующую задачу исполнителю; к Phase 5 не переходить.
