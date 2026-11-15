---
feature: chat-shell
part: web-shell
design: design-web-shell.md
plan: 1 of 1
status: completed
---

# План работ: chat-shell / `web-shell` — оболочка чата в `apps/web`

Дата создания: 2026-10-30
Тип: feature
Оценка длительности: 9–12 рабочих дней (29 задач: T1.1–T1.4, T2.1–T2.4, T3.1–T3.4, T4.1–T4.3, T5.1–T5.3, T6.1–T6.2, T7.1–T7.5, T8.1–T8.4; 24 единицы, готовые к коммиту, — по одной на каждую задачу, кроме T1.3, T8.1, T8.2, T8.3, T8.4; T8.1 даёт единицу только при исправлениях, остальные четыре кода в репозиторий не добавляют)
Оценка объёма: ~75 файлов (≈ 55 новых, ≈ 18 изменённых, 2 удалённых; 7 скелетов переносятся в `apps/web/src/components/shell/`)
Ветка: `feature/chat-shell` (HEAD на момент планирования — `b31121e`; слияние в `main` — вместе с `threads-api`)

**Frontmatter — единственный источник последовательности планов.** Часть `web-shell` планируется одним планом (`plan: 1 of 1`); `depends-on` отсутствует, так как план первый в части. Межчастевая зависимость от `threads-api` (план `threads-api/20261028-feature-threads-api.md`, `status: completed`) — в «Connection Map». Статус `draft`: в каталоге части других планов нет, конфликт `active` исключён.

**Стратегия коммитов фичи: `manual`.** Оркестратор спрашивает пользователя; исполнители и оркестратор сами не коммитят. Задача завершается в состоянии «готово к коммиту»: изменения в рабочем дереве, все гейты задачи пройдены. В сообщениях коммитов **нет** строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code» и любых иных упоминаний Claude.

## Snapshot

- **Что меняется**: прототип `apps/web` (одна страница, `useChatRuntime` без адаптеров) становится оболочкой: маршруты `/` и `/chat/[threadId]` в группе `(chat)`, рантайм `useRemoteThreadListRuntime` с адаптерами поверх `threads-api` (KD-1), сайдбар по датам, шапка, тема без FOUC, шторка, рабочая область, action bar «Копировать», блок ошибки с «Перегенерировать», Vitest + RTL + MSW.
- **Что не меняется**: `apps/api`, `packages/contracts`, `ChatRequestSchema`; рендер сообщений каркаса (кроме исключений DD); версия `ai` в `apps/web` (`^7.0.155`) и в `apps/api` (`7.0.148`).
- **Порядок**: сначала спайк рантайма S-1…S-5 (Phase 1, ранняя точка проверки, гейт G1), после гейта — шторка S-11 (T1.4); провал S-1 (фоновый стриминг) — **стоп и эскалация пользователю**.
- **Главный риск**: `backgroundThreads` не сохраняет стрим AI SDK при смене беседы (S-1, Certainty: low).
- **Тесты**: 10 интеграционных (14 скелетов, 4 слиты; исключение из лимита 5 — раздел «Решение по бюджету интеграционных тестов»), unit и компонентные по Test Strategy DD, L1-сценарии L1-1…L1-10 в финальной фазе.
- **Открытых вопросов к пользователю**: 0 — все четыре закрыты (раздел «Открытые вопросы»); отступление от DD — `ai` в `apps/web` остаётся `^7.0.155` (строка `gap` в трассировке).

## Связанные документы

- PRD: `docs/features/chat-shell/prd.md` v1.5 — FR-01…FR-12 (Must), FR-19…FR-22 (Should); Delivery Parts: `web-shell` (dependsOn: `threads-api`)
- UXRD: `docs/features/chat-shell/uxrd.md` v1.7 — трассировка компонентов (раздел «UXRD Component → Task Mapping»)
- Design Doc: `docs/features/chat-shell/design-web-shell.md` v1.5 (Approved) — KD-1, Implementation Order (шаги 1–11, 10a), Verification Strategy, спайки S-1…S-11
- Upstream: `docs/features/chat-shell/design-threads-api.md` v1.9; план `docs/features/chat-shell/threads-api/20261028-feature-threads-api.md` (`completed`, T6.3 отложена в браузерную проверку этой части); контракты `packages/contracts/src/threads.ts`
- ADR: нет (раздел «ADR Bindings»)
- Скелеты интеграционных тестов (до T2.1): `docs/features/chat-shell/web-shell/test-skeletons/{shell.list,shell.new-chat,shell.open-thread,shell.deleted-thread,shell.message-error,shell.delete-open-thread,shell.workspace}.int.test.tsx` — 14 `it.todo` в 7 файлах
- L1-чек-лист: `docs/features/chat-shell/web-shell/l1-browser-scenarios.md` (L1-1…L1-10, T6.3-a, T6.3-b)

## Правила выполнения (действуют для каждой задачи)

1. **Next 16.4.3.** Перед кодом, затрагивающим маршрутизацию, layout, `cookies()`, inline-скрипты, `viewport`, `Link`/`usePathname` — прочитать соответствующий документ в `apps/web/node_modules/next/dist/docs/01-app/` (`02-guides/preventing-flash-before-hydration.md`, `02-guides/preserving-ui-state.md`, `02-guides/single-page-applications.md`, `03-api-reference/03-file-conventions/dynamic-routes.md`). `apps/web/AGENTS.md` — блок, который `next dev` пересоздаёт; его не удалять.
2. **Версии.** `@assistant-ui/react` 0.15.32, `@assistant-ui/ai-sdk` 0.0.16, `@assistant-ui/react-markdown` 0.14.24, `assistant-stream` 0.3.55 — точные (без `^`). `ai` в `apps/web` остаётся `^7.0.155` (lock-файл разрешает 7.0.155), `ai` в `apps/api` — `7.0.148`; ни один из них не меняется. Проверка: `pnpm why -r ai` → `apps/api` 7.0.148, `apps/web` 7.0.155.
3. **Окружение для L1 и спайка.** `POSTGRES_PORT=5433 pnpm db:up` (порт 5432 занят чужим контейнером); `apps/api/.env`: `DATABASE_URL=postgres://agent:agent@localhost:5433/agent_os`, `FRONTEND_ORIGIN=http://localhost:3000`; `pnpm --filter api dev` (порт 4000); `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`.
4. **Перед прямым запуском vitest** в `apps/web` — `pnpm --filter @agent-os/contracts build`, если `packages/contracts/dist` старше `packages/contracts/src` (turbo `pnpm test` делает это сам через `^build`).
5. **Гейты качества задачи** (все — ноль ошибок): `pnpm --filter web lint`; `pnpm --filter web exec tsc --noEmit`; `pnpm --filter web test` (с T2.1); `pnpm --filter web build`. Prettier для `apps/web` не применяется: у пакета нет конфигурации (`.prettierrc` есть только в `apps/api`); стиль — по Applicable Standards DD (файлы приложения — одинарные кавычки и `;`, `ui/*` — как генерирует CLI).
6. **Скелеты `it.todo`**: каждый кейс реализуется по своим комментариям Arrange/Act/Assert; превращать todo в пустую заглушку запрещено; ожидаемые значения — литералы. Моки — только сеть (MSW) и `next/navigation`; `lib/threads/*` и `@assistant-ui/*` не мокаются.
7. **Тесты после спайка.** Модули Phase 1 пишутся до появления Vitest (порядок DD: спайк до шага 2). Их unit-тесты (T2.2, T2.3) — характеризационные: для каждого правила исполнитель один раз ломает код (мутация) и фиксирует, что тест краснеет; без этого задача не завершена.
8. **Файлы вне Target Files** задачи не меняются; если без этого задачу не выполнить — эскалация, а не расширение объёма. Временная отладочная инструментовка (счётчики монтирований, `console.count`) не остаётся в дереве к концу задачи.
9. **Dev-only seed** (T8.2) не попадает в репозиторий: скрипт живёт в scratchpad сессии.
10. **Наполнение `it.todo` — только поставленными строками и элементами.** Задача, наполняющая кейс скелета, до его наполнения сверяет каждую строку и элемент из Assert (тексты, роли, подписи, ссылки сайдбара — включая отрицательные утверждения `queryBy… === null`) с тем, что поставляет эта задача или более ранняя. Отрицательное утверждение о строке, которой ещё нет в интерфейсе, проходит пусто и ничего не доказывает. Если элемент поставляет более поздняя задача — кейс не наполняется, исполнитель эскалирует (перенос кейса — через `update` плана).

## Phase Structure Diagram

```mermaid
---
title: "Фазы плана web-shell"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  flowchart:
    curve: step
---
flowchart LR
    P1["Phase 1 · спайк S-1…S-5,<br/>S-11 (T1.4, после G1)"]
    G1{"гейт G1<br/>фоновый стрим"}
    STOP(["пользователь<br/>решает по эскалации"])
    P2["Phase 2 · тесты,<br/>тема, токены"]
    P3["Phase 3 · каркас<br/>оболочки"]
    P4["Phase 4 · список,<br/>открытие, новый чат"]
    P5["Phase 5 · переименование,<br/>удаление, рабочая область"]
    P6["Phase 6 · Should<br/>FR-19, FR-22"]
    P7["Phase 7 · лента<br/>ошибки, markdown, i18n"]
    QA["Phase 8 · QA<br/>и L1-сценарии"]
    P1 --> G1
    G1 -->|"пройден"| P2
    G1 -.->|"S-1 не подтверждён"| STOP
    P2 --> P3
    P3 --> P4
    P4 --> P5
    P5 --> P6
    P6 --> P7
    P7 --> QA
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    classDef changed fill:#fde8e8,stroke:#dc2626,stroke-width:2px,color:#1a1a1a
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    class STOP,QA,G1 unchanged
    class P1,P7 changed
    class P2,P3,P4,P5,P6 new
```

Гейт G1 — проверка S-1 внутри Phase 1 (T1.3); всё, что идёт после него, на схеме — справа от гейта. Задача T1.4 (шторка S-11) числится в Phase 1, но начинается только после гейта G1. Гейт G1: S-1 (фоновый стриминг при переключении беседы и при «Новом чате») подтверждён в реальном браузере против реального API. Провал S-1 — стоп реализации и отчёт пользователю: фоновый стриминг потребовал бы варианта B KD-1 (собственная карта экземпляров `Chat`) — это изменение дизайна, тихий переход запрещён. Провалы S-2…S-5 и S-11 — не стоп: исполнитель применяет запасной путь из таблицы Early Verification Point и записывает результат в Notes. Phase 6 и Phase 7 выполняются последовательно по умолчанию; T7.1 и T7.4 не делят файлов с Phase 3–6 и могут идти параллельно сразу после T2.1.

## Task Dependency Diagram

Правило глубины (не больше двух уровней зависимостей) действует внутри фазы; между фазами порядок задают критерии завершения фаз и гейт G1. Пунктирная стрелка — гейт, а не зависимость задач, в счёт глубины не входит.

```mermaid
---
title: "Задачи Phase 1–2"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  flowchart:
    curve: step
---
flowchart LR
    T11["T1.1 клиент API,<br/>адаптеры, статус-стор"]
    T12["T1.2 рантайм,<br/>маршруты (chat)"]
    T13["T1.3 L1 спайка<br/>S-1…S-5"]
    T14["T1.4 shadcn add,<br/>шторка Drawer S-11"]
    T21["T2.1 Vitest, MSW,<br/>перенос скелетов"]
    T22["T2.2 unit клиента<br/>и адаптеров"]
    T23["T2.3 unit URL<br/>и опроса заголовка"]
    T24["T2.4 тема, шрифт,<br/>токены"]
    T11 --> T12
    T12 --> T13
    T13 -.->|"гейт G1"| T14
    T14 --> T21
    T21 --> T22
    T21 --> T23
    T14 --> T24
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    classDef changed fill:#fde8e8,stroke:#dc2626,stroke-width:2px,color:#1a1a1a
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    class T13 unchanged
    class T12,T24 changed
    class T11,T14,T21,T22,T23 new
```

```mermaid
---
title: "Задачи Phase 3–4"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  flowchart:
    curve: step
---
flowchart LR
    T24["T2.4 тема,<br/>токены"]
    T31["T3.1 ChatShell,<br/>AppSidebar"]
    T32["T3.2 меню<br/>пользователя"]
    T33["T3.3 шапка"]
    T34["T3.4 MainView,<br/>TH-06/TH-07"]
    T41["T4.1 группировка<br/>по датам"]
    T42["T4.2 список<br/>бесед"]
    T43["T4.3 новый чат,<br/>приветствие"]
    T24 --> T31
    T31 --> T32
    T31 --> T33
    T31 --> T34
    T33 --> T34
    T41 --> T42
    T34 --> T42
    T42 --> T43
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    classDef changed fill:#fde8e8,stroke:#dc2626,stroke-width:2px,color:#1a1a1a
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    class T24 unchanged
    class T34,T43 changed
    class T31,T32,T33,T41,T42 new
```

```mermaid
---
title: "Задачи Phase 5–6"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  flowchart:
    curve: step
---
flowchart LR
    T42["T4.2 список<br/>бесед"]
    T33["T3.3 шапка"]
    T51["T5.1 переименование"]
    T52["T5.2 удаление"]
    T53["T5.3 рабочая<br/>область"]
    T61["T6.1 подгрузка<br/>FR-19"]
    T62["T6.2 сочетания<br/>FR-22"]
    T42 --> T51
    T51 --> T52
    T33 --> T53
    T42 --> T61
    T51 --> T62
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    classDef changed fill:#fde8e8,stroke:#dc2626,stroke-width:2px,color:#1a1a1a
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    class T42,T33 unchanged
    class T61,T62 changed
    class T51,T52,T53 new
```

```mermaid
---
title: "Задачи Phase 7–8"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  flowchart:
    curve: step
---
flowchart LR
    T71["T7.1 политика<br/>markdown"]
    T72["T7.2 action bar<br/>«Копировать»"]
    T73["T7.3 блок ошибки,<br/>E-8"]
    T74["T7.4 ошибка<br/>инструмента"]
    T75["T7.5 локализация,<br/>доступность"]
    T81["T8.1 гейты,<br/>проверка AC"]
    T82["T8.2 dev-only<br/>seed"]
    T83["T8.3 L1-1…L1-10"]
    T84["T8.4 T6.3-a/b<br/>метрики № 10, № 7"]
    T72 --> T73
    T73 --> T75
    T74 --> T75
    T71 --> T81
    T75 --> T81
    T81 --> T83
    T82 --> T83
    T83 --> T84
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    classDef changed fill:#fde8e8,stroke:#dc2626,stroke-width:2px,color:#1a1a1a
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    class T81,T82,T83,T84 unchanged
    class T71,T72,T73,T74,T75 changed
```

T7.2 начинается после T4.3 (обе правят `thread.aui.tsx`); T7.1 и T7.4 — после T2.1. T8.2 не зависит от кода `apps/web` и может быть подготовлена в любой момент после T1.3. T4.2 зависит от T3.4 через `shell.open-thread.int.test.tsx` и `MainView` (T3.1 при этом уже позади). T8.4 идёт после T8.3: она останавливает API на порту 4000 ради worktree `83fd532`.

**Пересечения файлов** (последовательность, не параллель):
- `apps/web/package.json`, `pnpm-lock.yaml`: T1.1 → T1.4 → T2.1
- `apps/web/src/components/assistant-ui/elements/thread.aui.tsx`: T3.4 → T4.3 → T7.2 → T7.3 → T7.5
- `apps/web/src/components/shell/shell.open-thread.int.test.tsx`: T2.1 → T3.4 → T4.2
- `apps/web/src/components/shell/chat-shell.tsx`: T1.2 → T1.4 → T3.1 → T3.3 → T3.4 → T4.2 → T5.3 → T6.2
- `apps/web/src/components/shell/app-sidebar.tsx`: T3.1 → T3.2 → T4.2 → T6.2
- `apps/web/src/components/ui/sidebar.tsx`: T1.4 → T3.1 → T6.2
- `apps/web/src/lib/threads/shell-services.ts`: T1.2 → T7.3
- `apps/web/src/components/shell/chat-runtime-provider.tsx`, `shell-actions.tsx`: T1.2 → T4.3
- `apps/web/src/components/shell/thread-history-list.tsx`, `thread-history-list.test.tsx`: T4.2 → T5.2 → T6.1
- `apps/web/src/components/shell/thread-history-item.tsx`: T4.2 → T4.3 → T5.1 → T5.2
- `apps/web/src/components/shell/main-view.tsx`: T3.4 → T4.3 → T7.3
- `apps/web/src/components/shell/thread-notice.tsx`, `thread-notice.test.tsx`: T3.4 → T7.3
- `apps/web/src/components/shell/chat-header.tsx`: T3.3 → T5.3 → T6.2
- `apps/web/src/lib/config.ts`: T1.1 → T7.3
- `apps/web/src/app/(chat)/layout.tsx`: T1.2 → T3.1
- `apps/web/src/app/layout.tsx`: T2.4 → T7.5 (только проверка строк)

## Verification Strategy (из Design Doc)

### Correctness Proof Method

- **Correctness definition**: (а) каждый AC web-shell проходит свой автоматический тест или L1-сценарий на production-сборке против реального `threads-api`; (б) лента восстановленной беседы визуально и по составу частей совпадает с живой (качественная метрика PRD «Непрерывность»); (в) переключение беседы и «Новый чат» не прерывают генерацию.
- **Verification method**: Vitest (U/C/I) в CI; L1-сценарии через Claude-in-Chrome со скриншотами, консолью и Network; side-by-side сравнение живой и восстановленной беседы (L1-4).
- **Verification timing**: спайк — до шага 2 (Phase 1 этого плана); U/C/I — в каждом срезе; L1 — по завершении каждого среза для его сценариев (операционная проверка фазы) и полный прогон на шаге 11 (T8.3).

### Early Verification Point

- **First verification target**: спайк S-1…S-5 — `ChatRuntimeProvider` + адаптеры + `url-sync` + минимальная разметка (список ссылок, `Thread`) против реального API (T1.1–T1.3); S-11 — шторка на base-ui `Drawer` (T1.4, после гейта G1).
- **Success criteria** (все в реальном браузере, копия DD):
  1. Первая отправка с `/`: `POST /api/threads` → `POST /api/chat/assistant` с `id` из ответа; URL `/chat/<id>` через `replaceState`; layout не перемонтирован (счётчик монтирований `ChatRuntimeProvider` = 1), запроса документа или RSC-перезапроса layout нет.
  2. Во время стрима в X переход на Y (ссылка) и на `/`: запрос X не отменён, ответ X дописан; возврат в X показывает продолжающийся или полный ответ.
  3. F5 на `/chat/<id>` → история; `/chat/does-not-exist` → `switchError` с `kind: 'not_found'`; искусственный 500 на `/messages` (MSW в браузере или временный флаг API) → статус `load_failed`, «Повторить» загружает.
  4. Назад/Вперёд переключают беседы.
  5. Удаление беседы с идущим стримом останавливает генерацию (в логе API — отмена по `close`).
- **Failure response** (копия DD): (1)/(4) — переключиться на `router.replace` вместо `replaceState` и повторить; (2) не подтвердилось — **стоп**, отчёт пользователю: фоновый стриминг требует варианта B (собственная карта экземпляров `Chat`) — изменение дизайна; (3) — перейти на `adapter.unstable_useAdapters` для истории; (5) — явная `cancelRun` тела перед `delete` через `aui.threads.item({ id })`-контекст.
- **Уточнение плана к п. 3**: «искусственный 500» создаётся обёрткой `window.fetch` через `javascript_tool` (как в L1-10), без временного флага в `apps/api` — API в этой части не меняется.

| # | Пункт | Certainty | Задача проверки | Если не подтвердилось |
|---|---|---|---|---|
| S-1 | Фоновый стрим при смене main и `switchToNewThread` | low | T1.3 (п. 2), T8.3 (L1-6) | **Стоп и эскалация** |
| S-2 | `replaceState` синхронизирует `usePathname`, без перемонтирования; `Link` и Назад/Вперёд | low | T1.3 (п. 1, 4), T8.3 (L1-5) | `router.replace('/chat/<id>')` |
| S-3 | `useAui()` в `runtimeHook`, кэш `WeakMap`, `load()` один раз на монтирование | medium | T1.3 (п. 3 + счётчик `load`) | `adapter.unstable_useAdapters` |
| S-4 | `generateTitle` после первого прогона, заголовок без `rename` | medium | T1.3 (Network: нет `PATCH`), T8.3 (L1-1) | Опрос из `ThreadActivityTracker` + `aui.threads.reload()` |
| S-5 | Удаление беседы останавливает стрим | low | T1.3 (п. 5) | Явная остановка прогона перед `delete` |
| S-6 | Отказ `rename`/`delete` откатывает оптимистичное изменение | medium | T2.2 (U), T8.3 (L1-2) | Повторный `fetch` метаданных |
| S-7 | `document.title` не перезаписывается метаданными Next | medium | T4.3, T8.3 (L1-5) | `<title>` React 19 в `DocumentTitle` |
| S-8 | base-ui `AlertDialog`/`Sheet` `initialFocus`/`finalFocus`; sonner объявляет ошибки | medium | T5.2 (C), T8.3 (L1-9) | Фокус в `onOpenChange`; `toast.custom` с `role="alert"` |
| S-9 | `AuiConfig({ suggestions })` наполняет `ThreadPrimitive.Suggestions` | medium | T4.3 (`thread-welcome.test.tsx`) | `useAui({ suggestions })` + `AuiProvider` |
| S-10 | `react-resizable-panels` 4.15 `collapsible` панель | medium | T5.3, T8.3 (L1-1) | Условный рендер панели без анимации |
| S-11 | base-ui `Drawer` в мобильной ветке `ui/sidebar.tsx` | medium | T1.4, T3.1 (C), T8.3 (L1-3) | `Sheet` + обработчик `pointerdown/pointerup` (≥ 30 % ширины) |

### Proof Strategy

- **Источник обязательств доказательства**: комментарии скелетов (Primary failure mode, Behavior) для интеграционных тестов; для U/C — первичный режим отказа AC и применимые категории Failure Mode Checklist.
- **Распространение на задачи**: каждая задача, реализующая утверждение или применимую категорию отказа, записывает Proof obligations — что именно тест обязан поймать (какая мутация делает его красным). Ревью проверяет, доказывают ли тесты утверждение, а не только исполняются.

## Quality Assurance Mechanisms (из Design Doc)

| Mechanism | Enforces | Config/Source | Covered Files | Type |
|-----------|----------|---------------|---------------|------|
| ESLint `eslint-config-next` (core-web-vitals + typescript) | Правила Next/React/TS; `no-img-element` выключен только списком `files` | `apps/web/eslint.config.mjs` | `apps/web/src/**` | executable_check |
| TypeScript `strict`, `noEmit` | Типы без `any`; внешние данные — `unknown` + zod | `apps/web/tsconfig.json` | `apps/web/**/*.ts(x)` | executable_check |
| Vitest 4 + RTL + MSW (`vitest run`) | U/C/I-тесты без запущенного API (AC-12.2) | `apps/web/vitest.config.ts`, `apps/web/src/test/setup.ts` | `apps/web/src/**/*.test.{ts,tsx}` | executable_check |
| `next build` | Пререндер; падение без `NEXT_PUBLIC_API_URL` | `apps/web/next.config.ts`, `apps/web/src/lib/config.ts` | `apps/web` | executable_check |
| turbo `test` → `^build` | Тесты web видят собранный `@agent-os/contracts` | `turbo.json` | project-wide | executable_check |
| Стиль файлов (кавычки, `;`, CLI-стиль `ui/*`) | Implicit-стандарт, подтверждён пользователем | DD «Applicable Standards» | `apps/web/src/**` | passive_constraint |
| Обёртки assistant-ui — `*.aui.tsx`; оболочка — `components/shell/*.tsx` | Implicit-стандарт размещения | DD «Applicable Standards» | `apps/web/src/components/**` | passive_constraint |
| Движение и нажатия — `surfaces.tsx` (`pressable`, `ShimmerLabel`, `--ease-panel`) | Implicit-стандарт | `apps/web/src/components/surfaces.tsx` | `apps/web/src/components/**` | passive_constraint |
| Только семантические токены; WCAG 2.1 AA | PRD Dark mode, UXRD 7.6 | `apps/web/src/app/globals.css` | `apps/web/src/**` | passive_constraint |
| Точные версии `@assistant-ui/*`, `assistant-stream`; `ai` не меняется | Стабильность `unstable_` API | `apps/web/package.json`, `pnpm-lock.yaml` | `apps/web/package.json` | passive_constraint |
| Интеграция с `unstable_` API изолирована | Maintainability NFR | DD «Non-Functional Requirements» | `apps/web/src/lib/threads/*`, `apps/web/src/components/shell/chat-runtime-provider.tsx` | passive_constraint |

## Решение по бюджету интеграционных тестов

