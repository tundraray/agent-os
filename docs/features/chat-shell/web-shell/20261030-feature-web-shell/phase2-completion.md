# Phase 2 Completion: Фундамент — тестовая инфраструктура, тесты модулей спайка, тема, шрифт, токены

Plan: `docs/features/chat-shell/web-shell/20261030-feature-web-shell.md`

## Environment
Тесты идут без API (AC-12.2); Postgres 5433 и API нужны только для браузерных проверок. `ai`: `apps/api` 7.0.148 / `apps/web` ^7.0.155; Next.js 16.4.3; manual commits. Перед прямым vitest — `pnpm --filter @agent-os/contracts build`, если `dist` старше `src`.

## Task Completion Checklist
- [ ] task-T2.1 — готов к коммиту (Vitest/RTL/MSW, перенос скелетов, `config.test.ts`)
- [ ] task-T2.2 — готов к коммиту (unit клиента, адаптеров, `RetryGate`; мутации записаны)
- [ ] task-T2.3 — готов к коммиту (unit URL, `url-sync`, опросчик; мутации записаны)
- [ ] task-T2.4 — готов к коммиту (тема, шрифт, токены; проверка в `dev` оркестратором)

## Phase Completion Criteria
- [ ] T2.1–T2.4 готовы к коммиту
- [ ] `pnpm --filter web test` зелёный (U: 8 файлов); 10 `it.todo`
- [ ] lint, tsc, build — 0 ошибок; `pnpm test` (turbo) зелёный
- [ ] Интеграционные тесты: 0/10 (все — `it.todo`)
- [ ] Мутационные проверки T2.2/T2.3 записаны в Notes

## Operational Verification Procedures
1. `pnpm --filter web test` без запущенного API (AC-12.2) — зелёный.
2. `pnpm --filter web build && pnpm --filter web start`, `localStorage.theme = 'dark'`, F5 — первый кадр тёмный (быстрая проверка; полная L1-8 — T8.3).
