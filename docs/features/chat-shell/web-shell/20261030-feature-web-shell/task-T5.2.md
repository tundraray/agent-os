# Task T5.2: Удаление — `DeleteThreadDialog` (DLG-01), удаление открытой и не открытой беседы, фокус; интеграционный `shell.delete-open-thread`

Metadata:
- Task type: frontend (apps/web)
- Phase: 5
- Dependencies: task-T5.1 → Deliverable: меню «⋯» с пунктом «Удалить» в `thread-history-item.tsx`; T4.3 (`focusAfterNewChat`)
- Provides: `DeleteThreadDialog`; `router.replace('/')` при удалении открытой беседы
- Size: Medium (6 файлов)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; Postgres 5433 для dev/L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны (**правило 10** — для `shell.delete-open-thread`).

## Implementation Content
Диалог удаления `alertdialog` «Удалить беседу?», удаление открытой беседы (библиотека уходит с беседы → `syncUrlWithThread` → `router.replace('/')` → `focusAfterNewChat()`) и не открытой (фокус на следующую ссылку → предыдущую → SB-03), уведомления. Наполняет `shell.delete-open-thread`. AC-06.1–06.3; S-5, S-8; A-4.

## Target Files
- [ ] `apps/web/src/components/shell/delete-thread-dialog.tsx` (new)
- [ ] `apps/web/src/components/shell/delete-thread-dialog.test.tsx` (new)
- [ ] `apps/web/src/components/shell/thread-history-item.tsx`
- [ ] `apps/web/src/components/shell/thread-history-list.tsx` (фокус после удаления не открытой)
- [ ] `apps/web/src/components/shell/thread-history-list.test.tsx` (кейс AC-06.3)
- [ ] `apps/web/src/components/shell/shell.delete-open-thread.int.test.tsx`

## Investigation Targets
- UXRD 6.23 (DLG-01, вариант A-4), 7.4; DD «UI Action-API Contract Mapping», `focus.ts`
- `apps/web/src/components/shell/shell.delete-open-thread.int.test.tsx` (перенесён в T2.1)
- `apps/web/src/test/render-with-runtime.tsx` (`<Toaster />`), `lib/threads/{thread-list-adapter,url-sync}.ts`
- `apps/web/src/components/ui/alert-dialog.tsx` (S-8: `initialFocus`/`finalFocus`)

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ UI Action-API Contract Mapping) | derived-display | «204 / 404 → «Беседа удалена»»; «прочее → возврат элемента + «Не удалось удалить беседу. Попробуйте ещё раз.»» | Y, если уведомления дословно совпадают |
| design-web-shell.md (§ Маршрутизация и синхронизация URL) | state-lifecycle-negative | «`remoteId === undefined` и путь начинается с `/chat/` → `router.replace('/')`» | Y, если после удаления открытой беседы вызван `router.replace('/')`, `push` не вызван |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| Диалог | `alertdialog` «Удалить беседу?» с названием в «ёлочках», «Отмена» (`initialFocus`), «Удалить» — `Button variant="destructive"`; при `isRunning` — абзац A-4; `finalFocus` = «⋯» | План T5.2 |
| Удаление открытой | библиотека уходит с беседы → `syncUrlWithThread` → `router.replace('/')` → `focusAfterNewChat()` | План T5.2 |
| Удаление не открытой | фокус на следующую ссылку, нет — предыдущую, нет — SB-03 (вычисляется до удаления) | План T5.2 |
| I-тест | 1 тест (строки: точный → композер, грубый → `h1`): `DELETE /api/threads/a`; ссылки `a` нет; `router.replace('/')`, `push` не вызван; «Чем могу помочь?»; уведомление «Беседа удалена» | План T5.2 |
| S-8 не подтвердился | Фокус в `onOpenChange`; `toast.custom` с `role="alert"` | Таблица S-1…S-11 |
| S-5 | Остановка стрима при удалении — подтверждена в T1.3; здесь не повторяется | План |

