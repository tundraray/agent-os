# Phase 3 Completion: Каркас оболочки — раскладка, сайдбар без списка, меню пользователя, шапка, основная область

Plan: `docs/features/chat-shell/web-shell/20261030-feature-web-shell.md`

## Environment
Postgres 5433 (`POSTGRES_PORT=5433 pnpm db:up`), `pnpm --filter api dev` (4000), `apps/web/.env.local` `NEXT_PUBLIC_API_URL=http://localhost:4000` — для браузерных проверок; `ai`: `apps/api` 7.0.148 / `apps/web` ^7.0.155; Next.js 16.4.3; manual commits.

## Task Completion Checklist
- [ ] task-T3.1 — готов к коммиту (ChatShell, AppSidebar, cookie, S-11 C)
- [ ] task-T3.2 — готов к коммиту (UserMenu)
- [ ] task-T3.3 — готов к коммиту (ChatHeader)
- [ ] task-T3.4 — готов к коммиту (MainView, ThreadNotice, `shell.open-thread` AC-02.2 + AC-04.3)

## Phase Completion Criteria
- [ ] T3.1–T3.4 готовы к коммиту
- [ ] Интеграционные тесты: 1/10 (todo: 9)
- [ ] AC-12.1 частично: тема 2, шапка 4
- [ ] lint, tsc, test, build — 0 ошибок

## Operational Verification Procedures
1. L1-1 (раскладка, без списка): 1440 px, сайдбар развёрнут/свёрнут, полоса 48 px, `aria-expanded="false"`; F5 — свёрнут на первом кадре.
2. L1-3 (часть): 375 px — сайдбар скрыт до гидратации, в шапке «Меню» и «Новый чат», нет горизонтального скролла; «Меню» открывает шторку.
3. `/chat/does-not-exist` → «Беседа не найдена», вкладка — после T4.3.
