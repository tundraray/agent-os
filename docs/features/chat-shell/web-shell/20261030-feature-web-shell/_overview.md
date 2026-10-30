# Overall Design Document: web-shell (оболочка чата в `apps/web`)

Generation Date: 2026-10-30
Target Plan Document: `docs/features/chat-shell/web-shell/20261030-feature-web-shell.md` (frontmatter: `plan: 1 of 1`, `status: active`)
Task directory: `docs/features/chat-shell/web-shell/20261030-feature-web-shell/`

## Project Overview

### Purpose and Goals
Дать пользователю оболочку чата в стиле ChatGPT поверх реализованного `threads-api`: беседы сохраняются и адресуются URL (`/`, `/chat/[threadId]` в группе `(chat)`), открываются после F5, группируются по датам, переименовываются и удаляются; генерация не прерывается при переключении беседы и при «Новом чате»; ошибки ответа и инструмента показываются фиксированным русским текстом; всё проверено тестами (Vitest + RTL + MSW) и L1-сценариями в реальном браузере.

### Background and Context
`apps/web` — прототип: одна страница, `useChatRuntime` без адаптеров, клиентские id (сервер отвечает на них 404), беседа теряется при F5. `threads-api` реализован и закоммичен (план `completed`). Не меняются: `apps/api`, `packages/contracts`, `ChatRequestSchema`, версии `ai` (`apps/api` — `7.0.148` точно; `apps/web` — `^7.0.155`, решение пользователя).

## Task Division Design

### Division Policy
Стратегия Hybrid (из DD): risk-driven спайк рантайма первым (T1.1–T1.3, затем T1.4 после гейта G1), короткий горизонтальный фундамент (Phase 2), вертикальные срезы по сценариям (Phase 3–5), Should (Phase 6), лента (Phase 7), QA/L1 (Phase 8).
Единица задачи = одна единица, готовая к коммиту (manual), кроме T1.3, T8.1 (коммит только при исправлениях), T8.2, T8.3, T8.4 (кода в репозиторий не добавляют).

Распределение уровней верификации: L3 — T1.1, T1.2; L1 — T1.3, T8.3, T8.4 (браузер, оркестратор); L2 — задачи с тестами (T2.1–T7.5); T1.4/T2.4/T3.1 — L2/L3 плюс быстрая браузерная проверка оркестратором.

### Типы задач

| Тип | Задачи | Исполнитель |
|---|---|---|
| frontend (apps/web, код + тесты) | T1.1, T1.2, T1.4*, T2.1, T2.2, T2.3, T2.4*, T3.1*, T3.2, T3.3, T3.4, T4.1, T4.2, T4.3, T5.1, T5.2, T5.3, T6.1, T6.2, T7.1, T7.2, T7.3, T7.4, T7.5, T8.1 | `task-executor-frontend` |
| L1/browser | T1.3, T8.3, T8.4 | оркестратор через Claude-in-Chrome; шаги `[DevTools — user]` — просьба пользователю (группами); невыполненное = «not executed» + причина, никогда «pass» |
| dev-only | T8.2 (seed-скрипт в scratchpad, никогда не коммитится) | исполнитель (скрипт в scratchpad), запуск по требованию T8.3 |

\* T1.4 (проверка S-11), T2.4 (проверка темы/шрифта в `dev`), T3.1 (быстрая проверка cookie F5): код и CLI делает исполнитель, браузерную проверку делает оркестратор; результат записывается в Notes плана.