Лимит `integration-e2e-testing` — 3 интеграционных теста на часть, расширенный — до 5 с обоснованием. DD (утверждён) называет 7 интеграционных файлов; генератор оставил в них 14 `it.todo`. План сливает четыре кандидата — каждое слияние продолжает тот же сценарий, а правило, которое кандидат дублировал, доказывается ниже:

| Кандидат | Решение | Обоснование |
|---|---|---|
| AC-11.1 (рабочая область скрыта при загрузке) | Слит в тест AC-11.3 как утверждение после загрузки (до первого клика) | Тот же рендер `ChatShell`; дефект «панель открыта по умолчанию» ловится первым утверждением теста AC-11.3 |
| AC-03.3 (новая беседа первой в «Сегодня», активна) | Слит в тест AC-04.1 | Тот же сценарий первой отправки; правило сортировки — unit `group-threads-by-date.test.ts`, интеграция проверяет только проводку `ThreadActivityTracker` → группировка (утверждения добавляются в тот же тест, фикстура: беседа с `updatedAt` сегодня 09:00) |
| AC-01.5, ветка «Повторить» | Слит в тест AC-01.7 | Тот же сценарий ошибки списка: после проверки композера — «Повторить» → второй `GET /api/threads` без `cursor` → список; вид кнопки и вызов `onRetry` — компонентный тест `thread-history-list.test.tsx` |
| AC-04.3 (неизвестный id → TH-06) | Слит в первый тест AC-02.2 | Тот же `deferred` на `GET /api/threads/x`: сначала скелетон, затем разрешение 404 → «Беседа не найдена» с фокусом на `h1`; классификация 404 — unit `threads-api-client.test.ts` |

Итог — **10 тестов в 7 файлах: на 5 больше расширенного лимита (5)**. Исключение следует из утверждённого DD, который называет 7 интеграционных файлов, и подтверждено пользователем. Каждый из десяти тестов ловит дефект, которого не видит ни unit/C-тест, ни другой интеграционный тест:

| Тест (файл) | Дефект, который ловит только он |
|---|---|
| AC-01.7 + AC-01.5 (`shell.list`) | Библиотека глотает ошибку списка, а невалидный ответ ломает композер; «Повторить» не вызывает `threads.reload()` |
| AC-03.2 (`shell.new-chat`) | «Новый чат» создаёт беседу на сервере до первой отправки |
| AC-04.1 + AC-03.3 (`shell.new-chat`) | Порядок `POST /api/threads` → `POST /api/chat`, `body.id`, `replaceState`; новая беседа не попадает в список активной. Дефект «поднятие беседы не подключено» этот тест не ловит: беседа без `lastMessageAt` и так встаёт первой в «Сегодня» (`group-threads-by-date.ts:35`); его ловит `thread-activity-tracker.test.tsx` |
| AC-02.2 + AC-04.3 (`shell.open-thread`) | Приветствие вместо скелетона при прямой ссылке; `switchError` не доходит до TH-06 |
| AC-02.2 F5 (`shell.open-thread`) | Гонка правила 4: приветствие мелькает, когда список отвечает после истории |
| AC-02.5 (`shell.open-thread`) | Ошибка истории не видна (библиотека глотает) или «Повторить» не освобождает `RetryGate` |
| AC-08.5e (`shell.deleted-thread`) | 404 `THREAD_NOT_FOUND` без `responseBody` классифицирован как обычная ошибка TH-08 |
| AC-08.5b (`shell.message-error`) | Блок ошибки и «Перегенерировать» остаются у старого ответа после новой отправки |
| AC-06.2 (`shell.delete-open-thread`) | `router.push` вместо `replace`; URL остаётся `/chat/a` после удаления открытой беседы |
| AC-11.3 + AC-11.1 (`shell.workspace`) | Фокус теряется на `body` при закрытии «×»; панель открыта по умолчанию |

**Полностековые компонентные тесты сверх исключения 10 (для внимания пользователя).** `test-auditor` (T8.1) отметил три теста уровня интеграции без суффикса `.int`: они рендерят полную оболочку или реальный рантайм, но по имени остаются компонентными. Оркестратор решил сохранить их — у каждого свой дефект, которого не ловит ни один из десяти интеграционных тестов:

| Тест (файл) | Дефект, который ловит только он |
|---|---|
| `app-sidebar.test.tsx` (шторка S-11, AC-10.2) | Выбор беседы или «Новый чат» в мобильной шторке не закрывает её либо оставляет фокус на «Меню» вместо `h1` страницы |
| `thread-activity-tracker.test.tsx` (D-11) | Поднятие беседы при начале ответа не подключено: беседа из «Предыдущие 7 дней» не поднимается наверх «Сегодня», пока ответ идёт |
| `i18n.test.tsx` «new chat and the conversation menus» | Подписи «Нового чата» и меню беседы не локализованы — английские тексты библиотеки просачиваются в оболочку |

Фоновый стриминг (AC-02.6, AC-03.4) намеренно без автотеста — S-1 и L1-6 (обоснование DD «Integration Tests»). Слияния выполняет T2.1 при переносе скелетов: слитые `it.todo` удаляются, их Arrange/Act/Assert-комментарии переносятся в принимающий кейс.

**Место интеграционных тестов.** DD называет имена файлов, но не каталог; правило DD «тесты — рядом с кодом, кроме общей обвязки в `src/test/`» даёт `apps/web/src/components/shell/` (рядом с `ChatShell`). Шаблон `include: ['src/**/*.test.{ts,tsx}']` их подхватывает.

**Распределение по задачам** (правило выполнения 10): кейс наполняется в задаче, которая поставляет все проверяемые им строки и элементы. `shell.open-thread`: AC-02.2 + AC-04.3 — T3.4 (подпись композера «Сообщение» и приветствие «Чем могу помочь?» ставит сама T3.4); F5 и AC-02.5 — T4.2 (утверждают ссылку сайдбара «Отчёт», которая появляется только со списком).

## Design-to-Plan Traceability

| Design Doc | DD Section | DD Item | Category | Covered By Task(s) | Gap Status | Notes |
|---|---|---|---|---|---|---|
| design-web-shell.md | KD-1 | Вариант A: `useRemoteThreadListRuntime` (клиентский режим, `backgroundThreads`) + собственные адаптеры | impl-target | T1.1, T1.2, T1.3 | covered | Провал S-1 — стоп |
| design-web-shell.md | Implementation Path Mapping | Удалить `app/page.tsx`, `components/assistant.tsx` | impl-target | T1.2 | covered | |
| design-web-shell.md | Implementation Path Mapping | `app/layout.tsx`: шрифты, `ThemeProvider`, `Toaster`, theme-color, `suppressHydrationWarning`, `viewport`, `preconnect`, метаданные | impl-target | T2.4 | covered | |
| design-web-shell.md | Implementation Path Mapping | `globals.css`: `--font-sans`, кольцо, `--destructive-foreground`, токены оболочки и движения | impl-target | T2.4 | covered | |
| design-web-shell.md | Implementation Path Mapping | `thread.aui.tsx`: 48rem, экспорт скелетона, заголовок приветствия, подпись и placeholder композера | impl-target | T3.4 | covered | Строки, которые утверждает `shell.open-thread` |
| design-web-shell.md | Implementation Path Mapping | `thread.aui.tsx`: подсказки 2×2, прочие тексты приветствия, вложения скрыты, `autoFocus={false}` | impl-target | T4.3 | covered | |
| design-web-shell.md | Implementation Path Mapping / Action bar | `thread.aui.tsx`: action bar, удаление `BranchPicker`/`EditComposer`, пустые ответы | impl-target | T7.2 | covered | |
| design-web-shell.md | Implementation Path Mapping / Action bar | `thread.aui.tsx`: `MessageError`, «Перегенерировать», слот `DeletedNotice` | impl-target | T7.3 | covered | |
| design-web-shell.md | Implementation Path Mapping | `tool-fallback.aui.tsx`: ветвление по `isError`, фиксированный текст, строки | impl-target | T7.4 | covered | |
| design-web-shell.md | Implementation Path Mapping | Строки `attachment.aui.tsx`, `reasoning.tsx`, `tool-group.aui.tsx`, `ui/dialog.tsx`, `image.tsx`, `file.tsx`, `media-player.tsx` | impl-target | T7.5 | covered | |
| design-web-shell.md | Implementation Path Mapping | `markdown-text.tsx`: «Копировать», `a`/`img` | impl-target | T7.1 | covered | |
| design-web-shell.md | Implementation Path Mapping | `ui/button.tsx`: непрозрачное кольцо, сплошной `destructive` | impl-target | T2.4 | covered | |
| design-web-shell.md | Implementation Path Mapping | `eslint.config.mjs`: `markdown-text.tsx` в списке `files` | impl-target | T7.1 | covered | |
| design-web-shell.md | Implementation Path Mapping | `package.json`: зависимости, скрипты, точные версии `@assistant-ui/*` и `assistant-stream` | prerequisite | T1.1, T1.4, T2.1 | covered | |
| design-web-shell.md | Implementation Order, шаг 2 | `package.json`: точная фиксация `ai` 7.0.155 в `apps/web` | prerequisite | T1.1, T8.1 (проверка) | gap | Решение пользователя: остаётся `^7.0.155`; lock-файл разрешает 7.0.155; `pnpm why -r ai` — в T1.1 и T8.1. Закрыто подтверждением пользователя |
| design-web-shell.md | Implementation Path Mapping | shadcn add `sidebar, sheet, dropdown-menu, alert-dialog, input, separator, sonner` + `use-mobile` | prerequisite | T1.4 | covered | |
| design-web-shell.md | Implementation Path Mapping | `app/(chat)/layout.tsx` (Suspense + `cookies()`), страницы `null` | impl-target | T1.2, T3.1 | covered | |
| design-web-shell.md | Implementation Path Mapping | `app/error.tsx` | impl-target | T3.1 | covered | Перенесено по DD v1.7 |
| design-web-shell.md | Implementation Path Mapping | `components/theme-provider.tsx` | impl-target | T2.4 | covered | |
| design-web-shell.md | Implementation Path Mapping | `hooks/use-media-query.ts`, `use-now.ts`, `use-global-shortcuts.ts` | impl-target | T3.1, T4.1, T6.2 | covered | |
| design-web-shell.md | Main Components | `ChatShell` | impl-target | T1.2, T3.1, T5.3 | covered | |
| design-web-shell.md | Main Components | `ChatRuntimeProvider`, `ShellActionsProvider` | impl-target | T1.2, T4.3 | covered | |
| design-web-shell.md | Main Components | `ThreadListAdapter` | impl-target | T1.1 | covered | |
| design-web-shell.md | Main Components | `ThreadHistoryAdapter`, `RetryGate` | impl-target | T1.1 | covered | |
| design-web-shell.md | Main Components | Title poller | impl-target | T1.1 | covered | |
| design-web-shell.md | Main Components | `AppSidebar` | impl-target | T3.1 | covered | |
| design-web-shell.md | Main Components | `ThreadHistoryList`, `ThreadHistoryItem`, `ThreadActivityTracker` | impl-target | T4.2 | covered | |
| design-web-shell.md | Main Components | `ThreadTitleField` | impl-target | T5.1 | covered | |
| design-web-shell.md | Main Components | `DeleteThreadDialog` | impl-target | T5.2 | covered | |
| design-web-shell.md | Main Components | `UserMenu` | impl-target | T3.2 | covered | |
| design-web-shell.md | Main Components | `ChatHeader` | impl-target | T3.3 | covered | |
| design-web-shell.md | Main Components | `MainView`, `ThreadNotice` | impl-target | T3.4, T7.3 | covered | |
| design-web-shell.md | Main Components | `WorkspacePanel` | impl-target | T5.3 | covered | |
| design-web-shell.md | Main Components | `DocumentTitle` | impl-target | T4.3 | covered | |
| design-web-shell.md | File Layout | `lib/threads/resolve-main-view.ts` | impl-target | T3.4 | covered | |
| design-web-shell.md | File Layout | `lib/threads/group-threads-by-date.ts` | impl-target | T4.1 | covered | |
| design-web-shell.md | File Layout | `lib/threads/shell-services.ts` | impl-target | T1.2, T7.3 | covered | |
| design-web-shell.md | File Layout | `lib/config.ts` (`apiBaseUrl`, `regenerateAfterError`) | impl-target | T1.1, T7.3 | covered | |
| design-web-shell.md | File Layout | `lib/focus.ts`, `lib/welcome-suggestions.ts` | impl-target | T4.3 | covered | |
| design-web-shell.md | File Layout | `lib/keyboard-shortcuts.ts` | impl-target | T6.2 | covered | |
| design-web-shell.md | File Layout | `lib/dev-user.ts` | impl-target | T3.2 | covered | |
| design-web-shell.md | File Layout | `lib/markdown-policy.ts` | impl-target | T7.1 | covered | |
| design-web-shell.md | File Layout | `lib/i18n/plural-ru.ts` | impl-target | T7.5 | covered | |
| design-web-shell.md | File Layout | `vitest.config.ts`, `src/test/{setup,msw-server,fixtures,render-with-runtime}` | prerequisite | T2.1 | covered | |
| design-web-shell.md | Integration Point Map | IP1: первая отправка → `POST /api/threads` → чат | connection-switching | T1.2, T1.3, T4.3 | covered | |
| design-web-shell.md | Integration Point Map | IP2: `/api/threads*` через клиент и zod | connection-switching | T1.1, T2.2 | covered | |
| design-web-shell.md | Integration Point Map | IP3: слоты `Thread`, action bar | connection-switching | T4.3, T7.2, T7.3 | covered | |
| design-web-shell.md | Integration Point Map | IP4: `RootLayout` | connection-switching | T2.4 | covered | |
| design-web-shell.md | Integration Point Map | IP5: токены и `ui/button.tsx` | connection-switching | T2.4, T8.3 | covered | L1-8 — контраст |
| design-web-shell.md | Integration Point Map | IP6: Next router, controlled `threadId` | connection-switching | T1.2, T2.3, T1.3 | covered | |
| design-web-shell.md | Integration Point Map | IP7: `MarkdownText` `a`/`img` | connection-switching | T7.1 | covered | |
| design-web-shell.md | Integration Point Map | IP8: `ToolFallbackImpl`/`ToolFallbackError` | connection-switching | T7.4 | covered | |
| design-web-shell.md | Minimal Surface Alternatives | Element 1: `ShellStatus` (vanilla zustand) | contract-change | T1.1, T8.1 | covered | Инвариант — код-ревью в T8.1 |
| design-web-shell.md | Minimal Surface Alternatives | Element 2: слот `ThreadComponents.DeletedNotice` | contract-change | T7.3 | covered | |
| design-web-shell.md | Minimal Surface Alternatives | Element 3: `--destructive-foreground` и сплошной `destructive` | contract-change | T2.4 | covered | |
| design-web-shell.md | Minimal Surface Alternatives | Element 4: `setOpen(value, { persist })` | contract-change | T3.1 | covered | |
| design-web-shell.md | Minimal Surface Alternatives | Element 5: `ThreadsApiError` с `kind` | contract-change | T1.1 | covered | |
| design-web-shell.md | Minimal Surface Alternatives | Element 6: контейнер / вид | contract-change | T3.3, T4.2 | covered | |
| design-web-shell.md | Маршрутизация и синхронизация URL | `threadPath`/`parseRouteThreadId`, `syncUrlWithThread`, «Новый чат» | connection-switching | T1.1, T1.2, T2.3, T4.3 | covered | |
| design-web-shell.md | Тема, шрифт, токены | next-themes `scriptProps`, theme-color, шрифт кириллица (UXQ-3), токены | impl-target | T2.4 | covered | |
| design-web-shell.md | Тема, шрифт, токены | Шторка на base-ui `Drawer` (S-11) | impl-target | T1.4 | covered | |
| design-web-shell.md | Тема, шрифт, токены | Закрытие шторки при ≥ 768 px; `h-dvh`, safe-area | impl-target | T3.1, T4.3 | covered | Отступ композера — T4.3 |
| design-web-shell.md | Тема, шрифт, токены | Текст строки SB-06 на `--sidebar-accent` | impl-target | T4.2 | covered | |
| design-web-shell.md | Доступность — реализация | Политика фокуса (`lib/focus.ts`, таблица событий) | impl-target | T4.3, T5.1, T5.2, T5.3, T7.3 | covered | |
| design-web-shell.md | Доступность — реализация | Клавиатура: `isShortcutBlocked`, `Ctrl/⌘+Shift+O`, `Ctrl/⌘+B`, ↑/↓/Home/End | impl-target | T4.2, T6.2 | covered | |
| design-web-shell.md | Доступность — реализация | ARIA по таблице UXRD 7.2, skip link, reduced motion | impl-target | T3.1, T3.3, T4.2, T7.5 | covered | |
| design-web-shell.md | Локализация | Строки каркаса + `i18n.test.ts` | impl-target | T1.4, T2.4, T7.1, T7.4, T7.5 | covered | |
| design-web-shell.md | Правки скопированных shadcn-компонентов | `ui/sidebar.tsx`, `ui/sonner.tsx` | impl-target | T1.4, T2.4, T3.1, T6.2 | covered | |
| design-web-shell.md | Error Handling | Таблица ситуаций (список, история, 404, чат, создание, операции, граница ошибок, конфигурация) | impl-target | T1.1, T3.1, T3.4, T4.2, T5.1, T5.2, T6.1, T7.3 | covered | |
| design-web-shell.md | Logging and Monitoring | `console.error`/`warn` с `{ remoteId, kind, status }`, без текста | impl-target | T1.1 | covered | |
| design-web-shell.md | Security Considerations | Валидация ответов zod, `encodeURIComponent`, публичность `NEXT_PUBLIC_*` | impl-target | T1.1, T2.1 | covered | |
| design-web-shell.md | Недоверенный markdown | Политика ссылок и изображений | impl-target | T7.1, T8.3 | covered | L1-4 |
| design-web-shell.md | Test Strategy — Unit | 14 U-файлов DD + `i18n.test` | verification | T2.1, T2.2, T2.3, T3.4, T4.1, T4.3, T6.2, T7.1, T7.5 | covered | План добавляет `shell-services.test.ts` (T7.3) |
| design-web-shell.md | Test Strategy — Component | 11 C-файлов DD | verification | T3.2, T3.3, T3.4, T4.2, T4.3, T5.1, T5.2, T6.1, T7.1, T7.2, T7.3, T7.4 | covered | План добавляет `app-sidebar.test.tsx` (S-11, T3.1) и `use-global-shortcuts.test.tsx` (AC-22.1 C, T6.2) |
| design-web-shell.md | Test Strategy — Integration | 7 файлов I | verification | T3.4, T4.2, T4.3, T5.2, T5.3, T7.3 | covered | 14 → 10 тестов (бюджет) |
| design-web-shell.md | Verification Strategy | Early Verification Point S-1…S-5 | verification | T1.3 | covered | |
| design-web-shell.md | Verification Strategy | S-6…S-11 | verification | T1.4, T2.2, T3.1, T4.3, T5.2, T5.3, T8.3 | covered | |
| design-web-shell.md | L1-сценарии | L1-1…L1-10 | verification | T8.3 | covered | Выполняет оркестратор |
| design-web-shell.md | Performance Tests | Метрики № 2, 10, LCP, CLS, Lighthouse a11y ≥ 95 | verification | T8.3 | covered | |
| design-web-shell.md | Cross-Layer Assumptions | 1–8 | verification | T1.3, T2.2, T7.4, T8.3 | covered | |
| design-web-shell.md | Open Questions | п. 2: перечитывание первой страницы при возврате во вкладку только при одной загруженной странице | impl-target | T4.2 | covered | |
| design-web-shell.md | Open Questions | п. 1, 3–6: заметки UX-владельцу | verification | T8.3 | covered | Расхождения пишутся в Notes |
| design-web-shell.md | Migration Strategy | Слияние в `main` вместе с `threads-api` | prerequisite | T8.1 | covered | Проверка ветки и атрибуции |
| l1-browser-scenarios.md | Deferred from `threads-api` T6.3 | T6.3-a (метрика № 10), T6.3-b (метрика № 7) | verification | T8.4 | covered | Ключ `ANTHROPIC_API_KEY` из `apps/api/.env` разрешён пользователем |

Итого: 84 строки — 83 `covered`, 1 `gap` (точная фиксация `ai`, закрыта решением пользователя). Отложенный компонент UXRD (SB-14) — в таблице «UXRD Component → Task Mapping».

## Reference Contract Values

