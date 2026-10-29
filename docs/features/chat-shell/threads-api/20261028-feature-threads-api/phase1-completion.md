# Phase 1 Completion: Фундамент (шаги 1–2 DD)

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 1)
- Dependencies: T1.1, T1.2, T1.3 завершены (каждая — в состоянии «готово к коммиту»)
- Provides: переход к Phase 2 (T2.1)

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

Это проверочная задача фазы: кода не пишет и файлов не меняет (кроме отметок в Progress Tracking плана, если оркестратор это требует). Исполнитель выполняет проверки и отмечает чек-листы; `git commit` не запускает. Процедуры скопированы из «Operational Verification Procedures» плана (источник — E2E-проверки Design Doc, Integration Points).

## Task Completion Checklist
- [ ] T1.1 Контракты `threads.ts` — готова к коммиту
- [ ] T1.2 `configureApp`, `ZodValidationPipe` — готова к коммиту
- [ ] T1.3 Тестовая обвязка — готова к коммиту (после T1.2)

## Phase Completion Criteria
- [ ] T1.1–T1.3 выполнены; изменения только в Target Files задач; коммиты (manual) — на стороне пользователя, без строк атрибуции
- [ ] `pnpm --filter @agent-os/contracts build`, `pnpm --filter api build`, lint, format, unit — без ошибок
- [ ] `test/app.e2e-spec.ts` проходит без правок (AC-18.3, промежуточно)
- [ ] Интеграционные тесты: 0/21 (фаза фундамента), perf 0/2

## E2E / Operational Verification Procedures
1. `pnpm db:up`; `pnpm --filter @agent-os/contracts build`; `pnpm --filter api test:e2e -- app.e2e-spec` → 2 теста зелёные.
2. `pnpm --filter api dev`; `POST localhost:4000/api/chat/no-such-agent` с телом `{"id":"x","messages":[]}` и заголовком `content-type: application/json` → 404 (поведение `configureApp` идентично прежнему).

## Failure Response
Любой провал — вернуть соответствующую задачу исполнителю; к Phase 2 не переходить.
