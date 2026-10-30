# Task T4.3: Новый чат, фокус-политика, приветствие и подсказки, композер, `DocumentTitle`; интеграционный `shell.new-chat`

Metadata:
- Task type: frontend (apps/web)
- Phase: 4
- Dependencies: task-T4.2 → Deliverable: `thread-history-item.tsx`, `thread-activity-tracker.tsx`, список в сайдбаре
- Provides: `focus.ts`, `welcome-suggestions.ts`, `ShellWelcome`, `DocumentTitle`, `newChat` — для T5.1–T5.3, T7.2, T7.3
- Size: Medium (12 файлов, часть — точечные правки)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; Postgres 5433 для dev/L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны (**правило 10** — для `shell.new-chat`).

## Implementation Content
«Новый чат» (`newChat(source)`), фокус-политика (`lib/focus.ts`), приветствие и подсказки 2×2, композер (вложения скрыты, отступ safe-area), заголовок вкладки `DocumentTitle`. Наполняет `shell.new-chat` (2 теста). AC-03.1, AC-03.2, AC-03.3, AC-04.1, AC-08.2; S-7, S-9; UX-04.

## Target Files
- [x] `apps/web/src/lib/focus.ts` (new)
- [x] `apps/web/src/lib/focus.test.ts` (new)
- [x] `apps/web/src/lib/welcome-suggestions.ts` (new)
- [x] `apps/web/src/components/shell/shell-welcome.tsx` (new)
- [x] `apps/web/src/components/shell/document-title.tsx` (new)
- [x] `apps/web/src/components/shell/thread-welcome.test.tsx` (new)
- [x] `apps/web/src/components/shell/shell-actions.tsx` (`newChat`)
- [x] `apps/web/src/components/shell/chat-runtime-provider.tsx` (`Suggestions(WELCOME_SUGGESTIONS)` через `auiConfig`)
- [x] `apps/web/src/components/shell/main-view.tsx` (`Welcome: ShellWelcome`)
- [x] `apps/web/src/components/shell/thread-history-item.tsx` (фокус по клику)
- [x] `apps/web/src/components/assistant-ui/elements/thread.aui.tsx` (прочие тексты приветствия кроме заголовка из T3.4, подсказки 2×2 без «>», кнопка вложений удалена, `AttachmentDropzone` → `div`, `addAttachmentOnPaste={false}`, `data-shell-focus="composer"`, `pb-[max(1rem,env(safe-area-inset-bottom))]`, композер внизу на < 768 px)
- [x] `apps/web/src/components/shell/shell.new-chat.int.test.tsx`
- [x] `apps/web/src/components/shell/thread-activity-tracker.test.tsx` (new; добавлен решением оркестратора, 2026-10-30)

## Investigation Targets
- DD «Доступность — реализация» (`lib/focus.ts`, таблица событий), «Маршрутизация, `DocumentTitle`», UXRD 6.3, 6.15, 6.16, UX-04, 8.2
- `apps/web/src/components/shell/shell.new-chat.int.test.tsx` (перенесён и слит в T2.1 — 2 теста)
- `apps/web/src/components/shell/{shell-actions,chat-runtime-provider,main-view,thread-history-item}.tsx`, `thread.aui.tsx`
- `@assistant-ui/react` — `AuiConfig({ suggestions })`, `ThreadPrimitive.Suggestions` (S-9)
- `apps/web/src/lib/threads/shell-services.ts` (`auiConfig`)

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Маршрутизация, `DocumentTitle`) | derived-display | ««{Название} — Agent OS» / «Новый чат — Agent OS» / «Новая беседа — Agent OS» / «Беседа не найдена — Agent OS»; `metadata.title` корня — «Agent OS»» | Y, если `DocumentTitle` формирует `document.title` по этим форматам |
| design-web-shell.md (§ Доступность — реализация, `lib/focus.ts`) | derived-display | «`focusAfterNewChat = (): void => focusShellTarget(isFinePointer() ? 'composer' : 'page-title')`»; «'composer' → [data-shell-focus="composer"] (ComposerPrimitive.Input), 'page-title' → [data-shell-focus="page-title"] (h1, tabIndex -1)» | Y, если `lib/focus.ts` реализует именно это |
| design-web-shell.md (§ State Transitions and Invariants) | state-lifecycle-negative | «Беседа создаётся на сервере только при первой отправке (initialize); «Новый чат» сетевых запросов не делает»; «В тело чата не уходит клиентский id: body.id = remoteId из POST /api/threads»; «Элемент списка не перемещается при переименовании и приходе автозаголовка до перезагрузки списка» | Y, если `newChat` не вызывает сеть, а `body.id` = id из `POST /api/threads` |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| `newChat(source)` | `pathname === '/'` → только фокус; иначе `router.push('/')` и фокус | План T4.3 |
| Холодная загрузка `/` | фокус только при точном указателе | План T4.3 |
| `DocumentTitle` | форматы UX-04 (Reference Contracts), эффект `document.title`; `metadata.title` корня — «Agent OS» | План T4.3 |
| Тест подсказок | `useLocalRuntime` + фейковый адаптер модели (S-9) | План T4.3 |
| I-тесты | 2 теста: AC-03.2 (на `/chat/a` «Новый чат» → `/` → ссылка b → ноль `POST /api/threads`, список не изменился); AC-04.1 + AC-03.3 (на `/` Enter → `POST /api/threads` (201 `{id:'t-1'}`) раньше `POST /api/chat/assistant` с `body.id='t-1'`, `replaceState` на `/chat/t-1`, первая ссылка «Сегодня» — «Новая беседа» с `aria-current="page"` выше беседы с `updatedAt` сегодня 09:00) | План T4.3, раздел бюджета |
| S-7 не подтвердился | `<title>` React 19 в `DocumentTitle` | Таблица S-1…S-11 |
| S-9 не подтвердился | `useAui({ suggestions })` + `AuiProvider` | Таблица S-1…S-11 |