| Design Doc (§ Section) | Contract Type | Required Observable Value (verbatim) | Covered By Task(s) |
|---|---|---|---|
| design-web-shell.md (§ Contract Definitions, `group-threads-by-date.ts`) | structure-order | `today: 'Сегодня', yesterday: 'Вчера', previous7: 'Предыдущие 7 дней', previous30: 'Предыдущие 30 дней', older: 'Старше'`; «дни = round((startOfDay(now) − startOfDay(activityAt)) / 86 400 000): ≤0 today, 1 yesterday, 2..7 previous7, 8..30 previous30, >30 older; сортировка по activityAt DESC (стабильно, при равенстве — исходный порядок), пустые группы не возвращаются.» | T4.1, T4.2 |
| design-web-shell.md (§ Field Propagation Map, `updatedAt → время активности`) | derived-display | «max(lastMessageAt, activityAt); нет обоих → now; календарный день в TZ браузера» | T4.1 |
| design-web-shell.md (§ Contract Definitions, `resolve-main-view.ts`) | derived-display | «1) switchError?.threadId === routeThreadId → not_found ? not-found : load-error/switch 2) routeThreadId !== undefined && mainRemoteId !== routeThreadId → switching (скелетон, не приветствие — AC-02.2) 3) historyStatus === 'not_found' → not-found; 'load_failed' → load-error/history 4) routeThreadId !== undefined && (historyStatus === undefined \|\| historyStatus === 'loading') → switching 5) иначе thread { deleted: historyStatus === 'deleted' }» | T3.4 |
| design-web-shell.md (§ Маршрутизация и синхронизация URL) | derived-display | «`threadPath(id) = `/chat/${encodeURIComponent(id)}`` (`lib/threads/route-thread-id.ts`) используется везде, где путь строится или сравнивается»; «`parseRouteThreadId(threadPath(id)) === id` для любого id из `ThreadIdSchema`»; «некорректная %-последовательность → сырой сегмент» | T1.1, T2.3 |
| design-web-shell.md (§ Маршрутизация и синхронизация URL) | state-lifecycle-negative | «`remoteId` задан и `location.pathname !== threadPath(remoteId)` → `window.history.replaceState(null, '', threadPath(remoteId))`»; «`remoteId === undefined` и путь начинается с `/chat/` → `router.replace('/')`» | T1.1, T2.3, T5.2 |
| design-web-shell.md (§ Fact Disposition, `contract:RemoteThreadMetadata-vs-ThreadSummary`) | derived-display | «`toRemoteMetadata`: `{ status: 'regular', remoteId: id, title: title ?? undefined, lastMessageAt: new Date(updatedAt) }`; `list({after})` → `?cursor=after`, `nextCursor: null` → `undefined`; `archive` отклоняется (UI архивирования нет), `generateTitle` — опросчик FR-20; `DELETE` 404 = успех (AC-16.3)» | T1.1, T2.2 |
| design-web-shell.md (§ Data Contract, TitlePoll stream) | state-lifecycle-negative | «нет ответа ассистента в messages → поток закрыт сразу, запросов нет; не более 1 запроса в 1 000 мс, не дольше 15 000 мс; ShellStatus.titleWaiting[remoteId] = true только во время опроса»; `TITLE_POLL_INTERVAL_MS = 1_000`, `TITLE_POLL_WINDOW_MS = 15_000` | T1.1, T2.3 |
| design-web-shell.md (§ Minimal Surface, Element 1) | state-lifecycle-negative | «Инвариант: стор не дублирует данные рантайма (список, заголовки, сообщения, `isRunning`, текущая беседа).» | T1.1, T8.1 |
| design-web-shell.md (§ State Transitions and Invariants) | state-lifecycle-negative | «Беседа создаётся на сервере только при первой отправке (initialize); «Новый чат» сетевых запросов не делает»; «В тело чата не уходит клиентский id: body.id = remoteId из POST /api/threads»; «Элемент списка не перемещается при переименовании и приходе автозаголовка до перезагрузки списка» | T1.1, T4.2, T4.3 |
| design-web-shell.md (§ Contract Definitions, `lib/config.ts`) | state-lifecycle-negative | `z.url({ protocol: /^https?$/ }).safeParse(process.env.NEXT_PUBLIC_API_URL)`; при провале — `throw new Error('NEXT_PUBLIC_API_URL must be an absolute http(s) URL')`; `apiBaseUrl = parsed.data.replace(/\/+$/, '')` | T1.1, T2.1 |
| design-web-shell.md (§ Action bar и ошибки в ленте) | derived-display | `regenerateAfterError` `true` (поставка): «Не удалось получить ответ. Попробуйте перегенерировать.» · кнопка «Есть у последнего ответа» · `aria-describedby` «У кнопки → `id` текста»; `false`: «Не удалось получить ответ.» · «Нет» · «Нет — нет кнопки» | T7.3 |
| design-web-shell.md (§ Action bar и ошибки в ленте, видимость) | derived-display | «Последнее сообщение (`s.message.isLast`) — Видна всегда; Не последнее, точный указатель — Проявляется при `:hover` реплики и при `:focus-within`; Грубый указатель (`pointer: coarse`) — Видна всегда у каждого сообщения; Идёт прогон: ответ, который сейчас генерируется (`s.message.status?.type === 'running'`) — Не рендерится у этого ответа»; «`display: none` и `visibility: hidden` запрещены» | T7.2 |
| design-web-shell.md (§ Action bar и ошибки в ленте, «Копировать») | structure-order | «Порядок Tab внутри реплики не меняется: содержимое → «Перегенерировать» (если есть) → «Копировать» (UXRD 7.3).» | T7.2, T7.3 |
| design-web-shell.md (§ AC-14.5, `ToolFallbackError`) | derived-display | «Для статуса `incomplete` с причиной, отличной от `cancelled`, — «Ошибка:» и «Не удалось выполнить инструмент.» независимо от `status.error`»; «отмена (`cancelled`) — прежний вывод причины под «Причина отмены:»» | T7.4 |
| design-web-shell.md (§ AC-08.5e, E-8) | derived-display | «уведомление «Беседа удалена» / «Её удалили в другой вкладке или окне.» с кнопкой «Новый чат» и без «Перегенерировать» и скрыть композер» | T7.3 |
| design-web-shell.md (§ State × Display Matrix) | derived-display | SB-09: «`role="status"` «Загружаем беседы…»», «Пока нет бесед» / «Начните новый чат — он появится здесь.», «Не удалось загрузить беседы» + «Повторить» → `threads.reload()`; SB-10: «`role="status"` «Загружаем ещё беседы…»», «Не удалось загрузить ещё беседы» + «Повторить» → `loadMore()` | T4.2, T6.1 |
| design-web-shell.md (§ UI Action-API Contract Mapping) | derived-display | «любая ошибка → откат + «Не удалось переименовать беседу. Попробуйте ещё раз.»»; «204 / 404 → «Беседа удалена»»; «прочее → возврат элемента + «Не удалось удалить беседу. Попробуйте ещё раз.»» | T5.1, T5.2 |
| design-web-shell.md (§ Маршрутизация, `DocumentTitle`) | derived-display | ««{Название} — Agent OS» / «Новый чат — Agent OS» / «Новая беседа — Agent OS» / «Беседа не найдена — Agent OS»; `metadata.title` корня — «Agent OS»» | T4.3 |
| design-web-shell.md (§ Доступность — реализация, `lib/focus.ts`) | derived-display | «`focusAfterNewChat = (): void => focusShellTarget(isFinePointer() ? 'composer' : 'page-title')`»; «'composer' → [data-shell-focus="composer"] (ComposerPrimitive.Input), 'page-title' → [data-shell-focus="page-title"] (h1, tabIndex -1)» | T4.3 |
| design-web-shell.md (§ Тема, шрифт, токены) | derived-display | «светлые `--ring`, `--sidebar-ring` → `oklch(0.556 0 0)`; `* { @apply border-border outline-ring; }`; `--destructive-foreground` (светлая `oklch(0.985 0 0)`, тёмная `oklch(0.145 0 0)` = `--background`) + `--color-destructive-foreground`; размеры `--thread-max-width: 48rem`, `--header-height: 3.5rem`; движение `--ease-panel: cubic-bezier(0.32, 0.72, 0, 1)`, `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`, `--duration-fast: 150ms`, `--duration-panel: 200ms`» | T2.4 |
| design-web-shell.md (§ Недоверенный markdown) | derived-display | «опасная схема … → `span` с текстом ссылки **без `href`**»; «абсолютные `http(s)` → `target="_blank"` + `rel="noopener noreferrer"` … + sr-only «(откроется в новой вкладке)»»; «ссылки на тот же origin … → тоже новая вкладка»; «`#фрагмент` … → переход внутри документа без `target`»; «`mailto:` → без `target`»; «`img` рендерится только для абсолютного `https:`-источника, с `referrerPolicy="no-referrer"`, `loading="lazy"`, `decoding="async"`» | T7.1 |
| design-web-shell.md (§ Test Strategy, `vitest.config.ts`) | state-lifecycle-negative | «в начале модуля `process.env.TZ = 'Europe/Berlin'`»; «`test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], include: ['src/**/*.test.{ts,tsx}'], env: { NEXT_PUBLIC_API_URL: 'http://api.test' } }`»; MSW «`onUnhandledRequest: 'error'`» | T2.1 |
| design-web-shell.md (§ Тема, шрифт, токены, сайдбар) | state-lifecycle-negative | «cookie `sidebar_state` (пишет shadcn при пользовательском переключении) читается сервером в layout группы → `SidebarProvider defaultOpen`»; «временное сворачивание (рабочая область) — `setOpen(false, { persist: false })`» | T3.1, T5.3 |

## Failure Mode Checklist

| Category | Applies? | Covered By Task(s) |
|---|---|---|
| same-value | yes — `syncUrlWithThread` ничего не делает при `location.pathname === threadPath(id)`; «Новый чат» на `/` — только фокус; переименование тем же названием | T2.3 (url-sync), T4.3, T5.1 |
| no-op | yes — «Новый чат» без отправки не создаёт беседу (AC-03.2); `release`/`drop` без ожидающего в `RetryGate`; `append` адаптера истории | T2.2, T4.3 |
| empty input | yes — пустой список (AC-01.4); пустой `messages` → `[]` без `safeValidateUIMessages`; пустое название + Enter (AC-05.3); ответ без частей не рендерит строку | T2.2, T4.2, T5.1, T7.2 |
| invalid option | yes — невалидный ответ списка/истории (AC-01.7, AC-02.5); 400 на `:threadId` → `not_found`; некорректная %-последовательность; формат не `ai-sdk/v6`; опасные схемы ссылок | T2.2, T2.3, T7.1 |
| missing config | yes — `NEXT_PUBLIC_API_URL` не задан или не абсолютный URL → исключение при импорте; выключатель `regenerateAfterError = false` | T2.1 (`config.test.ts`), T7.3 |
| unavailable boundary | yes — сеть/5xx списка и истории; 404 `THREAD_NOT_FOUND` от чата; ошибки опроса заголовка; заблокированный `GET /api/threads` (L1-3) | T2.2, T2.3, T3.4, T4.2, T7.3, T8.3 |
| shared-state dependency | yes — `ShellStatus` между адаптерами и видами; смонтированные фоновые тела; один ожидающий на `remoteId`; `forget` при удалении | T1.3, T2.2, T5.2 |
| rollback-only visibility | yes — откат переименования и удаления видим только как возврат значения и уведомление (S-6) | T2.2, T5.1, T5.2, T8.3 |
| missing-sort-key ordering | yes — нет ни `lastMessageAt`, ни `activityAt` → `now`; равные `activityAt` → исходный порядок | T4.1 |

## UXRD Component → Task Mapping

| UXRD Component (section heading) | States to Cover | Covered By Task(s) | Gap Status | Notes |
|---|---|---|---|---|
| 6.1 Состояния представления основной области | default / loading / error | T3.4, T7.3 | covered | `resolveMainView` |
| 6.2 SH-01 AppShell | default | T1.2, T3.1 | covered | |
| 6.3 SB-03 «Новый чат» (и HD-05, иконка в SB-12) | default | T3.1, T4.3 | covered | |
| 6.4 SB-04 ThreadList, SB-05 заголовок группы, SB-09 состояния списка | default / loading / empty / error | T4.2 | covered | |
| 6.5 SB-06 ThreadItem | default / partial | T4.2 | covered | Title pending |
| 6.6 SB-07 Меню «⋯» элемента | default | T5.1, T5.2 | covered | |
| 6.7 SB-08 Поле переименования (на месте) | default / error | T5.1 | covered | |
| 6.8 SB-10 «Показать ещё» (Should, FR-19) | default / loading / error | T6.1 | covered | |
| 6.9 SB-11 Блок пользователя и меню (TM-01 — тема) | default | T3.2 | covered | |
| 6.10 SB-12 Иконочная полоса и переключение сайдбара (HD-02) | default | T3.1, T3.3 | covered | |
| 6.11 SB-13 Мобильная шторка | default | T1.4, T3.1 | covered | |
| 6.12 SB-14 Индикатор стриминга (Could, FR-24 — опционально) | — | — | gap | PRD Could FR-24 — отложен |
| 6.13 HD-01 Шапка, HD-02/HD-04/HD-05 | default / loading / partial | T3.3, T5.3 | covered | |
| 6.14 TH-01 Лента и колонка | default | T3.4 | covered | |
| 6.15 TH-02 Приветствие и TH-03 подсказки | empty | T3.4, T4.3 | covered | Заголовок «Чем могу помочь?» — T3.4 |
| 6.16 TH-04 Композер | default | T3.4, T4.3 | covered | Подпись «Сообщение» и placeholder — T3.4 |
| 6.17 TH-05 Скелетон истории | loading | T3.4 | covered | |
| 6.18 TH-06 «Беседа не найдена» | error | T3.4 | covered | |
| 6.19 TH-07 Ошибка загрузки беседы | error | T3.4, T7.3 | covered | «Deleted while open» — T7.3 |
| 6.20 TH-08 Ошибка ответа | error | T7.3 | covered | |
| 6.21 TH-09 «Вниз» | default | T7.5 | covered | Каркас; строка |
| 6.22 WS-01 Рабочая область, WS-02 ручка, WS-03 «×» | default / empty | T5.3 | covered | |
| 6.23 DLG-01 Диалог удаления | default / partial | T5.2 | covered | Вариант A-4 |
| 6.24 TST-01 Уведомления | error | T2.4, T5.1, T5.2 | covered | |
| 6.25 UX-07 Плейсхолдер и обновление заголовка | partial | T3.3, T4.2, T4.3 | covered | |
| 6.26 TH-10 Action bar сообщения | default | T7.2 | covered | |
| 7.2 ARIA Requirements | — | T3.1, T3.3, T4.2, T7.5 | covered | |
| 7.3 Keyboard Navigation | — | T4.2, T6.2 | covered | |
| 7.4 Focus Management | — | T4.3, T5.1, T5.2, T5.3, T7.3 | covered | |
| 7.6 Color and Contrast | — | T2.4, T4.2, T8.3 | covered | |
| 7.7 Reduced Motion | — | T7.5 | covered | |
| 8.2 Mobile-Specific Behavior | — | T1.4, T3.1, T4.3 | covered | |
| 9.3 Без вспышки (AC-09.2) | — | T2.4, T8.3 | covered | |
| 10.2 Локализация строк каркаса | — | T7.5 | covered | |

## ADR Bindings

ADR нет: каталога `docs/adr/` не существует, Prerequisite ADRs DD пусты, ADR-тест DD — «ADR не пишется». Структурных ограничений из ADR план не несёт.

## Connection Map

Часть `web-shell` строится против **реализованного** `threads-api` (план `completed`), а не только против его дизайна.

| Boundary | Owner (left side) | Owner (right side) | Serialized Format | Consumer Parse Rule | Expected Signal | Covered By Task(s) |
|---|---|---|---|---|---|---|
| web → `/api/threads*` (JSON) | `apps/web/src/lib/threads/threads-api-client.ts` | `apps/api/src/threads/threads.controller.ts`, `packages/contracts/src/threads.ts` | `ThreadSummary`, `ThreadListResponse`, `ThreadMessagesResponse`, `ApiError` | `schema.safeParse` → провал `ThreadsApiError('invalid_response')`; 404 (и 400 на `:threadId`) → `not_found`; `fetch` reject → `network` | U (MSW) зелёные; L1-1/L1-5 — 200 | T1.1, T2.2 |
| web → `GET /api/threads?cursor=` | `apps/web/src/lib/threads/thread-list-adapter.ts` | `apps/api/src/threads/thread-cursor.ts` | непрозрачная строка `nextCursor`, `encodeURIComponent` | сервер: 400 `INVALID_CURSOR` при порче; клиент — SB-10 Error | Вторая страница без дублей (L1, FR-19) | T1.1, T6.1 |
| История → лента | `apps/api/src/threads/thread.mapper.ts` | `apps/web/src/lib/threads/threads-api-client.ts`, `thread-history-adapter.ts` | `HistoryMessage[]` (форма `UIMessage` AI SDK; части ошибки модели удалены, `errorText` инструментов замаскирован) | `ThreadMessagesResponseSchema`, затем `safeValidateUIMessages`; пустой `messages` → `[]`; `parentId = messages[i-1]?.id ?? null` | L1-4: порядок и число частей как в живом стриме | T1.1, T2.2, T8.3 |
| Транспорт → `POST /api/chat/:agentId` | `apps/web/src/lib/threads/shell-services.ts` (`AssistantChatTransport`) | `apps/api/src/chat/chat.controller.ts`, `apps/api/src/chat/chat.dto.ts` | тело `AssistantChatTransport` (`id` = `remoteId`, `messages`, `trigger`, …), SSE v7 | сервер: `ChatRequestSchema` `{ id?, threadId?, messages }`, лишние поля отбрасываются | Network: `id` = id из `POST /api/threads` (L1-1) | T1.2, T1.3, T4.3 |
| 404 чата до SSE → «Беседа удалена» | `apps/api/src/chat/chat.controller.ts` (`THREAD_NOT_FOUND`) | `apps/web/src/lib/threads/shell-services.ts` (`handleChatError`) | `APICallError` `statusCode: 404`, `responseBody` JSON `ApiError` | `APICallError.isInstance(e) && e.statusCode === 404`, `responseBody` → `ApiErrorSchema`, `errorCode === 'THREAD_NOT_FOUND'` → статус `deleted` | `shell.deleted-thread.int.test.tsx`; L1-7 | T7.3 |
| URL ↔ беседа | `apps/web/src/lib/threads/route-thread-id.ts`, `url-sync.ts` | `apps/web/src/components/shell/chat-runtime-provider.tsx`, `thread-history-item.tsx` | `/chat/<encodeURIComponent(id)>` | `parseRouteThreadId(usePathname())`; некорректная %-последовательность → сырой сегмент | Round-trip U; L1-5 | T1.1, T1.2, T2.3, T4.2 |
| Cookie сайдбара | `apps/web/src/components/ui/sidebar.tsx` (запись при пользовательском переключении) | `apps/web/src/app/(chat)/layout.tsx` (`cookies()`) | `sidebar_state=true\|false`, 7 дней | `value !== 'false'` → `defaultSidebarOpen` | L1-1: F5 → полоса на первом кадре | T3.1, T5.3 |
| Тема | next-themes (`apps/web/src/components/theme-provider.tsx`) | `apps/web/src/components/shell/user-menu.tsx` | `localStorage['theme']` = `light`/`dark`/`system` | next-themes inline-скрипт до отрисовки | L1-8: нет кадра светлой темы | T2.4, T3.2 |
| Переменная окружения API | `apps/web/.env.local`, `apps/web/vitest.config.ts` (`test.env`) | `apps/web/src/lib/config.ts` | `NEXT_PUBLIC_API_URL` (абсолютный http(s) URL) | литеральный `process.env.NEXT_PUBLIC_API_URL`, `z.url`, срез `/` в конце | `next build` падает без переменной; `config.test.ts` | T1.1, T2.1 |
| Dev-only seed → история | скрипт в scratchpad (T8.2), образец `apps/api/test/support/seed.ts` | `apps/api/src/threads/thread.mapper.ts` → `GET /api/threads/:id/messages` | сообщения format 2 через `Memory.saveThread`/`saveMessages`, resource `dev-user` | серверный маппер + `maskHistoryErrors` | `SEED-RICH`, `SEED-TOOL-ERROR` открываются в ленте (L1-4, L1-10) | T8.2 |

## Цель

Дать пользователю оболочку чата в стиле ChatGPT поверх реализованного `threads-api`: беседы сохраняются и адресуются URL, открываются после F5, группируются по датам, переименовываются и удаляются; генерация не прерывается при переключении; ошибки ответа и инструмента показываются фиксированным русским текстом; всё проверено тестами FR-12 и L1-сценариями в реальном браузере.

## Предыстория

`apps/web` — одна страница (`app/page.tsx`) со сплитом 40/60 и `components/assistant.tsx` (`useChatRuntime` без адаптеров): список в памяти, клиентские id (сервер после шага 8 `threads-api` отвечает на них 404), беседа теряется при F5, нет сайдбара, темы, URL на беседу и тестов. `threads-api` реализован и закоммичен: эндпоинты `/api/threads*`, чат принимает только существующие беседы, история маскирует ошибки (AC-14.5), перегенерация после ошибки оставляет один ответ (AC-14.6).

## Риски и меры

### Технические риски

- **Риск**: `backgroundThreads` не сохраняет стрим AI SDK при смене беседы (S-1).
  - **Влияние**: AC-02.6, AC-03.4 — высокое; дизайн меняется на вариант B.
  - **Мера**: T1.3 до основной работы; гейт G1 — стоп и эскалация, без тихой замены варианта.
- **Риск**: `replaceState` под `cacheComponents` перемонтирует layout или рассинхронизирует `usePathname` (S-2).
  - **Влияние**: AC-04.1, AC-04.4.
  - **Мера**: T1.3, счётчик монтирований; запасной путь `router.replace`.
- **Риск**: `shadcn add` перезаписывает существующие `ui/button.tsx`, `ui/skeleton.tsx`, `ui/tooltip.tsx` (зависимости реестра `sidebar`).
  - **Влияние**: потеря правок каркаса.
  - **Мера**: T1.4 — CLI без `--overwrite` (с `--yes`, если флаг есть в `shadcn add --help`), все семь компонентов одним вызовом до любых правок `ui/*`; после — `git diff --stat` по трём файлам пуст, иначе восстановить из git и записать в Notes.
- **Риск**: jsdom/base-ui несовместимы в тестах (порталы, pointer events, `matchMedia`).
  - **Влияние**: сроки Phase 2–5.
  - **Мера**: полифилы в `src/test/setup.ts` (T2.1); презентационные компоненты тестируются по props.
- **Риск**: тесты модулей спайка пишутся после кода и проходят по построению.
  - **Влияние**: ложное чувство покрытия.
  - **Мера**: правило выполнения 7 — мутационная проверка каждого правила в T2.2/T2.3.
- **Риск**: обновление `@assistant-ui/*` ломает `unstable_` API.
  - **Влияние**: регрессия рантайма.
  - **Мера**: точные версии (T1.1); I-тесты как сигнал; обновление — отдельная задача с полным L1.
- **Риск**: реальная модель недоступна (ключ провайдера), S-1 и L1-6/L1-10/T6.3 нечем проверить.
  - **Влияние**: блок гейта G1 и финальной приёмки.
  - **Мера**: ключ `ANTHROPIC_API_KEY` из `apps/api/.env` разрешён пользователем для T1.3, T8.3, T8.4 (Открытые вопросы, п. 1); первый шаг T1.3 проверяет, что модель отвечает; ключ недействителен — стоп и вопрос пользователю.
- **Риск**: утечка через `https`-изображение в ответе модели (остаточный риск DD).
  - **Влияние**: среднее, вероятность низкая.
  - **Мера**: T7.1 (`https`-only, `no-referrer`); полное закрытие вне объёма.

### Риски расписания и процесса

- **Риск**: `[DevTools — user]` шаги L1 (CPU ×4, тач, `pointer: coarse`, блокировка запросов, `canceled`, `Referer`) требуют пользователя.
  - **Влияние**: T8.3 растягивается.
  - **Мера**: оркестратор группирует такие шаги и просит пользователя за один заход; невыполненная проверка записывается как «not executed» с причиной, никогда как «pass».
- **Риск**: на стенде нет инструментов у ассистента и способа воспроизвести упавший инструмент.
  - **Влияние**: L1-4, L1-10 C невыполнимы.
  - **Мера**: T8.2 — dev-only seed `SEED-RICH`, `SEED-TOOL-ERROR`.
- **Риск**: `next dev` пересоздаёт блок в `apps/web/AGENTS.md`.
  - **Влияние**: шум в диффе.
  - **Мера**: блок не удалять; если он в диффе — коммитить вместе с работой (как сказано в самом блоке).

## Implementation Phases

Стратегия: **Hybrid** из DD — risk-driven спайк рантайма первым (S-1…S-5 на реальном API, плюс S-11), затем короткий горизонтальный фундамент (инструменты тестов, тема, токены), затем вертикальные срезы по пользовательским сценариям, в конце — Should, лента (action bar, ошибки, markdown, локализация) и L1-приёмка. Unit-скелетов не передано, поэтому Phase 0 (Red unit-тестов) не выделяется: с Phase 3 unit- и компонентные тесты пишутся test-first внутри задач; модули спайка получают характеризационные тесты с мутационной проверкой (T2.2, T2.3). Интеграционные скелеты наполняются в фазе, где реализуется проверяемое поведение.

Индикатор прогресса интеграционных тестов (после слияний T2.1): **10** `it.todo` — Phase 3: 1/10, Phase 4: 6/10, Phase 5: 8/10, Phase 7: 10/10.

---

### Phase 1: Ранняя точка проверки — спайк рантайма S-1…S-5 и шторки S-11 (шаг 1 DD + S-11 из шага 4) (оценка коммитов: 3)

**Цель**: до любых вложений в UI доказать в реальном браузере против реального API, что выбранная композиция рантайма (KD-1) держит фоновый стрим, синхронизирует URL, восстанавливает историю и ошибки, и что шторка на `Drawer` работает. Код спайка становится production-кодом этих модулей.

#### Tasks

- [x] **T1.1 Клиент `threads-api`, адаптеры списка и истории, статус-стор, URL-функции, опросчик заголовка** (KD-1; Elements 1, 5; AC-01.7, AC-02.5, AC-04.1, AC-04.3, AC-20.1 — реализация)
  - Target Files: `apps/web/package.json`, `pnpm-lock.yaml`, `apps/web/src/lib/config.ts` (new, только `apiBaseUrl`), `apps/web/src/lib/threads/threads-api-error.ts` (new), `apps/web/src/lib/threads/threads-api-client.ts` (new), `apps/web/src/lib/threads/retry-gate.ts` (new), `apps/web/src/lib/threads/shell-status-store.ts` (new), `apps/web/src/lib/threads/thread-list-adapter.ts` (new), `apps/web/src/lib/threads/thread-history-adapter.ts` (new), `apps/web/src/lib/threads/title-poller.ts` (new), `apps/web/src/lib/threads/route-thread-id.ts` (new), `apps/web/src/lib/threads/url-sync.ts` (new)
  - Investigation Targets: DD «Contract Definitions» (код клиентов, адаптеров, `RetryGate`, `route-thread-id`, `config`), «Data Contract», «Field Propagation Map»; `packages/contracts/src/threads.ts`; `apps/web/node_modules/@assistant-ui/core` — `runtimes/remote-thread-list/types.d.ts:37-140`, `adapters/thread-history.d.ts`; `@assistant-ui/ai-sdk` `runtime/useExternalHistory.js`; `assistant-stream` `createAssistantStream`; `ai` `safeValidateUIMessages`.
  - Содержание:
    - `package.json`: `zod` `^4.6.7`, `assistant-stream` `0.3.55`, `sonner` `^2.0.8` (нужен `notify` в T1.2) — прямые зависимости; `@assistant-ui/react` `0.15.32`, `@assistant-ui/ai-sdk` `0.0.16`, `@assistant-ui/react-markdown` `0.14.24` — точные; `ai` не трогать. `pnpm install`.
    - Модули — по фрагментам DD дословно по поведению: `ThreadsApiError { kind: 'not_found' | 'invalid_response' | 'http' | 'network'; status? }`; клиент с `credentials: 'include'`, `encodeURIComponent`, `treatBadRequestAsNotFound` для `getThread`/`getThreadMessages`, пустой `messages` → `[]`; `createThreadListAdapter` (все обязательные методы, `archive` отклоняет, `DELETE` 404 = успех + `notify.deleted()`, `initialize` ставит `history[id] = 'ready'` до возврата `remoteId`, `loadMoreFailed` для `list({after})`); `createHistoryAdapterFactory` (кэш `WeakMap` по клиенту `aui`, цикл `loadFor`, `withFormat` только `ai-sdk/v6`, `append` — no-op, `retry`/`forget`); `createRetryGate`; `ShellStatus` — vanilla zustand: `history[remoteId]`, `loadMoreFailed`, `titleWaiting[remoteId]`, `activityAt[itemId]`, `setHistory`, `setLoadMoreFailed`, `bumpActivity`, `forgetThread`; `createTitlePollStream` (константы `TITLE_POLL_INTERVAL_MS`, `TITLE_POLL_WINDOW_MS`); `threadPath`, `parseRouteThreadId`; `syncUrlWithThread({ remoteId, location, history, router })`.
    - Логи — `console.error`/`console.warn` с `{ remoteId, kind, status }`, без текста сообщений и заголовков.
  - Тесты: нет (Vitest появляется в T2.1; характеризационные тесты — T2.2, T2.3).
  - Зависимости: нет (prerequisite: `threads-api` реализован — да, план `completed`).
  - Completion: [x] `pnpm --filter web exec tsc --noEmit` и `pnpm --filter web lint` — 0 ошибок; [x] `pnpm why -r ai` — `apps/web` 7.0.155, `apps/api` 7.0.148; [x] версии `@assistant-ui/*` и `assistant-stream` в `package.json` без `^`.