### Inter-task Relationship Map
```
Phase 1:  T1.1 → T1.2 → T1.3 (L1, ГЕЙТ G1) ⇢ T1.4
                          └→ [S-1 провал: СТОП, эскалация пользователю]
Phase 2:  T1.4 → T2.1 → {T2.2, T2.3}          T1.4 → T2.4
Phase 3:  T2.4 → T3.1 → {T3.2, T3.3} → T3.4   (T3.4 также требует T2.1-обвязку)
Phase 4:  T2.1 → T4.1 ;  {T4.1, T3.4} → T4.2 → T4.3
Phase 5:  T4.2 → T5.1 → T5.2 ;  T3.3 → T5.3 (после T5.2 из-за chat-shell.tsx)
Phase 6:  T4.2 → T6.1 (после T5.2: thread-history-list) ;  T5.1 → T6.2 (после T5.3: chat-shell/chat-header)
Phase 7:  T2.1 → T7.1 ; T2.1 → T7.4 ; T4.3 → T7.2 → T7.3 ; {T7.3, T7.4} → T7.5
Phase 8:  T7.1–T7.5 → T8.1 ; T1.3 → T8.2 ; {T8.1, T8.2} → T8.3 → T8.4
```
Deliverables между задачами — файлы кода и тестов в `apps/web/src` (см. Target Files задач); research-deliverable'ов нет, результаты T1.3/T1.4/T8.x записываются в Notes плана (оркестратором) и в `l1-browser-scenarios.md` (T8.3, T8.4).

Параллельно допустимо (не делят файлов с остальными): T7.1 и T7.4 — сразу после T2.1; T8.2 — в любой момент после T1.3. По умолчанию — последовательно.

### Interface Change Impact Analysis

| Existing Interface | New Interface | Conversion Required | Corresponding Task |
|---|---|---|---|
| `useChatRuntime()` без адаптеров (`components/assistant.tsx`) | `useRemoteThreadListRuntime` + адаптеры списка/истории, controlled `threadId` | Да (файл удаляется) | T1.1, T1.2 |
| `app/page.tsx` (одна страница) | `app/(chat)/{layout,page,chat/[threadId]/page}.tsx` | Да (файл удаляется) | T1.2 |
| `Thread` каркаса (`thread.aui.tsx`): англ. строки, `BranchPicker`, `EditComposer`, полный action bar | русские строки, 48rem, подсказки 2×2, только «Копировать», `MessageError`, слот `DeletedNotice` | Да | T3.4, T4.3, T7.2, T7.3, T7.5 |
| `markdown-text.tsx` (`a`/`img` без политики) | `linkPolicy` / `isRenderableImageSrc` | Да | T7.1 |
| `ToolFallbackImpl` / `ToolFallbackError` (показ `status.error`) | ветвление по `isError`, фиксированный текст | Да | T7.4 |
| `ui/sidebar.tsx` (CLI, `Sheet`) | `Drawer` (S-11), `setOpen(value,{persist})`, охрана `Ctrl/⌘+B` | Да | T1.4, T3.1, T6.2 |
| `ui/button.tsx` (`ring`, `destructive`) | непрозрачное кольцо, сплошной `destructive` + токен | Да | T2.4 |
| `app/layout.tsx` | шрифты c кириллицей, `ThemeProvider`, `Toaster`, viewport, preconnect | Да | T2.4 |
| `ChatRequestSchema`, `/api/*`, `ai` в обоих пакетах | не меняются | Нет | — |

### Common Processing Points
- `apps/web/src/lib/threads/*` — клиент API, адаптеры, `ShellStatus` (vanilla zustand), `url-sync`, `route-thread-id`, `title-poller`, `shell-services` — создаются в T1.1/T1.2 и используются всеми последующими задачами; не дублировать.
- `threadPath()` — единственное место построения пути беседы (Reference Contract Values).
- `src/test/{setup,msw-server,fixtures,render-with-runtime}` (T2.1) — общая обвязка тестов; `deferred()` и `<Toaster />` предусмотрены в T2.1, чтобы T3.4/T4.2/T5.2 не правили `src/test/*`.
- `lib/focus.ts` (T4.3) — политика фокуса для T5.1, T5.2, T5.3, T7.3.
- `ShellStatus` — не дублирует данные рантайма (инвариант Element 1, проверка в T8.1).

