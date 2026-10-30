# Phase 4 Completion: Список бесед, открытие, новый чат

Plan: `docs/features/chat-shell/web-shell/20261030-feature-web-shell.md`

## Environment
Postgres 5433, `pnpm --filter api dev` (4000), `apps/web/.env.local` `NEXT_PUBLIC_API_URL=http://localhost:4000` — для браузерных проверок; `TZ=Europe/Berlin` в тестах; `ai`: `apps/api` 7.0.148 / `apps/web` ^7.0.155; Next.js 16.4.3; manual commits.

## Task Completion Checklist
- [ ] task-T4.1 — готов к коммиту (`groupThreadsByDate`, `useNow`)
- [ ] task-T4.2 — готов к коммиту (список, `ThreadActivityTracker`; `shell.list` + `shell.open-thread` F5/AC-02.5)
- [ ] task-T4.3 — готов к коммиту (новый чат, фокус, приветствие, `DocumentTitle`; `shell.new-chat`)

## Phase Completion Criteria
- [ ] T4.1–T4.3 готовы к коммиту
- [ ] Интеграционные тесты: 6/10
- [ ] AC-12.1: ≥ 8 тестов в четырёх областях выполнено (группировка 4+, состояния сайдбара 4, тема 2, шапка 4)
- [ ] lint, tsc, test, build — 0 ошибок

## Operational Verification Procedures
1. L1-1 (часть): новый чат на 1440 px — колонка 768 px; подсказка № 1 → Network `POST /api/threads` → `POST /api/chat/assistant` (`id` совпадает), адресная строка `/chat/<id>`, «Новая беседа» первой в «Сегодня» с мерцанием и `aria-current="page"`; заголовок ≤ 15 с в сайдбаре, шапке, вкладке.
2. L1-5: A → B → C кликами, F5 на C, Назад ×2, Вперёд — выделение и шапка синхронны; заголовок вкладки не перезаписан (S-7).