## Investigation Notes
(Правило 10: сверка Assert обоих I-тестов с поставкой T4.3 и ранее; уточнить «Новая беседа» в сайдбаре — T4.2 + T4.3.)

**Правило 10 (сверка Assert, 2026-10-30).** Оба кейса `shell.new-chat` заполнены строго по скелету; все Assert опираются на поставку T1.2–T4.3: порядок `POST /api/threads` → `POST /api/chat/assistant`, `body.id`, `replaceState` — рантайм и `url-sync` (T1.2, T2.3); «Новая беседа», `aria-current="page"`, группа «Сегодня» — T4.1/T4.2; «Чем могу помочь?» и ноль `POST /api/threads` при «Новом чате» — T3.4 + `newChat` (T4.3). До реализации T4.3 оба теста падали только на добавленных утверждениях заголовка вкладки (UX-04, `document.title` пуст) — остальная проводка уже поставлена T1.2–T4.2. В каждый тест добавлено одно утверждение `document.title` (Reference Contract UX-04), комментарий Behavior дополнен.

**S-9 подтвердился.** `AssistantRuntimeProvider config={AuiConfig({ suggestions: Suggestions(WELCOME_SUGGESTIONS) })}` наполняет `ThreadPrimitive.Suggestions` (корневая область `s.suggestions`); запасной путь не нужен. В `chat-runtime-provider.tsx` конфиг собирается `useMemo` из `services.auiConfig` + `suggestions` (сам `shell-services.ts` вне Target Files не менялся).

**S-7.** Основной путь — эффект `document.title` в `DocumentTitle` (смонтирован в `ChatRuntimeProvider` внутри `ShellActionsProvider`, без разметки); `metadata.title` корня уже «Agent OS». Перезапись метаданными Next при мягких переходах проверяется только в браузере (L1-5, оркестратор); при провале — запасной путь `<title>` React 19.

**Фокус-политика.** `lib/focus.ts` — по DD; `focusShellTarget` ждёт кадр и, если цели ещё нет (переход на `/` с TH-06/TH-07, где композера нет), повторяет до 30 кадров, затем `console.warn`. `newChat`: на `/` — сразу `focusAfterNewChat()`; иначе флаг + `router.push('/')`, фокус — эффектом, когда `pathname` стал `/` (флаг сбрасывается при любом другом переходе). Холодная загрузка `/` — `focusShellTarget('composer')` только при точном указателе (эффект монтирования `ShellActionsProvider`). Ссылка SB-06: шторка (`isMobile`) → `setOpenMobile(false)` + `page-title`; `detail === 0` (Enter) — фокус не трогается; иначе по указателю. Ручная проверка (временные утверждения, удалены): после «Новый чат» с `/chat/a` и после клика по ссылке «Беседа B» фокус в композере при точном указателе.

