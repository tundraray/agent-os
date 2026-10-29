# Phase 3 Completion: Список, создание, переименование, удаление, аудит (шаги 4–6 DD)

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 3)
- Dependencies: T3.1, T3.2, T3.3, T3.4, T3.5 завершены (каждая — «готова к коммиту»)
- Provides: переход к T4.3 (после T4.1–T4.2) и далее к Phase 4; Phase 4 стартует только при пройденных Gate G (T2.3) и Gate G3 (T2.5); Gate G2 снят

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

Это проверочная задача фазы: кода не пишет и файлов не меняет. Исполнитель выполняет проверки и отмечает чек-листы; `git commit` не запускает. Процедуры скопированы из «Operational Verification Procedures» плана (источник — Integration Points Design Doc).

## Task Completion Checklist
- [ ] T3.1 Курсор + `GET /api/threads` + e2e — готова к коммиту
- [ ] T3.2 `ThreadWriteLock` — готова к коммиту
- [ ] T3.3 `POST /api/threads`, `DELETE` + e2e — готова к коммиту
- [ ] T3.4 `PATCH` rename + 13.2a + 13.3 + e2e — готова к коммиту
- [ ] T3.5 `AuditInterceptor` `params.threadId` — готова к коммиту

## Phase Completion Criteria
- [ ] Интеграционные тесты: скелеты 15/21 (`threads.e2e-spec.ts` 14/14, `chat-threads.e2e-spec.ts` 1/7) + доп. 4/5 (T2.2, T2.4, T2.5, T3.1)
- [ ] Unit: `thread-cursor`, `thread-write-lock`, `threads.service`, `audit.interceptor` зелёные
- [ ] lint, tsc, format, unit, e2e, build — без ошибок

## E2E / Operational Verification Procedures (Integration Points 1 и 4 DD)
1. e2e с двумя `x-user-id` на каждый маршрут — чужая беседа неотличима от несуществующей.
2. Каскад: после `DELETE` запрос `SELECT count(*) FROM mastra_messages WHERE thread_id = $1` через клиент `pg` на `DATABASE_URL` возвращает литерал `0`.
3. (Integration Point 4 DD) unit перехватчика: для `/threads/:threadId` записан id маршрута, тело с `id` его не подменяет; для `/chat/:agentId` — `body.threadId ?? body.id`; для `POST /api/threads` с телом `{ id: 'x' }` — `threadId` не записан (`undefined`).

## Failure Response
Любой провал — вернуть соответствующую задачу исполнителю; к Phase 4 не переходить (и убедиться, что Gate G и G3 пройдены).