### Пересечения файлов (последовательность, не параллель)
- `apps/web/package.json`, `pnpm-lock.yaml`: T1.1 → T1.4 → T2.1
- `apps/web/src/components/assistant-ui/elements/thread.aui.tsx`: T3.4 → T4.3 → T7.2 → T7.3 → T7.5
- `apps/web/src/components/shell/shell.open-thread.int.test.tsx`: T2.1 → T3.4 → T4.2
- `apps/web/src/components/shell/chat-shell.tsx`: T1.2 → T1.4 → T3.1 → T3.3 → T3.4 → T4.2 → T5.3 → T6.2
- `apps/web/src/components/shell/app-sidebar.tsx`: T3.1 → T3.2 → T4.2 → T6.2
- `apps/web/src/components/ui/sidebar.tsx`: T1.4 → T3.1 → T6.2
- `apps/web/src/lib/threads/shell-services.ts`: T1.2 → T7.3
- `chat-runtime-provider.tsx`, `shell-actions.tsx`: T1.2 → T4.3
- `thread-history-list.tsx`, `thread-history-list.test.tsx`: T4.2 → T5.2 → T6.1
- `thread-history-item.tsx`: T4.2 → T4.3 → T5.1 → T5.2
- `main-view.tsx`: T3.4 → T4.3 → T7.3
- `thread-notice.tsx`, `thread-notice.test.tsx`: T3.4 → T7.3
- `chat-header.tsx`: T3.3 → T5.3 → T6.2
- `lib/config.ts`: T1.1 → T7.3
- `app/(chat)/layout.tsx`: T1.2 → T3.1
- `app/layout.tsx`: T2.4 → T7.5 (только проверка строк)

## Implementation Considerations

### Среда выполнения (одинакова для каждой задачи)
- Postgres на хост-порту **5433**: `POSTGRES_PORT=5433 pnpm db:up`; `DATABASE_URL=postgres://agent:agent@localhost:5433/agent_os`. `apps/api/.env`: `FRONTEND_ORIGIN=http://localhost:3000`; `pnpm --filter api dev` (порт 4000); `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`.
- `ai`: `apps/api` — ровно `7.0.148`; `apps/web` остаётся `^7.0.155` (решение пользователя, lock разрешает 7.0.155). Ни один не меняется. Проверка: `pnpm why -r ai`.
- **Next.js 16.4.3**: перед кодом читать `apps/web/node_modules/next/dist/docs/` (`apps/web/AGENTS.md`; блок AGENTS.md `next dev` пересоздаёт — не удалять).
- Гейты качества web (ноль ошибок): `pnpm --filter web lint`; `pnpm --filter web exec tsc --noEmit`; `pnpm --filter web test` (с T2.1); `pnpm --filter web build`. Prettier для `apps/web` не применяется (нет конфигурации).
- **Стратегия коммитов: manual.** Исполнители **не** запускают `git add`, `git commit`, `git stash`, `git checkout`. Задача завершается в состоянии «готово к коммиту»: изменения в рабочем дереве, гейты пройдены. Строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code» и упоминаний Claude нет ни в коммитах, ни в PR.