**Расширение Target Files (решение оркестратора, 2026-10-30).** Мутация «отключённый `ThreadActivityTracker`» не краснила AC-03.3 (новая беседа первая и без трекера — см. Notes). Решение: закрыть остаток сфокусированным тестом, не L1. Добавлен `thread-activity-tracker.test.tsx` (настоящий рантайм через `renderWithRuntime`): существующая беседа из «Предыдущие 7 дней» (`updatedAt` 3 дня назад), ответ удерживается `deferred` (беседа выполняется) → беседа первая в «Сегодня» выше беседы с `updatedAt` сегодня 09:00, группа «Предыдущие 7 дней» исчезла; после ответа подъём сохраняется. `ShellStatus.activityAt[id]` проверяется через наблюдаемое: попасть в «Сегодня» выше беседы 09:00 можно только при `activityAt` из интервала (09:00, 12:00] = «сейчас» замороженных часов; стор наружу из `renderWithRuntime` не отдаётся, а внутренности не мокаются. Мутации: вызов `bumpActivity` удалён → красный (`expected ['Свежая беседа'] to deeply equal ['Старая беседа', 'Свежая беседа']`); монтирование трекера удалено из `chat-shell.tsx` → красный; оба файла восстановлены байт в байт (`cmp`).

**`DocumentTitle` для TH-07 = «Agent OS»** — решение исполнителя: UX-04 этот случай не описывает (DD будет выровнен позже).

**Приветствие.** `ShellWelcome` (TH-02: заголовок + подзаголовок, проявление 8 px/300 мс, подзаголовок +80 мс); подсказки TH-03 остаются под композером (`ThreadSuggestions` в `thread.aui.tsx`): `role="group" aria-label="Подсказки"`, 1 колонка < 640 px, 2×2 от 640 px, карточки с рамкой, `rounded-xl`, `min-h-14`, каскад 40 мс, без «>». Каркасный `ThreadWelcome` получил тот же подзаголовок (прочие тексты приветствия).

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [x] Прочитать Investigation Targets; сверить Assert (правило 10)
- [x] U `focus.test.ts` — точный указатель → `composer`, грубый → `page-title` (таблица)
- [x] C `thread-welcome.test.tsx` — «Чем могу помочь?», 4 подсказки, клик отправляет склеенный текст (S-9)
- [x] I `shell.new-chat.int.test.tsx` — 2 теста (см. Decisions)
- [x] Запустить, увидеть падение

### 2. Green Phase
- [x] `focus.ts`, `welcome-suggestions.ts`, `shell-welcome.tsx`, `document-title.tsx`; правки `shell-actions.tsx`, `chat-runtime-provider.tsx`, `main-view.tsx`, `thread-history-item.tsx`, `thread.aui.tsx`; тесты зелёные

### 3. Refactor Phase
- [x] Упростить; интеграционные 6/10

## Quality Assurance Mechanisms
- Vitest + RTL + MSW, ESLint, `tsc`, `next build` — Type: `executable_check`
- Политика фокуса (`lib/focus.ts`, таблица событий DD) — Type: `passive_constraint`
- WCAG 2.1 AA; reduced motion — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: U, C, I + гейты. Браузер (оркестратор, по необходимости): новый чат на 1440 px — колонка 768 px; подсказка № 1 → Network `POST /api/threads` → `POST /api/chat/assistant` (`id` совпадает), `/chat/<id>`, «Новая беседа» первой в «Сегодня» с мерцанием; заголовок ≤ 15 с (L1-1, T8.3); A → B → C кликами, F5, Назад ×2, Вперёд; заголовок вкладки не перезаписан (S-7, L1-5).
- **Success criteria**: U, C, I зелёные; интеграционные 6/10.
- **Failure response**: S-7/S-9 — запасные пути из Decisions; кейс с элементом поздней задачи — эскалация.
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-03.2 — «Новый чат» не создаёт беседу на сервере
- **Claim**: на `/chat/a` «Новый чат» → `/` → ссылка b → ноль `POST /api/threads`; список не изменился.
- **Primary failure mode**: `initialize` вызывается при «Новом чате».
- **Boundary to exercise**: интеграционный.
- **State assertion**: запросы `POST /api/threads` = 0; список до = после.
- **Mock boundary rationale**: сеть — MSW; `next/navigation` — мок.
- **Proven by**: `new: shell.new-chat.int.test.tsx — AC-03.2`.
- **Residual**: нет.