- [x] **T1.2 `ChatRuntimeProvider`, `ShellServices`, маршруты группы `(chat)`, минимальная оболочка спайка** (KD-1; IP1, IP6; AC-03.2, AC-04.1 — реализация)
  - Target Files: `apps/web/src/lib/threads/shell-services.ts` (new), `apps/web/src/components/shell/chat-runtime-provider.tsx` (new), `apps/web/src/components/shell/shell-actions.tsx` (new), `apps/web/src/components/shell/chat-shell.tsx` (new, версия спайка), `apps/web/src/components/shell/shell-fallback.tsx` (new), `apps/web/src/app/(chat)/layout.tsx` (new), `apps/web/src/app/(chat)/page.tsx` (new → `null`), `apps/web/src/app/(chat)/chat/[threadId]/page.tsx` (new → `null`), `apps/web/src/app/page.tsx` (delete), `apps/web/src/components/assistant.tsx` (delete)
  - Investigation Targets: `apps/web/node_modules/next/dist/docs/01-app/02-guides/{single-page-applications,preserving-ui-state}.md`, `03-api-reference/03-file-conventions/dynamic-routes.md`; DD «Композиция рантайма и владение состоянием», «Маршрутизация и синхронизация URL», фрагмент `chat-runtime-provider.tsx`; удаляемый `components/assistant.tsx` (перенести `api`, `credentials: 'include'`, `sendAutomaticallyWhen`); `@assistant-ui/ai-sdk` `transport/AssistantChatTransport.js:35-62`.
  - Содержание:
    - `createShellServices()` — `apiClient`, `status`, `listAdapter`, `history` (фабрика), `transport` (`AssistantChatTransport`, `api: \`${apiBaseUrl}/api/chat/assistant\``, `credentials: 'include'`), `notify` (тонкая обёртка над `toast` из `sonner`: `renameFailed`, `deleted`, `deleteFailed`), `auiConfig`, `handleChatError` (в спайке — только `console.error` с контекстом; классификация E-8 — T7.3).
    - `ChatRuntimeProvider` — по фрагменту DD: `useState(createShellServices)`, `runtimeHook` вызывает только `useAui()` и `useChatRuntime()`, controlled `threadId = parseRouteThreadId(usePathname())`, `onThreadIdChange` → `syncUrlWithThread`; `ShellActionsProvider` с `newChat(source)`, `retryHistory(remoteId)`, `retrySwitch(threadId)` (`useShellActions()` вне провайдера бросает ошибку). Константа `ASSISTANT_AGENT_ID = 'assistant'`.
    - `(chat)/layout.tsx` — серверный: `<Suspense fallback={<ShellFallback />}>` + внутренний async-компонент, читающий `(await cookies()).get('sidebar_state')?.value !== 'false'`; страницы возвращают `null` и не читают `params`.
    - `chat-shell.tsx` спайка: список ссылок из `useAuiState(s => s.threads.threadItems)` через `next/link` + `threadPath`, строка статуса истории из `ShellStatus` с «Повторить» (`retryHistory`), «Новый чат», `Thread`. Разметка спайка заменяется в Phase 3.
    - Рабочая область прототипа временно исчезает (возвращается в T5.3).
  - Тесты: нет (см. T1.1).
  - Зависимости: T1.1.
  - Completion: [x] гейты lint, tsc, `pnpm --filter web build` (с `.env.local`) — 0 ошибок; [x] `pnpm --filter web dev` открывает `/` и `/chat/<id>` без ошибок в консоли (кроме ожидаемых); [x] в дереве нет `app/page.tsx` и `components/assistant.tsx`, поиск `components/assistant` по `apps/web/src` пуст.

- [x] **T1.3 L1-проверка спайка S-1…S-5 против реального API — гейт G1** (Early Verification Point; AC-02.6, AC-03.4, AC-04.1, AC-04.3, AC-04.4, AC-02.5 — подтверждение механизмов)
  - Target Files: только исправления в файлах T1.1/T1.2 (если найдены дефекты); временная инструментовка (счётчики, кнопка удаления спайка в `chat-shell.tsx`) удаляется до завершения.
  - Предусловия: ключ `ANTHROPIC_API_KEY` из `apps/api/.env` разрешён пользователем к расходу (Открытые вопросы, п. 1); окружение по правилу выполнения 3; `pnpm --filter web dev` (production не требуется).
  - Проверка ключа (до шага 1): короткая отправка с `/` — ответ модели пришёл. Ответа нет и в логе `apps/api` отказ провайдера (401/403, ошибка ключа) → **стоп**, T1.3 не продолжается, оркестратор сообщает пользователю, что ключ недействителен, и ждёт решения.
  - Шаги (оркестратор через Claude-in-Chrome; `[DevTools — user]` — по запросу пользователю):
    1. Временный `console.count('ChatRuntimeProvider mount')` и счётчик вызовов `load()` адаптера истории. Первая отправка с `/`: Network — `POST /api/threads` → `POST /api/chat/assistant` с `id` из ответа; адресная строка `/chat/<id>`; счётчик монтирований = 1; запроса документа и RSC-перезапроса layout нет (критерий 1, S-2).
    2. Длинный запрос в X; во время стрима — ссылка на Y, затем «Новый чат» (`/`); вернуться в X до и после завершения. Network: запрос X не `canceled` (`[DevTools — user]`, если расширение не показывает статус); ответ X дописан; в Y и на `/` ответа X нет (критерий 2, **S-1**).
    3. F5 на `/chat/<id>` → история (счётчик `load` = 1 на тело, S-3); `/chat/does-not-exist` → `switchError` `kind: 'not_found'` (строка статуса/консоль). Затем установить обёртку `window.fetch` через `javascript_tool` (500 на `/messages`) и без перезагрузки открыть ссылкой спайка беседу, не открывавшуюся в этом документе (F5 сняла бы обёртку, у открытой ранее беседы история уже загружена) → статус `load_failed`; снять обёртку, «Повторить» → история загружена (критерий 3).
    4. Открыть A, B, C ссылками; Назад ×2, Вперёд — беседы переключаются (критерий 4, S-2).
    5. Во время стрима удалить беседу временной кнопкой удаления в списке спайка (`aui` из консоли недоступен; кнопка живёт только на время T1.3) → в логе `apps/api` отмена по `close` (критерий 5, S-5).
    6. Новая беседа: после конца ответа ≤ 15 с заголовок появляется в списке спайка; Network — нет `PATCH` (S-4).
  - Решение (гейт G1): **S-1 не подтверждён → стоп**, отчёт пользователю (вариант B KD-1 — изменение дизайна). S-2…S-5 не подтверждены → запасной путь из таблицы Early Verification Point, повтор шага, запись в Notes. Все результаты, включая применённые запасные пути, — в Notes «Ранняя точка проверки».
  - Зависимости: T1.2.
  - Completion: [x] шаги 1–6 выполнены с доказательствами (скриншоты, Network, консоль, лог API); [x] S-1 подтверждён — иначе план остановлен; [x] временная инструментовка удалена (`git diff` не содержит `console.count`, счётчика `load` и кнопки удаления спайка); [x] гейты T1.2 повторно зелёные (`eslint`, `tsc --noEmit`, `next build`).

- [x] **T1.4 shadcn add семи компонентов, шторка на base-ui `Drawer` в `ui/sidebar.tsx`, русские подписи сайдбара — S-11** (AC-10.2 — механизм; UXRD 8.2)
  - Target Files: `apps/web/src/components/ui/{sidebar,sheet,dropdown-menu,alert-dialog,input,separator,sonner}.tsx` (new, CLI), `apps/web/src/hooks/use-mobile.ts` (new, CLI), `apps/web/package.json`, `pnpm-lock.yaml`, `apps/web/src/components/shell/chat-shell.tsx` (обернуть спайк в `SidebarProvider` + `Sidebar`)
  - Investigation Targets: `apps/web/components.json` (base-nova, `@base-ui/react`); `apps/web/node_modules/@base-ui/react/drawer/root/DrawerRoot.d.ts`; DD «Тема, шрифт, токены» (абзац «Шторка: закрытие свайпом»), «Правки скопированных shadcn-компонентов».
  - Содержание:
    - Сначала `pnpm --filter web exec shadcn add --help`: есть флаг `--yes` — добавить его к вызову (CLI не спрашивает подтверждения); `--overwrite` не использовать в любом случае; в выводе ожидается «skipped» для существующих `button`, `skeleton`, `tooltip`.
    - Затем один вызов `pnpm --filter web exec shadcn add sidebar sheet dropdown-menu alert-dialog input separator sonner [--yes]` **без** `--overwrite` (нужна сеть). После — `git diff --stat apps/web/src/components/ui/button.tsx apps/web/src/components/ui/skeleton.tsx apps/web/src/components/ui/tooltip.tsx` пуст; иначе восстановить из git, записать в Notes. Спецификаторы, добавленные CLI: `next-themes` → `^0.4.6`, `sonner` → `^2.0.8`.
    - `ui/sidebar.tsx`: в мобильной ветке `Sheet` заменить на `Drawer.Root swipeDirection="left"` с теми же классами панели (288 px, `max-w-[85vw]`), открытие свайпом от края не добавлять; `role="dialog" aria-modal="true" aria-label="История бесед"`; русские `aria-label`/`title`/sr-only («Боковая панель» вместо «Toggle Sidebar»). Остальные правки `sidebar.tsx` — T3.1 и T6.2.
  - Проверка S-11 (оркестратор, `pnpm --filter web dev`, 375 px): шторка открывается, `role="dialog"`, фокус внутри (ловушка), Esc закрывает, свайп влево закрывает (`[DevTools — user: touch emulation]`), фокус возвращается на кнопку открытия. Не подтвердилось → запасной путь `Sheet` + `pointerdown/pointerup` (смещение влево ≥ 30 % ширины → `setOpenMobile(false)`), запись в Notes. Компонентный тест шторки — T3.1.
  - Зависимости: T1.3 (гейт G1); оболочка для монтирования — из T1.2.
  - Completion: [x] гейты lint, tsc, build — 0 ошибок; [x] три существующих `ui/*` не изменены; [x] проверка S-11 записана в Notes (свайп влево не выполнен — перенесён в T8.3 L1-3).

#### Phase Completion Criteria
- [ ] T1.1, T1.2, T1.4 готовы к коммиту (manual); T1.3 выполнена, результаты в Notes
- [x] Гейт G1 пройден до начала T1.4: S-1 подтверждён; для S-2…S-5 — подтверждение или применённый запасной путь
- [ ] S-11 (T1.4): подтверждение или применённый запасной путь
- [ ] lint, tsc, build `apps/web` — 0 ошибок
- [ ] Интеграционные тесты: 0/10 (Vitest ещё нет)

#### Operational Verification Procedures
1. Шаги 1–6 T1.3 и проверка S-11 из T1.4 (копия критериев Early Verification Point DD).
2. Первая отправка с `/`: два запроса в правильном порядке, `body.id` совпадает с id из `POST /api/threads`, адресная строка `/chat/<id>`, нет запроса документа (Integration Point 1 DD).
3. Во время стрима X открыть Y: запрос X не отменён, ответ дописан (Integration Point 3 DD).

---

### Phase 2: Фундамент — тестовая инфраструктура, тесты модулей спайка, тема, шрифт, токены (шаги 2–3 DD) (оценка коммитов: 4)

**Цель**: Vitest + RTL + MSW в `apps/web` (FR-12), скелеты на местах, характеризационные тесты модулей спайка, тема без FOUC и токены контраста.

#### Tasks

- [x] **T2.1 Vitest 4 + RTL + MSW 2 + jsdom 29, обвязка `src/test/`, перенос и слияние скелетов, `config.test.ts`** (FR-12: AC-12.2; Reference: `vitest.config.ts`, `lib/config.ts`)
  - Target Files: `apps/web/package.json`, `pnpm-lock.yaml`, `apps/web/vitest.config.ts` (new), `apps/web/src/test/setup.ts` (new), `apps/web/src/test/msw-server.ts` (new), `apps/web/src/test/fixtures.ts` (new), `apps/web/src/test/render-with-runtime.tsx` (new), `apps/web/src/lib/config.test.ts` (new), `apps/web/src/components/shell/{shell.list,shell.new-chat,shell.open-thread,shell.deleted-thread,shell.message-error,shell.delete-open-thread,shell.workspace}.int.test.tsx` (new — перенос), `docs/features/chat-shell/web-shell/test-skeletons/*.int.test.tsx` (delete — 7 файлов, каталог удаляется)
  - Investigation Targets: DD «Инструменты и версии», абзац о `vitest.config.ts` и `setup.ts`; `apps/api/vitest.config.ts` (та же линия Vitest 4 / Vite 8); комментарии «Harness» в скелетах; `turbo.json`.
  - Содержание:
    - devDependencies: `vitest` `^4.1.12`, `vite` `^8.0.0`, `@vitejs/plugin-react` `^6.1.2`, `jsdom` `^29.1.1` (не 30.x: Node 24.11 < 24.15), `@testing-library/react` `^16.3.3`, `@testing-library/dom` `^10.4.2`, `@testing-library/jest-dom` `^7.0.1`, `@testing-library/user-event` `^14.6.8`, `msw` `^2.15.0`; скрипты `"test": "vitest run"`, `"test:watch": "vitest"`.
    - `vitest.config.ts` — дословно по Reference Contract Values; `setup.ts` — `@testing-library/jest-dom/vitest`, полифилы `matchMedia` (управляемые `pointer`, `prefers-color-scheme`, ширина), `ResizeObserver`, `IntersectionObserver`, `PointerEvent`, `Element.prototype.scrollIntoView`; MSW `setupServer` с `onUnhandledRequest: 'error'`, `resetHandlers` после каждого теста.
    - `fixtures.ts` — `threadSummary(...)`, `threadList(...)`, `historyMessages(...)`, `sseFromChunks(...)` (SSE v7); фикстуры проходят схемы `@agent-os/contracts`. Плюс `deferred()` → `{ promise, resolve, reject }` — удержание ответа MSW (импортирует `shell.open-thread`, используют T3.4 и T4.2).
    - `render-with-runtime.tsx` — `renderWithRuntime({ pathname, pointer, ... })`: `vi.mock('next/navigation')` с управляемым `pathname` и шпионом `router` (`push`, `replace`), монтирует `ChatRuntimeProvider` + `ChatShell` и рядом `<Toaster />` из `@/components/ui/sonner` (создан в T1.4) — тост «Беседа удалена» в `shell.delete-open-thread` (T5.2) без правки `src/test/*`.
    - Перенос: текущее содержимое рабочего дерева семи скелетов (включая неотслеживаемый `shell.message-error.int.test.tsx`) → `apps/web/src/components/shell/`; слияния по разделу «Решение по бюджету интеграционных тестов» (14 → 10 `it.todo`); исходные файлы в `docs/.../test-skeletons/` удаляются.
    - `config.test.ts` — `vi.stubEnv` + `vi.resetModules()`: не задан, `'localhost:4000'`, `'ftp://x'` → исключение при импорте; `'http://api.test/'` → `apiBaseUrl === 'http://api.test'` (одна табличная проверка).
  - Зависимости: T1.4 (общие `package.json`, `pnpm-lock.yaml`; гейт G1 к этому моменту пройден).
  - Proof obligations: `config.test.ts` краснеет, если убрать срез `/` в конце или проверку протокола.
  - Completion: [x] `pnpm --filter web test` — `config.test.ts` зелёный, 10 `it.todo` учтены как todo; [x] `pnpm test` из корня (turbo) выполняет тесты `apps/web`; [x] в `apps/web/src/components/shell/` 7 файлов `*.int.test.tsx`, в `docs/.../test-skeletons/` файлов нет; [x] lint, tsc, build — 0 ошибок.

- [x] **T2.2 Unit-тесты клиента API, адаптеров списка и истории, `RetryGate` (характеризация с мутациями)** (AC-01.7, AC-02.5, AC-04.3, AC-05.4 (S-6), AC-16.3 клиент; Cross-Layer Assumption 7)
  - Target Files: `apps/web/src/lib/threads/threads-api-client.test.ts` (new), `apps/web/src/lib/threads/thread-list-adapter.test.ts` (new), `apps/web/src/lib/threads/thread-history-adapter.test.ts` (new), `apps/web/src/lib/threads/retry-gate.test.ts` (new); исправления в модулях T1.1, если тест вскрыл дефект
  - Тесты (MSW; кейсы — строки таблиц):
    - `threads-api-client.test.ts` — 200/невалидно → `invalid_response`; 404 и 400 на `:threadId` → `not_found`; сеть → `network`; провал `safeValidateUIMessages` → `invalid_response`; пустой `messages` → `[]` без ошибки.
    - `thread-list-adapter.test.ts` — маппинг `ThreadSummary` → метаданные; `initialize` → `history[id] === 'ready'` до возврата `remoteId`; `nextCursor: null` → `undefined`; `loadMoreFailed` ставится/снимается; `DELETE` 404 → успех + `deleted`; `PATCH` 500 → `renameFailed` + отказ.
    - `thread-history-adapter.test.ts` — цепочка `parentId`/`headId`; 404 → `not_found` + отказ; 500 → `load_failed`, `retry` → `ready` и разрешение; 500 → `load_failed`, `forget` → отказ `ThreadsApiError('not_found')`, второго запроса `/messages` нет, статусы удалены; не-`ai-sdk/v6` → ошибка конфигурации.
    - `retry-gate.test.ts` — `release` разрешает; `drop` отклоняет `kind: 'not_found'`; без ожидающего — без ошибок; повторный `drop` после `release` — ничего.
  - Зависимости: T2.1.
  - Proof obligations: мутации — 400 перестаёт трактоваться как 404; `initialize` ставит `ready` после возврата; `forget` не вызывает `drop`; `withFormat` пропускает чужой формат — каждая краснит хотя бы один кейс (записать в Notes).
  - Completion: [x] 4 файла зелёные; [x] мутационная проверка записана; [x] lint, tsc — 0 ошибок.

- [x] **T2.3 Unit-тесты `route-thread-id`, `url-sync`, опросчика заголовка (характеризация с мутациями)** (AC-04.1, AC-04.3, AC-20.1; S-2, S-4 — правила)
  - Target Files: `apps/web/src/lib/threads/route-thread-id.test.ts` (new), `apps/web/src/lib/threads/url-sync.test.ts` (new), `apps/web/src/lib/threads/title-poller.test.ts` (new); исправления в модулях T1.1 при дефекте
  - Тесты:
    - `route-thread-id.test.ts` — `/chat/a%2Fb`, `/`, `/foo`, `/chat/`, `/chat/a/b`, `/chat/%E0` (сырой сегмент); round-trip для `'abc'`, `'a/b'`, `'с пробелом'`, `'%'`, `'?#&'`, UUID.
    - `url-sync.test.ts` — `replaceState(null, '', threadPath(id))` при новом id; `router.replace('/')` при `undefined` на `/chat/…`; ничего при `location.pathname === threadPath(id)` (в т. ч. id с `/`).
    - `title-poller.test.ts` (фейковые таймеры) — без ответа ассистента запросов нет; заголовок на 3-м запросе → поток с текстом, `titleWaiting` снят; окно 15 с → 15 запросов и пустой поток; 404 → остановка.
  - Зависимости: T2.1.
  - Proof obligations: мутации — `push` вместо `replaceState`; опрос без проверки ответа ассистента; интервал 500 мс — каждая краснит кейс.
  - Completion: [x] 3 файла зелёные; [x] мутационная проверка записана.

- [x] **T2.4 Тема без FOUC, шрифт с кириллицей, токены контраста и движения, `Toaster`, кнопка** (FR-09: AC-09.1–09.3 механизм; UXQ-3; UXRD 7.6; Element 3; IP4, IP5)
  - Target Files: `apps/web/src/components/theme-provider.tsx` (new), `apps/web/src/app/layout.tsx`, `apps/web/src/app/globals.css`, `apps/web/src/components/ui/button.tsx`, `apps/web/src/components/ui/sonner.tsx`
  - Investigation Targets: `apps/web/node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md` («Understanding suppressHydrationWarning», `InlineScript`); DD «Тема, шрифт, токены», фрагмент `theme-provider.tsx`; `next-themes` 0.4.6 `dist/index.mjs`.
  - Содержание:
    - `theme-provider.tsx` — по фрагменту DD (`scriptProps` по `typeof window`).
    - `layout.tsx`: `<html lang="ru" suppressHydrationWarning>`; `Geist`/`Geist_Mono` с `subsets: ['latin', 'cyrillic']`; `ThemeProvider` первым в `<body>` (`attribute="class"`, `defaultTheme="system"`, `enableSystem`, `enableColorScheme`, `disableTransitionOnChange`); `TooltipProvider`; `Toaster`; inline-скрипт theme-color (`MutationObserver` на `html.class`); `export const viewport` (`viewportFit: 'cover'`, `interactiveWidget: 'resizes-content'`); `<link rel="preconnect" href={apiBaseUrl} crossOrigin="use-credentials">`; `metadata` `title: 'Agent OS'`, `description: 'Рабочее пространство Agent OS'`.
    - `globals.css` — токены дословно по Reference Contract Values; `@theme inline { --font-sans: var(--font-geist-sans); --font-heading: var(--font-geist-sans); }`.
    - `button.tsx` — `focus-visible:ring-3 focus-visible:ring-ring`; `destructive` → `bg-destructive text-destructive-foreground`.
    - `ui/sonner.tsx` — `position="bottom-right"`, `closeButton`.
  - Тесты: компонентный тест темы — T3.2 (`user-menu.test.tsx`); FOUC, шрифт, контраст — L1-8 (T8.3).
  - Зависимости: T1.4 (`ui/sonner.tsx`, `next-themes`).
  - Completion: [x] lint, tsc, build — 0 ошибок; [x] `pnpm --filter web dev` (оркестратор, Chrome, 2026-10-30): `localStorage.theme = 'dark'` + reload → `html.dark`, `color-scheme: dark`, `--background` `lab(2.75% 0 0)`, meta `theme-color` = `--background`; `'light'` → светлая, `theme-color` `lab(100% 0 0)`; переключение класса `dark` обновляет `theme-color` (MutationObserver работает); ключ удалён → system (ОС светлая) → светлая; `html lang=ru`; ровно один регион sonner `Toaster`; в консоли нет предупреждений о `<script>` и гидратации; [x] `document.fonts.check('14px Geist', 'Жё')` → `true`; `body` font-family `Geist, "Geist Fallback"`; [ ] отсутствие FOUC на production-сборке — не выполнено: `next start` не смог занять :3000 (занят dev-сервером) → перенесено в T8.3 L1-8 (production build).

#### Phase Completion Criteria
- [x] T2.1–T2.4 готовы к коммиту
- [ ] `pnpm --filter web test` зелёный (U: 8 файлов); 10 `it.todo`
- [ ] lint, tsc, build — 0 ошибок; `pnpm test` (turbo) зелёный
- [ ] Интеграционные тесты: 0/10

#### Operational Verification Procedures
1. `pnpm --filter web test` без запущенного API (AC-12.2) — зелёный.
2. `pnpm --filter web build && pnpm --filter web start`, `localStorage.theme = 'dark'`, F5 — первый кадр тёмный (быстрая проверка; полная L1-8 — T8.3).

---

### Phase 3: Каркас оболочки — раскладка, сайдбар без списка, меню пользователя, шапка, основная область (шаг 4 DD) (оценка коммитов: 4)

**Цель**: заменить разметку спайка на раскладку SH-01: сайдбар с полосой и шторкой, шапка, `MainView` с TH-05/TH-06/TH-07, тема в меню пользователя.

#### Tasks