### Правила выполнения плана (действуют для каждой задачи, копия)
1. **Next 16.4.3.** Перед кодом, затрагивающим маршрутизацию, layout, `cookies()`, inline-скрипты, `viewport`, `Link`/`usePathname` — прочитать соответствующий документ в `apps/web/node_modules/next/dist/docs/01-app/` (`02-guides/preventing-flash-before-hydration.md`, `02-guides/preserving-ui-state.md`, `02-guides/single-page-applications.md`, `03-api-reference/03-file-conventions/dynamic-routes.md`). `apps/web/AGENTS.md` — блок, который `next dev` пересоздаёт; его не удалять.
2. **Версии.** `@assistant-ui/react` 0.15.32, `@assistant-ui/ai-sdk` 0.0.16, `@assistant-ui/react-markdown` 0.14.24, `assistant-stream` 0.3.55 — точные (без `^`). `ai` в `apps/web` остаётся `^7.0.155`, `ai` в `apps/api` — `7.0.148`; ни один не меняется. Проверка: `pnpm why -r ai` → `apps/api` 7.0.148, `apps/web` 7.0.155.
3. **Окружение для L1 и спайка.** `POSTGRES_PORT=5433 pnpm db:up` (порт 5432 занят чужим контейнером); `apps/api/.env`: `DATABASE_URL=postgres://agent:agent@localhost:5433/agent_os`, `FRONTEND_ORIGIN=http://localhost:3000`; `pnpm --filter api dev` (порт 4000); `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`.
4. **Перед прямым запуском vitest** в `apps/web` — `pnpm --filter @agent-os/contracts build`, если `packages/contracts/dist` старше `packages/contracts/src` (turbo `pnpm test` делает это сам через `^build`).
5. **Гейты качества задачи** (все — ноль ошибок): `pnpm --filter web lint`; `pnpm --filter web exec tsc --noEmit`; `pnpm --filter web test` (с T2.1); `pnpm --filter web build`. Prettier для `apps/web` не применяется: у пакета нет конфигурации (`.prettierrc` есть только в `apps/api`); стиль — по Applicable Standards DD (файлы приложения — одинарные кавычки и `;`, `ui/*` — как генерирует CLI).
6. **Скелеты `it.todo`**: каждый кейс реализуется по своим комментариям Arrange/Act/Assert; превращать todo в пустую заглушку запрещено; ожидаемые значения — литералы. Моки — только сеть (MSW) и `next/navigation`; `lib/threads/*` и `@assistant-ui/*` не мокаются.
7. **Тесты после спайка.** Модули Phase 1 пишутся до появления Vitest (порядок DD: спайк до шага 2). Их unit-тесты (T2.2, T2.3) — характеризационные: для каждого правила исполнитель один раз ломает код (мутация) и фиксирует, что тест краснеет; без этого задача не завершена.
8. **Файлы вне Target Files** задачи не меняются; если без этого задачу не выполнить — эскалация, а не расширение объёма. Временная отладочная инструментовка (счётчики монтирований, `console.count`) не остаётся в дереве к концу задачи.
9. **Dev-only seed** (T8.2) не попадает в репозиторий: скрипт живёт в scratchpad сессии.
10. **Наполнение `it.todo` — только поставленными строками и элементами.** Задача, наполняющая кейс скелета, до его наполнения сверяет каждую строку и элемент из Assert (тексты, роли, подписи, ссылки сайдбара — включая отрицательные утверждения `queryBy… === null`) с тем, что поставляет эта задача или более ранняя. Отрицательное утверждение о строке, которой ещё нет в интерфейсе, проходит пусто и ничего не доказывает. Если элемент поставляет более поздняя задача — кейс не наполняется, исполнитель эскалирует (перенос кейса — через `update` плана).

### Гейт G1 и остановки (жёсткие)
- **Гейт G1 (T1.3)**: S-1 (фоновый стриминг при смене беседы и «Новом чате») подтверждён в реальном браузере против реального API. **S-1 не подтверждён → СТОП**, отчёт пользователю: фоновый стриминг потребовал бы варианта B KD-1 (собственная карта экземпляров `Chat`) — это изменение дизайна, тихий переход запрещён. T1.4 и всё после неё не начинаются.
- Провалы S-2…S-5 и S-11 — не стоп: запасной путь из таблицы Early Verification Point + запись в Notes.
- **Проверка ключа провайдера (первый шаг T1.3)**: короткая отправка с `/` — ответ модели пришёл. Ответа нет и в логе `apps/api` отказ провайдера (401/403, ошибка ключа) → **СТОП**, T1.3 не продолжается, оркестратор сообщает пользователю, что ключ недействителен, и **ждёт решения** (спрашивает пользователя).
- Ключ `ANTHROPIC_API_KEY` из `apps/api/.env` разрешён пользователем для T1.3, T8.3, T8.4.

### Risks and Countermeasures
- Риск: `backgroundThreads` не сохраняет стрим при смене беседы (S-1). Мера: T1.3 до основной работы, гейт G1.
- Риск: `replaceState` перемонтирует layout/рассинхронизирует `usePathname` (S-2). Мера: счётчик монтирований в T1.3; запасной путь `router.replace`.
- Риск: `shadcn add` перезаписывает `ui/button.tsx`, `ui/skeleton.tsx`, `ui/tooltip.tsx`. Мера: T1.4 без `--overwrite`, одним вызовом; `git diff --stat` по трём файлам пуст.
- Риск: jsdom/base-ui несовместимы (порталы, pointer events, `matchMedia`). Мера: полифилы в `setup.ts` (T2.1).
- Риск: тесты модулей спайка пишутся после кода. Мера: правило 7 — мутационная проверка в T2.2/T2.3.
- Риск: `[DevTools — user]` шаги требуют пользователя. Мера: группировка просьб; «not executed» с причиной.
- Риск: `next dev` пересоздаёт блок `apps/web/AGENTS.md`. Мера: не удалять; если в диффе — коммитить вместе с работой.

