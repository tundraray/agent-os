# Task T2.3: Unit-тесты `route-thread-id`, `url-sync`, опросчика заголовка (характеризация с мутациями)

Metadata:
- Task type: frontend (apps/web) — тесты
- Phase: 2
- Dependencies: task-T2.1 → Deliverable: Vitest-обвязка; модули T1.1 `route-thread-id.ts`, `url-sync.ts`, `title-poller.ts`
- Provides: характеризационные тесты URL-правил и опросчика; Notes «Мутационные проверки»
- Size: Small (3 тестовых файла)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- Тесты без API; `http://api.test` из `vitest.config.ts`; TZ `Europe/Berlin`.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны (правило 7 — мутации).

## Implementation Content
Характеризационные тесты правил URL беседы (`threadPath`/`parseRouteThreadId`, `syncUrlWithThread`) и опросчика автозаголовка (фейковые таймеры). Покрывает AC-04.1, AC-04.3, AC-20.1; S-2, S-4 (правила).

## Target Files
- [ ] `apps/web/src/lib/threads/route-thread-id.test.ts` (new)
- [ ] `apps/web/src/lib/threads/url-sync.test.ts` (new)
- [ ] `apps/web/src/lib/threads/title-poller.test.ts` (new)
- [ ] Исправления в `route-thread-id.ts`, `url-sync.ts`, `title-poller.ts` (T1.1) — только при вскрытом дефекте

## Investigation Targets
- `apps/web/src/lib/threads/{route-thread-id,url-sync,title-poller,shell-status-store}.ts`
- DD «Data Contract» (TitlePoll stream), «Маршрутизация и синхронизация URL»
- `packages/contracts/src/threads.ts` (`ThreadIdSchema`)

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Маршрутизация и синхронизация URL) | derived-display | «`threadPath(id) = `/chat/${encodeURIComponent(id)}`` (`lib/threads/route-thread-id.ts`) используется везде, где путь строится или сравнивается»; «`parseRouteThreadId(threadPath(id)) === id` для любого id из `ThreadIdSchema`»; «некорректная %-последовательность → сырой сегмент» | Y, если тесты утверждают round-trip и сырой сегмент для `/chat/%E0` |
| design-web-shell.md (§ Маршрутизация и синхронизация URL) | state-lifecycle-negative | «`remoteId` задан и `location.pathname !== threadPath(remoteId)` → `window.history.replaceState(null, '', threadPath(remoteId))`»; «`remoteId === undefined` и путь начинается с `/chat/` → `router.replace('/')`» | Y, если тесты утверждают `replaceState(null,'',…)`, `router.replace('/')` и отсутствие вызовов при равном пути |
| design-web-shell.md (§ Data Contract, TitlePoll stream) | state-lifecycle-negative | «нет ответа ассистента в messages → поток закрыт сразу, запросов нет; не более 1 запроса в 1 000 мс, не дольше 15 000 мс; ShellStatus.titleWaiting[remoteId] = true только во время опроса»; `TITLE_POLL_INTERVAL_MS = 1_000`, `TITLE_POLL_WINDOW_MS = 15_000` | Y, если тесты утверждают 15 запросов за окно 15 с и остановку на 404 |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| Таймеры | `vi.useFakeTimers()` в `title-poller.test.ts` | План T2.3 |
| Мутации | `push` вместо `replaceState`; опрос без проверки ответа ассистента; интервал 500 мс — каждая краснит кейс | План T2.3 |

## Investigation Notes
(Таблица мутаций.)

## Implementation Steps (TDD: Red-Green-Refactor, характеризация)
### 1. Red Phase
- [ ] `route-thread-id.test.ts`: `/chat/a%2Fb`, `/`, `/foo`, `/chat/`, `/chat/a/b`, `/chat/%E0` (сырой сегмент); round-trip для `'abc'`, `'a/b'`, `'с пробелом'`, `'%'`, `'?#&'`, UUID (табличный)
- [ ] `url-sync.test.ts`: `replaceState(null, '', threadPath(id))` при новом id; `router.replace('/')` при `undefined` на `/chat/…`; ничего при `location.pathname === threadPath(id)` (в т. ч. id с `/`)
- [ ] `title-poller.test.ts` (фейковые таймеры): без ответа ассистента запросов нет; заголовок на 3-м запросе → поток с текстом, `titleWaiting` снят; окно 15 с → 15 запросов и пустой поток; 404 → остановка
- [ ] Запустить; дефекты модулей — исправить

### 2. Green Phase
- [ ] Минимальные исправления модулей, тесты зелёные

### 3. Мутационная проверка (обязательна)
- [ ] `push` вместо `replaceState` → краснеет
- [ ] опрос без проверки ответа ассистента → краснеет
- [ ] интервал 500 мс → краснеет
- [ ] Откатить мутации; записать в Notes

### 4. Refactor Phase
- [ ] Свести дубли; тесты зелёные

## Quality Assurance Mechanisms
- Vitest (fake timers) — Type: `executable_check`
- ESLint, `tsc` — Type: `executable_check`
- Test Selection — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: `pnpm --filter web test` (3 файла), lint, tsc.
- **Success criteria**: 3 файла зелёные; мутации краснят кейсы.
- **Failure response**: исправить модуль T1.1; вне Target Files — эскалация.
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-04.1 / S-2 — синхронизация URL без навигации
- **Claim**: при появлении `remoteId` URL меняется `replaceState`; при исчезновении на `/chat/…` — `router.replace('/')`; при совпадении — ничего.
- **Primary failure mode**: `push` вместо `replaceState` (Назад ломается / перемонтирование).
- **Boundary to exercise**: in-process unit.
- **State assertion**: pathname до/после и вызовы `history`/`router`.
- **Mock boundary rationale**: `history`, `router`, `location` передаются параметрами (внедрение); сеть не используется.
- **Proven by**: `new: url-sync.test.ts — три ветки`.
- **Residual**: реальная работа `usePathname` — T1.3/L1-5.

### Obligation: AC-04.3 — разбор id из пути
- **Claim**: `parseRouteThreadId` возвращает id для `/chat/<enc>`; сырой сегмент для некорректной %-последовательности; `undefined` для прочих путей.
- **Primary failure mode**: исключение на `%E0` или потеря `/` в id.
- **Boundary to exercise**: in-process unit.
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Proven by**: `new: route-thread-id.test.ts — таблица`.
- **Residual**: нет.

### Obligation: AC-20.1 — опрос автозаголовка
- **Claim**: опрос идёт ≤ 1 раз в 1000 мс, ≤ 15 с, только если есть ответ ассистента; останавливается на 404; `titleWaiting` true только во время опроса.
- **Primary failure mode**: опрос без проверки ответа ассистента; интервал 500 мс.
- **Boundary to exercise**: in-process unit (fake timers + MSW).
- **State assertion**: `titleWaiting[remoteId]`: false → true → false.
- **Mock boundary rationale**: сеть — MSW; время — fake timers.
- **Proven by**: `new: title-poller.test.ts`.
- **Residual**: видимый заголовок — L1-1.

## Completion Criteria
- [ ] 3 файла зелёные, прогон содержательный
- [ ] Мутационная проверка записана в Notes
- [ ] lint, tsc — 0 ошибок
- [ ] Reference Contracts — `Y`

## Notes
- Impact scope: правки T1.1-модулей при дефекте.
- Scope boundary: вне Target Files не менять.