### Obligation: AC-04.1 + AC-03.3 — порядок запросов, `body.id`, `replaceState`, поднятие беседы
- **Claim**: `POST /api/threads` раньше `POST /api/chat/assistant` с `body.id='t-1'`; `replaceState` на `/chat/t-1`; «Новая беседа» первой в «Сегодня», активна, выше беседы с `updatedAt` сегодня 09:00.
- **Primary failure mode**: порядок запросов/`body.id`/`replaceState` нарушены; `ThreadActivityTracker` отключён (беседа не поднимается).
- **Boundary to exercise**: интеграционный (рантайм + группировка + MSW).
- **State assertion**: `/` → отправка → `/chat/t-1`, первая ссылка «Сегодня» — «Новая беседа» `aria-current="page"`.
- **Mock boundary rationale**: сеть — MSW (SSE v7 из `sseFromChunks`).
- **Proven by**: `new: shell.new-chat.int.test.tsx — AC-04.1 + AC-03.3` (правило сортировки — unit T4.1; здесь только проводка).
- **Residual**: фоновый стрим — S-1/L1-6 (без автотеста).

### Obligation: Failure Mode: same-value / no-op — фокус и «Новый чат» на `/`
- **Claim**: на `/` «Новый чат» — только фокус; грубый указатель → `page-title`.
- **Primary failure mode**: фокус на неверной цели.
- **Boundary to exercise**: in-process unit; компонентный.
- **State assertion**: `document.activeElement`.
- **Mock boundary rationale**: `matchMedia` pointer — полифил.
- **Proven by**: `new: focus.test.ts` (таблица); `new: thread-welcome.test.tsx` (S-9).
- **Residual**: фокус в ленте/диалогах — T5.x, T7.3.

## Completion Criteria
- [x] U, C, I зелёные; интеграционные 6/10
- [x] lint, tsc, build — 0 ошибок
- [x] Мутации (`initialize` при «Новом чате» краснит AC-03.2; отключённый `ThreadActivityTracker` краснит AC-03.3) записаны в Notes — вторая мутация НЕ краснит, см. Notes
- [x] Reference Contracts — `Y`; Resolved decisions применены

## Notes
- Impact scope: `thread.aui.tsx` далее правят T7.2, T7.3, T7.5; `main-view.tsx` — T7.3; `shell-actions.tsx`/`chat-runtime-provider.tsx` — не меняются после.
- Scope boundary: вне Target Files не менять; вложения скрыты, не удалять компоненты каркаса сверх перечисленного.
- Мутации (2026-10-30): (1) `void services.listAdapter.initialize('local')` в `newChat` → AC-03.2 красный (`expected 1 to be +0`). (2) Удалён `<ThreadActivityTracker />` из `chat-shell.tsx` → AC-04.1 + AC-03.3 **остаётся зелёным**: у беседы, созданной в этой вкладке, нет `lastMessageAt`, и `entryActivityAt` (T4.1) считает такую беседу активной «сейчас» — она первая в «Сегодня» и без трекера. Трекер нужен для подъёма уже существующей беседы при ответе (D-11). Скелет (правило 10) не менялся; остаток закрыт `thread-activity-tracker.test.tsx` (решение оркестратора; мутации краснят — см. Investigation Notes).
- Reference Contracts (итог): UX-04 — `Y` (`DocumentTitle`: `/` → «Новый чат — Agent OS», TH-06 → «Беседа не найдена — Agent OS», беседа → «{Название} — Agent OS» / «Новая беседа — Agent OS»; TH-07 → «Agent OS»; пока URL-беседа разрешается — прежний заголовок); `lib/focus.ts` — `Y` (сигнатуры и селекторы DD); state-lifecycle-negative — `Y` (`newChat` без сети, AC-03.2 зелёный; `body.id = 't-1'` из `POST /api/threads`).
- Остаток для шторки: при выборе беседы в шторке `focusShellTarget('page-title')` может быть перебит `finalFocus` шторки (`focusMenuButton` в `app-sidebar.tsx`, вне Target Files) — проверить в L1-3; при перебивании `finalFocus` должен выбирать `h1`, когда шторка закрыта выбором беседы или «Новым чатом».
- Гейты (2026-10-30): eslint и `tsc --noEmit` — 0; `vitest run` — 140 passed, 4 todo (22 файла + 4 со всеми todo); `next build` — успешно.
