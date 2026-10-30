# Task T6.1: Подгрузка — SB-10 «Показать ещё», автоподгрузка, ошибка подгрузки

Metadata:
- Task type: frontend (apps/web)
- Phase: 6 — Should (FR-19)
- Dependencies: task-T4.2 → Deliverable: `thread-history-list.tsx`/`.test.tsx`; по файлам — после T5.2 (T4.2 → T5.2 → T6.1)
- Provides: SB-10 (подгрузка списка, состояние ошибки подгрузки)
- Size: Small (2 файла)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; Postgres 5433 для dev/L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны.

## Implementation Content
Подгрузка страниц списка: кнопка «Показать ещё» при `hasMore`, автоподгрузка `IntersectionObserver`, скелетоны и `role="status"` во время подгрузки, ошибка подгрузки с «Повторить». FR-19 браузерно не проверяется здесь (120 бесед засорили бы стенд) — проверка в T8.3 после сида T8.2. AC-19.1.

## Target Files
- [ ] `apps/web/src/components/shell/thread-history-list.tsx`
- [ ] `apps/web/src/components/shell/thread-history-list.test.tsx`

## Investigation Targets
- UXRD 6.8 (SB-10); DD State × Display Matrix (SB-10)
- `apps/web/src/components/shell/thread-history-list.tsx` (T4.2/T5.2), `lib/threads/thread-list-adapter.ts` (`loadMoreFailed`)

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ State × Display Matrix) | derived-display | SB-10: «`role="status"` «Загружаем ещё беседы…»», «Не удалось загрузить ещё беседы» + «Повторить» → `loadMore()` | Y, если тексты и роли совпадают, «Повторить» вызывает `loadMore()` |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| SB-10 | кнопка `ghost sm` при `hasMore`; `IntersectionObserver` с `rootMargin: '0px 0px 200px 0px'` | План T6.1 |
| Загрузка | `isLoadingMore` → 3 строки-скелетона, `role="status"` «Загружаем ещё беседы…» | План T6.1 |
| Ошибка | `loadMoreFailed` → «Не удалось загрузить ещё беседы» в `role="alert"` + «Повторить» → `loadMore()`; загруженные остаются | План T6.1 |
| Тесты | Один C-кейс SB-10 Error; монотонность групп — U T4.1 (не дублировать) | План T6.1 |

## Investigation Notes
(Наблюдения.)

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать Investigation Targets
- [ ] C `thread-history-list.test.tsx` — SB-10 Error: текст в `alert`, «Повторить» вызывает `onLoadMore`, загруженные элементы на месте
- [ ] Запустить, увидеть падение

### 2. Green Phase
- [ ] Реализовать SB-10 в `thread-history-list.tsx`; тест зелёный

### 3. Refactor Phase
- [ ] Упростить; тесты зелёные

## Quality Assurance Mechanisms
- Vitest + RTL, ESLint, `tsc` — Type: `executable_check`
- WCAG 2.1 AA; reduced motion — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: C-тест + гейты. FR-19 в браузере — T8.3 после сида T8.2.
- **Success criteria**: тест зелёный; lint/tsc — 0; build — 0.
- **Failure response**: расхождение с UXRD — эскалация.
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-19.1 — ошибка подгрузки не теряет загруженное
- **Claim**: при ошибке подгрузки показан `alert`, «Повторить» вызывает `loadMore`, уже загруженные беседы остаются.
- **Primary failure mode**: ошибка стирает список / «Повторить» — no-op.
- **Boundary to exercise**: компонентный по props вида.
- **State assertion**: загруженные элементы до = после.
- **Mock boundary rationale**: `onLoadMore` — шпион.
- **Proven by**: `new: thread-history-list.test.tsx — SB-10 Error`.
- **Residual**: порядок групп/дубли страниц — U T4.1 + браузер T8.3.

## Completion Criteria
- [ ] Тест зелёный (содержательно)
- [ ] lint, tsc, build — 0 ошибок
- [ ] Reference Contract — `Y`

## Notes
- Impact scope: `thread-history-list.tsx` больше не правится после.
- Scope boundary: вне Target Files не менять.
