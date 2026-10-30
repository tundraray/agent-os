# Phase 1 Completion: Ранняя точка проверки — спайк рантайма S-1…S-5 и шторки S-11

Task type: проверка фазы выполняется оркестратором (L1/browser) и по гейтам web.
Plan: `docs/features/chat-shell/web-shell/20261030-feature-web-shell.md`

## Environment
Postgres на 5433 (`POSTGRES_PORT=5433 pnpm db:up`, `postgres://agent:agent@localhost:5433/agent_os`); `pnpm --filter api dev` (4000); `apps/web/.env.local` `NEXT_PUBLIC_API_URL=http://localhost:4000`; `ai`: `apps/api` 7.0.148 / `apps/web` ^7.0.155; Next.js 16.4.3; manual commits (без `git add/commit/stash/checkout` исполнителями, без attribution).

## Task Completion Checklist
- [ ] task-T1.1 — готов к коммиту (manual)
- [ ] task-T1.2 — готов к коммиту (manual)
- [ ] task-T1.3 — выполнена (L1), результаты в Notes «Ранняя точка проверки»; **гейт G1**
- [ ] task-T1.4 — готов к коммиту (manual); начата только после G1; S-11 записан в Notes

## Phase Completion Criteria
- [ ] T1.1, T1.2, T1.4 готовы к коммиту (manual); T1.3 выполнена, результаты в Notes
- [ ] **Гейт G1 пройден до начала T1.4**: S-1 подтверждён (иначе — СТОП, эскалация пользователю: вариант B KD-1 = изменение дизайна); для S-2…S-5 — подтверждение или применённый запасной путь
- [ ] Ключ провайдера проверен первым шагом T1.3 (недействителен — СТОП, вопрос пользователю)
- [ ] S-11 (T1.4): подтверждение или применённый запасной путь
- [ ] lint, tsc, build `apps/web` — 0 ошибок
- [ ] Интеграционные тесты: 0/10 (Vitest ещё нет)
- [ ] Три существующих `ui/button.tsx`, `ui/skeleton.tsx`, `ui/tooltip.tsx` не изменены

## Operational Verification Procedures
1. Шаги 1–6 T1.3 и проверка S-11 из T1.4 (копия критериев Early Verification Point DD).
2. Первая отправка с `/`: два запроса в правильном порядке, `body.id` совпадает с id из `POST /api/threads`, адресная строка `/chat/<id>`, нет запроса документа (Integration Point 1 DD).
3. Во время стрима X открыть Y: запрос X не отменён, ответ дописан (Integration Point 3 DD).

## E2E Verification (из Design Doc, Early Verification Point)
1. Первая отправка с `/`: `POST /api/threads` → `POST /api/chat/assistant` с `id` из ответа; URL `/chat/<id>` через `replaceState`; layout не перемонтирован (счётчик монтирований = 1), запроса документа или RSC-перезапроса layout нет.
2. Во время стрима в X переход на Y и на `/`: запрос X не отменён, ответ X дописан; возврат в X показывает продолжающийся или полный ответ.
3. F5 на `/chat/<id>` → история; `/chat/does-not-exist` → `switchError` `kind: 'not_found'`; искусственный 500 на `/messages` (обёртка `window.fetch`) → `load_failed`, «Повторить» загружает.
4. Назад/Вперёд переключают беседы.
5. Удаление беседы с идущим стримом останавливает генерацию (в логе API — отмена по `close`).
Failure response: (1)/(4) → `router.replace`; (2) → **СТОП**, отчёт пользователю; (3) → `adapter.unstable_useAdapters`; (5) → явная `cancelRun` перед `delete`.