### Impact Scope Management
- Allowed change scope: `apps/web/**`, `pnpm-lock.yaml`; `docs/features/chat-shell/web-shell/**` (только перенос скелетов в T2.1 и Evidence/Sign-off в T8.3/T8.4).
- No-change areas: `apps/api/**`, `packages/contracts/**`, `ChatRequestSchema`, версия `ai` в обоих пакетах, `apps/web/src/utils/href.ts`, `ui/button.tsx`/`ui/skeleton.tsx`/`ui/tooltip.tsx` в T1.4.

## Task Index

| Task | Type | Файл | Зависимости | Уровень |
|---|---|---|---|---|
| T1.1 | frontend | task-T1.1.md | — | L3 |
| T1.2 | frontend | task-T1.2.md | T1.1 | L3 |
| T1.3 | L1/browser (гейт G1) | task-T1.3.md | T1.2 | L1 |
| T1.4 | frontend (+S-11 оркестратор) | task-T1.4.md | T1.3 (G1), T1.2 | L3/L1 |
| T2.1 | frontend | task-T2.1.md | T1.4 | L2 |
| T2.2 | frontend | task-T2.2.md | T2.1 | L2 |
| T2.3 | frontend | task-T2.3.md | T2.1 | L2 |
| T2.4 | frontend | task-T2.4.md | T1.4 | L3 |
| T3.1 | frontend | task-T3.1.md | T2.4 | L2 |
| T3.2 | frontend | task-T3.2.md | T3.1 | L2 |
| T3.3 | frontend | task-T3.3.md | T3.1 | L2 |
| T3.4 | frontend | task-T3.4.md | T3.1, T3.3, T2.1 | L2 |
| T4.1 | frontend | task-T4.1.md | T2.1 | L2 |
| T4.2 | frontend | task-T4.2.md | T4.1, T3.4 | L2 |
| T4.3 | frontend | task-T4.3.md | T4.2 | L2 |
| T5.1 | frontend | task-T5.1.md | T4.2 | L2 |
| T5.2 | frontend | task-T5.2.md | T5.1 | L2 |
| T5.3 | frontend | task-T5.3.md | T3.3 (и T5.2 по файлам) | L2 |
| T6.1 | frontend | task-T6.1.md | T4.2 (и T5.2 по файлам) | L2 |
| T6.2 | frontend | task-T6.2.md | T5.1 (и T5.3 по файлам) | L2 |
| T7.1 | frontend | task-T7.1.md | T2.1 | L2 |
| T7.2 | frontend | task-T7.2.md | T4.3 | L2 |
| T7.3 | frontend | task-T7.3.md | T7.2 | L2 |
| T7.4 | frontend | task-T7.4.md | T2.1 | L2 |
| T7.5 | frontend | task-T7.5.md | T7.3, T7.4 | L2 |
| T8.1 | frontend (гейты/ревью) | task-T8.1.md | T7.1–T7.5 | L2/L3 |
| T8.2 | dev-only (scratchpad) | task-T8.2.md | T1.3 | — |
| T8.3 | L1/browser | task-T8.3.md | T8.1, T8.2 | L1 |
| T8.4 | L1/browser | task-T8.4.md | T8.1, T8.3 | L1 |

Phase completion files: `phase1-completion.md` … `phase8-completion.md`.

Индикатор интеграционных тестов (10 после слияний T2.1): T3.4 → 1/10; T4.2 → 4/10; T4.3 → 6/10; T5.2 → 7/10; T5.3 → 8/10; T7.3 → 10/10.
