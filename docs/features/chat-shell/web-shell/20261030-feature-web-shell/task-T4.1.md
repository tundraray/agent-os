# Task T4.1: `groupThreadsByDate` и `useNow`

Metadata:
- Task type: frontend (apps/web)
- Phase: 4 — список бесед (шаги 5–6 DD)
- Dependencies: task-T2.1 → Deliverable: Vitest-обвязка (`TZ=Europe/Berlin` в `vitest.config.ts`)
- Provides: `apps/web/src/lib/threads/group-threads-by-date.ts`, `apps/web/src/hooks/use-now.ts` для T4.2
- Size: Small (3 файла)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- Тесты без API; `TZ = 'Europe/Berlin'` задаётся в `vitest.config.ts`. `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны.

## Implementation Content
Чистая функция группировки бесед по датам (метки, правило дней, сортировка, эффективное время) и хук `useNow()` (обновление при возврате во вкладку и в полночь). AC-01.1; AC-19.1 — монотонность; D-11; A-6.

## Target Files
- [x] `apps/web/src/lib/threads/group-threads-by-date.ts` (new)
- [x] `apps/web/src/lib/threads/group-threads-by-date.test.ts` (new)
- [x] `apps/web/src/hooks/use-now.ts` (new)

## Investigation Targets
- DD «Contract Definitions» (`group-threads-by-date.ts`), «Field Propagation Map» (`updatedAt → время активности`)
- `apps/web/vitest.config.ts` (TZ), `apps/web/src/test/fixtures.ts`

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Contract Definitions, `group-threads-by-date.ts`) | structure-order | `today: 'Сегодня', yesterday: 'Вчера', previous7: 'Предыдущие 7 дней', previous30: 'Предыдущие 30 дней', older: 'Старше'`; «дни = round((startOfDay(now) − startOfDay(activityAt)) / 86 400 000): ≤0 today, 1 yesterday, 2..7 previous7, 8..30 previous30, >30 older; сортировка по activityAt DESC (стабильно, при равенстве — исходный порядок), пустые группы не возвращаются.» | Y, если метки, границы дней, стабильная сортировка и отсутствие пустых групп совпадают |
| design-web-shell.md (§ Field Propagation Map, `updatedAt → время активности`) | derived-display | «max(lastMessageAt, activityAt); нет обоих → now; календарный день в TZ браузера» | Y, если эффективное время считается так |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| `useNow()` | обновляется при возврате во вкладку (`visibilitychange`) и в полночь | План T4.1 |
| Страж окружения | `new Date(2026, 2, 28).getTimezoneOffset() !== new Date(2026, 2, 30).getTimezoneOffset()` — тест падает, если TZ не Berlin | План T4.1 |
| Табличные тесты | одна табличная проверка на правило | testing-principles (Test Selection) |

## Investigation Notes
- Подтверждено: `Math.round` над разностью локальных `startOfDay` (`Date#setHours(0,0,0,0)` — TZ браузера); стабильность — встроенная стабильность `Array.prototype.sort` (ES2019) по копии входа.
- Эффективное время (Field Propagation Map) вынесено в экспортируемый `entryActivityAt({ lastMessageAt, activityAt }, now)`: `max` из имеющихся, нет обоих → `now`. Контракт `groupThreadsByDate(entries, now)` и `ThreadListEntry` — без изменений (DD § Contract Definitions); потребитель T4.2 вызывает `entryActivityAt` при построении `ThreadListEntry`.
- Кейсы DST из DD (03-28 23:30→03-29 12:00; 10-24 23:30→10-25 23:30; 10-18→10-25) дают разность ровно 24·n ч и `floor` не ловят. Добавлены кейсы, где сутки 23 ч попадают в разность: 03-29 12:00 при now 03-30 12:00 → «Вчера»; 03-24 при now 04-01 → «Предыдущие 30 дней»; плюс 25-часовые 10-25 23:30 при now 10-26 00:10 → «Вчера».
- Мутации (временно, откачены): `Math.floor` → красные 2 кейса (23-часовые сутки 03-29→03-30 и 03-24→04-01); `[...entries].reverse().sort` (нестабильный порядок при равенстве) → красный кейс «равные activityAt → исходный порядок».
- Reference Contracts: метки/границы/сортировка/без пустых групп — Y; `max(lastMessageAt, activityAt)`, нет обоих → now, календарный день в TZ браузера — Y.
- `useNow()`: `useState(() => new Date())`; `visibilitychange` (visible) → новый `now`; `setTimeout` до следующей локальной полуночи, перепланируется при каждом обновлении `now`. Отдельного теста в Target Files нет; проверка проводки — T4.2/T4.3.

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [x] Прочитать Investigation Targets
- [x] U табличные: AC-01.1 (сегодня/вчера/5/40 дней → четыре группы по порядку, без пустых); границы 2/7/8/30/31 день; DST `Europe/Berlin` — 2026-03-29 (`activityAt` 2026-03-28 23:30, `now` 2026-03-29 12:00 → «Вчера»; 2026-03-29 00:30 → «Сегодня») и 2026-10-25 (`activityAt` 2026-10-24 23:30, `now` 2026-10-25 23:30 → «Вчера»; 2026-10-18 12:00 → «Предыдущие 7 дней»); страж окружения; сортировка с локальным поднятием; монотонность при склейке двух страниц; нет ключей сортировки → `now`; равные `activityAt` → исходный порядок
- [x] Запустить, увидеть падение

### 2. Green Phase
- [x] `group-threads-by-date.ts`, `use-now.ts`; тесты зелёные

### 3. Refactor Phase
- [x] Упростить; тесты зелёные

## Quality Assurance Mechanisms
- Vitest, ESLint, `tsc` — Type: `executable_check`
- Test Selection — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: `pnpm --filter web test group-threads-by-date`; гейты.
- **Success criteria**: тесты зелёные (≥ 4 — вклад в AC-12.1 «группировка»).
- **Failure response**: DST-кейсы красные → проверить `round` и TZ; не ослаблять ожидания.
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-01.1 / D-11 — группировка по календарным дням, DST
- **Claim**: группы и границы дней корректны, включая переходы на летнее/зимнее время.
- **Primary failure mode**: `Math.floor` вместо `round` краснит DST-кейсы; нестабильная сортировка краснит кейс равенства.
- **Boundary to exercise**: in-process unit.
- **State assertion**: N/A.
- **Mock boundary rationale**: время передаётся параметром `now`; TZ — конфигурация Vitest.
- **Proven by**: `new: group-threads-by-date.test.ts — таблицы дней/DST/сортировки` (единственный тест правила; интеграция проверяет только проводку).
- **Residual**: проводка `ThreadActivityTracker` → группировка — I-тест T4.3.

### Obligation: Failure Mode: missing-sort-key ordering / AC-19.1 монотонность
- **Claim**: нет ключей → `now`; равные `activityAt` → исходный порядок; склейка страниц монотонна.
- **Primary failure mode**: беседа без ключей пропадает/уезжает; перестановка при равенстве.
- **Boundary to exercise**: in-process unit.
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Proven by**: `new: group-threads-by-date.test.ts` (те же таблицы).
- **Residual**: нет.

## Completion Criteria
- [x] Тесты зелёные (≥ 4 — вклад в AC-12.1 «группировка»); прогон содержательный
- [x] Мутации `Math.floor`/нестабильная сортировка краснят кейсы (записано в Notes)
- [x] lint, tsc — 0 ошибок
- [x] Reference Contracts — `Y`

## Notes
- Impact scope: потребитель — `thread-history-list.tsx` (T4.2).
- Scope boundary: вне Target Files не менять.
