# Phase 5 Completion: Смена поведения `POST /api/chat/:agentId` (шаг 8 DD)

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 5)
- Dependencies: T5.1 завершена («готова к коммиту»)
- Provides: переход к Phase 6 (T6.1)

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

Это проверочная задача фазы: кода не пишет и файлов не меняет. Исполнитель выполняет проверки и отмечает чек-листы; `git commit` не запускает. Процедуры скопированы из «Operational Verification Procedures» плана (источник — Integration Point 2 Design Doc).

## Task Completion Checklist
- [ ] T5.1 e2e проверки беседы в `POST /api/chat/:agentId` (код `getOwnedThread` — T2.5) + мутационная проверка — готова к коммиту; `chat.controller.ts` восстановлен после мутации

## Phase Completion Criteria
- [ ] Интеграционные тесты: скелеты 21/21 (`threads.e2e-spec.ts` 14/14, `chat-threads.e2e-spec.ts` 7/7) + доп. 5/5
- [ ] `app.e2e-spec.ts` без изменений и зелёный (`git diff --exit-code apps/api/test/app.e2e-spec.ts` пуст)
- [ ] Мутационная проверка выполнена один раз: без `getOwnedThread` в `ChatController.chat` оба кейса 404 краснеют; файл восстановлен (sha256 совпадает)

## E2E / Operational Verification Procedures (Integration Point 2 DD)
1. Создать беседу `POST /api/threads`, отправить сообщение через mock-модель с reasoning и инструментами, получить историю — `safeValidateUIMessages` успешен, части совпадают с литералами.
2. `DELETE` беседы → `POST /api/chat/assistant` с её id → 404 `THREAD_NOT_FOUND` до SSE; `getThreadById` → `null`; беседы нет в списке.
3. Чужая беседа → 404 (раньше 500).

## Failure Response
Любой провал — вернуть T5.1 исполнителю; к Phase 6 не переходить.
