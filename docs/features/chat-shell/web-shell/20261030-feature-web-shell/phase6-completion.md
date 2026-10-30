# Phase 6 Completion: Should — подгрузка списка (FR-19) и горячие клавиши (FR-22)

Plan: `docs/features/chat-shell/web-shell/20261030-feature-web-shell.md`

## Environment
Postgres 5433, `pnpm --filter api dev` (4000), `apps/web/.env.local` `NEXT_PUBLIC_API_URL=http://localhost:4000`; `ai`: `apps/api` 7.0.148 / `apps/web` ^7.0.155; Next.js 16.4.3; manual commits.

## Task Completion Checklist
- [ ] task-T6.1 — готов к коммиту (подгрузка SB-10)
- [ ] task-T6.2 — готов к коммиту (горячие клавиши)

## Phase Completion Criteria
- [ ] T6.1, T6.2 готовы к коммиту
- [ ] lint, tsc, test, build — 0 ошибок

## Operational Verification Procedures
1. FR-19 в браузере здесь не проверяется: 120 бесед засорили бы стенд для L1 и все попали бы в «Сегодня». Проверка — в T8.3 после сида T8.2 (беседы с разнесённым `updatedAt`, удаляются после проверки); в Phase 6 — C-тесты T6.1.
2. L1-9 (часть): `Ctrl+Shift+O` из композера, `Ctrl+B`; в поле переименования и в открытом меню сочетания не срабатывают.