- [x] **T3.1 `ChatShell` (SH-01), `AppSidebar` без списка, граница ошибок, cookie сайдбара, правки `ui/sidebar.tsx`, `useMediaQuery`** (AC-07.1 механизм, AC-10.1–10.3 механизм, AC-21.1; Element 4; S-11 — C)
  - Target Files: `apps/web/src/components/shell/chat-shell.tsx`, `apps/web/src/components/shell/app-sidebar.tsx` (new), `apps/web/src/app/(chat)/error.tsx` (new), `apps/web/src/app/(chat)/layout.tsx`, `apps/web/src/hooks/use-media-query.ts` (new), `apps/web/src/components/ui/sidebar.tsx`, `apps/web/src/components/shell/app-sidebar.test.tsx` (new)
  - Содержание:
    - `ChatShell` — `SidebarProvider defaultOpen={defaultSidebarOpen}`, `SidebarInset` как `main`, корень `h-dvh`; эффект: `!isMobile && openMobile` → `setOpenMobile(false)`; skip link «Перейти к сообщению» первым в Tab. Разметка спайка удаляется.
    - `AppSidebar` — `Sidebar collapsible="icon"` + `SidebarRail`; SB-02 марка; SB-03 «Новый чат» (полная/иконочная, `aria-keyshortcuts="Control+Shift+O Meta+Shift+O"`); в шторке «×» «Закрыть меню», шапка шторки `pt-[env(safe-area-inset-top)]`; `nav aria-label="История бесед"` — место для списка (T4.2); в полосе список не рендерится.
    - `ui/sidebar.tsx` — `setOpen(value, options?: { persist?: boolean })` (по умолчанию `persist: true`; `false` — без записи cookie); `transition-[width,left,right]` с `ease-(--ease-panel) duration-(--duration-panel) motion-reduce:transition-none`.
    - `(chat)/error.tsx` — `'use client'`: «Что-то пошло не так» + «Обновить страницу», `console.error` с `digest`.
    - `useMediaQuery(query)` — `useSyncExternalStore` над `matchMedia`.
  - Тесты (C): `app-sidebar.test.tsx` — 1 тест S-11: при мобильной ширине «Меню» открывает `role="dialog"` «История бесед», фокус на «Новый чат», Esc закрывает, фокус возвращается на «Меню» (AC-10.2 — механизм шторки; свайп — только L1-3).
  - Зависимости: T2.4.
  - Proof obligations: тест краснеет, если `finalFocus` шторки не задан (фокус уходит на `body`).
  - Completion: [x] тест зелёный; [x] lint, tsc, build — 0; [x] dev: свернуть сайдбар, F5 — полоса на первом кадре (быстрая проверка AC-21.1).
  - Notes (оркестратор, 2026-10-30, dev-сервер, desktop): сворачивание через «Боковая панель» пишет `sidebar_state=false`, после F5 остаётся полоса 48 px (`data-state=collapsed`); серверный HTML содержит `data-state="collapsed"` при Cookie `sidebar_state=false` и `"expanded"` при `true` — анимации раскрытия на первом кадре нет (AC-21.1 PASS).

- [x] **T3.2 Меню пользователя и тема (SB-11, TM-01)** (AC-09.1, AC-09.4; AC-12.1 — тема)
  - Target Files: `apps/web/src/components/shell/user-menu.tsx` (new), `apps/web/src/lib/dev-user.ts` (new), `apps/web/src/components/shell/user-menu.test.tsx` (new), `apps/web/src/components/shell/app-sidebar.tsx` (подключение `UserMenu`)
  - Содержание: `DropdownMenu` (side `top`), аватар «DU», «dev-user» / «Режим разработки» из `DEV_USER`, `DropdownMenuRadioGroup` «Тема» (`light`/`dark`/`system`) через `useTheme()`; нет «Выйти»/«Настройки».
  - Тесты (C, test-first): `user-menu.test.tsx` — внутри `ThemeProvider` выбор «Тёмная» → `document.documentElement.classList.contains('dark')`; «Системная» → класс по `matchMedia('(prefers-color-scheme: dark)')`; нет «Выйти»/«Настройки», есть «dev-user» (2 теста — AC-12.1 «тема»).
  - Зависимости: T3.1.
  - Completion: [x] 2 теста зелёные; [x] lint, tsc — 0.

- [x] **T3.3 Шапка: `ChatHeader` (контейнер) + `ChatHeaderView`** (AC-07.1, AC-07.2, AC-07.3; AC-12.1 — шапка; Element 6)
  - Target Files: `apps/web/src/components/shell/chat-header.tsx` (new), `apps/web/src/components/shell/chat-header.test.tsx` (new), `apps/web/src/components/shell/chat-shell.tsx` (подключение)
  - Содержание: HD-02 — `md:hidden` «Меню» (`aria-haspopup="dialog"`) и `hidden md:inline-flex` «Боковая панель» (`aria-expanded`, `aria-controls`, `aria-keyshortcuts="Control+B Meta+B"`); HD-03 `h1 tabIndex={-1}` `data-shell-focus="page-title"` по `HeaderTitle` (`hidden` → sr-only «Новый чат», `loading` → скелетон 160×16, `text` + `pending` → «Новая беседа» в `ShimmerLabel`); HD-04 `hidden lg:inline-flex` «Рабочая область» (`aria-expanded`; панель — T5.3); HD-05 `md:hidden`; граница снизу по `data-scrolled`. Контейнер читает рантайм (`mainThreadId`, `threadItems`, `isRunning`) и `ShellStatus.titleWaiting`.
  - Тесты (C, test-first): `chat-header.test.tsx` — `text` → `h1` с названием; `pending` → «Новая беседа»; `hidden` → sr-only «Новый чат»; `loading` → скелетон; кнопка рабочей области `aria-expanded` (4 теста AC-12.1, кейсы — строки таблицы); AC-07.1 — внутри `SidebarProvider defaultOpen` + `Sidebar collapsible="icon"`, `(min-width: 768px)` = true: «Боковая панель» `aria-expanded="true"` → клик → `"false"`, у сайдбара `data-state="collapsed"`, `data-collapsible="icon"`.
  - Зависимости: T3.1.
  - Completion: [x] тесты зелёные; [x] lint, tsc — 0.

- [x] **T3.4 `MainView` + `resolveMainView`, `ThreadNotice` (TH-06, TH-07), лента 48rem, скелетон, заголовок приветствия и подпись композера; интеграционный `shell.open-thread` (AC-02.2 + AC-04.3)** (AC-02.2, AC-04.3; AC-02.5, AC-04.2 — механизм)
  - Target Files: `apps/web/src/lib/threads/resolve-main-view.ts` (new), `apps/web/src/lib/threads/resolve-main-view.test.ts` (new), `apps/web/src/components/shell/main-view.tsx` (new), `apps/web/src/components/shell/thread-notice.tsx` (new), `apps/web/src/components/shell/thread-notice.test.tsx` (new), `apps/web/src/components/assistant-ui/elements/thread.aui.tsx` (`--thread-max-width: 48rem`, `export ThreadHistorySkeleton`, заголовок приветствия, подпись и placeholder композера), `apps/web/src/components/shell/chat-shell.tsx` (подключение `MainView`), `apps/web/src/components/shell/shell.open-thread.int.test.tsx`
  - Содержание:
    - `resolveMainView` — правила 1–5 дословно (Reference Contract Values); `MainView` → `Thread` (`autoFocus={false}`), `ThreadNotice` или `ThreadHistorySkeleton`.
    - `ThreadHistorySkeleton` — `role="status"` с именем «Загружаем беседу…», появление через 150 мс.
    - `ThreadNotice` варианты `not-found` / `load-error` (`h1 tabIndex={-1}`, фокус при монтировании, «Повторить» → `retrySwitch`/`retryHistory`, «Новый чат»); вариант `deleted` — T7.3.
    - `thread.aui.tsx`: заголовок приветствия «Чем могу помочь?» вместо `How can I help you today?`; композер — `aria-label="Сообщение"` вместо `Message input`, placeholder «Спросите что-нибудь…» вместо `Send a message...` цветом `text-muted-foreground` без прозрачности (UXRD TH-04). Подсказки 2×2, прочие тексты приветствия и фокус-политика — T4.3.
  - Тесты (test-first):
    - U `resolve-main-view.test.ts` — все ветви таблицы, включая правило 4: `{ routeThreadId: 'x', mainRemoteId: 'x', historyStatus: undefined }` и `'loading'` → `switching`; `'ready'` → `thread`; `{ routeThreadId: undefined, historyStatus: undefined }` → `thread`.
    - C `thread-notice.test.tsx` — тексты TH-06/TH-07, фокус на заголовке (E-8 — строка добавляется в T7.3).
    - I `shell.open-thread.int.test.tsx` — 1 тест из трёх в файле: AC-02.2 + AC-04.3 (скелетон «Загружаем беседу…» при удержанном `GET /api/threads/x`, приветствия «Чем могу помочь?» нет; затем 404 → «Беседа не найдена», фокус на `h1`, поля «Сообщение» нет). Кейсы F5 и AC-02.5 — T4.2 (утверждают ссылку сайдбара «Отчёт»).
  - Зависимости: T3.1, T3.3 (общий `chat-shell.tsx`; и T2.1 — обвязка).
  - Proof obligations: правило 2 удалено (`switching` → `thread`) → краснеет I (приветствие при прямой ссылке); `switchError` не доходит до `ThreadNotice` → краснеет I (нет «Беседа не найдена»); правило 4 удалено → краснеет U-кейс правила 4.
  - Completion: [x] U, C, I зелёные; интеграционные 1/10; [x] утверждения о «Чем могу помочь?» и «Сообщение» проверяют строки, которые есть в рендере (правило выполнения 10); [x] lint, tsc, build — 0.

#### Phase Completion Criteria
- [x] T3.1–T3.4 готовы к коммиту
- [x] Интеграционные тесты: 1/10 (todo: 9)
- [ ] AC-12.1 частично: тема 2, шапка 4
- [x] lint, tsc, test, build — 0 ошибок

#### Operational Verification Procedures
1. L1-1 (раскладка, без списка): 1440 px, сайдбар развёрнут/свёрнут, полоса 48 px, `aria-expanded="false"`; F5 — свёрнут на первом кадре.
2. L1-3 (часть): 375 px — сайдбар скрыт до гидратации, в шапке «Меню» и «Новый чат», нет горизонтального скролла; «Меню» открывает шторку.
3. `/chat/does-not-exist` → «Беседа не найдена», вкладка — после T4.3.

---

### Phase 4: Список бесед, открытие, новый чат (шаги 5–6 DD) (оценка коммитов: 3)

**Цель**: сайдбар по датам с выделением и стрелками, поднятие беседы при отправке, новый чат с приветствием, фокус-политика, заголовок вкладки.

#### Tasks

- [x] **T4.1 `groupThreadsByDate` и `useNow`** (AC-01.1; AC-19.1 — монотонность; D-11; A-6)
  - Target Files: `apps/web/src/lib/threads/group-threads-by-date.ts` (new), `apps/web/src/lib/threads/group-threads-by-date.test.ts` (new), `apps/web/src/hooks/use-now.ts` (new)
  - Содержание: по Reference Contract Values (метки, правило дней, сортировка, эффективное время `max(lastMessageAt, activityAt)`, нет обоих → `now`); `useNow()` обновляется при возврате во вкладку и в полночь.
  - Тесты (U, test-first, табличные): AC-01.1 (сегодня/вчера/5/40 дней → четыре группы по порядку, без пустых); границы 2/7/8/30/31 день; DST `Europe/Berlin` — 2026-03-29 (`activityAt` 2026-03-28 23:30, `now` 2026-03-29 12:00 → «Вчера»; 2026-03-29 00:30 → «Сегодня») и 2026-10-25 (`activityAt` 2026-10-24 23:30, `now` 2026-10-25 23:30 → «Вчера»; 2026-10-18 12:00 → «Предыдущие 7 дней»); страж окружения `new Date(2026, 2, 28).getTimezoneOffset() !== new Date(2026, 2, 30).getTimezoneOffset()`; сортировка с локальным поднятием; монотонность при склейке двух страниц; нет ключей сортировки → `now`; равные `activityAt` → исходный порядок.
  - Зависимости: T2.1.
  - Proof obligations: `Math.floor` вместо `round` краснит DST-кейсы; нестабильная сортировка краснит кейс равенства.
  - Completion: [x] тесты зелёные (≥ 4 — вклад в AC-12.1 «группировка»).

- [x] **T4.2 Список бесед: `ThreadHistoryList` + `ThreadHistoryListView`, `ThreadHistoryItem` (отображение), `ThreadActivityTracker`, ↑/↓/Home/End; интеграционные `shell.list` и `shell.open-thread` (F5, AC-02.5)** (AC-01.1–01.7, AC-02.2 (F5), AC-02.5, AC-03.3 механизм, AC-22.2; AC-12.1 — состояния сайдбара; Open Questions п. 2)
  - Target Files: `apps/web/src/components/shell/thread-history-list.tsx` (new), `apps/web/src/components/shell/thread-history-item.tsx` (new), `apps/web/src/components/shell/thread-activity-tracker.tsx` (new), `apps/web/src/components/shell/thread-history-list.test.tsx` (new), `apps/web/src/components/shell/app-sidebar.tsx` (подключение), `apps/web/src/components/shell/chat-shell.tsx` (монтирование `ThreadActivityTracker`), `apps/web/src/components/shell/shell.list.int.test.tsx`, `apps/web/src/components/shell/shell.open-thread.int.test.tsx` (кейсы F5 и AC-02.5)
  - Содержание:
    - Контейнер: `useAuiState` → `threadItems` (`status === 'regular'`), `isLoading`, `loadError`, `hasMore`, `isLoadingMore`, `mainThreadId`; `ShellStatus` → `activityAt`, `loadMoreFailed`, `titleWaiting`; `useNow()`; «Повторить» SB-09 → `threads.reload()`; при возврате во вкладку `reload()` только если загружена одна страница, иначе — только пересчёт групп.
    - Вид: тексты SB-09 по Reference Contract Values (Loading `role="status"`, Error-текст в `role="alert"`, «Повторить» вне `alert`); группы `h2` (через `render` у `SidebarGroupLabel`) + `ul`.
    - Элемент: `li > SidebarMenuButton render={<Link href={threadPath(remoteId)} data-thread-link …/>}`, `aria-current="page"` у активной; обрезка в одну строку + тултип (500 мс или фокус); «Новая беседа» + `ShimmerLabel` при `isRunning || titleWaiting`; в hover/active/открытом меню — только `text-sidebar-accent-foreground`; фокус по клику добавляет T4.3 вместе с `lib/focus.ts`.
    - `ThreadActivityTracker` — фронт `isRunning` false→true → `status.bumpActivity(id, Date.now())`.
    - ↑/↓/Home/End — `onKeyDown` контейнера по `a[data-thread-link]` через границы групп, `preventDefault()`; Tab-порядок не меняется.
  - Тесты (test-first):
    - C `thread-history-list.test.tsx` — Loading, Empty, Error (`getByRole('alert')` «Не удалось загрузить беседы», «Повторить» вызывает `onRetry`), Ready (`h2`, ссылки, `aria-current="page"`) — 4 теста AC-12.1; ↑/↓/Home/End между группами (AC-22.2); тултип при обрезке (AC-01.6).
    - I `shell.list.int.test.tsx` — 1 тест (AC-01.7 + AC-01.5): невалидный ответ списка → SB-09 Error в `alert`, композер «Сообщение» (T3.4) отправляет новый чат; «Повторить» → второй `GET /api/threads` без `cursor` → список.
    - I `shell.open-thread.int.test.tsx` — 2 оставшихся теста: AC-02.2 F5 (список отвечает после истории, `MutationObserver` — «Чем могу помочь?» не появлялся, ссылка сайдбара «Отчёт» с `aria-current="page"`); AC-02.5 (невалидная история → «Не удалось загрузить беседу», ссылка «Отчёт» в сайдбаре на месте, «Повторить» → сообщения).
  - Зависимости: T4.1, T3.4 (`MainView`, `ThreadNotice`, заголовок приветствия; T3.1 позади).
  - Proof obligations: «Повторить» как no-op краснит `shell.list`; `aria-current="true"` вместо `"page"` краснит C; правило 4 `resolveMainView` удалено → краснеет тест F5; `retryHistory` не вызывает `retry` → краснеет AC-02.5.
  - Completion: [x] C и I зелёные; интеграционные 4/10; [x] lint, tsc, build — 0.
  - Notes (T4.2, 2026-10-30): исправление мелькания приветствия при F5 сделано в `MainView`: охранник `bodyLoading` (`thread.isLoading && messages.length === 0`) расширяет `historyPending` для маршрутных бесед. Тест F5 написан с удержанным `GET /api/threads/:id/messages`. Правило 4 `resolveMainView` доказывается его юнит-строками: кейс F5 его больше не различает, потому что охранник покрывает ту же ситуацию. Гейты: eslint и `tsc --noEmit` — 0; `vitest run` ×3 — 133 passed, 6 todo, без нестабильности; `next build` — успешно.

- [x] **T4.3 Новый чат, фокус-политика, приветствие и подсказки, композер, `DocumentTitle`; интеграционный `shell.new-chat`** (AC-03.1, AC-03.2, AC-03.3, AC-04.1, AC-08.2; S-7, S-9; UX-04)
  - Target Files: `apps/web/src/lib/focus.ts` (new), `apps/web/src/lib/focus.test.ts` (new), `apps/web/src/lib/welcome-suggestions.ts` (new), `apps/web/src/components/shell/shell-welcome.tsx` (new), `apps/web/src/components/shell/document-title.tsx` (new), `apps/web/src/components/shell/thread-welcome.test.tsx` (new), `apps/web/src/components/shell/shell-actions.tsx` (`newChat`), `apps/web/src/components/shell/chat-runtime-provider.tsx` (`Suggestions(WELCOME_SUGGESTIONS)` через `auiConfig`), `apps/web/src/components/shell/main-view.tsx` (`Welcome: ShellWelcome`), `apps/web/src/components/shell/thread-history-item.tsx` (фокус по клику), `apps/web/src/components/assistant-ui/elements/thread.aui.tsx` (прочие тексты приветствия кроме заголовка из T3.4, подсказки 2×2 без «>», кнопка вложений удалена, `AttachmentDropzone` → `div`, `addAttachmentOnPaste={false}`, `data-shell-focus="composer"`, `pb-[max(1rem,env(safe-area-inset-bottom))]`, композер внизу на < 768 px), `apps/web/src/components/shell/shell.new-chat.int.test.tsx`
  - Содержание: `lib/focus.ts` по DD (`isFinePointer`, `focusShellTarget`, `focusAfterNewChat`); `newChat(source)`: `pathname === '/'` → только фокус, иначе `router.push('/')` и фокус; холодная загрузка `/` — фокус только при точном указателе; `DocumentTitle` — форматы UX-04 (Reference Contract Values), эффект `document.title`.
  - Тесты (test-first):
    - U `focus.test.ts` — точный указатель → `composer`, грубый → `page-title` (таблица).
    - C `thread-welcome.test.tsx` — «Чем могу помочь?», 4 подсказки, клик отправляет склеенный текст (`useLocalRuntime` + фейковый адаптер модели) — S-9.
    - I `shell.new-chat.int.test.tsx` — 2 теста: AC-03.2 (на `/chat/a` «Новый чат» → `/` → ссылка b → ноль `POST /api/threads`, список не изменился); AC-04.1 + AC-03.3 (на `/` Enter → `POST /api/threads` (201 `{id:'t-1'}`) раньше `POST /api/chat/assistant` с `body.id='t-1'`, `replaceState` на `/chat/t-1`, первая ссылка «Сегодня» — «Новая беседа» с `aria-current="page"` выше беседы с `updatedAt` сегодня 09:00).
  - Зависимости: T4.2.
  - Proof obligations: `initialize` при «Новом чате» краснит AC-03.2; отключённый `ThreadActivityTracker` краснит утверждения AC-03.3.
  - Completion: [x] U, C, I зелёные; интеграционные 6/10; [x] lint, tsc, build — 0.
  - Notes (T4.3, 2026-10-30): решение по `ThreadActivityTracker`: поднятие существующей беседы при начале ответа (D-11) доказывается отдельным юнит-тестом `thread-activity-tracker.test.tsx` (беседа из «Предыдущие 7 дней» поднимается наверх «Сегодня», пока ответ идёт), а `shell.new-chat` покрывает путь новой беседы (AC-03.3 + AC-04.1). Усиления по ревью интеграционных тестов: `afterEach` сбрасывает URL окна (`replaceState(null, '', '/')`); в AC-03.2 клик по ссылке «Беседа B» гасит `preventDefault`, что убирает шум jsdom «navigation to another Document» без ослабления утверждений; заголовки `shell.*.int.test.tsx` обновлены до DD v1.9 / «10 skeletons». Гейты: eslint, `tsc --noEmit` — 0; `vitest run` ×3 — 140 passed, 4 todo, без нестабильности; `next build` — успешно; CR в изменённых файлах — 0.

#### Phase Completion Criteria
- [x] T4.1–T4.3 готовы к коммиту
- [x] Интеграционные тесты: 6/10 (после T4.3, todo: 4)
- [x] AC-12.1: ≥ 8 тестов в четырёх областях выполнено (группировка 4+, состояния сайдбара 4, тема 2, шапка 4)
- [x] lint, tsc, test, build — 0 ошибок

#### Operational Verification Procedures
1. L1-1 (часть): новый чат на 1440 px — колонка 768 px; подсказка № 1 → Network `POST /api/threads` → `POST /api/chat/assistant` (`id` совпадает), адресная строка `/chat/<id>`, «Новая беседа» первой в «Сегодня» с мерцанием и `aria-current="page"`; заголовок ≤ 15 с в сайдбаре, шапке, вкладке.
2. L1-5: A → B → C кликами, F5 на C, Назад ×2, Вперёд — выделение и шапка синхронны; заголовок вкладки не перезаписан (S-7).

---

### Phase 5: Переименование, удаление, рабочая область (шаги 7–8 DD) (оценка коммитов: 3)

**Цель**: операции над беседой с уведомлениями и откатом, удаление открытой беседы с заменой URL, рабочая область со свёрткой сайдбара без записи cookie.

#### Tasks

- [x] **T5.1 Переименование: меню «⋯» (SB-07), `ThreadTitleField` (SB-08), уведомление об ошибке** (AC-05.1–05.4, AC-01.6)
  - Target Files: `apps/web/src/components/shell/thread-title-field.tsx` (new), `apps/web/src/components/shell/thread-history-item.tsx`, `apps/web/src/components/shell/thread-history-item.test.tsx` (new)
  - Содержание: `SidebarMenuAction` «⋯» (`aria-label="Действия с беседой «{название}»"`, `aria-haspopup="menu"`) + `DropdownMenu` «Переименовать», «Удалить» (пункт «Удалить» — `data-highlighted:bg-destructive data-highlighted:text-destructive-foreground`); поле `input aria-label="Название беседы" maxLength={200}`, `data-shortcuts-blocked`; Enter сохраняет обрезанное, Esc отменяет, пусто + Enter → `aria-invalid="true"` и «Введите название» без запроса; фокус после сохранения/отмены — ссылка беседы; ошибка `PATCH` — откат библиотеки + уведомление из адаптера.
  - Тесты (C, test-first): `thread-history-item.test.tsx` — Enter сохраняет обрезанное; Esc отменяет; пусто + Enter → `aria-invalid` и «Введите название» без `onRename`; `maxLength=200`; «Новая беседа» при `title: undefined`; тултип при обрезке.
  - Зависимости: T4.2.
  - Completion: [x] тесты зелёные; [x] lint, tsc — 0.

- [x] **T5.2 Удаление: `DeleteThreadDialog` (DLG-01), удаление открытой и не открытой беседы, фокус; интеграционный `shell.delete-open-thread`** (AC-06.1–06.3; S-5, S-8; A-4)
  - Target Files: `apps/web/src/components/shell/delete-thread-dialog.tsx` (new), `apps/web/src/components/shell/delete-thread-dialog.test.tsx` (new), `apps/web/src/components/shell/thread-history-item.tsx`, `apps/web/src/components/shell/thread-history-list.tsx` (фокус после удаления не открытой), `apps/web/src/components/shell/thread-history-list.test.tsx` (кейс AC-06.3), `apps/web/src/components/shell/shell.delete-open-thread.int.test.tsx`
  - Содержание: `alertdialog` «Удалить беседу?» с названием в «ёлочках», «Отмена» (`initialFocus`), «Удалить» — `Button variant="destructive"`; при `isRunning` — абзац A-4; `finalFocus` = «⋯»; удаление открытой → библиотека уходит с беседы → `syncUrlWithThread` → `router.replace('/')` → `focusAfterNewChat()`; удаление не открытой — фокус на следующую ссылку, нет — предыдущую, нет — SB-03 (вычисляется до удаления); уведомления «Беседа удалена» / «Не удалось удалить беседу. Попробуйте ещё раз.».
  - Тесты (test-first):
    - C `delete-thread-dialog.test.tsx` — `alertdialog`, название в «ёлочках», фокус на «Отмена», вариант A-4 (S-8).
    - C `thread-history-list.test.tsx` — новый кейс AC-06.3: после удаления не открытой фокус на следующей ссылке.
    - I `shell.delete-open-thread.int.test.tsx` — 1 тест (строки: точный → композер, грубый → `h1`): `DELETE /api/threads/a`; ссылки `a` нет; `router.replace('/')`, `push` не вызван; «Чем могу помочь?»; уведомление «Беседа удалена».
  - Зависимости: T5.1.
  - Proof obligations: `router.push` вместо `replace` краснит I.
  - Completion: [x] C и I зелёные; интеграционные 7/10; [x] lint, tsc, build — 0.

