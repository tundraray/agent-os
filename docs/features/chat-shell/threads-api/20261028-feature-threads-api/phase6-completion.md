# Phase 6 Completion: Quality Assurance (шаг 9 DD)

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 6)
- Dependencies: T6.1, T6.2, T6.3 завершены
- Provides: готовность плана к пользовательскому утверждению (Completion Criteria плана)

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

Это проверочная задача фазы: кода не пишет. Исполнитель выполняет проверки и отмечает чек-листы; `git commit` не запускает. Процедуры скопированы из «Operational Verification Procedures» Phase 6 плана.

## Task Completion Checklist
- [ ] T6.1 Perf AC-13.4 / AC-14.4 — готова к коммиту; решение о `test:perf` записано
- [ ] T6.2 Итоговые гейты качества — пройдены; таблица «Проверка AC» заполнена
- [ ] T6.3 Ручная L1-проверка — результаты в Notes плана (изменений кода нет)

## Phase Completion Criteria
- [ ] Все тесты проходят: unit, 21 интеграционный из скелетов + 5 доп., 2 perf, `app.e2e-spec.ts`; нерешённых `it.todo`: 0
- [ ] Static check (tsc), lint (oxlint type-aware), format (prettier) — без ошибок
- [ ] Build (`nest build`, contracts `tsc`) успешен; `pnpm test` (turbo) зелёный
- [ ] Покрытие `apps/api/src/threads` и `apps/api/src/common` ≥ 80 %
- [ ] Notes плана содержат исходы EVP (G, G3), хранимое состояние после ошибки модели и после обрыва сети, perf-решение и L1 (метрики № 7, № 10; № 10 — до/после единицы T2.4 + T2.5)
- [ ] Коммиты (если созданы пользователем) без строк атрибуции; ветка `feature/chat-shell`, слияние в `main` — вместе с `web-shell`

## E2E / Operational Verification Procedures
Копия процедур Integration Points 1–4 DD (см. Phase 2, 3, 4, 5 completion) — выполняются заново одним полным прогоном `test:e2e` и unit; плюс ручной старт `pnpm --filter api dev` отвечает на `/api/chat` и `/api/threads`.

## Failure Response
Любой провал — вернуть соответствующую задачу исполнителю или эскалировать оркестратору; утверждение пользователя запрашивается только после прохождения всех критериев.