## Investigation Notes
(Правило 10: Assert I-теста — «Чем могу помочь?» (T3.4), уведомление «Беседа удалена» (T1.2 `notify` + `<Toaster />` из T2.1) — подтвердить поставку.)

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать Investigation Targets; сверить Assert I-кейса (правило 10)
- [ ] C `delete-thread-dialog.test.tsx` — `alertdialog`, название в «ёлочках», фокус на «Отмена», вариант A-4 (S-8)
- [ ] C `thread-history-list.test.tsx` — новый кейс AC-06.3: после удаления не открытой фокус на следующей ссылке
- [ ] I `shell.delete-open-thread.int.test.tsx` — 1 тест
- [ ] Запустить, увидеть падение

### 2. Green Phase
- [ ] `delete-thread-dialog.tsx`; правки `thread-history-item.tsx`, `thread-history-list.tsx`; тесты зелёные

### 3. Refactor Phase
- [ ] Упростить; интеграционные 7/10

## Quality Assurance Mechanisms
- Vitest + RTL + MSW, ESLint, `tsc`, `next build` — Type: `executable_check`
- Политика фокуса (таблица событий DD); WCAG 2.1 AA — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: C, I + гейты. Браузер (L1-2, T8.3): удаление не открытой (URL не изменился, фокус на соседней ссылке), открытой (URL `/`, Назад не возвращает на удалённую).
- **Success criteria**: C и I зелёные; интеграционные 7/10.
- **Failure response**: S-8 — запасной путь из Decisions.
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-06.2 — удаление открытой беседы заменяет URL
- **Claim**: после удаления открытой `a` — `router.replace('/')`, `push` не вызван; ссылки `a` нет; приветствие; уведомление.
- **Primary failure mode**: `router.push` вместо `replace`; URL остаётся `/chat/a`.
- **Boundary to exercise**: интеграционный.
- **State assertion**: `/chat/a` → `/` (replace); список без `a`.
- **Mock boundary rationale**: сеть — MSW; `next/navigation` — мок со шпионом.
- **Proven by**: `new: shell.delete-open-thread.int.test.tsx`.
- **Residual**: остановка стрима — S-5 (T1.3).

### Obligation: AC-06.1 / AC-06.3 / A-4 — диалог и фокус
- **Claim**: диалог с названием, фокус на «Отмена», вариант A-4 при `isRunning`; после удаления не открытой фокус на следующей ссылке.
- **Primary failure mode**: фокус на «Удалить»/`body`; потеря фокуса после удаления.
- **Boundary to exercise**: компонентный.
- **State assertion**: `document.activeElement`.
- **Mock boundary rationale**: презентационный; `matchMedia` полифил.
- **Proven by**: `new: delete-thread-dialog.test.tsx`; `new: thread-history-list.test.tsx — AC-06.3`.
- **Residual**: откат при ошибке удаления — unit T2.2 / L1-2.

### Obligation: Failure Mode: rollback-only visibility
- **Claim**: при отказе `DELETE` элемент возвращается и показывается «Не удалось удалить беседу…».
- **Primary failure mode**: элемент не возвращается / нет уведомления.
- **Boundary to exercise**: unit адаптера (T2.2) + L1.
- **State assertion**: N/A.
- **Mock boundary rationale**: сеть — MSW.
- **Proven by**: `existing: thread-list-adapter.test.ts — DELETE/PATCH` (T2.2) и L1-2 (T8.3); нового теста не пишется.
- **Residual**: видимый откат в UI — L1-2.

## Completion Criteria
- [ ] C и I зелёные; интеграционные 7/10
- [ ] lint, tsc, build — 0 ошибок
- [ ] Мутация `router.push` вместо `replace` краснит I (записано)
- [ ] Reference Contracts — `Y`; Resolved decisions применены

## Notes
- Impact scope: `thread-history-item.tsx`, `thread-history-list.tsx` далее правит T6.1 (только список).
- Scope boundary: вне Target Files не менять.
