# Phase 8 Completion: Quality Assurance

Plan: `docs/features/chat-shell/web-shell/20261030-feature-web-shell.md`

## Environment
Postgres 5433 (`POSTGRES_PORT=5433 pnpm db:up`), `apps/api` dev на 4000, `apps/web` — `pnpm --filter web build && pnpm --filter web start` (L1-8 дополнительно `dev`); `apps/web/.env.local` `NEXT_PUBLIC_API_URL=http://localhost:4000`; `ai`: `apps/api` 7.0.148 / `apps/web` ^7.0.155; Next.js 16.4.3; ключ `ANTHROPIC_API_KEY` разрешён пользователем для T8.3, T8.4; manual commits.

## Task Completion Checklist
- [x] task-T8.1 — гейты, ревью, таблица AC (frontend; коммит только при исправлениях)
- [x] task-T8.2 — dev-only seed в scratchpad (в репозиторий не попадает)
- [x] task-T8.3 — L1-1…L1-10, FR-19, метрики, Lighthouse (оркестратор, Claude-in-Chrome)
- [x] task-T8.4 — T6.3-a, T6.3-b (оркестратор)

## Quality Assurance (из плана)
- [x] Поэтапные проверки качества (ai-development-guide): lint → tsc → build → unit/C → интеграционные
- [x] Все тесты проходят; `it.todo` — 0 (финальная сборка после пост-реализационных исправлений — 268 тестов `apps/web` зелёные)
- [x] Статическая проверка (tsc) — 0
- [x] Lint — 0
- [x] Сборка `apps/web` и всего монорепо — успешна (полный `pnpm build` заменён по решению оркестратора, Phase 8 Notes плана)

## Completion Criteria (весь план)
- [x] Все фазы завершены; гейт G1 пройден
- [ ] Операционные проверки каждой фазы выполнены — остаётся свайп S-11 (L1-3, реальное касание — пользователь)
- [ ] AC Design Doc выполнены (таблица «Проверка AC» в плане) — открыта строка AC-08.5b: возврат в беседу с блоком ошибки (L1-10 B, шаги 3 и 6) не выполнялся
- [x] Поэтапные проверки качества — 0 ошибок
- [x] Все тесты проходят; интеграционные 10/10
- [x] L1 Sign-off заполнен; T6.3-a/b выполнены или записаны как «not executed» с причиной по решению пользователя
- [x] Notes плана дополнены результатами ранней точки проверки, мутационных проверок и метрик
- [x] Пост-реализационная проверка всей реализации выполнена — code-verifier: drift, 0 critical / 0 major / 9 minor (D001–D004, D007, D009 — design-web-shell v1.11; D005, D006, D008 — в коде); security-reviewer: approved_with_notes, 15/15, 4 усиления применены; quality-fixer: web 268/268 ×3, api 149 unit + 34 e2e, покрытие строк 88,37 %
- [ ] Изменения закоммичены (manual, по решению пользователя)
- [ ] Ревью пользователя получено

## Operational Verification Procedures
Копия раздела DD «L1-сценарии» — выполняется по `docs/features/chat-shell/web-shell/l1-browser-scenarios.md` (L1-1…L1-10, T6.3-a, T6.3-b) на `next build && next start` против реального API: каждый сценарий фиксирует скриншоты, консоль, ключевые запросы Network; проверка, которая не выполнялась, не считается пройденной. Integration Verification Points DD: первая отправка — порядок запросов и `body.id` (I + L1-1); прямая ссылка, 404 и ошибки истории (I + L1-7); фоновый стрим (S-1 + L1-6) — только реальный браузер и реальный API.
