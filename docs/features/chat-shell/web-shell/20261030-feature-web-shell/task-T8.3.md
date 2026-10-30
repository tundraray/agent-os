# Task T8.3: L1-сценарии L1-1…L1-10, производительность, Lighthouse

Metadata:
- Task type: **L1/browser** — выполняет **оркестратор** через Claude-in-Chrome; шаги `[DevTools — user]` — просьба пользователю (группами). Не отдавать `task-executor-frontend`.
- Phase: 8
- Dependencies: task-T8.1 (гейты, production-сборка), task-T8.2 (seed → `<scratchpad>/seed-l1.ts`)
- Provides: заполненный Evidence/Sign-off в `l1-browser-scenarios.md`; метрики в Notes плана «Метрики и L1»
- Size: Small по файлам (1 документ), Large по времени
- Commit: manual — репозиторий меняется только документом `l1-browser-scenarios.md` (Evidence, отметки, Sign-off)

## Environment (каждая задача)
- Postgres 5433: `POSTGRES_PORT=5433 pnpm db:up`; `apps/api/.env`: `DATABASE_URL=postgres://agent:agent@localhost:5433/agent_os`, `FRONTEND_ORIGIN=http://localhost:3000`; `pnpm --filter api dev` (порт 4000); `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`.
- Production-сборка: `pnpm --filter web build && pnpm --filter web start` (L1-8 — дополнительно `pnpm --filter web dev` для консоли).
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3.
- Ключ `ANTHROPIC_API_KEY` из `apps/api/.env` разрешён пользователем для T1.3, T8.3, T8.4.
- Никаких `git add/commit/stash/checkout`; без attribution-строк.

## Implementation Content
Полный прогон чек-листа `docs/features/chat-shell/web-shell/l1-browser-scenarios.md` (L1-1…L1-10) на production-сборке против реального API: скриншоты, консоль, Network. Плюс проверка FR-19 с сидом страниц, метрики производительности и Lighthouse, заметки UX-владельцу.

## Target Files
- [ ] `docs/features/chat-shell/web-shell/l1-browser-scenarios.md` (только Evidence, отметки и Sign-off)

Исправления кода — отдельной задачей через `update` плана, если найдены дефекты (не в этой задаче).

## Investigation Targets
- `docs/features/chat-shell/web-shell/l1-browser-scenarios.md` (чек-лист L1-1…L1-10, Sign-off)
- DD «L1-сценарии», «Performance Tests», Open Questions DD п. 1, 3–6
- Таблица «Проверка AC» в `task-T8.1.md`
- Скрипт `<scratchpad>/seed-l1.ts` (T8.2)

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| Порядок | Чек-лист по порядку; FR-19 — **после** L1-1…L1-10, чтобы 120 бесед не мешали сценариям | План T8.3 |
| Шаги `[DevTools — user]` | Оркестратор останавливается и просит пользователя (группами): CPU ×4, тач, `pointer: coarse`, блокировка запросов, `canceled`, `Referer` | План, риски расписания |
| Невыполненная проверка | «not executed» с причиной — **никогда «pass»** | План |
| `fail` | Останавливает приёмку соответствующего AC; записывается | План |
| Расхождения с UXRD | Open Questions DD п. 1, 3–6; AC-08.5b возврат в беседу — заметки UX-владельцу в Notes | План |
| FR-19 | `node <scratchpad>/seed-l1.ts --pages` → прокрутка к SB-10 подгружает по 20, порядок групп монотонен, вторая страница без дублей; блокировка запроса подгрузки (`[DevTools — user]` или обёртка `fetch`) → «Не удалось загрузить ещё беседы», «Повторить» подгружает; затем `--pages --remove`, в списке нет `SEED-PAGE-*` | План T8.3 |
| Performance | метрика № 2 (≤ 1,5 с до последнего из 50 сообщений, 10 прогонов); LCP `/chat/<id>` ≤ 2,5 с (5 прогонов); CLS ≤ 0,1 при сайдбаре и рабочей области; Lighthouse Accessibility ≥ 95 (`/` и `/chat/<id>` × обе темы × десктоп/мобильный) | План T8.3 |
| Дефект S-1 в L1-6 | Тот же гейт, что и G1: провал фонового стрима — стоп и отчёт пользователю | Early Verification Point |

