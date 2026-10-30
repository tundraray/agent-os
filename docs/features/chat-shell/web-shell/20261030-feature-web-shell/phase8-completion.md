# Phase 8 Completion: Quality Assurance

Plan: `docs/features/chat-shell/web-shell/20261030-feature-web-shell.md`

## Environment
Postgres 5433 (`POSTGRES_PORT=5433 pnpm db:up`), `apps/api` dev на 4000, `apps/web` — `pnpm --filter web build && pnpm --filter web start` (L1-8 дополнительно `dev`); `apps/web/.env.local` `NEXT_PUBLIC_API_URL=http://localhost:4000`; `ai`: `apps/api` 7.0.148 / `apps/web` ^7.0.155; Next.js 16.4.3; ключ `ANTHROPIC_API_KEY` разрешён пользователем для T8.3, T8.4; manual commits.

## Task Completion Checklist
- [ ] task-T8.1 — гейты, ревью, таблица AC (frontend; коммит только при исправлениях)
- [ ] task-T8.2 — dev-only seed в scratchpad (в репозиторий не попадает)
- [ ] task-T8.3 — L1-1…L1-10, FR-19, метрики, Lighthouse (оркестратор, Claude-in-Chrome)
- [ ] task-T8.4 — T6.3-a, T6.3-b (оркестратор)

## Quality Assurance (из плана)
- [ ] Поэтапные проверки качества (ai-development-guide): lint → tsc → build → unit/C → интеграционные
- [ ] Все тесты проходят; `it.todo` — 0
- [ ] Статическая проверка (tsc) — 0
- [ ] Lint — 0
- [ ] Сборка `apps/web` и всего монорепо — успешна

## Completion Criteria (весь план)
- [ ] Все фазы завершены; гейт G1 пройден
- [ ] Операционные проверки каждой фазы выполнены
- [ ] AC Design Doc выполнены (таблица «Проверка AC» в `task-T8.1.md`)
- [ ] Поэтапные проверки качества — 0 ошибок
- [ ] Все тесты проходят; интеграционные 10/10
- [ ] L1 Sign-off заполнен; T6.3-a/b выполнены или записаны как «not executed» с причиной по решению пользователя
- [ ] Notes плана дополнены результатами ранней точки проверки, мутационных проверок и метрик
- [ ] Ревью пользователя получено

## Operational Verification Procedures
Копия раздела DD «L1-сценарии» — выполняется по `docs/features/chat-shell/web-shell/l1-browser-scenarios.md` (L1-1…L1-10, T6.3-a, T6.3-b) на `next build && next start` против реального API: каждый сценарий фиксирует скриншоты, консоль, ключевые запросы Network; проверка, которая не выполнялась, не считается пройденной. Integration Verification Points DD: первая отправка — порядок запросов и `body.id` (I + L1-1); прямая ссылка, 404 и ошибки истории (I + L1-7); фоновый стрим (S-1 + L1-6) — только реальный браузер и реальный API.