- [x] **T5.3 Рабочая область (WS-01…WS-03), HD-04, временная свёртка сайдбара; интеграционный `shell.workspace`** (AC-11.1–11.4; Element 4; S-10)
  - Target Files: `apps/web/src/components/shell/workspace-panel.tsx` (new), `apps/web/src/components/shell/chat-shell.tsx`, `apps/web/src/components/shell/chat-header.tsx` (HD-04 обработчик), `apps/web/src/components/shell/shell.workspace.int.test.tsx`
  - Investigation Targets: `apps/web/node_modules/react-resizable-panels/dist/react-resizable-panels.d.ts` (`collapsible`, `panelRef`, единицы `px`/`%`); `apps/web/src/components/ui/resizable.tsx`.
  - Содержание: `ResizablePanelGroup` в `SidebarInset`: панель чата + `collapsible` панель рабочей области (`collapsedSize={0}`, `minSize="360px"`, лента ≥ 480 px, открытие 40 %); `workspaceOpen` (`useState`) × `useMediaQuery('(min-width: 1024px)')`; основная область < 840 px → `setOpen(false, { persist: false })` и разворачивание при закрытии; `aside aria-label="Рабочая область"`, шапка 56 px с «×»; `Separator` `aria-label="Изменить ширину рабочей области"`, ←/→ ±16 px, Shift ±64 px, Home/End; закрытие → фокус на HD-04; плейсхолдер.
  - Тесты (test-first): I `shell.workspace.int.test.tsx` — 1 тест (AC-11.3 + AC-11.1): после загрузки `complementary` «Рабочая область» нет, HD-04 `aria-expanded="false"`; клик HD-04 → панель, `"true"`; «×» → панели нет, фокус на HD-04; повторный клик HD-04 открывает, ещё клик закрывает — фокус на HD-04.
  - Зависимости: T3.3.
  - Proof obligations: закрытие «×» без переноса фокуса краснит I; `workspaceOpen` по умолчанию `true` краснит первое утверждение.
  - Completion: [x] I зелёный; интеграционные 8/10; [x] lint, tsc, build — 0.

#### Phase Completion Criteria
- [x] T5.1–T5.3 готовы к коммиту
- [x] Интеграционные тесты: 8/10
- [x] lint, tsc, test, build — 0 ошибок

#### Operational Verification Procedures
1. L1-2: переименование «Отчёт Q3» + Enter, Esc, пусто + Enter (нет `PATCH`), F5 — сохранено; удаление не открытой (URL не изменился, фокус на соседней ссылке), открытой (URL `/`, Назад не возвращает на удалённую). S-6 — временная ошибка `PATCH` через обёртку `fetch` → откат и уведомление.
2. L1-1 (часть): HD-04 → панель 40 %, лента ≥ 480 px при 1280; < 1024 px — нет кнопки и панели, при 1440 панель вернулась (S-10).

---

### Phase 6: Should — подгрузка списка (FR-19) и горячие клавиши (FR-22) (шаг 9 DD) (оценка коммитов: 2)

**Цель**: подгрузка страниц с состоянием ошибки и сочетания клавиш. FR-20 (опрос заголовка) реализован в T1.1, проверен T2.3 и отображён T3.3/T4.2; FR-21 (cookie сайдбара) — T1.2/T3.1; их L1-проверка — L1-1.

#### Tasks

- [x] **T6.1 Подгрузка: SB-10 «Показать ещё», автоподгрузка, ошибка подгрузки** (AC-19.1)
  - Target Files: `apps/web/src/components/shell/thread-history-list.tsx`, `apps/web/src/components/shell/thread-history-list.test.tsx`
  - Содержание: SB-10 — кнопка `ghost sm` при `hasMore`; `IntersectionObserver` с `rootMargin: '0px 0px 200px 0px'`; `isLoadingMore` → 3 строки-скелетона, `role="status"` «Загружаем ещё беседы…»; `loadMoreFailed` → «Не удалось загрузить ещё беседы» в `role="alert"` + «Повторить» → `loadMore()`; загруженные остаются.
  - Тесты (C, test-first): `thread-history-list.test.tsx` — SB-10 Error: текст в `alert`, «Повторить» вызывает `onLoadMore`, загруженные элементы на месте (монотонность групп — U T4.1).
  - Зависимости: T4.2.
  - Completion: [x] тесты зелёные; [x] lint, tsc — 0.

- [x] **T6.2 Горячие клавиши: `isShortcutBlocked`, `Ctrl/⌘+Shift+O`, `Ctrl/⌘+B` с охраной, символ платформы в тултипах** (AC-22.1)
  - Target Files: `apps/web/src/lib/keyboard-shortcuts.ts` (new), `apps/web/src/lib/keyboard-shortcuts.test.ts` (new), `apps/web/src/hooks/use-global-shortcuts.ts` (new), `apps/web/src/hooks/use-global-shortcuts.test.tsx` (new), `apps/web/src/components/ui/sidebar.tsx` (охрана `Ctrl/⌘+B`), `apps/web/src/components/shell/chat-shell.tsx` (подключение хука), `apps/web/src/components/shell/app-sidebar.tsx`, `apps/web/src/components/shell/chat-header.tsx` (тултипы «⌘»/«Ctrl»)
  - Содержание: по DD «Клавиатура»: `isShortcutBlocked(event)` — `true` внутри `[data-shortcuts-blocked]` или при открытом `[role="alertdialog"]`, `[role="menu"]`, `[role="dialog"][aria-modal="true"]`; для `Ctrl/⌘+B` — исключение, открытая шторка закрывается; `event.code === 'KeyO'`; символ — `navigator.platform`/`userAgentData` → «⌘» на macOS, иначе «Ctrl».
  - Тесты (test-first): U `keyboard-shortcuts.test.ts` — таблица блокировок (поле переименования, `alertdialog`, `menu`, модальный `dialog`, исключение `Ctrl+B` при шторке); C `use-global-shortcuts.test.tsx` — 1 тест проводки: `Ctrl+Shift+O` вызывает `newChat` и `preventDefault`, внутри `[data-shortcuts-blocked]` — нет.
  - Зависимости: T5.1 (поле переименования с `data-shortcuts-blocked`).
  - Completion: [x] тесты зелёные; [x] lint, tsc, build — 0.

#### Phase Completion Criteria
- [x] T6.1, T6.2 готовы к коммиту
- [x] lint, tsc, test, build — 0 ошибок

#### Operational Verification Procedures
1. FR-19 в браузере здесь не проверяется: 120 бесед засорили бы стенд для L1 и все попали бы в «Сегодня». Проверка — в T8.3 после сида T8.2 (беседы с разнесённым `updatedAt`, удаляются после проверки); в Phase 6 — C-тесты T6.1.
2. L1-9 (часть): `Ctrl+Shift+O` из композера, `Ctrl+B`; в поле переименования и в открытом меню сочетания не срабатывают.

---

### Phase 7: Лента — политика markdown, action bar, блок ошибки и «Беседа удалена», ошибка инструмента, локализация и доступность (шаги 10, 10a DD) (оценка коммитов: 5)

**Цель**: намеренные изменения ленты каркаса (Non-Scope DD «Намеренные исключения»): недоверенный markdown, только «Копировать», перегенерация из блока ошибки последнего ответа, E-8, фиксированный текст ошибки инструмента; локализация и reduced motion.

#### Tasks

- [x] **T7.1 Политика ссылок и изображений markdown** (Security «Недоверенный markdown»; IP7)
  - Target Files: `apps/web/src/lib/markdown-policy.ts` (new), `apps/web/src/lib/markdown-policy.test.ts` (new), `apps/web/src/components/markdown-text.tsx`, `apps/web/src/components/markdown-text.test.tsx` (new), `apps/web/eslint.config.mjs`
  - Содержание: `linkPolicy`, `isRenderableImageSrc` по фрагменту DD поверх `safeHref` (`apps/web/src/utils/href.ts` не меняется); `a`/`img` в `markdown-text.tsx` по фрагменту DD (стиль файла — двойные кавычки без `;`), `MarkdownImageFallback`; `Copy` → «Копировать»; `src/components/markdown-text.tsx` добавить в список `files` переопределения `@next/next/no-img-element` с дополнением комментария; `rehype-raw` не подключать, `urlTransform` не трогать.
  - Тесты (test-first): U `markdown-policy.test.ts` — таблица DD (`javascript:alert(1)`, ` JAVASCRIPT:…`, `data:text/html,…`, `vbscript:…`, `''` → `unsafe`; `https://…`, `http://…`, `/chat/x`, `./a`, `?q` → `new-tab`; `#user-content-fn-1` → `fragment`; `mailto:a@b.c` → `mail`; `isRenderableImageSrc` — `https` → `true`, прочие → `false`); C `markdown-text.test.tsx` — пять случаев DD.
  - Зависимости: T2.1 (может идти параллельно с Phase 3–6).
  - Completion: [x] тесты зелёные; [x] lint (без inline-отключений), tsc — 0.

- [x] **T7.2 Action bar: только «Копировать» у ответов и сообщений пользователя, видимость CSS, пустые ответы, удаление `BranchPicker` и `EditComposer`** (AC-08.6; D-13, TH-10)
  - Target Files: `apps/web/src/components/assistant-ui/elements/thread.aui.tsx`, `apps/web/src/components/assistant-ui/elements/message-actions.test.tsx` (new)
  - Содержание: по таблице DD «Action bar и ошибки в ленте»: `AssistantActionBar` — `Copy` (+ условный отзыв каркаса), без `Reload`, `ActionBarMorePrimitive`, `ExportMarkdown`, без `autohide` и `hideWhenRunning`, `AuiIf` по `s.message.status?.type === 'running'`, «Копировать» только при непробельной текстовой части; `UserActionBar` — `Copy` вместо `Edit`; `AssistantMessage` без частей и не в прогоне — без строки; `BranchPicker`, `EditComposer`, ветка `isEditing` удалены; видимость — Reference Contract Values (прозрачность, без `display: none`/`visibility: hidden`); постоянно смонтированный sr-only `role="status"` «Скопировано».
  - Тесты (C, test-first): `message-actions.test.tsx` — по DD: «Копировать» у каждого сообщения без наведения, запрещённых кнопок и «1 / 2» нет, двойной клик не открывает правку; порядок Tab к первому сообщению пользователя и первому ответу; во время прогона — «Копировать» у прежних есть и в Tab, у генерируемого нет, после завершения появляется; клик → `navigator.clipboard.writeText` + `status` «Скопировано» (оба типа); ответ только с инструментом / только с рассуждением — без «Копировать»; ответ без частей — без строки. Случай «ошибка до первого токена — только блок ошибки» перенесён в T7.3 (решение оркестратора, правило 10): блока ошибки до T7.3 нет.
  - Зависимости: T4.3.
  - Proof obligations: возврат `autohide="not-last"` краснит порядок Tab; `hideWhenRunning` краснит кейс «во время прогона».
  - Completion: [x] тесты зелёные; [x] lint, tsc, build — 0.

- [x] **T7.3 Блок ошибки ответа с «Перегенерировать», выключатель `regenerateAfterError`, слот `DeletedNotice`, классификация 404 `THREAD_NOT_FOUND`; интеграционные `shell.message-error` и `shell.deleted-thread`** (AC-08.5, AC-08.5a–e; Element 2; E-8; IP1 404)
  - Target Files: `apps/web/src/components/assistant-ui/elements/thread.aui.tsx` (`MessageError`, слот `DeletedNotice` в `ThreadComponents`, скрытие композера при слоте), `apps/web/src/lib/config.ts` (`regenerateAfterError = true`), `apps/web/src/lib/threads/shell-services.ts` (`handleChatError`: `APICallError` 404 + `ApiErrorSchema` `THREAD_NOT_FOUND` → `status.setHistory(remoteId, 'deleted')`), `apps/web/src/components/shell/thread-notice.tsx` (вариант `deleted`, экспорт `DeletedNotice`), `apps/web/src/components/shell/thread-notice.test.tsx` (строка E-8), `apps/web/src/components/shell/main-view.tsx` (`DeletedNotice: deleted ? DeletedNotice : undefined`), `apps/web/src/components/assistant-ui/elements/message-error.test.tsx` (new), `apps/web/src/lib/threads/shell-services.test.ts` (new), `apps/web/src/components/shell/shell.message-error.int.test.tsx`, `apps/web/src/components/shell/shell.deleted-thread.int.test.tsx`
  - Investigation Targets: `@assistant-ui/ai-sdk` `runtime/useAISDKRuntime.js:219-226, 648`; `@assistant-ui/core` `runtime/utils/external-message-conversion.js:257-285`; `ai` `dist/index.js:20244-20293` (`APICallError`).
  - Содержание: блок — `data-slot="message-error"`, текст в `role="alert"` с `id` из `useId()` (`text-foreground`, рамка/иконка `--destructive`), тексты по выключателю (Reference Contract Values); «Перегенерировать» — `Button variant="outline" size="sm"` через `render` у `ActionBarPrimitive.Reload`, `pressable`, `pointer-coarse:h-11`, `aria-describedby`, только у последнего (`AuiIf` по `s.message.isLast`); после нажатия — `focusAfterNewChat()`; слот задан → вместо блока рендерится `DeletedNotice` (`h2` «Беседа удалена», текст в `role="alert"`, «Новый чат», фокус на «Новый чат» только если он был в скрытом композере), композер не рендерится; `responseBody` в ленту не попадает.
  - Тесты (test-first):
    - C `message-error.test.tsx` — случаи 1–6 DD (`useLocalRuntime` с адаптером модели, бросающим ошибку с английским текстом).
    - C `message-error.test.tsx` — плюс случай, перенесённый из T7.2: ошибка до первого токена — в ленте только блок ошибки, без пустой строки ответа и «Копировать».
    - C `thread-notice.test.tsx` — строка E-8 (тексты, «Новый чат»).
    - I `shell.message-error.int.test.tsx` — 1 тест AC-08.5b (первый ответ «Частичный» + ошибка, новая отправка → у первого ответа нет блока и кнопки, «Частичный» виден, ни одной «Перегенерировать»).
    - I `shell.deleted-thread.int.test.tsx` — 1 тест AC-08.5e (404 `THREAD_NOT_FOUND` до SSE → уведомление под сообщением, нет TH-08 и «Перегенерировать», нет композера, нет пустой строки ответа и «Копировать»; «Новый чат» → `/` с приветствием и композером).
    - U `shell-services.test.ts` — таблица `handleChatError`: `APICallError` 404 + `errorCode: 'THREAD_NOT_FOUND'` → статус `deleted`; 404 с другим `errorCode`, 404 с неразбираемым `responseBody`, 500, не `APICallError` → статус не меняется (дефект, который I-тест не видит: любой 404 превращается в «Беседа удалена»).
  - Зависимости: T7.2.
  - Proof obligations: классификация только по `statusCode` краснит U-строку «404 с другим `errorCode`»; выключатель, не влияющий на кнопку, краснит случай 4 `message-error.test.tsx`.
  - Completion: [x] C и I зелёные; интеграционные 10/10; [x] lint, tsc, build — 0.
  - Notes (T7.3, 2026-10-30): по ревью интеграционных тестов — глобально `testTimeout`/`hookTimeout` 20 с в `vitest.config.ts` (причина таймаутов 5 с на 6–8 интеграционных тестах под нагрузкой машины) и `configure({ asyncUtilTimeout: 3000 })` в `src/test/setup.ts`; семантика тестов не меняется. Заголовки `shell.message-error`/`shell.deleted-thread` обновлены до DD v1.10; у утверждения про h2 — пометка «h2 per DD v1.10 §ThreadNotice (skeleton expected no heading)». Гейты: eslint и `tsc --noEmit` — 0; `vitest run` ×3 — 36 файлов, 251 passed, без нестабильности; `next build` — успешно; CR в изменённых файлах — 0.
  - Notes (оркестратор, 2026-10-30, dev-сервер): T7.2 — у каждого из 4 сообщений ровно одна «Копировать», у непоследних opacity 0 в покое, у последнего 1, доверенный клик → `status` «Скопировано». T7.3 L1-7 «удалена при открытой в другой вкладке» — PASS: сообщение осталось, «Беседа удалена» (h2) + «Её удалили в другой вкладке или окне.» (alert) + «Новый чат», композера нет, «Перегенерировать» нет, фокус на «Новый чат», `POST /api/chat/assistant` → 404, `POST /api/threads` нет. Примечание: удалённая беседа остаётся в списке сайдбара вкладки A до перезагрузки списка (синхронизации между вкладками нет — ожидаемо).

- [x] **T7.4 Ошибка инструмента: ветвление `ToolFallbackImpl` по `isError`, фиксированный текст `ToolFallbackError`, строки `tool-fallback.aui.tsx`** (AC-14.5 клиент; D-15; IP8; Cross-Layer Assumption 8)
  - Target Files: `apps/web/src/components/assistant-ui/elements/tool-fallback.aui.tsx`, `apps/web/src/components/assistant-ui/elements/tool-fallback-error.test.tsx` (new)
  - Содержание: по таблице DD: при `isError: true` — статус `incomplete`/`error` для триггера и `ToolFallbackError`, без `ToolFallbackResult`; «Ошибка:» + «Не удалось выполнить инструмент.» независимо от `status.error`; `cancelled` — «Причина отмены:» и исходная причина; без `role="alert"`; локальный `pressable` не трогать; все пользовательские строки файла (`Reply queued, not sent yet`, `Cancelled tool`/`Failed tool`, `Approved by user`, `Allow`/`Always allow`/`Deny`/`Always deny`, `Answered`/`Allowed`/`Dismissed`/`Denied` и др.) — на русском.
  - Тесты (C, test-first): `tool-fallback-error.test.tsx` — часть с `isError: true` и `{ error: 'boom' }`: подпись неудавшегося инструмента, «Ошибка:», «Не удалось выполнить инструмент.»; нет «boom», `"error"`, «Result:» и перевода; нет `alert`; `incomplete`/`error` с `'Agent error'` и с пустой ошибкой → тот же текст; `cancelled` → «Причина отмены:».
  - Зависимости: T2.1 (может идти параллельно с Phase 3–6).
  - Completion: [x] тесты зелёные; [x] lint, tsc — 0.

- [x] **T7.5 Локализация каркаса, reduced motion, аудит ARIA; `plural-ru`, `i18n.test.ts`** (UXRD 10.2, 7.2, 7.7; fact `i18n:scaffold-strings`)
  - Target Files: `apps/web/src/lib/i18n/plural-ru.ts` (new), `apps/web/src/lib/i18n/plural-ru.test.ts` (new), `apps/web/src/lib/i18n/i18n.test.tsx` (new), `apps/web/src/components/assistant-ui/elements/reasoning.tsx`, `apps/web/src/components/assistant-ui/elements/tool-group.aui.tsx`, `apps/web/src/components/assistant-ui/elements/attachment.aui.tsx`, `apps/web/src/components/ui/dialog.tsx`, `apps/web/src/components/image.tsx`, `apps/web/src/components/file.tsx`, `apps/web/src/components/media-player.tsx`, `apps/web/src/components/assistant-ui/elements/thread.aui.tsx` (оставшиеся строки: «Отправить», «Остановить», TH-09 «К последнему сообщению» и др.; заголовок приветствия, подпись и placeholder композера уже поставлены в T3.4)
  - Содержание: таблица DD «Локализация» (`Рассуждения (N с)`, `pluralRu(N, ['вызов инструмента', 'вызова инструментов', 'вызовов инструментов'])` через `Intl.PluralRules('ru-RU')`, «Закрыть», aria-строки); `motion-reduce:transition-none`/`motion-reduce:animate-none` на всех переходах оболочки; вставка/удаление элементов списка — `@starting-style` с отключением при `prefers-reduced-motion`; сверка ARIA с таблицей UXRD 7.2.
  - Тесты (test-first): U `plural-ru.test.ts` — 1, 2, 5, 11, 21, 22, 25 (таблица); `i18n.test.tsx` — рендер ключевых экранов (новый чат, беседа с инструментом из фикстуры, меню) не содержит слов стоп-листа (`Send`, `Copy`, `Close`, `Toggle`, `Loading`, `Reasoning`, `tool call`).
  - Зависимости: T7.3, T7.4.
  - Completion: [x] тесты зелёные; [x] lint, tsc, build — 0.

#### Phase Completion Criteria
- [x] T7.1–T7.5 готовы к коммиту
- [x] Интеграционные тесты: 10/10 (todo: 0)
- [x] lint, tsc, test, build — 0 ошибок

#### Operational Verification Procedures
1. L1-7 (часть): во второй вкладке удалить беседу, открытую в первой, отправить — сообщение видно, «Беседа удалена» / «Её удалили в другой вкладке или окне.», «Новый чат», нет «Перегенерировать», нет композера.
2. L1-10 A (часть, без seed): Tab по ленте — у каждого сообщения только «Копировать»; во время стрима «Копировать» прежних остаётся в Tab.
3. L1-4 (часть): ответ с `[опасная](javascript:alert(1))` — не ссылка; внешняя — новая вкладка.

---

### Phase 8: Quality Assurance (шаг 11 DD, обязательна) (оценка коммитов: 0–1)

**Цель**: все гейты, все AC, бюджет тестов, полный прогон L1 на production-сборке против реального API, отложенные метрики `threads-api`.

#### Tasks

- [x] **T8.1 Итоговые гейты, проверка AC, аудит тестов** (все AC; Migration Strategy)
  - Target Files: только исправления (по находкам), иначе изменений нет
  - Содержание: `pnpm --filter web lint`, `pnpm --filter web exec tsc --noEmit`, `pnpm --filter web test`, `pnpm --filter web build`, `pnpm build`, `pnpm test` (turbo) — 0 ошибок; `it.todo`/`it.skip` в `apps/web` — 0 (поиск по `apps/web/src`); `pnpm why -r ai` — `apps/web` 7.0.155, `apps/api` 7.0.148; точные версии `@assistant-ui/*`, `assistant-stream`; поиск `components/assistant` и `app/page.tsx` пуст; бюджет тестов (Test Selection): 10 интеграционных, ни один тест не дублирует дефект другого (при сомнении — `test-auditor`); атрибуция `git log main..HEAD` без `Co-Authored-By`/`Claude`; таблица AC ниже заполнена.
    - Код-ревью инварианта Element 1: состояние `ShellStatus` (`apps/web/src/lib/threads/shell-status-store.ts`) содержит ровно `history`, `loadMoreFailed`, `titleWaiting`, `activityAt` и их сеттеры — без списка, заголовков, сообщений, `isRunning` и текущей беседы.
  - Зависимости: T7.1–T7.5.
  - Completion: [x] все гейты — 0; [x] инвариант Element 1 проверен ревью; [x] таблица «Проверка AC» заполнена; [x] результаты в Notes; [x] отчёт `test-auditor` исполнен по решению оркестратора (Phase 8 Notes).

- [x] **T8.2 Dev-only seed для L1-4 и L1-10 (не в репозитории)** (известный пробел стенда: у ассистента `tools: {}`)
  - Target Files: нет в репозитории — скрипт в scratchpad сессии исполнителя
  - Investigation Targets: `apps/api/test/support/seed.ts` (только текстовые части — образец), `apps/api/src/mastra/mastra.provider.ts` (как строится `PostgresStore`/`Memory`), `apps/api/src/threads/thread.mapper.ts` (что уходит в `/messages`, `maskHistoryErrors`), `apps/api/src/mastra/agents/assistant.agent.ts`.
  - Содержание: скрипт пишет через `Memory.saveThread`/`saveMessages` для resource `dev-user` в БД `localhost:5433` сообщения format 2: `SEED-RICH` — 12 сообщений; ответ с частью рассуждения; ответ с частью инструмента `output-available` и результатом; ответ с таблицей; ответ с блоком кода 80+ строк. `SEED-TOOL-ERROR` — сообщение пользователя, ответ с частью инструмента `output-error`, `errorText: 'boom'`; сообщение пользователя, ответ **только** с частью инструмента; сообщение пользователя, ответ **только** с рассуждением. Повторный запуск идемпотентен (фиксированные id `SEED-RICH`, `SEED-TOOL-ERROR`, удаление перед записью).
    - Режим страниц для FR-19 (вызывается из T8.3): `--pages` создаёт 120 бесед `SEED-PAGE-001…120` с `updatedAt` по образцу `descendingDates` из `apps/api/test/support/seed.ts` с шагом 12 ч (охват 60 дней — все пять групп, включая «Старше»), по 2 текстовых сообщения; после `saveMessages` повторно вызвать `saveThread` с исходным `updatedAt` (как `seed()` в `apps/api/test/support/seed.ts`, строки 85-88) — `saveMessages` сбрасывает `updatedAt` беседы на `now()`; `--pages --remove` удаляет их.
    - Запуск: `node <scratchpad>/seed-l1.ts [--pages [--remove]]` на Node 24.11 — снятие типов встроено, `tsx` не нужен и не установлен. Скрипт пишется только стираемым синтаксисом TS (без `enum`, `namespace`, parameter properties; типы — `import type`). Голые спецификаторы из scratchpad не разрешаются (ESM ищет пакеты от импортирующего файла), поэтому пакеты берутся от `apps/api`: `const require = createRequire('<abs>/apps/api/package.json')`, затем `await import(pathToFileURL(require.resolve('@mastra/memory')).href)` и так же `@mastra/pg` (`createRequire` — `node:module`, `pathToFileURL` — `node:url`).
  - Зависимости: T1.3 (стенд работает).
  - Completion: [x] `GET /api/threads/SEED-RICH/messages` и `.../SEED-TOOL-ERROR/messages` → 200, части нужных типов, в теле нет `boom`; [x] пробный прогон `--pages`, затем `--pages --remove` — в `GET /api/threads` не остаётся `SEED-PAGE-*` (и в `mastra_threads` — 0); [x] `git status` не показывает новых файлов от T8.2.

