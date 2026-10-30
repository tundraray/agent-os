# Task T7.5: Локализация каркаса, reduced motion, аудит ARIA; `plural-ru`, `i18n.test.ts`

Metadata:
- Task type: frontend (apps/web)
- Phase: 7
- Dependencies: task-T7.3, task-T7.4 → Deliverable: `thread.aui.tsx`, `tool-fallback.aui.tsx`
- Provides: русские строки каркаса, `pluralRu`, `i18n.test.tsx`
- Size: Large по числу файлов (13), но однородные правки строк; допустима единая единица по плану; при превышении — эскалация
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; Postgres 5433 для dev/L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны.

## Implementation Content
Локализация оставшихся англоязычных строк каркаса, `pluralRu`, reduced motion на всех переходах оболочки, сверка ARIA с UXRD 7.2. UXRD 10.2, 7.2, 7.7; fact `i18n:scaffold-strings`.

## Target Files
- [ ] `apps/web/src/lib/i18n/plural-ru.ts` (new)
- [ ] `apps/web/src/lib/i18n/plural-ru.test.ts` (new)
- [ ] `apps/web/src/lib/i18n/i18n.test.tsx` (new)
- [ ] `apps/web/src/components/assistant-ui/elements/reasoning.tsx`
- [ ] `apps/web/src/components/assistant-ui/elements/tool-group.aui.tsx`
- [ ] `apps/web/src/components/assistant-ui/elements/attachment.aui.tsx`
- [ ] `apps/web/src/components/ui/dialog.tsx`
- [ ] `apps/web/src/components/image.tsx`
- [ ] `apps/web/src/components/file.tsx`
- [ ] `apps/web/src/components/media-player.tsx`
- [ ] `apps/web/src/components/assistant-ui/elements/thread.aui.tsx` (оставшиеся строки: «Отправить», «Остановить», TH-09 «К последнему сообщению» и др.; заголовок приветствия, подпись и placeholder композера уже поставлены в T3.4)

`app/layout.tsx` — только сверка строк (изменения не ожидаются; если нужны — эскалация).

## Investigation Targets
- DD «Локализация» (таблица строк), UXRD 10.2, 7.2, 7.7
- Указанные файлы; результат T3.4/T7.3/T7.4 в `thread.aui.tsx`, `tool-fallback.aui.tsx`
- `apps/web/src/app/layout.tsx` (проверка строк)

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| Строки | `Рассуждения (N с)`, `pluralRu(N, ['вызов инструмента', 'вызова инструментов', 'вызовов инструментов'])` через `Intl.PluralRules('ru-RU')`, «Закрыть», aria-строки — по таблице DD «Локализация» | План T7.5 |
| Reduced motion | `motion-reduce:transition-none`/`motion-reduce:animate-none` на всех переходах оболочки; вставка/удаление элементов списка — `@starting-style` с отключением при `prefers-reduced-motion` | План T7.5 |
| ARIA | сверка с таблицей UXRD 7.2 | План T7.5 |
| `i18n.test.tsx` | рендер ключевых экранов (новый чат, беседа с инструментом из фикстуры, меню) не содержит слов стоп-листа (`Send`, `Copy`, `Close`, `Toggle`, `Loading`, `Reasoning`, `tool call`) | План T7.5 |
| Правка вне перечня | Нужна правка файла вне Target Files — эскалация, не расширение | Правило 8 |

## Investigation Notes
(Список найденных англоязычных строк и ARIA-расхождений.)

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать Investigation Targets; собрать англоязычные строки
- [ ] U `plural-ru.test.ts` — 1, 2, 5, 11, 21, 22, 25 (таблица)
- [ ] `i18n.test.tsx` — рендер экранов, стоп-лист
- [ ] Запустить, увидеть падение

### 2. Green Phase
- [ ] `plural-ru.ts`; перевод строк в перечисленных файлах; `motion-reduce`/`@starting-style`; тесты зелёные

### 3. Refactor Phase
- [ ] Упростить; аудит ARIA по UXRD 7.2

## Quality Assurance Mechanisms
- Vitest + RTL, ESLint, `tsc`, `next build` — Type: `executable_check`
- Reduced motion, WCAG 2.1 AA — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: тесты + гейты. Браузер (L1-9, L1-10, Lighthouse a11y ≥ 95 — T8.3).
- **Success criteria**: тесты зелёные; lint/tsc/build — 0.
- **Failure response**: слово стоп-листа в экране вне Target Files — эскалация.
- **Verification level**: L2.

## Proof Obligations
### Obligation: UXRD 10.2 — плюрализация
- **Claim**: `pluralRu` корректно склоняет для 1, 2, 5, 11, 21, 22, 25.
- **Primary failure mode**: `Intl.PluralRules` не используется/неверные формы («11 вызова»).
- **Boundary to exercise**: in-process unit (таблица).
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Proven by**: `new: plural-ru.test.ts`.
- **Residual**: нет.

### Obligation: UXRD 10.2 — отсутствие английских строк каркаса
- **Claim**: ключевые экраны не содержат слов стоп-листа.
- **Primary failure mode**: забытая англоязычная aria/текст.
- **Boundary to exercise**: компонентный (рендер экранов).
- **State assertion**: N/A.
- **Mock boundary rationale**: фикстуры бесед; сеть — MSW где нужно.
- **Proven by**: `new: i18n.test.tsx` (единственный тест, ловящий забытую строку по всем экранам).
- **Residual**: строки в состояниях, не покрытых экранами теста — L1.

## Completion Criteria
- [ ] Тесты зелёные (содержательно)
- [ ] lint, tsc, build — 0 ошибок
- [ ] Resolved decisions применены

## Notes
- Impact scope: `thread.aui.tsx` — последняя правка; `app/layout.tsx` — только проверка.
- Scope boundary: файлы вне Target Files не менять.