## Investigation Notes
(Ссылка на заполненные Evidence; сводка pass/fail/not executed.)

## Implementation Steps (процедура L1; TDD неприменим)
### 1. Предусловия
- [ ] T8.1 и T8.2 завершены; окружение по Environment; `pnpm --filter web build && pnpm --filter web start`

### 2. Сценарии
- [ ] L1-1 … L1-10 по чек-листу (для каждого: скриншоты, консоль, Network, ключевые запросы)
- [ ] Шаги `[DevTools — user]` — сгруппировать и запросить у пользователя за один заход

### 3. FR-19 (после L1-1…L1-10)
- [ ] Сид страниц, прокрутка, ошибка подгрузки, «Повторить», удаление сида

### 4. Метрики
- [ ] № 2 (10 прогонов), LCP (5 прогонов), CLS, Lighthouse a11y ≥ 95 (матрица)

### 5. Фиксация
- [ ] Evidence и Sign-off в `l1-browser-scenarios.md`; метрики и заметки UX — в Notes плана «Метрики и L1»; обновить колонку «Результат» таблицы AC (T8.1)

## Quality Assurance Mechanisms
- L1-чек-лист, Lighthouse — Type: `executable_check` (ручная процедура)
- «Проверка, которая не выполнялась, не считается пройденной» — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: чек-лист `l1-browser-scenarios.md` на `next build && next start` против реального API; Integration Verification Points DD: первая отправка — порядок запросов и `body.id`; прямая ссылка, 404 и ошибки истории; фоновый стрим (S-1 + L1-6).
- **Success criteria**: Sign-off L1-1…L1-10 заполнен (pass / fail / not executed + причина); FR-19 проверен, сид страниц удалён; метрики записаны.
- **Failure response**: любой fail — остановка приёмки AC и запись; код правится отдельной задачей через `update` плана; S-1 провал — отчёт пользователю.
- **Verification level**: L1.

## Proof Obligations
### Obligation: AC-02.6 / AC-03.4 — фоновый стрим (L1-6, без автотеста)
- **Claim**: переключение беседы и «Новый чат» не прерывают генерацию в production-сборке.
- **Primary failure mode**: запрос `canceled`; ответ обрывается.
- **Boundary to exercise**: реальный браузер + реальный API + модель.
- **State assertion**: стрим идёт → переход → ответ дописан.
- **Mock boundary rationale**: none.
- **Proven by**: `new (L1): L1-6`.
- **Residual**: нет.

### Obligation: Непрерывность — восстановленная беседа = живая (L1-4)
- **Claim**: лента восстановленной беседы совпадает с живой по составу частей и визуально (side-by-side).
- **Primary failure mode**: расхождение порядка/числа частей.
- **Boundary to exercise**: реальный браузер, seed `SEED-RICH`.
- **State assertion**: live vs reload — сравнение.
- **Mock boundary rationale**: none.
- **Proven by**: `new (L1): L1-4`.
- **Residual**: нет.

### Obligation: AC-09.2 / AC-10.x / AC-11.x / AC-21.1 / AC-22.x — оставшиеся L1-проверки
- **Claim**: тема без FOUC и контраст (L1-8), шторка и мобильный (L1-3), рабочая область (L1-1), cookie сайдбара (L1-1), сочетания (L1-9).
- **Primary failure mode**: см. сценарии.
- **Boundary to exercise**: реальный браузер.
- **State assertion**: по чек-листу.
- **Mock boundary rationale**: none.
- **Proven by**: `new (L1): L1-1, L1-3, L1-8, L1-9`.
- **Residual**: `[DevTools — user]` шаги, отмеченные «not executed».

## Completion Criteria
- [ ] Sign-off L1-1…L1-10 заполнен (pass / fail / not executed + причина)
- [ ] FR-19 проверен, сид страниц удалён
- [ ] Любой fail остановил приёмку соответствующего AC и записан
- [ ] Метрики записаны в Notes плана

## Notes
- Impact scope: стенд (dev-БД, API порт 4000); `l1-browser-scenarios.md`.
- Scope boundary: код `apps/web`/`apps/api` не менять.