- [x] **T8.3 L1-сценарии L1-1…L1-10, производительность, Lighthouse — выполняет оркестратор через Claude-in-Chrome** (все AC с L1; S-1…S-11; Performance Tests)
  - Target Files: `docs/features/chat-shell/web-shell/l1-browser-scenarios.md` (только Evidence, отметки и Sign-off); исправления кода — отдельной задачей через `update` плана, если найдены дефекты
  - Предусловия: T8.1, T8.2; окружение по правилу выполнения 3; `pnpm --filter web build && pnpm --filter web start` (L1-8 — дополнительно `pnpm --filter web dev` для консоли); ключ `ANTHROPIC_API_KEY` из `apps/api/.env` разрешён пользователем (Открытые вопросы, п. 1).
  - Содержание: чек-лист `l1-browser-scenarios.md` по порядку; шаги **[DevTools — user]** — оркестратор останавливается и просит пользователя (группами); невыполненная проверка — «not executed» с причиной.
    - FR-19 (вне чек-листа, после L1-1…L1-10, чтобы 120 бесед не мешали сценариям): `node <scratchpad>/seed-l1.ts --pages` → прокрутка к SB-10 подгружает по 20, порядок групп монотонен, вторая страница без дублей; блокировка запроса подгрузки (`[DevTools — user]` или обёртка `fetch`) → «Не удалось загрузить ещё беседы», «Повторить» подгружает; затем `--pages --remove`, в списке нет `SEED-PAGE-*`. Результат — в Notes «Метрики и L1». Performance: метрика № 2 (≤ 1,5 с до последнего из 50 сообщений, 10 прогонов), LCP `/chat/<id>` ≤ 2,5 с (5 прогонов), CLS ≤ 0,1 при сайдбаре и рабочей области, Lighthouse Accessibility ≥ 95 (`/` и `/chat/<id>` × обе темы × десктоп/мобильный). Расхождения с UXRD (Open Questions DD п. 1, 3–6; AC-08.5b возврат в беседу) — заметки UX-владельцу в Notes.
  - Зависимости: T8.1, T8.2.
  - Completion: [x] Sign-off L1-1…L1-10 заполнен (pass / fail / not executed + причина); [x] FR-19 проверен, сид страниц удалён; [x] любой fail остановил приёмку соответствующего AC и записан (fail нет; дефект шторки исправлен в ходе T8.3); [x] метрики записаны в Notes.

- [x] **T8.4 Отложенные проверки `threads-api` T6.3-a (метрика № 10) и T6.3-b (метрика № 7)** (требуют реальных ключей провайдера)
  - Target Files: `docs/features/chat-shell/web-shell/l1-browser-scenarios.md` (Evidence, Sign-off); результаты переносятся в Notes плана `threads-api` («L1 / метрики № 7, № 10») через `update` этого плана оркестратором (статус `completed` сохраняется)
  - Предусловия: ключ `ANTHROPIC_API_KEY` из `apps/api/.env` разрешён пользователем (Открытые вопросы, п. 1); production-сборка (T8.1); T8.3 завершена — стенд свободен.
  - Содержание: по разделу «Deferred from `threads-api` T6.3» чек-листа: T6.3-a — «до» `main` `83fd532` в git worktree вне репозитория, по разогреву и 5 прогонов на каждую сторону, median(after) − median(before) ≤ 50 мс, иначе эскалация с десятью значениями; worktree удалён. T6.3-b — 20 новых бесед (10 RU, 10 EN), ≥ 19 из 20 заголовков 1…80 символов без кавычек и переносов, на языке первого сообщения, видны ≤ 15 с; лог `apps/api` — ≤ 10 с; провал — эскалация.
  - Зависимости: T8.1, T8.3 (стенд свободен: T6.3-a останавливает API на порту 4000 ради worktree `83fd532`).
  - Completion: [x] десять значений и медианы записаны; [x] таблица 20 бесед записана; [x] `git worktree list` — только основной.

#### Проверка AC (заполняется в T8.1 и T8.3)

| AC | Проверка | Задача | Результат |
|---|---|---|---|
| AC-01.1 | U `group-threads-by-date`, C | T4.1, T4.2 | [x] авто: `group-threads-by-date.test.ts` («AC-01.1: … four labelled groups»), `thread-history-list.test.tsx` (Ready: h2 по порядку) |
| AC-01.2 | C, L1-1 | T4.2, T8.3 | [x] авто ✓ `thread-history-list.test.tsx` (Ready: `aria-current` только у активной); L1-1 и L1-5 — pass |
| AC-01.3 / 01.4 | C | T4.2 | [x] авто: `thread-history-list.test.tsx` (Loading «Загружаем беседы…», Empty «Пока нет бесед») |
| AC-01.5 / 01.7 | C, I `shell.list` | T4.2 | [x] авто: `thread-history-list.test.tsx` (Error + «Повторить»), `shell.list.int.test.tsx` (AC-01.7 + AC-01.5), `threads-api-client.test.ts` (классификация `invalid_response`) |
| AC-01.6 | C | T4.2, T5.1 | [x] авто: `thread-history-item.test.tsx` (тултип усечённого названия, влезающее название — без тултипа, «Новая беседа») |
| AC-02.1 / 02.3 / 02.4 | U, L1-4 | T2.2, T8.3 | [x] авто ✓ `thread-history-adapter.test.ts` (линейная цепочка parentId/headId); L1-4 — pass: 02.1 (рассуждения, инструмент), 02.3 на production (12 → 14 сообщений, после F5 — 14), 02.4 (рендер markdown; «Копировать» блока кода меняет значок на галочку) |
| AC-02.2 | U, I `shell.open-thread` (прямая ссылка; F5) | T3.4, T4.2 | [x] авто: `resolve-main-view.test.ts`, `shell.open-thread.int.test.tsx` («AC-02.2 + AC-04.3», «AC-02.2 (F5)») |
| AC-02.5 | U, C, I `shell.open-thread` | T2.2, T3.4, T4.2 | [x] авто: `thread-history-adapter.test.ts` (500 → `load_failed`, retry), `thread-notice.test.tsx` (load-error), `shell.open-thread.int.test.tsx` («AC-02.5») |
| AC-02.6 / 03.4 | S-1, L1-6 (без автотеста) | T1.3, T8.3 | [x] S-1 подтверждён в T1.3 (гейт G1); L1-6 — pass (повторно подтверждён в T8.3) |
| AC-03.1 | U, C, L1-1, L1-3 | T4.3, T8.3 | [x] авто ✓ `focus.test.ts` (правило указателя), `shell.delete-open-thread.int.test.tsx` (фокус по типу указателя); L1-3 — pass (HD-05, выбор беседы и SB-03 в шторке → `h1`) |
| AC-03.2 / 03.3 / 04.1 | I `shell.new-chat`, U, L1-1 | T2.3, T4.3, T8.3 | [x] авто ✓ `shell.new-chat.int.test.tsx` (AC-03.2; AC-04.1 + AC-03.3), `url-sync.test.ts`, `thread-activity-tracker.test.tsx`; L1-1 — pass |
| AC-04.2 / 04.4 | S-2, L1-5 | T1.3, T8.3 | [x] S-2 подтверждён в T1.3; L1-5 — pass |
| AC-04.3 | U, I, L1-7 | T2.2, T3.4, T8.3 | [x] авто ✓ `thread-history-adapter.test.ts` (404 → `not_found`), `thread-notice.test.tsx` (not-found, фокус на h1), `shell.open-thread.int.test.tsx`; L1-7 — pass |
| AC-05.1…05.3 | C, L1-2 | T5.1, T8.3 | [x] авто ✓ `thread-history-item.test.tsx` (SB-08: Enter/Esc/пусто/без изменений/blur/200 символов); L1-2 — pass |
| AC-05.4 | U, S-6 (L1-2) | T2.2, T8.3 | [x] авто ✓ `thread-list-adapter.test.ts` (PATCH 500 → `renameFailed` + отказ для отката); L1-2 — pass (откат + уведомление) |
| AC-06.1 / 06.3 | C, L1-2 | T5.2, T8.3 | [x] авто ✓ `delete-thread-dialog.test.tsx` (DLG-01), `thread-history-list.test.tsx` (удаление не открытой, фокус на соседнюю); L1-2 — pass (Esc в диалоге → «⋯») |
| AC-06.2 | I `shell.delete-open-thread`, L1-2 | T5.2, T8.3 | [x] авто ✓ `shell.delete-open-thread.int.test.tsx`; L1-2 — pass |
| AC-06.4 | L1-7 | T8.3 | [x] L1-7 — pass: экран «Беседа не найдена» на `/chat/does-not-exist` (Phase 4); адрес удалённой беседы идёт тем же путём 404 |
| AC-07.1…07.3 | C `chat-header`, L1-1 | T3.3, T8.3 | [x] авто ✓ `chat-header.test.tsx` (HD-02, HD-03 по `HeaderTitle`); L1-1 и L1-5 — pass |
| AC-08.1 / 08.3 / 08.4 | L1-1, L1-4, L1-6 | T8.3 | [x] production: колонка 768 px при 1440×900 (08.1); «К последнему сообщению» видна после прокрутки вверх и возвращает ленту вниз (08.3); 08.4 — L1-6 pass |
| AC-08.2 | C, L1-1 | T4.3, T8.3 | [x] авто ✓ `thread-welcome.test.tsx`; L1-1 — pass |
| AC-08.5 / 08.5a / 08.5c / 08.5d | C `message-error`, L1-10 | T7.3, T8.3 | [x] авто ✓ `message-error.test.tsx` (случаи 1–5; 08.5d — только C); L1-10 B — pass |
| AC-08.5b | I `shell.message-error`, L1-10 | T7.3, T8.3 | [ ] авто ✓ `shell.message-error.int.test.tsx`; возврат в беседу с блоком ошибки (L1-10 B, шаги 3 и 6) — not executed |
| AC-08.5e | C, I `shell.deleted-thread`, L1-7 | T7.3, T8.3 | [x] авто ✓ `message-error.test.tsx` (случай 6), `thread-notice.test.tsx` (deleted), `shell.deleted-thread.int.test.tsx`, `shell-services.test.ts`; L1-7 — pass |
| AC-08.6 | C `message-actions`, L1-10 | T7.2, T8.3 | [x] авто ✓ `message-actions.test.tsx`; L1-10 A — pass |
| AC-14.5 (клиент) | C `tool-fallback-error`, L1-10 | T7.4, T8.3 | [x] авто ✓ `tool-fallback-error.test.tsx`; L1-10 C — pass (живой стрим — not executed: на стенде нет инструментов) |
| AC-14.6 (клиентская сторона) | L1-10 | T8.3 | [x] L1-10 B — pass: после F5 один ответ (серверная часть — владелец `threads-api`) |
| AC-09.1…09.4 | C `user-menu`, L1-8 | T3.2, T8.3 | [x] авто ✓ `user-menu.test.tsx` (09.1, 09.3 «Системная», 09.4); L1-8 на production — pass: 09.2 (FOUC нет), 09.3 (тема ОС переключается без перезагрузки, сохранённая тема — `null`) |
| AC-10.1…10.4 | C (S-11), L1-3 | T3.1, T8.3 | [x] авто ✓ `app-sidebar.test.tsx` (10.2, выбор беседы и SB-03 → `h1`); L1-3 — pass: 10.2, 10.3; на production 10.1 (нет горизонтального скролла при 375 и 360 px) и 10.4 (при 360 px прокручивается только блок кода); свайп S-11 (UXRD 8.2, не AC) — not executed (реальное касание, пользователь) |
| AC-11.1 / 11.3 | I `shell.workspace`, L1-1 | T5.3, T8.3 | [x] авто ✓ `shell.workspace.int.test.tsx`; L1-1 — pass |
| AC-11.2 / 11.4 | L1-1 | T8.3 | [x] L1-1 — pass (браузерная проверка оркестратора, Phase 5, T5.3) |
| AC-12.1 / 12.2 | `pnpm --filter web test` ≥ 8 тестов в 4 областях, без API | T2.1–T4.2, T8.1 | [x] T8.1: `vitest run` — 38 файлов, 259 passed (после аудита тестов), 0 todo/skip; сеть — только MSW (`http://api.test`), API не нужен |
| AC-19.1 | U, C, браузер (сид страниц) | T4.1, T6.1, T8.3 | [x] авто ✓ `group-threads-by-date.test.ts` («AC-19.1: … monotonic»), `thread-history-list.test.tsx` (SB-10), `thread-list-adapter.test.ts` (`loadMoreFailed`); браузер с сидом страниц — pass (FR-19, Notes «Метрики и L1») |
| AC-20.1 | U, L1-1 | T2.3, T8.3 | [x] авто ✓ `title-poller.test.ts`; L1-1 — pass |
| AC-21.1 | L1-1 | T8.3 | [x] L1-1 — pass (браузерная проверка оркестратора, Phase 3) |
| AC-22.1 / 22.2 | U, C, L1-9 | T4.2, T6.2, T8.3 | [x] авто ✓ `keyboard-shortcuts.test.ts`, `use-global-shortcuts.test.tsx`, `thread-history-list.test.tsx` (↑/↓, Home/End); L1-9 — pass (`Ctrl+Shift+O`, `Ctrl+B`, блокировка при открытом меню) |
| Метрики № 7, № 10 (`threads-api` T6.3) | T6.3-b, T6.3-a | T8.4 | [x] T8.4 — pass: № 10 Δ медиан −208 мс; № 7 19/20 после исправления заголовков |

#### Operational Verification Procedures

Копия раздела DD «L1-сценарии» — выполняется по `l1-browser-scenarios.md` (L1-1…L1-10, T6.3-a, T6.3-b) на `next build && next start` против реального API: каждый сценарий фиксирует скриншоты, консоль, ключевые запросы Network; проверка, которая не выполнялась, не считается пройденной. Integration Verification Points DD: первая отправка — порядок запросов и `body.id` (I + L1-1); прямая ссылка, 404 и ошибки истории (I + L1-7); фоновый стрим (S-1 + L1-6) — только реальный браузер и реальный API.

### Quality Assurance
- [x] Поэтапные проверки качества (ai-development-guide): lint → tsc → build → unit/C → интеграционные
- [x] Все тесты проходят; `it.todo` — 0
- [x] Статическая проверка (tsc) — 0
- [x] Lint — 0
- [x] Сборка `apps/web` и всего монорепо — успешна (полный `pnpm build` заменён по решению оркестратора, Phase 8 Notes)

## Completion Criteria
- [x] Все фазы завершены; гейт G1 пройден
- [ ] Операционные проверки каждой фазы выполнены — остаётся свайп S-11 (L1-3, реальное касание — пользователь)
- [ ] AC Design Doc выполнены (таблица «Проверка AC») — открыта строка AC-08.5b: возврат в беседу с блоком ошибки (L1-10 B, шаги 3 и 6) не выполнялся
- [x] Поэтапные проверки качества — 0 ошибок
- [x] Все тесты проходят; интеграционные 10/10
- [x] L1 Sign-off заполнен; T6.3-a/b выполнены или записаны как «not executed» с причиной по решению пользователя
- [x] Notes дополнены результатами ранней точки проверки, мутационных проверок и метрик
- [x] Пост-реализационная проверка всей реализации выполнена — code-verifier: drift, 0 critical / 0 major / 9 minor (D001–D004, D007, D009 — design-web-shell v1.11; D005, D006, D008 — в коде); security-reviewer: approved_with_notes, 15/15, 4 усиления применены; quality-fixer: web 268/268 ×3, api 149 unit + 34 e2e, покрытие строк 88,37 %
- [ ] Изменения закоммичены (manual, по решению пользователя)
- [ ] Ревью пользователя получено

## Progress Tracking
### Phase 1
- Start:
- Complete:
- Notes:

### Phase 2
- Start:
- Complete:
- Notes:

### Phase 3
- Start:
- Complete:
- Notes:

### Phase 4
- Start:
- Complete:
- Notes:
  - Проверка оркестратора в браузере (2026-10-30, свежий dev-сервер) — PASS: `/` показывает «Чем могу помочь?», подзаголовок, 4 подсказки 2×2, композер в фокусе (точный указатель), кнопки вложений нет, `document.title` «Новый чат — Agent OS». Клик по подсказке 1 → `POST /api/threads` 201 → `POST /api/chat/assistant` 200, адрес `/chat/<id>` без навигации документа, «Новая беседа» первой в «Сегодня» с `aria-current`, вкладка «Новая беседа — Agent OS»; автозаголовок «План встречи по запуску проекта» появился в списке и во вкладке за ~16 с. Группы по датам в сайдбаре, заголовок шапки, тёмная тема в меню пользователя, `/chat/does-not-exist` (заметка, фокус на `h1`, композера нет, заголовок шапки пуст) — PASS.
  - НЕ проверено в dev: возврат фокуса на кнопку меню пользователя (портал оверлея Next dev лежит поверх кнопки и забирает фокус) → перепроверить на production-сборке в T8.3.
  - Остаточный риск 2 (T4.3): `finalFocus` шторки против фокуса на заголовке страницы → T8.3 L1-3.

### Phase 5
- Start:
- Complete:
- Notes:
  - Проверка оркестратора в браузере (2026-10-30, dev-сервер) — T5.1 переименование: пусто + Enter → «Введите название», `PATCH` не отправлен; валидное название → один `PATCH` 200, новое название в сайдбаре, шапке и во вкладке, фокус вернулся на ссылку строки; `PATCH` 500 → откат названия + уведомление. Задержка фокуса поля исправлена: ~1065 мс → ~190 мс (первое открытие в dev ~600 мс, перепроверить на production в T8.3).
  - T5.2 удаление: диалог «Удалить беседу?» с названием в «ёлочках», фокус на «Отмена», Esc → фокус на «⋯»; удаление не открытой → фокус на следующую ссылку + уведомление; удаление открытой → `replace` на `/`, длина истории не изменилась, приветствие + фокус на композере, «Назад» к удалённой не возвращает; удаление во время ответа → показан абзац A-4, запрос чата прерван до `DELETE`, сервер отвечает 404 при 0 сообщений, строки расхода нет.
  - T5.3 рабочая область: открывается на ~40 % (441 из 1103 px); сайдбар остаётся развёрнутым, пока основная область ≥ 840 px; ←/→ ±16, Shift ±64, End → 360, Home → максимум с лентой 480; «×» закрывает с фокусом на HD-04, cookie не изменилась. При 1050 px сайдбар временно сворачивается при открытии и восстанавливается при закрытии без записи cookie; при 900 px панель и HD-04 скрыты, при возврате к 1440 px панель снова открыта.

### Phase 6
- Start:
- Complete:
- Notes:

### Phase 7
- Start:
- Complete:
- Notes:
  - T7.5 (2026-10-30): гейты — eslint и `tsc --noEmit` — 0; `vitest run` ×3 — 38 файлов, 262 passed, без нестабильности; `next build` — успешно; CR в изменённых файлах — 0; новых `as` (кроме `as const`) нет. `typeLabel` удалён без остаточных ссылок. Стоп-лист `i18n.test.tsx` не проходит на пустом рендере: перед каждой проверкой `englishLeaks()` утверждается наличие русских элементов экрана.
  - Оркестратор, L1-10 B (2026-10-30, dev-сервер, реальная модель, обёртка `fetch` вставляет SSE-чанк ошибки после 64 текстовых дельт и отменяет реальный поток): частичный текст сохранён + блок «Не удалось получить ответ. Попробуйте перегенерировать.» с кнопкой «Перегенерировать», сырой текст ошибки не показан; «Перегенерировать» → блок исчез, новый ответ на месте прежнего, без ‹1/2›, фокус в композере; F5 → ровно одно сообщение пользователя и один ответ, блока нет; сервер `/messages` = user:text | assistant:reasoning+text (хвост сброшен). Часть (b) L1-10 B (ошибка → новое сообщение → возврат в той же вкладке → F5) покрыта `shell.message-error.int.test.tsx` и остаётся для T8.3.

