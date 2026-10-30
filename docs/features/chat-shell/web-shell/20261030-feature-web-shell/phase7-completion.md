# Phase 7 Completion: Лента — политика markdown, action bar, блок ошибки и «Беседа удалена», ошибка инструмента, локализация и доступность

Plan: `docs/features/chat-shell/web-shell/20261030-feature-web-shell.md`

## Environment
Postgres 5433, `pnpm --filter api dev` (4000), `apps/web/.env.local` `NEXT_PUBLIC_API_URL=http://localhost:4000`; `ai`: `apps/api` 7.0.148 / `apps/web` ^7.0.155; Next.js 16.4.3; manual commits.

## Task Completion Checklist
- [ ] task-T7.1 — готов к коммиту (политика markdown)
- [ ] task-T7.2 — готов к коммиту (action bar «Копировать»)
- [ ] task-T7.3 — готов к коммиту (блок ошибки, `DeletedNotice`, классификация 404; `shell.message-error` + `shell.deleted-thread`)
- [ ] task-T7.4 — готов к коммиту (ошибка инструмента)
- [ ] task-T7.5 — готов к коммиту (локализация, reduced motion, ARIA)

## Phase Completion Criteria
- [ ] T7.1–T7.5 готовы к коммиту
- [ ] Интеграционные тесты: 10/10 (todo: 0)
- [ ] lint, tsc, test, build — 0 ошибок

## Operational Verification Procedures
1. L1-7 (часть): во второй вкладке удалить беседу, открытую в первой, отправить — сообщение видно, «Беседа удалена» / «Её удалили в другой вкладке или окне.», «Новый чат», нет «Перегенерировать», нет композера.
2. L1-10 A (часть, без seed): Tab по ленте — у каждого сообщения только «Копировать»; во время стрима «Копировать» прежних остаётся в Tab.
3. L1-4 (часть): ответ с `[опасная](javascript:alert(1))` — не ссылка; внешняя — новая вкладка.
