# Phase 5 Completion: Переименование, удаление, рабочая область

Plan: `docs/features/chat-shell/web-shell/20261030-feature-web-shell.md`

## Environment
Postgres 5433, `pnpm --filter api dev` (4000), `apps/web/.env.local` `NEXT_PUBLIC_API_URL=http://localhost:4000` — для браузерных проверок; `ai`: `apps/api` 7.0.148 / `apps/web` ^7.0.155; Next.js 16.4.3; manual commits.

## Task Completion Checklist
- [ ] task-T5.1 — готов к коммиту (переименование)
- [ ] task-T5.2 — готов к коммиту (удаление; `shell.delete-open-thread`)
- [ ] task-T5.3 — готов к коммиту (рабочая область; `shell.workspace`)

## Phase Completion Criteria
- [ ] T5.1–T5.3 готовы к коммиту
- [ ] Интеграционные тесты: 8/10
- [ ] lint, tsc, test, build — 0 ошибок

## Operational Verification Procedures
1. L1-2: переименование «Отчёт Q3» + Enter, Esc, пусто + Enter (нет `PATCH`), F5 — сохранено; удаление не открытой (URL не изменился, фокус на соседней ссылке), открытой (URL `/`, Назад не возвращает на удалённую). S-6 — временная ошибка `PATCH` через обёртку `fetch` → откат и уведомление.
2. L1-1 (часть): HD-04 → панель 40 %, лента ≥ 480 px при 1280; < 1024 px — нет кнопки и панели, при 1440 панель вернулась (S-10).