### Phase 8
- Start: 2026-10-30
- Complete: 2026-10-30 — T8.1–T8.4; пост-реализационная проверка и коммит открыты
- Notes:
  - T8.1 (2026-10-30), гейты — все 0 ошибок: `pnpm --filter web lint` — 0; `tsc --noEmit` — 0; `pnpm --filter web test` — 38 файлов, 262 passed; `pnpm --filter web build` — успешно (маршруты `/`, `/chat/[threadId]`); `pnpm test` (turbo) — 3/3 задачи (api 14 файлов / 138 passed, web 262 passed); `pnpm --filter api test:e2e` (`DATABASE_URL` 5433, пустые ключи провайдеров) — 4 файла, 34 passed; `pnpm build --filter=web...` (contracts + web) — успешно. Полный `pnpm build` не запускался: `nest build` с `deleteOutDir` удалил бы `apps/api/dist`, из которого работает dev-сервер API на :4000. Вместо этого `tsc -p tsconfig.build.json --noEmit` для `apps/api` — 0.
  - Версии: `pnpm why -r ai` — web 7.0.155, api 7.0.148; `apps/web` держит `ai` `^7.0.155` (решение пользователя); `@assistant-ui/ai-sdk` 0.0.16, `@assistant-ui/react` 0.15.32, `@assistant-ui/react-markdown` 0.14.24, `assistant-stream` 0.3.55 — точные. `it.todo`/`it.skip`/`xit` в `apps/web/src` — 0 (устаревшая строка-комментарий «10 it.todo in 7 files» в заголовках 7 файлов `shell.*.int.test.tsx` обновлена по решению оркестратора). `components/assistant` (без `-ui`) — не найдено; `src/app/page.tsx` нет (есть `app/(chat)/page.tsx`).
  - Element 1 (код-ревью `shell-status-store.ts`) — **Y**: состояние — `history`, `loadMoreFailed`, `titleWaiting`, `activityAt`; сеттеры `setHistory`, `setLoadMoreFailed`, `setTitleWaiting` (записанный дополнительный сеттер), `bumpActivity` (сеттер `activityAt`, DD § ThreadActivityTracker), `forgetThread` (очистка трёх карт, DD § history.forget / DELETE). Списка, заголовков, сообщений, `isRunning` и текущей беседы нет.
  - Атрибуция: `git log main..HEAD` (10 коммитов, включая `threads-api` — сливаются в `main` вместе, Migration Strategy) — нет `Co-Authored-By`/`Claude`. Ветка `feature/chat-shell`.
  - Бюджет тестов: 10 интеграционных тестов (12 случаев с учётом двух `it.each`) в 7 файлах `*.int.test.tsx`, каждый ловит отдельный дефект. Отчёт `test-auditor` (только отчёт, тесты не менялись), решение оркестратора — в следующем пункте Notes: (1) дубли в `thread-history-list.test.tsx` (describe «ThreadHistoryItem — title»): «a truncated title shows the full title…» и «a thread without a title reads «Новая беседа»» повторяют тесты `thread-history-item.test.tsx`; «a title that fits shows no tooltip» уникален → перенести в файл элемента; (2) кандидаты на удаление: `delete-thread-dialog` «Esc is «Отмена»» (поведение base-ui), `retry-gate` «drop after release…» (не может покраснеть), `thread-list-adapter` «archive is rejected» (заглушка); (3) слияния: `chat-header` «pending…» → «text…», `message-error` случай 3 строка Space, `group-threads-by-date` (пустой список; сортировка; без ключей), строка `coarse` в `shell.delete-open-thread` (компромисс: она ловит жёстко прописанный `composer.focus()`); (4) табличные слияния без потери покрытия: `message-actions` (буфер обмена), `tool-fallback-error`, `markdown-policy`, пара AC-06.3; (5) 3 теста уровня интеграции без суффикса `.int`: `app-sidebar.test.tsx`, `thread-activity-tracker.test.tsx`, `i18n.test.tsx` «new chat and the conversation menus» — фактически 13 интеграционных при утверждённом исключении 10; (6) в таблице дефектов плана тест «AC-04.1 + AC-03.3» вряд ли ловит «поднятие новой беседы не подключено»: новая беседа без `lastMessageAt` и так попадает первой (`group-threads-by-date.ts:35`); поднятие доказывает `thread-activity-tracker.test.tsx`.
  - T8.1, решение по аудиту тестов. Orchestrator decision on the T8.1 test-budget audit (verbatim):
    > APPLY:
    > 1. Confirmed duplicates: in thread-history-list.test.tsx (describe 'ThreadHistoryItem — title') delete 'a truncated title shows the full title in a tooltip on hover' and 'a thread without a title reads «Новая беседа»' (covered in thread-history-item.test.tsx); MOVE 'a title that fits shows no tooltip' into thread-history-item.test.tsx.
    > 2. Drops: delete-thread-dialog 'Esc is «Отмена»' (base-ui default behaviour — but FIRST confirm the Esc→focus-back-to-«⋯» behaviour is asserted elsewhere; if this test is the only proof of focus return on Esc, keep it and say so); retry-gate 'drop after release leaves the already resolved waiter resolved' (cannot fail); thread-list-adapter 'archive is rejected' (asserts a stub).
    > 3. Lossless table merges: message-actions clipboard pair, tool-fallback-error pair, markdown-policy cases, AC-06.3 pair; chat-header 'pending…' into 'text…' as a table row; three group-threads-by-date tests (empty list, sorting, no sort keys) into one table; message-error case 3 Space row may stay as a table row (cheap, AC-08.5a keyboard).
    > KEEP: the coarse row of shell.delete-open-thread (only case that catches a hard-coded composer.focus()); app-sidebar.test.tsx, thread-activity-tracker.test.tsx and the i18n 'new chat and the conversation menus' case (full-stack component tests, each with a unique defect) — record them in the plan's budget section as full-stack component tests beyond the 10 integration exception, with their unique defects, for the user's attention.
    > ALSO: fix the plan's defect table — the 'AC-04.1 + AC-03.3' integration test does not catch 'new-thread lifting not wired' (a new thread with no lastMessageAt lands first anyway, group-threads-by-date.ts:35); that defect is caught by thread-activity-tracker.test.tsx. Update the outdated '10 it.todo in 7 files' header comment in the 7 shell.*.int.test.tsx files to reflect they are filled. Record that the full `pnpm build` substitute (pnpm build --filter=web... + api tsc -p tsconfig.build.json --noEmit) is accepted because nest build deleteOutDir would delete the running API's dist; the full build runs when the stand is stopped.
  - T8.1, исполнение решения (2026-10-30, Fix Mode): (1) из `thread-history-list.test.tsx` удалён describe «ThreadHistoryItem — title» (2 дубля), «a title that fits shows no tooltip on hover» перенесён в `thread-history-item.test.tsx` (те же заглушки `scrollWidth`/`clientWidth` 120/200, то же утверждение); (2) «Esc is «Отмена»» удалён: проверка показала, что он **не** утверждал возврат фокуса на «⋯» (только закрытие и отсутствие `onConfirm`), то есть не был доказательством возврата фокуса по Esc; возврат фокуса через `finalFocus` доказывает ««Отмена» closes without confirming and returns focus to «⋯»», а возврат именно по Esc автотестом нигде не утверждается — остаётся за L1-2 (T8.3); удалены `retry-gate` «drop after release…» и `thread-list-adapter` «archive is rejected»; (3) табличные слияния `it.each` (каждая строка — отдельный случай; утверждения не ослаблены, часть строк получила утверждения соседа): `message-actions` буфер обмена (2 строки), `tool-fallback-error` incomplete/error (2 строки; строка без значения ошибки теперь также проверяет отсутствие `alert`), `markdown-policy` (`linkPolicy` — 13 строк, `isRenderableImageSrc` — 5 строк), AC-06.3 (2 строки; строка «последняя ссылка» теперь также проверяет имя диалога и `onDelete` ровно один раз с `{id, title}`), `chat-header` text/pending (строка pending теперь также проверяет `tabindex=-1` и `data-shell-focus`), `group-threads-by-date` «ordering» (пустой список, сортировка, без ключей — 3 строки); `message-error` случай 3 уже был `it.each` — без изменений; строка `coarse` `shell.delete-open-thread` сохранена; (4) заголовки 7 файлов `shell.*.int.test.tsx`: «10 tests in 7 files, all implemented — no it.todo left». `thread-list-adapter.test.ts` хранился в репозитории с CRLF — при правке переведён в LF. Счёт тестов: до — 264 случая в 38 файлах (рабочее дерево на момент правок; запись T8.1 выше — 262, разница — два случая в `app-sidebar.test.tsx`, изменённом параллельно), после — 259 (−5: 2 дубля, 3 удаления; перенос и табличные слияния счёт не меняют). Гейты после правок: eslint — 0; `tsc --noEmit` — 0; `vitest run` ×2 — 38 файлов, 259 passed, без нестабильности (предыдущая пара прогонов дала 2 падения в `app-sidebar.test.tsx` во время параллельной правки `app-sidebar.tsx`/теста в 16:53–16:54, которых T8.1 не касалась; после её завершения — зелёный); `next build` — успешно; CR в изменённых файлах — 0; `as` (кроме `as const`) — 0. Полный `pnpm build` заменён на `pnpm build --filter=web...` + `tsc -p tsconfig.build.json --noEmit` для api — замена принята оркестратором (`nest build` с `deleteOutDir` удалил бы `dist` работающего API на :4000); полный `pnpm build` — когда стенд остановлен.
  - Таблица «Проверка AC»: 37 строк — 7 закрыты автотестами полностью, 22 с зелёной автоматической частью ждут L1 (T8.3), 7 только L1 (T8.3), 1 — метрики (T8.4). Пробелов нет: все AC DD сопоставлены; AC-23.1/24.1 вне scope (DD); AC-16.x/17.1 принадлежат `threads-api` (клиентская часть AC-16.3 — `thread-list-adapter.test.ts` «DELETE 404 counts as success»).
  - Известный открытый вопрос (не исправлялся, расследуется отдельно): в одном сохранённом ответе ассистента найдено повреждение U+FFFD.

## Открытые вопросы

Открытых вопросов нет. Закрытые:

1. **Ключ провайдера для спайка и финальной проверки — закрыт.** `ANTHROPIC_API_KEY` из `apps/api/.env` разрешён пользователем для T1.3 (S-1), T8.3 (L1) и T8.4 (T6.3). Его действие не проверялось; T1.3 проверяет ключ первым шагом и при отказе останавливается с вопросом пользователю.
2. **Спецификатор `ai` в `apps/web` — закрыт.** Остаётся `^7.0.155` вопреки шагу 2 DD (точная фиксация); lock-файл разрешает 7.0.155, `pnpm why -r ai` — в T1.1 и T8.1. Отступление записано строкой `gap` в трассировке.
3. **Каталог интеграционных тестов — закрыт.** `apps/web/src/components/shell/` (правило «рядом с кодом»).
4. **Лимит интеграционных тестов — закрыт.** 10 тестов при расширенном лимите 5 приняты как исключение (раздел «Решение по бюджету интеграционных тестов»).

## Notes

- **Происхождение Target Files**: пути взяты из Implementation Path Mapping, File Layout и Change Impact Map DD и проверены по рабочему дереву (`apps/web/src` — 32 файла; `components/ui` — `avatar, button, dialog, resizable, skeleton, textarea, tooltip`; каталогов `components/shell`, `lib/threads`, `src/test`, `app/(chat)` нет — создаются). Пути новых тестовых файлов, не названные DD (`app-sidebar.test.tsx`, `use-global-shortcuts.test.tsx`, `i18n.test.tsx` в `lib/i18n/`, `message-error.test.tsx` и соседние в `components/assistant-ui/elements/`), выбраны планом по правилу «рядом с кодом». API-стороны Connection Map проверены по `apps/api/src/{chat,threads}`.
- **Окружение (факты на 2026-10-30)**: Node 24.11.0; `apps/web` `ai` разрешён в 7.0.155, `apps/api` — 7.0.148; `@base-ui/react/drawer` установлен; документы Next 16.4.3 (`preventing-flash-before-hydration.md`, `preserving-ui-state.md`, `single-page-applications.md`) на месте; у `apps/web` нет Prettier-конфигурации; `apps/web/.env.example` — `NEXT_PUBLIC_API_URL=http://localhost:4000`.
- **Ранняя точка проверки** (заполняется в T1.3, T1.4):
  - **T1.3 — гейт G1 ПРОЙДЕН** (реальный браузер + реальный `threads-api` + реальная модель `claude-haiku-5-5`, 2026-10-30; подробности, причины и путь к библиотеке — Investigation Notes `task-T1.3.md`):
    - Шаг 0, ключ: действителен (ответ «Париж»).
    - Шаг 1 / S-2, критерий 1 — **подтверждён**: первая отправка с `/` → `POST /api/threads` 201 → `POST /api/chat/assistant` 200 с id сервера; адрес `/chat/<id>` через `replaceState`; запроса документа и RSC-запроса к :3000 нет; счётчик монтирований не изменился (1, 2 при загрузке страницы — двойной эффект StrictMode).
    - Шаг 2 / **S-1**, критерий 2 — **подтверждён**: длинный ответ в X; переход в Y, затем «Новый чат» (`/`), возврат в X во время стрима (ответ продолжается, видна Stop) и после завершения; в Y и на `/` текста X не было; сервер сохранил полный ответ (8676 символов, оканчивается «КОНЕЦ»), отмены в логе API нет.
    - Шаг 3 / S-3, критерий 3 — **подтверждён**: F5 на `/chat/<id>` → счётчик `load` = 1, статус `ready`; `/chat/does-not-exist` → `switchError` `not_found`; обёртка `window.fetch` (500 на `/messages`) и открытие ссылкой не открывавшейся беседы → `load_failed` + «Повторить»; обёртка снята → «Повторить» → `ready`. Замечание: на маршруте несуществующей беседы assistant-ui пишет `console.error '[assistant-ui] thread list switch failed: ThreadsApiError … not_found (404)'` (оверлей Next dev — «1 Issue»); это ожидаемый лог библиотеки, обрабатывается UI TH-07 в следующих задачах.
    - Шаг 4 / S-2, критерий 4 — **подтверждён**: A, B, C по ссылкам, Назад ×2, Вперёд — беседы переключаются без перезагрузки (состояние окна сохранено), история каждой загружена один раз.
    - Шаг 5 / S-5, критерий 5 — **подтверждён с запасным путём (5) и серверным исправлением**. Первый прогон: удаление по умолчанию не остановило стрим в браузере; серверный `DELETE` вернул 204 (сетевая панель расширения ошибочно показывала 503, Resource Timing — 204), а сохранение Mastra в конце прогона воссоздало беседу. Применён запасной путь — `ShellActions.deleteThread` (v1 использовал `aui.threads.__internal_getThreadBody`, которого нет у scope `threads` приложения в 0.15.32; v2 — пути main/background, DD v1.6). Браузер: основная беседа → fetch прерван до `DELETE`, строки `usage` нет, беседа 404; фоновая беседа → путь отмены сработал, но `DELETE` всё равно опережал закрытие fetch → беседа воскресала до серверного исправления threads-api v1.10 (`ThreadRunRegistry`, план 2 из 2); после исправления тот же фоновый сценарий → 404, 0 сообщений, нет `usage`, нет «Run outlived».
    - Шаг 6 / S-4 — **подтверждён**: заголовок пришёл опросом `GET`, без `PATCH`, за ~6 с. Найден дефект качества заголовка (мета-рассуждение) → исправлен в threads-api v1.10 KD-7; повторная проверка: «Столица Франции: вопрос на одно слово».
    - Очистка: временная инструментовка T1.3 удалена (`console.count` монтирования, обёртка счётчика `load` в `shell-services.ts`, кнопка «×» спайка в `chat-shell.tsx`, `console.debug` пути отмены в `shell-actions.tsx`); production-`ShellActions.deleteThread` оставлен (DD v1.6). Гейты `apps/web`: `eslint`, `tsc --noEmit` — зелёные; `next build` — зелёные (dev-сервер остановлен).
  - **T1.4 — S-11 (шторка base-ui `Drawer`), 2026-10-30, оркестратор, chrome-devtools, эмуляция 375×812, mobile, touch**:
    - При 375 px сайдбар скрыт, показана кнопка «Меню» (`aria-haspopup="dialog"`) — подтверждено.
    - «Меню» открывает модальный диалог «История бесед»: ширина 288 px, `left: 0`; основное содержимое исключено из дерева доступности — подтверждено.
    - Ловушка фокуса: Shift+Tab из диалога → последняя ссылка, Tab → «Новый чат» (цикл) — подтверждено.
    - Esc закрывает, фокус возвращается на «Меню» — подтверждено.
    - Нажатие на подложку закрывает, фокус возвращается на «Меню» — подтверждено.
    - **НЕ ВЫПОЛНЕНО: закрытие свайпом влево.** Синтетические pointer-события и drag-инструмент DevTools не воспринимаются как свайп (недоверенный ввод / нативное перетаскивание ссылки). Пользователь решил проверить позже → перепроверить в **T8.3 L1-3** (`[DevTools — user]`). Решение: `Drawer` оставлен; запасной путь (`Sheet` + pointer-обработчик) не применялся.
    - Находки для T3.1 (внесены в `task-T3.1.md`): (1) AC-10.2 требует начальный фокус на «Новый чат» при открытии шторки — сейчас фокус попадает на сам элемент диалога (использовать `initialFocus` у `Drawer`); (2) кнопки «×» «Закрыть меню» в шапке шторки (UXRD 761) пока нет.
    - Гейты (quality-fixer, 2026-10-30; dev-сервер :3000 работал, `next build` не запускался — код не менялся с успешной сборки исполнителя): `eslint src` — 0, `tsc --noEmit` — 0; `git diff HEAD` по `ui/button.tsx`, `ui/skeleton.tsx`, `ui/tooltip.tsx` — пусто; `pnpm install --frozen-lockfile --offline --ignore-scripts` принят («Lockfile is up to date»), `pnpm-lock.yaml` не изменился.
- **Мутационные проверки** (заполняются в T2.2, T2.3 и задачах с Proof obligations): T2.2 — 9 мутаций (M1–M9), T2.3 — 6 (M1–M6), каждая краснит названный кейс; таблицы в `task-T2.2.md` и `task-T2.3.md` (Investigation Notes). Модули T1.1 не менялись.
- **Метрики и L1** (T8.3, T8.4; 2026-10-30, оркестратор, Claude-in-Chrome + эмуляция chrome-devtools, dev-сервер, если не указано иное):
  - **L1-1…L1-10 — pass**, fail нет; Evidence и Sign-off — `l1-browser-scenarios.md`. Not executed: закрытие шторки свайпом влево (L1-3; нужно реальное касание, оставлено пользователю, `[DevTools — user]`); живой стрим с упавшим инструментом (L1-10 C; у ассистента на стенде нет инструментов). Наблюдения без записанного результата помечены в чек-листе «not recorded»; после проверки на production открыта одна строка таблицы «Проверка AC» — AC-08.5b (возврат в беседу с блоком ошибки, L1-10 B, шаги 3 и 6, не выполнялся).
  - **Проверка на production после пост-реализационных исправлений** (оркестратор, `next start` :3000, финальная сборка после исправлений security и code-verifier, 268 тестов `apps/web` зелёные): AC-08.1 — колонка 768 px при 1440×900; AC-08.3 — «К последнему сообщению» после прокрутки вверх, клик возвращает ленту вниз; AC-02.4 — «Копировать» блока кода меняет значок на галочку; AC-02.3 — в `SEED-RICH` (12) отправлено «Ответь одним словом: столица Италии?» → «Рим», 14 сообщений, после F5 — 14; AC-09.3 — без сохранённой темы страница следует за темой ОС (тёмная → `html.dark`, светлая — без перезагрузки), сохранённая тема остаётся `null`; AC-10.1 / 10.4 — при 375×812 и 360×740 горизонтального скролла нет, `pre` с `overflow-x: auto` прокручивается сам и заканчивается на x = 336; высота оболочки 740 px (`h-dvh`), viewport `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`.
  - **Пост-реализационная проверка** (оркестратор, 2026-10-30): code-verifier — статус drift, 0 critical, 0 major, 9 minor; документные D001–D004, D007, D009 исправлены в `design-web-shell.md` v1.11; кодовые: D005 — удалён `ui/sheet.tsx`, D006 — подсказки переведены, D008 — `shell-actions.test.tsx` (3 теста, мутационная проверка). security-reviewer — approved_with_notes, 15/15 требований, 4 усиления применены. Итоговый quality-fixer: `apps/web` 268/268 ×3, `apps/api` 149 unit + 34 e2e, покрытие строк 88,37 %.
  - **Заголовки безопасности** (`GET /chat/SEED-RICH`, production): `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
  - **Дефект T8.3, исправлен**: `finalFocus` шторки возвращал фокус на «Меню» после выбора беседы и SB-03 «Новый чат» в шторке (остаточный риск 2 T4.3). Исправление — `apps/web/src/components/shell/app-sidebar.tsx` (ref `actionOwnsFocus`: действие, которое само переносит фокус, пропускает `finalFocus`) + 2 теста в `app-sidebar.test.tsx`; перепроверено в эмуляции. Правка шла параллельно с T8.1; итоговый прогон гейтов T8.1 (259 passed) сделан после неё.
  - **Попутные правки доступности (L1-8)**: у композера `name="message"`; инициалы аватара в кнопке меню пользователя — `aria-hidden`.
  - **Закрыты отложенные пункты Phase 4–5**: возврат фокуса на кнопку меню пользователя проверен на production; поле переименования получает фокус через ~190 мс в dev и сразу на production.
  - **FR-19**: после `seed-l1.ts --pages` — 135 бесед, подгрузка по 20, группы по порядку, без дублей. Запрос страницы, оборванный перезапуском API в режиме watch, показал «Не удалось загрузить ещё беседы» + «Повторить»; повтор подгрузил остаток. После `--pages --remove` `SEED-PAGE-*` — 0 в `GET /api/threads` и в `mastra_threads`.
  - **Производительность и Lighthouse** (production): FOUC нет — скрипт темы в `<body>` перед `<main>`, CLS 0 при CPU ×4; предупреждений о `<script>` и гидратации нет; Lighthouse accessibility 100 (десктоп и мобильный), best practices 100, SEO 100. Метрика № 2 (≤ 1,5 с до последнего из 50 сообщений, 10 прогонов) — **pass**: беседа `SEED-LONG` (50 сообщений, `seed-l1.ts --long`), время от начала навигации до 50 узлов сообщений — 644, 620, 580, 617, 618, 681, 644, 567, 620, 576 мс, медиана 619 мс, максимум 681 мс; все 50 узлов были на месте уже при первой проверке после загрузки, поэтому значения — верхние оценки. LCP `/chat/SEED-RICH` (≤ 2,5 с, 5 прогонов, десктоп, без замедления) — **pass**: 872 мс (трасса производительности, CLS 0,00), затем 548, 532, 568, 528 мс (PerformanceObserver), медиана 548 мс, максимум 872 мс.
  - **Известные замечания, оставлены**: axe `label-content-name-mismatch` (не влияет на счёт) у кнопки меню пользователя — видимый текст «DU dev-user» против `aria-label` «Меню пользователя dev-user» из UXRD; Chrome issue «form field without id or name» — только скрытая измерительная textarea `react-textarea-autosize`; удалённая беседа остаётся в списке другой вкладки до перезагрузки (синхронизации вкладок нет по дизайну); U+FFFD в одном сохранённом ответе — вне `apps/web`, Notes плана 2 `threads-api`.
  - **T8.4 — метрики `threads-api`**: № 10 — точное перемеривание (обе стороны `node dist/main.js`, 15 чередующихся прогонов): медиана TTFT 886,9 мс после против 1094,9 мс до, Δ −208 мс ≤ 50 мс; проверка владения ≈ 0,7 мс (безмодельная проба). № 7 — после исправления заголовков (`threads-api` v1.11) 19/20 (№ 5 без ответа: `Overloaded` провайдера). Первые прогоны (+453 мс; 10/20) эскалированы; подробности — `l1-browser-scenarios.md`, способ замера — «Процедуры владельца».

## Процедуры владельца

- **Сид для L1 (T8.2).** Скрипт `seed-l1.ts` жил в scratchpad сессии и не сохранился — для повторного L1 написать заново по описанию T8.2 (запуск `node <scratchpad>/seed-l1.ts` из-под Node 24, пакеты — через `createRequire` от `apps/api/package.json`). Режимы: без аргументов — `SEED-RICH` (12) и `SEED-TOOL-ERROR` (6); `--pages` — `SEED-PAGE-001…120` (FR-19); `--long` — `SEED-LONG`, 50 сообщений, блок кода TS в каждом 5-м ответе (метрика № 2); с `--remove` — удаление своих бесед (`dev-user`, чужие не трогаются).
- **Замер TTFT (метрика № 10 `threads-api`).** Node-скрипт прямыми HTTP-запросами, не браузер: TTFT — от отправки `POST /api/chat/assistant` до первого SSE-чанка `*-delta`; беседа — `POST /api/threads`, её `id` в `body.id`. Одна модель (`ASSISTANT_MODEL`), один промпт. Обе стороны из собранного `dist` (`node dist/main.js`) на разных портах, база — та же (5433); базовая ревизия собирается в отдельной копии репозитория; 1 разогрев + 15 прогонов на сторону, стороны чередуются; критерий — Δ медиан ≤ 50 мс. Бенчмарк-беседы после замера удалить.
- **Заголовки (метрика № 7).** 20 бесед через API (10 RU, 10 EN), опрос `GET /api/threads/:id` до непустого `title` (≤ 15 с) + строки `ThreadTitleService` в логе API; проверить язык, кавычки, длину, переносы; после — удалить эти 20 бесед.
- **Не выполнено, за владельцем:** закрытие шторки свайпом влево (L1-3) — только реальным касанием; синтетические события DevTools свайпом не считаются.

## Change History

| Date | Changes | Author |
|---|---|---|
| 2026-10-30 | Создание плана по DD v1.5, PRD v1.5, UXRD v1.7: 8 фаз, 29 задач; ранняя точка проверки S-1…S-5 и S-11 первой (гейт G1); бюджет интеграционных тестов 14 → 10 | work-planner |
| 2026-10-30 | Ревизия по ревью и ответам пользователя: T3.4 ставит заголовок приветствия, подпись и placeholder композера; кейсы F5 и AC-02.5 `shell.open-thread` перенесены в T4.2 (прогресс 1/10 после Phase 3); правило выполнения 10; закрыты вопросы о ключе, `ai` (строка `gap`), каталоге тестов и лимите (исключение 10 при лимите 5); T1.4 после гейта G1; запуск сида через `node` с `createRequire`; проверка FR-19 перенесена в T8.3 с сидом страниц T8.2; инвариант Element 1 — ревью в T8.1; T8.4 после T8.3; SB-14 — `gap`; `shadcn add --yes`; T1.3 — порядок обёртки `fetch`, временная кнопка удаления | work-planner |
| 2026-10-30 | T2.1: `deferred()` в `fixtures.ts`, `<Toaster />` в `renderWithRuntime`; T8.2: повторный `saveThread` после `saveMessages` в режиме страниц; схема фаз — S-11 в узле Phase 1; T3.4 зависит от T3.3 (ребро на схеме); снапшот — «все четыре закрыты»; даты убраны из тела | work-planner |
| 2026-10-30 | План утверждён пользователем, статус active | work-planner |
| 2026-10-30 | Итоги T8.2–T8.4: отмечены задачи, строки «Проверка AC», Quality Assurance; Notes «Метрики и L1» (L1, FR-19, дефект шторки, Lighthouse, метрики № 7 и № 10); в Completion Criteria добавлены пост-реализационная проверка и коммит; статус active | work-planner |
| 2026-10-30 | Проверка оркестратора на production после пост-реализационных исправлений: отмечены AC-02.1/02.3/02.4, AC-08.1/08.3/08.4, AC-09.1…09.4, AC-10.1…10.4; метрика № 2 и LCP — pass; заголовки безопасности в Notes; открыты AC-08.5b и свайп S-11; статус active | work-planner |
| 2026-10-30 | Пост-реализационная проверка выполнена (code-verifier, security-reviewer, quality-fixer) — критерий отмечен, итоги в Notes; открыты AC-08.5b, свайп S-11, коммит и ревью пользователя; статус active | work-planner |
| 2026-11-11 | Final Cleanup: процедуры владельца из Notes задач перенесены в раздел «Процедуры владельца»; статус completed | work-planner |
