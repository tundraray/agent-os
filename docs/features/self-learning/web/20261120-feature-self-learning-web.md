---
feature: self-learning
part: web
design: design-web.md
plan: 1 of 1
status: draft
temporary: true
---

# Work Plan: Самообучение workflow — web

Created Date: 2026-11-20
Type: feature

## Snapshot

**Overview.** План строит в `apps/web` видимую сторону самообучения. В редакторе workflow появляется флажок «Самообучение» со ссылкой «Что узнал workflow», и он сохраняется общей кнопкой «Сохранить». Новый экран знаний по адресам `/library/<id>/knowledge` и `/admin/library/<id>/knowledge` показывает записи графа вкладками по видам, строки состояния над списком и удаляет записи по одной с подтверждением. Карточка задания перед запуском говорит, что workflow учится. Вкладка «Системные» в панели получает форму места для знаний и выключателя уроков. Подход гибридный: сначала основа без экранов — клиент API, чистые функции `knowledge-view`, адреса оболочки; затем экран знаний и удаление; затем флажок, строка в карточке и настройки; затем четыре интеграционных теста скелета и один quality gate. Основа идёт первой, потому что её берут все экраны; экраны идут срезами, потому что каждый срез доказывает свой тест.

- **Не меняется**: контракт `core` и всё в `apps/api` и `packages/*`; общие компоненты — `DataTable`, `PageHeader`, `ConfirmDialog`, `AdminForm`, `StateBadge`, `ui/tabs` — не получают новых свойств; беседа и карточка хода.
- **Главный риск**: флажок молча не сохраняется, потому что редактор считает «изменено» по явному списку полей. Строку `selfLearning` в `workflowChanges` ставит Task 3.1, доказывают строка unit-таблицы и INT-1 (Task 4.2).
- **Открытые вопросы**: сборку ничто не блокирует. Расхождения дизайна с кодом и решения плана — в Notes, пункты 3–14.
- **Design items no task covers**: таблица «L1-сценарии в браузере» дизайна, UC-5 (на настоящем API) и UC-6 / AC-13.1 / DC-4 (строка в карточке) — ручная проверка владельца (Owner Checklist): браузерной автоматики в этой среде нет.

## Implementation Phases

Каждая задача: реализация, тесты, которые она пишет (без запуска), и одна проверка — `pnpm --filter web typecheck` — плюс чтение по пунктам задачи. Если задача идёт параллельно с другой, её проверка — «нет ошибок типов в файлах задачи», а пакет целиком проверяет следующая задача после группы. `packages/contracts` эта часть не меняет: `dist` уже содержит `knowledge.js` и `selfLearning` (собран частью `core`); если `tsc` не видит имени из `@agent-os/contracts`, перед проверкой один раз выполняется `pnpm turbo build --filter=web^...`.

Коммитов нет; git worktree, stash и reset не используются; изменения копятся в общем рабочем дереве, где одновременно идёт постройка `core`. Проверок в конце фаз нет: Operational Verification Procedures всех фаз выполняются в Final Phase после единственного quality gate.

**Запрет на всю часть**: ни одна задача не запускает тесты, сервер `api`, e2e- и verify-наборы бэкенда и `pnpm db:*` — они пишут в базу разработчика, а часть `core` ещё строится. Тесты веба — Vitest, RTL и MSW без базы; их запускает только gate (Task Q.1).

**Что можно делать параллельно** (наборы файлов не пересекаются):

| Группа | Задачи | Условие начала |
|---|---|---|
| A | Task 1.1, Task 1.2, Task 1.3 | сразу |
| B | Task 2.1, Task 2.3, Task 3.1, Task 3.2 | после группы A (Task 3.2 зависимостей не имеет и может идти и с группой A) |
| C | Task 2.2, Task 3.3 | после Task 2.1 |
| — | Task 4.1, затем Task 4.2 | один файл теста; по одной |

### Phase 1: Основа — клиент API, чистые функции, адреса
**Purpose**: Дать экранам одно место для каждого запроса, каждого текста и подписи экрана знаний и каждого адреса.

#### Tasks

- [ ] **Task 1.1: Клиент API графа и настроек, `isKnowledgeHidden`** — covers DD Contract Definitions «Клиент API» (все четыре пункта), Building-block `libraryApi`, `adminApi`, `isKnowledgeHidden`; KD-1 (одно чтение графа для библиотеки и панели), KD-5 (`DELETE` по типу записи); Security Considerations (ответы разбирают схемы `contracts`); ADR-0012
  - Pattern: [web-api-client.md](../../../code-system/patterns/web-api-client.md).
  - `lib/library/library-api.ts`: `libraryApi.knowledge(id)` — `GET /api/library/:id/knowledge`, `schema: KnowledgeViewSchema`; `deleteKnowledgeEntity(id, entityId)` — `DELETE …/knowledge/entities/:entityId`; `deleteKnowledgeRelation(id, relationId)` — `DELETE …/knowledge/relations/:relationId`; оба без схемы, как `libraryApi.remove` (204 → `void`). Путь строится от `recordRoute(id)`; числовой id — `String(…)`. Сотрудника клиент не передаёт.
  - `lib/admin/admin-api.ts`: `adminApi.knowledge` — `settings()` (`GET /api/admin/knowledge/settings`, `KnowledgeSettingsSchema`) и `saveSettings(body: UpdateKnowledgeSettingsBody)` (`PUT`, ответ `KnowledgeSettingsSchema`), через `apiPath('knowledge', 'settings')`, по образцу `adminApi.library.settings` / `saveSettings`.
  - `lib/library/library-errors.ts`: `isKnowledgeHidden(error)` — истина для `isNotFound` (из `lib/admin/admin-errors.ts`, как его берёт `record-page.tsx`) и для `ApiRequestError` вида `http` со статусом 403 и кодом `LibraryErrorCode.KNOWLEDGE_FORBIDDEN`; иначе ложь.
  - Target Files: `apps/web/src/lib/library/library-api.ts`, `apps/web/src/lib/admin/admin-api.ts`, `apps/web/src/lib/library/library-errors.ts`, `apps/web/src/lib/library/library-errors.test.ts`.
  - Не трогает: `lib/admin/admin-errors.ts` (только импорт `isNotFound`); `packages/contracts`.
  - Dependencies: нет.
  - Тест: строки таблицы `library-errors.test.ts` (`isKnowledgeHidden`, хелпер `refusal(status, code)` файла): 404 → да; 403 `KNOWLEDGE_FORBIDDEN` → да; 403 другого кода (`ADMIN_REQUIRED`) → нет; 500 → нет. Ловит: «Не найдено» на любой 403 или ошибка вместо «Не найдено» на 403 графа (DC-2, правило).
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: маршруты совпадают с `apps/api/src/knowledge/knowledge.controller.ts` (`library/:id/knowledge`, `entities/:entityId`, `relations/:relationId`) и `admin-knowledge-settings.controller.ts` (`admin/knowledge/settings`).

- [ ] **Task 1.2: Чистые функции экрана знаний (`knowledge-view`); `formatDay` и `formatDayTime`** — covers DD KD-4 (имя меню, обрезка 60 знаков), KD-5 (число уходящих связей), Building-block `lib/library/knowledge-view.ts`, `formatDay`, `formatDayTime`, `library-row.tsx`; «Как экран выбирает, что показать» (все строки таблицы кроме чтений, абзацы о пометке, числах, строке отбора, строке 5, ячейке «Запись»); C3 «экран знаний» (`knowledge-view` — единственное место подписей); Terms «Строки состояния», «Отбор по смыслу»; UXRD KN-01 («Состояние», «Список», ячейка «Запись»), KD-4 и KD-7 UXRD, MC-3, MC-4, MC-5, MC-6 (тексты диалога и уведомлений), MC-7 / MC-1 (текст «Что узнал workflow»); AC-02.2, AC-03.2, AC-03.4, AC-04.3, AC-06.1, AC-06.2, AC-08.2, AC-11.1, AC-11.5, AC-11.6, AC-15.3, AC-17.1, AC-18.3, AC-18.4 (правило)
  - Pattern: [pure-decision.md](../../../code-system/patterns/pure-decision.md).
  - `lib/library/knowledge-view.ts` (new), функции без React и без чтений:
    - Строки состояния по `KnowledgeView` и признаку «workflow сотрудника в панели» (у записи есть `author` и экран — панель): строки 1–5 MC-3 по таблице дизайна. Числа — поля `counts` как есть ({M} `active`, {N} `always`, {K} `beyond`, {O} `outdated`, {P} `percent`, в том числе больше 100), {X} — `selection.pending`; по записям функции чисел строк не считают. Строка 1 — вариант «все» при `beyond` 0; строка 2 — при `beyond` > 0: «только по теме» при `selection` `on` или `preparing`, «не помещаются» при `off`. При выключенном самообучении вместо строк 1–2 — строка 4 о выключенном самообучении (у workflow сотрудника в панели — с «… Включить его может автор.»), строки об отборе нет. Строки 4 об отборе (`off` с причиной `model_not_selected` или `provider_failed` с моделью; `preparing` с {X}) и об уроках (`lessonsEnabled` выключен) — только при включённом самообучении. Строка 5 — при `lastExtraction` не `null` и при любом флажке: `done` — ненулевые `added`, `confirmed`, `outdated` или «нового не нашлось»; `skipped` / `failed` — причина MC-3 по `reason` (девять причин). Модель — `formatModel(model)` без `names`; дата строки 5 — `formatDayTime(at)`. Каждая строка несёт признак иконки (`Info` у строк 2 и 4, `CircleMinus` у причины строки 5) — рисует её компонент. Слова при числах — `pluralRu`.
    - Вкладки: «Все» (все записи, с устаревшими), «Факты» (`kind` `fact`: сущности и связи-факты), «Уроки», «Искал — не нашёл»; пятая — записи с `placement` `by_topic` или `does_not_fit`, только если такие есть; её имя — «Не помещаются» при `selection.state` `off`, иначе «Только по теме». У каждой вкладки — подпись «{имя} · {число}» (число — сколько записей она показывает) и текст «Нет совпадений» MC-5 («Фактов нет», «Уроков нет», «Записей «искал — не нашёл» нет»). Вкладка отбирает записи, порядок не меняет.
    - Запись: ключ строки `${type}:${id}` (id уникален только внутри `type`); вид — «факт», «рабочий урок», «искал — не нашёл»; пометка по `state` (`outdated` — «устарела», `lessons_off` — «уроки выключены»), у `active` по `placement` (`by_topic` — «только по теме» состоянием `neutral`, `does_not_fit` — «не помещается» состоянием `off`; `always` и `null` — без пометки); первая и вторая строка ячейки «Запись» по виду (сущность — имя и описание; связь-факт — «{from.name} → {label} → {to.name}»; урок — `server.tool` и вопрос, второй строкой подсказка и исход; «искал — не нашёл» — `server.tool` и вопрос, второй строкой «пусто»); текст записи для диалога и имя меню — тот же текст, обрезанный после 60 знаков с «…».
    - Удаление: число связей-фактов среди загруженных записей, у которых `from.id` или `to.id` — эта сущность; заголовок и текст диалога MC-6 (сущность со связями, без связей, другие записи); уведомление «Удалено» / «Удалено вместе со связями: {N}».
    - `KNOWLEDGE_TEXT`: общие тексты экрана — «Что узнал workflow» (MC-1, MC-7), `h1` «Что узнал «{имя}»», «Открыть workflow» (MC-2), пустые состояния, «Не удалось загрузить знания», «Загружаем знания…» (MC-5).
  - `lib/agents/format.ts`: `formatDay(at)` — «19 нояб.» в часовом поясе зрителя (нынешний частный форматтер дня файла становится экспортом); `formatDayTime(at)` — «19 нояб., 14:32» всегда, и сегодня тоже (`formatTime` за сегодня даёт только время).
  - `components/library/library-row.tsx`: своя копия `closedOn` удаляется, `banText` берёт `formatDay`.
  - В тексты экрана не входят слова «граф», «вектор», «эмбеддинг», «токены», «промпт», «извлечение» (UXRD KD-4); выключенный отбор называется «отбор по смыслу».
  - Target Files: `apps/web/src/lib/library/knowledge-view.ts` (new), `apps/web/src/lib/library/knowledge-view.test.ts` (new), `apps/web/src/lib/agents/format.ts`, `apps/web/src/components/library/library-row.tsx`.
  - Dependencies: нет.
  - Тест: `knowledge-view.test.ts` (new), одна таблица (дизайн UC-5): строки 1–5 с числами из `counts` (числа `counts` нарочно не совпадают с числом записей); строка отбора — `off` `model_not_selected`, `off` `provider_failed` с моделью, `preparing` с `pending`; пометки «только по теме», «не помещается», «устарела», «уроки выключены»; пятая вкладка «Только по теме» и «Не помещаются» с числом; при выключенном самообучении нет ни строки отбора, ни пятой вкладки, ни пометок по `placement`; ячейка «Запись» по каждому виду; по одной причине строки 5 на `skipped` и `failed`. Число связей сущности доказывает INT-3 (диалог и уведомление), отдельной строки нет. Ловит: числа строк, посчитанные по записям; не та пометка или вкладка при выключенном отборе; не те слова причины.
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: ни одно число строк состояния не считается по `items`; вкладка не сортирует.

- [ ] **Task 1.3: Вид страницы `knowledge` в адресах оболочки** — covers DD KD-2 (вид страницы, новая ветка разбора раньше одного сегмента), Contract Definitions «Адреса» (`LibraryPage`, `AdminPage`, `knowledgePath`, `adminKnowledgePath`), Building-block `parseShellRoute`, `LibraryPage`, `AdminPage`, `knowledgePath`, `adminKnowledgePath`; Fact Disposition W4, W5
  - Pattern: [shell-route.md](../../../code-system/patterns/shell-route.md).
  - `lib/shell-route.ts`: `LibraryPage` + `{ kind: 'knowledge'; id: string }`; `AdminPage` + `{ kind: 'knowledge'; key: string }`. `parseLibraryPage` разбирает `/library/<id>/knowledge` раньше `singleSegment`; разбор панели (`libraryAdminPage`) — `/admin/library/<id>/knowledge` только в разделе `library`, раньше разбора одного сегмента и после вкладок и `new`. `knowledgePath(id)` — `/library/<id>/knowledge`, `adminKnowledgePath(id)` — `/admin/library/<id>/knowledge`; номер кодируется так же, как в `recordPath` и `adminRecordPath`.
  - Совпадений по видам страницы в коде нет в виде исчерпывающего `switch` — только цепочки `if` (`main-view.tsx`, `library-section.tsx`): новый вид без ветки молча падает в список, и `tsc` этого не покажет. Ветки ставит Task 2.1.
  - Target Files: `apps/web/src/lib/shell-route.ts`, `apps/web/src/lib/shell-route.test.ts`.
  - Dependencies: нет.
  - Тест: строки таблиц `shell-route.test.ts`: `/library/abc/knowledge` → библиотека, `{ kind: 'knowledge', id: 'abc' }`; `/admin/library/abc/knowledge` → раздел `library`, `{ kind: 'knowledge', key: 'abc' }`. Ловит: экран знаний закрыт старым разбором (список библиотеки, «Сотрудники»).
  - Проверка: `pnpm --filter web typecheck`.

#### Operational Verification Procedures

Выполняются в Final Phase (Task Q.3).

1. `grep -rn "/knowledge" apps/web/src --include=*.ts --include=*.tsx --exclude-dir=test --exclude='*.test.*'` — строковые литералы с `/knowledge` только в `lib/library/library-api.ts`, `lib/admin/admin-api.ts` и `lib/shell-route.ts`; совпадения в комментариях не в счёт: адреса и маршруты строятся в одном месте.
2. `grep -rn "closedOn\|Intl.DateTimeFormat" apps/web/src/components/library/library-row.tsx` — пусто.

### Phase 2: Экран знаний
**Purpose**: Автор и администратор открывают экран знаний, видят строки состояния, вкладки и список и удаляют записи; прямая ссылка без доступа ведёт на «Не найдено».

#### Tasks

- [ ] **Task 2.1: `KnowledgePage` и `KnowledgeList` без удаления; ветки в оболочке и панели** — covers DD KD-1, KD-2 (вкладки — состояние, ключ таблицы — вкладка), KD-4, C3 «экран знаний» (все три пункта), «Дерево компонентов», «Данные экранов» (чтения двух экранов знаний), «Как экран выбирает, что показать» (строки чтений, ошибок, пустого графа, пустой вкладки), «Отличия от UXRD» (строки 1, 2, 4), Flow 2 (Outcome, Failure handling), Contract Definitions `KnowledgePage`, «Адреса» (фокус `AdminScreen`), Building-block `KnowledgePage`, `KnowledgeList`, `MainView`, `LibrarySection`, `AdminScreen`, `DataTable` и соседние reused, «Доступность и ширина» (пункты 1, 2, 3, 5), Логирование (чтения), Security Considerations (текст как текст, «Не найдено» ничего не называет); UXRD KN-01, KN-03, MC-2, MC-3, MC-4, MC-5; AC-11.1, AC-11.3, AC-11.4, AC-11.5, AC-09.1, AC-09.3, AC-06.1, AC-16.1 и видимая сторона AC Task 1.2; DC-2; ADR-0016
  - Pattern: [read-on-open.md](../../../code-system/patterns/read-on-open.md), [shell-route.md](../../../code-system/patterns/shell-route.md); спецификации [data-table.md](../../../design-system/components/data-table.md) (вариант «Строка с действиями»), [state-badge.md](../../../design-system/components/state-badge.md).
  - `components/library/knowledge-page.tsx` (new): `KnowledgePage({ id, variant: 'library' | 'panel' })`. Две `useResource` с меткой `library`, параллельно: запись (`libraryApi.get` в библиотеке, `adminApi.library.get` в панели) и граф (`libraryApi.knowledge` в обоих). По таблице дизайна: `isKnowledgeHidden` ошибки любого из двух чтений → `ThreadNotice` `library-not-found` (библиотека, RV-02) или `record-not-found` с `section="library"` (панель, AD-15) — без имени, строк и «Повторить»; другая ошибка записи → `ThreadNotice` `library-load-error` с `onRetry` (библиотека) или `RecordPlaceholder` (панель, он же загрузка); записи ещё нет → `RecordSkeleton` (библиотека). Есть запись — `PageHeader`: `h1` «Что узнал «{имя}»», родитель — «Библиотека» (`libraryPath()`) или `sectionParent('library')` с `area={PANEL_TITLE}` в панели; справа «Открыть workflow» `outline` `sm` на `ShellLink` — `recordPath(id)` или `adminRecordPath('library', id)`. Фокус на `h1` (`focusShellTarget('page-title')`), когда шапка нарисована. Граф читается → Loading таблицы; ошибка графа → ошибка таблицы «Не удалось загрузить знания» с «Повторить» (`resourceTableState`), строк состояния нет; граф пуст → пустое состояние MC-5 по `selfLearning` (у workflow сотрудника в панели — «Включить его может автор.»), без вкладок и строк состояния. Иначе — строки состояния (Task 1.2; первая UI `--foreground`, остальные Caption `--muted-foreground`, иконки `Info` `--info` и `CircleMinus` `--muted-foreground`) и `KnowledgeList`.
  - `components/library/knowledge-list.tsx` (new): `Tabs` из `ui/tabs` с вкладками Task 1.2 (подпись — «{имя} · {число}»), полоса вкладок прокручивается вбок внутри себя; активная вкладка — локальное состояние, по умолчанию «Все». Под вкладками — `DataTable` с ключом активной вкладки, `caption` — имя вкладки, `actionsAs="menu"`, колонки «Запись», «Вид» (только на «Все»; `StateBadge` `variant="source"`), «Подтверждений» (табличные цифры), «Дата» (`formatDay(date)`); строки в порядке ответа; ключ строки и имя меню — из Task 1.2; пометка — `StateBadge` во второй строке ячейки после текста. Пустая вкладка — «Нет совпадений» с текстом MC-5. Меню строки — один пункт «Удалить»; до Task 2.2 он не подключён (`onSelect` пуст или пункта нет — на выбор исполнителя, Task 2.2 ставит его).
  - Текст записей выводится как текст React: без `dangerouslySetInnerHTML`, без ссылок и разметки. Номера запуска и сотрудника на экране нет (их нет в контракте).
  - `components/shell/main-view.tsx`: ветка `library` `knowledge` → `<KnowledgePage key={id} id={id} variant="library" />` раньше ветки записи.
  - `components/admin/library/library-section.tsx`: `page.kind === 'knowledge'` → `<KnowledgePage key={page.key} id={page.key} variant="panel" />`.
  - `components/admin/admin-screen.tsx`: ключ эффекта фокуса берёт `page.key` и у вида `knowledge` — переход между двумя экранами знаний переводит фокус на `h1`.
  - `components/library/record-page.tsx`: `RecordSkeleton` экспортируется; больше ничего не меняется.
  - Таблица остаётся компактной, как в панели; варианта «Две строки» нет; после ухода последней строки фокус идёт на `h1` (поведение `DataTable`) — «Отличия от UXRD», строки 1, 2, 3. Заголовок вкладки браузера строит `PageHeader` с родителем — строка 4.
  - Target Files: `apps/web/src/components/library/knowledge-page.tsx` (new), `apps/web/src/components/library/knowledge-list.tsx` (new), `apps/web/src/components/shell/main-view.tsx`, `apps/web/src/components/admin/library/library-section.tsx`, `apps/web/src/components/admin/admin-screen.tsx`, `apps/web/src/components/library/record-page.tsx` (только экспорт `RecordSkeleton`).
  - Не трогает: `DataTable`, `PageHeader`, `ThreadNotice`, `StateBadge`, `ui/tabs` — без новых свойств.
  - Dependencies: Task 1.1, Task 1.2, Task 1.3.
  - Тестов своих нет: INT-2 (Task 4.1); подписи и числа — таблица Task 1.2; разбор адреса — строки Task 1.3.
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: «Не найдено» решает только `isKnowledgeHidden`; в библиотечном варианте нет ни одного маршрута `/api/admin/`; числа строк и вкладок не считаются в компоненте.

- [ ] **Task 2.2: Удаление записи с подтверждением (KN-02)** — covers DD KD-5, Flow 3 (Outcome, Failure handling — все три пункта), «Отличия от UXRD» (строка 5: ожидание и отказ в диалоге), «Данные экранов» (`DELETE` двух маршрутов), Логирование (`library: knowledge delete`), «Доступность и ширина» (пункт 4, фокус «Отмена»), Security Considerations (отказ пишется с номерами, без текста); UXRD KN-02, MC-6; AC-11.2, AC-09.2; DC-3
  - `components/library/knowledge-list.tsx`: «Удалить» в меню строки открывает `ConfirmDialog` с заголовком и текстом MC-6 из Task 1.2 (у сущности — число связей по загруженным записям), «Удалить» / «Отмена». `onConfirm` шлёт ровно один `DELETE`: `deleteKnowledgeEntity` у `type` `entity`, `deleteKnowledgeRelation` у `relation`; затем уведомление `toast` «Удалено» или «Удалено вместе со связями: {N}» и перечитывание графа (`reload` ресурса графа из `KnowledgePage`). Строку убирает новый ответ сервера, а не правка на месте. Отказ — `refusalText={deleteFailed}` (`library-errors.ts`, это и есть MC-6 «Не удалось удалить: {причина}»): диалог остаётся открытым, строка на месте, повтор — той же кнопкой. 204 на уже удалённую запись — обычный успех. `focusTitleAfterConfirm` не ставится: фокус после удаления ведёт `DataTable` (следующая строка, предыдущая, иначе `h1`).
  - Лог `library: knowledge delete` через `@/lib/logger` и `describeApiError`: `recordId`, `type`, `id`, итог (`ok`) или статус, код и причина, `durationMs`; текста записи в логе нет.
  - `components/library/knowledge-page.tsx`: передаёт `KnowledgeList` номер workflow и функцию перечитывания графа.
  - Target Files: `apps/web/src/components/library/knowledge-list.tsx`, `apps/web/src/components/library/knowledge-page.tsx`.
  - Dependencies: Task 2.1, Task 1.1.
  - Тестов своих нет: INT-3 (Task 4.1); фокус и «Отмена» по умолчанию — Owner Checklist «Удаление и фокус».
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: на одно подтверждение — один вызов клиента; ни один путь не убирает строку без перечитывания; в лог не попадает ни одно текстовое поле записи.

- [ ] **Task 2.3: Кнопка «Что узнал workflow» в панели (MC-7)** — covers DD Building-block `EditorHeaderActions`, `EmployeeRecordPage`, таблица «Остальные части фичи» (кнопка MC-7), C3 «флажок» (второй пункт: вход только там, где человек уже работает с workflow); UXRD KN-01 «Входы», MC-7; AC-11.3 (входа у коллеги нет)
  - `components/library/editor-header.tsx`: `EditorHeaderActions` в режиме `mode === 'system'` у записи `kind === 'workflow'` — кнопка `outline` `sm` «Что узнал workflow» (`KNOWLEDGE_TEXT`) на `ShellLink` к `adminKnowledgePath(record.id)`. В режиме `employee` кнопки нет: вход автора — ссылка под флажком (Task 3.1). У агентов кнопки нет.
  - `components/admin/library/employee-record-page.tsx`: у записи `kind === 'workflow'` — та же кнопка в `PageHeader` рядом с «Закрыть доступ».
  - Тесты, которые считают кнопки или ссылки шапки этих экранов: перед правкой `grep -rn "Закрыть доступ\|getAllByRole('link')\|getAllByRole('button')" apps/web/src/components/shell/custom-agents-web.int.test.tsx` — ожидание, которое ломает новая кнопка, правится в этой задаче (тогда файл добавляется в Target Files этой задачи).
  - Target Files: `apps/web/src/components/library/editor-header.tsx`, `apps/web/src/components/admin/library/employee-record-page.tsx`.
  - Dependencies: Task 1.2 (`KNOWLEDGE_TEXT`), Task 1.3 (`adminKnowledgePath`).
  - Тестов своих нет: вход — Owner Checklist «Флажок и экран»; отсутствие входа у коллеги — свойство RV-01, который эта часть не меняет.
  - Проверка: `pnpm --filter web typecheck`.

#### Operational Verification Procedures

Выполняются в Final Phase (Task Q.3).

1. `grep -rn "dangerouslySetInnerHTML" apps/web/src/components/library/knowledge-*.tsx` — пусто.
2. `grep -rniE "вектор|эмбеддинг|граф|токен|промпт|извлечени" apps/web/src/lib/library/knowledge-view.ts apps/web/src/components/library/knowledge-*.tsx apps/web/src/components/library/self-learning-field.tsx` — совпадения только в комментариях кода, ни одного в строке текста интерфейса.
3. `grep -rn "logger\." apps/web/src/components/library/knowledge-*.tsx` — вызовы не получают `name`, `description`, `label`, `question`, `hint`, `outcome` записи.

### Phase 3: Флажок, строка в карточке, настройки
**Purpose**: Автор включает самообучение в редакторе и сохраняет его; запускающий видит, что workflow учится; администратор задаёт место и уроки.

#### Tasks

- [ ] **Task 3.1: Блок «Самообучение» в редакторе workflow; поле в правиле «изменено»; строка в `DefinitionView`** — covers DD KD-3, C3 «флажок в редакторе» (оба пункта), Flow 1 (Outcome, Failure handling — подпись поля в блоке конфликта), Contract Definitions `SelfLearningField`, Building-block `WorkflowFields`, `blankWorkflow`, `SelfLearningField`, `workflowChanges`, `RECORD_FIELD_LABELS`, `DefinitionView`; Fact Disposition W1, W2, W3; Risks «Флажок не сохраняется молча»; UXRD SL-01, MC-1, Accessibility «Флажок»; AC-10.1, AC-02.2 (заметка); DC-1
  - Pattern: спецификации [record-editor.md](../../../design-system/components/record-editor.md) (вариант «Workflow»), [definition-view.md](../../../design-system/components/definition-view.md).
  - `components/library/self-learning-field.tsx` (new): `SelfLearningField` — значение, было ли оно включено в сохранённой записи, адрес экрана знаний или `null` у нового workflow, `onChange`. `Checkbox` из `ui/checkbox` «Самообучение»; подсказка MC-1 — `FieldDescription` и `aria-describedby`; заметка MC-1 «Знания сохранятся…» — когда флажок снят у сохранённого включённого, тоже описание флажка; ссылка «Что узнал workflow» (`KNOWLEDGE_TEXT`) — на `ShellLink` после подсказки, только при адресе, при любом положении флажка; уход по ней с несохранёнными правками спрашивает MC-11 через `ShellLink`. Ошибок проверки нет.
  - `components/library/workflow-fields.tsx`: блок между `FinalExecutorField` («Кто пишет ответ») и «Дополнительно»; значение — `values.content.selfLearning`; изменение — `setContent({ selfLearning }, null)`; адрес — у сохранённого (`saved !== null`) `knowledgePath(saved.id)` в режиме `employee`, `adminKnowledgePath(saved.id)` в режиме `system`; «было включено» — `saved?.content.selfLearning`. `blankWorkflow` уже ставит `selfLearning: false` — не меняется.
  - `lib/library/record-rules.ts`: `RECORD_FIELD_LABELS.selfLearning` — «Самообучение»; `workflowChanges` сравнивает `selfLearning` предыдущей и новой версии.
  - `components/library/definition-view.tsx`: у workflow строка «Самообучение» со значением «включено» / «выключено» (подпись — `RECORD_FIELD_LABELS.selfLearning`), с пометкой изменения, как у соседних строк.
  - Тесты, которые читают строки определения workflow (карточка черновика, RV-01, AL-03): перед правкой `grep -rn "Кто пишет ответ\|Координатор" apps/web/src --include=*.test.tsx`; ожидание полного списка строк, которое ломает новая строка, правится в этой задаче (файл добавляется в Target Files).
  - Target Files: `apps/web/src/components/library/self-learning-field.tsx` (new), `apps/web/src/components/library/workflow-fields.tsx`, `apps/web/src/lib/library/record-rules.ts`, `apps/web/src/lib/library/record-rules.test.ts`, `apps/web/src/components/library/definition-view.tsx`.
  - Не трогает: `record-editor.tsx` и отправку сохранения — она уже шлёт содержимое целиком.
  - Dependencies: Task 1.2 (`KNOWLEDGE_TEXT`), Task 1.3 (адреса).
  - Тест: строка таблицы `record-rules.test.ts` — у двух версий workflow, которые отличаются только `selfLearning`, `changedFields` называет поле `selfLearning`, а его подпись — «Самообучение». Ловит: правило «изменено» без нового поля (AC-10.1, правило).
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: флажок меняет содержимое тем же `setContent`, что остальные поля; ссылки нет у нового workflow.

- [ ] **Task 3.2: Строка «Workflow учится» в карточке задания (SL-02)** — covers DD KD-6, Flow 5 (Outcome, Failure handling), Contract Definitions `SelfLearningNote`, Building-block `DecisionCard`, `SelfLearningNote`, «Данные экранов» (карточка задания), Risks «лишнее чтение записи», Fact Disposition W11; UXRD SL-02, MC-9, Accessibility (строка читается перед кнопками); AC-13.1; DC-4
  - Pattern: [read-on-open.md](../../../code-system/patterns/read-on-open.md); спецификация [decision-card.md](../../../design-system/components/decision-card.md), вариант «Бриф».
  - `components/agents/decision-card.tsx`: `SelfLearningNote({ workflowId })` в этом файле — `useResource(() => libraryApi.get(workflowId), …, 'library')`; при `content.selfLearning` у записи `kind === 'workflow'` — строка MC-9 с иконкой `Info` над кнопками; пока ответа нет, при ошибке и при выключенном флажке — ничего (`null`). Монтируется один раз в общей разметке карточки над строкой кнопок, только при `brief !== null && outcome === null`: переход в «Правку» и обратно не перечитывает запись, после решения строки нет и чтения тоже. Кнопок и вопроса у строки нет; `TaskHeading` не меняется.
  - `components/shell/agent-platform-web.int.test.tsx`: тест «AC-24.2 / AC-28.2 / AC-28.3» рисует открытую карточку брифа `start_workflow`, и новое чтение `GET /api/library/:id` без обработчика валит его (`onUnhandledRequest: 'error'`). В его `server.use` добавляется обработчик `GET /api/library/${WORKFLOW_RECORD_ID}` → `recordDetail` workflow с `selfLearning: false`. Перед правкой — `grep -n "start_workflow" apps/web/src/components/shell/agent-platform-web.int.test.tsx`: другая открытая карточка брифа получает такой же обработчик. Утверждения тестов не меняются.
  - Target Files: `apps/web/src/components/agents/decision-card.tsx`, `apps/web/src/components/shell/agent-platform-web.int.test.tsx` (только обработчики MSW).
  - Dependencies: нет.
  - Тестов своих нет: строка MC-9 — ручная проверка (Owner Checklist «Флажок и экран»; дизайн UC-6, L1).
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: решение карточки не ждёт чтения; ошибка чтения не рисует ничего.

- [ ] **Task 3.3: Форма «Самообучение workflow» на вкладке «Системные» (AS-01)** — covers DD KD-7, Flow 4 (Outcome, Failure handling — оба пункта), Contract Definitions `KnowledgeSettingsForm`, `adminApi.knowledge`, Building-block `KnowledgeSettingsForm`, `knowledgeSettingsRules`, «Данные экранов» («Системные»), Логирование (`admin: knowledge settings`), Fact Disposition W10; UXRD AS-01, MC-8, Accessibility (`h2`); AC-12.1; DC-5
  - Pattern: [settings-row.md](../../../code-system/patterns/settings-row.md) по образцу `components/admin/library/library-settings-form.tsx`; спецификация [settings-form.md](../../../design-system/components/settings-form.md), вариант «Форма страницы».
  - `components/admin/library/knowledge-settings-form.tsx` (new): `KnowledgeSettingsForm` без свойств. `section` с `h2` «Самообучение workflow»; `useResource(adminApi.knowledge.settings, 'knowledge:settings')`; загрузка и ошибка — `DataTable` с `resourceTableState` и текстом MC-8 «Не удалось загрузить настройки» с «Повторить», как у `LibrarySettingsForm`. Готово — `AdminForm` `variant="page"`, ключ `data.updatedAt ?? 'defaults'`, начальные значения `{ limitTokens: String(…), lessonsEnabled }`, `validate={knowledgeSettingsRules}`, одна кнопка «Сохранить», уведомление «Настройки самообучения сохранены», `onSaved={settings.reload}`, `logEvent="admin: knowledge settings"`. Поле «Место для знаний в запуске, токенов» — `AdminTextField` `inputMode="numeric"` с подсказкой MC-8; флажок «Давать запускам уроки» — `Checkbox` из `ui/checkbox` с подсказкой MC-8 описанием, значение через `form.set('lessonsEnabled', …)`. Тело `saveSettings` — `{ limitTokens: число, lessonsEnabled }`. Отказ сервера — ошибка формы «Не удалось сохранить: {причина}», введённое остаётся (поведение `AdminForm`).
  - `lib/admin/form-rules.ts`: `knowledgeSettingsRules({ limitTokens })` — не целое или вне `KNOWLEDGE_LIMIT_TOKENS_MIN`…`KNOWLEDGE_LIMIT_TOKENS_MAX` → ошибка поля «Нужно целое число от {мин} до {макс}», числа — из констант `contracts`, разбор числа — как у `librarySettingsRules` (`parseDecimal`). Своих чисел границ нет.
  - `lib/admin/admin-texts.ts`: текст ошибки поля, если соседние правила держат тексты там.
  - `components/admin/library/library-section.tsx`: на вкладке «Системные» `KnowledgeSettingsForm` под `LibrarySettingsForm`.
  - Тестовые данные: `test/fixtures.ts` — `knowledgeSettings(overrides)` (по умолчанию `limitTokens: KNOWLEDGE_LIMIT_TOKENS_DEFAULT`, `lessonsEnabled: true`, `updatedAt: null`, через `KnowledgeSettingsSchema.parse`); `test/msw-server.ts` — обработчик по умолчанию `GET /api/admin/knowledge/settings` → `knowledgeSettings()`: вкладку «Системные» рисует `custom-agents-web.int.test.tsx`, а тесты идут с `onUnhandledRequest: 'error'`.
  - Target Files: `apps/web/src/components/admin/library/knowledge-settings-form.tsx` (new), `apps/web/src/lib/admin/form-rules.ts`, `apps/web/src/lib/admin/form-rules.test.ts`, `apps/web/src/lib/admin/admin-texts.ts`, `apps/web/src/components/admin/library/library-section.tsx`, `apps/web/src/test/fixtures.ts`, `apps/web/src/test/msw-server.ts`.
  - Не трогает: `AdminForm` (флажок — обычный `Checkbox` внутри формы, нового поля формы нет), `LibrarySettingsForm`.
  - Dependencies: Task 1.1, Task 2.1 (`library-section.tsx`).
  - Тест: строки таблицы `form-rules.test.ts` (`knowledgeSettingsRules`): `999`, `32001`, `12000.5`, пусто — ошибка с границами; `1000`, `32000` — нет. Ловит: число вне границ уходит на сервер (DC-5, правило).
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: оба значения уходят одним `PUT`; флажок лежит в значениях формы, а не в своём состоянии.

#### Operational Verification Procedures

Выполняются в Final Phase (Task Q.3).

1. `grep -nE "\b(1000|1_000|32000|32_000|8000|8_000)\b" apps/web/src/components/admin/library/knowledge-settings-form.tsx apps/web/src/lib/admin/form-rules.ts` — пусто: границы места только константами `contracts`.
2. `grep -rln "selfLearning" apps/web/src --include=*.ts --include=*.tsx --exclude-dir=test --exclude='*.test.*'` — только файлы этой части (`workflow-fields.tsx`, `self-learning-field.tsx`, `record-rules.ts`, `definition-view.tsx`, `decision-card.tsx`, `knowledge-*.ts(x)`); ни одного другого экрана, который читает флажок сам.

### Phase 4: Интеграционные тесты
**Purpose**: Заполнить четыре скелета `self-learning-web.int.test.tsx`. Тесты пишутся, не запускаются: первый прогон — quality gate.

Правило заполнения: строка теста заполняется, только когда каждая строка текста, роль и элемент её проверок уже есть в коде (Phases 1–3), включая отрицательные проверки. Шапка скелета написана по дизайну 1.1 и совпадает с планом; где комментарий скелета расходится с текстом задачи, верна задача. `resetRow()` — локальная функция файла, как в `custom-agents-web.int.test.tsx` и `model-providers-web.int.test.tsx` (в `test/admin-support.ts` её нет).

#### Tasks

- [ ] **Task 4.1: Данные графа; INT-2 и INT-3 — экран знаний, отказы доступа, удаление** — covers DD Test Strategy UC-2, UC-3, UC-E1, Flow 2, Flow 3; AC-11.1, AC-11.3, AC-11.4, AC-11.5, AC-09.1, AC-09.3, AC-06.1, AC-16.1, DC-2 → INT-2; AC-11.2, AC-09.2, DC-3 → INT-3
  - `test/fixtures.ts`: `knowledgeView(overrides)` и построители записей четырёх видов (`knowledgeEntity`, `knowledgeFact`, `knowledgeLesson`, `knowledgeSearchedNothing`), значения проходят `KnowledgeViewSchema` / `KnowledgeItemSchema`.
  - INT-2 по пунктам скелета, строки A–C с `resetRow()`: строка A — библиотека, самообучение включено, `selection` `on`, `counts` с числами, которые не равны числу записей (например `active` 126, `always` 64, `beyond` 2, `percent` 180), урок `logs.search` с тремя подтверждениями, две записи `by_topic`; проверки — ровно два чтения (запись и граф) без маршрутов `/api/admin/`, `h1` в фокусе, числа строк 1–2 литералами, вкладка «Только по теме · 2», пометки, нет строки отбора и пометки «не помещается», нет имени сотрудника. Строка B — граф 403 `KNOWLEDGE_FORBIDDEN`: экран RV-02, ни имени workflow, ни текста записей. Строка C — панель, запись 404: экран AD-15, так же.
  - INT-3 по пунктам скелета: сущность и две связи-факта с ней; диалог называет 2; один `DELETE …/knowledge/entities/:entityId` (204), после него ровно одно новое чтение графа; строк сущности и связей нет; уведомление «Удалено вместе со связями: 2». Короткая строка: `DELETE` 500 — диалог открыт с «Не удалось удалить: …», строка на месте.
  - Target Files: `apps/web/src/components/shell/self-learning-web.int.test.tsx`, `apps/web/src/test/fixtures.ts`.
  - Dependencies: Task 2.2, Task 3.3 (тот же `fixtures.ts`).
  - Ревью тестов: да (экран знаний с отказами доступа и удаление).
  - Проверка: `pnpm --filter web typecheck`.

- [ ] **Task 4.2: INT-1 и INT-4 — флажок и настройки** — covers DD Test Strategy UC-1, UC-4, Flow 1, Flow 4; AC-10.1, DC-1 → INT-1 (правило — строка Task 3.1); AC-12.1, DC-5 → INT-4 (проводка; границы — строки Task 3.3)
  - INT-1 по пунктам скелета: сохранённый workflow автора с выключенным флажком; щелчок только по «Самообучение» → форма «Изменено» и «Сохранить» доступна; тело `PUT /api/library/:id` несёт `content.selfLearning === true` и версию начала правки; после сохранения форма «Чисто»; новое открытие — флажок отмечен и ссылка ведёт на `/library/<id>/knowledge`.
  - INT-4 по пунктам скелета: вкладка «Системные»; ввод 12000, снятие «Давать запускам уроки», «Сохранить» → один `PUT /api/admin/knowledge/settings` с телом ровно `{ limitTokens: 12000, lessonsEnabled: false }`; после перечитывания поле 12000 и флажок снят. Короткая строка: 400 `VALIDATION_FAILED` — ошибка формы «Не удалось сохранить: …», введённое на месте.
  - Target Files: `apps/web/src/components/shell/self-learning-web.int.test.tsx`.
  - Dependencies: Task 4.1 (тот же файл), Task 3.1, Task 3.3.
  - Ревью тестов: нет.
  - Проверка: `pnpm --filter web typecheck`.

#### Operational Verification Procedures

Интеграционные тесты фазы — сами проверки точек стыка веба с ответами API; их прогон — quality gate (Task Q.1).

### Final Phase: Quality Assurance (Required)
**Purpose**: Один quality gate части, ревью тестов риск-задачи, аудит тестов и проверки фаз.

#### Tasks

- [ ] **Task Q.1: Quality gate** — `pnpm --filter web lint`, `pnpm --filter web typecheck`, `pnpm --filter web test` (unit и интеграционные тесты веба), `pnpm knip`. Каждая команда запускается отдельно: `pnpm check` одной командой останавливается на первой упавшей задаче. Падения исправляются, gate повторяется целиком. e2e- и verify-наборы бэкенда не запускаются. Итог — в Progress Tracking.
- [ ] **Task Q.2: Ревью тестов и аудит** — `integration-test-reviewer` по Task 4.1; один `test-auditor` по тестам части; исправления — до повторного Task Q.1. Итог — в Progress Tracking.
- [ ] **Task Q.3: Процедуры фаз** — Operational Verification Procedures Phase 1–3 по порядку; итог — в Progress Tracking.
- [ ] Каждый AC карты скелета (AC proof map) доказан тестом INT-1 – INT-4 или строкой unit-таблицы и проходит; ручные — в Owner Checklist.
- [ ] Тесты в бюджете части: четыре INT скелета (три по умолчанию и один сверх — его «Catches» в шапке скелета), unit-таблица `knowledge-view.test.ts` и строки `library-errors`, `shell-route`, `record-rules`, `form-rules`; правленые обработчики `agent-platform-web` (и, если нужно, ожидания `custom-agents-web` из Task 2.3, Task 3.1). Ничего сверх.

#### Operational Verification Procedures

1. Task Q.1 зелёный: все четыре команды без ошибок.
2. Процедуры Phase 1–3 (Task Q.3) дали ожидаемый результат.

## Verification Strategy

- **Correctness definition and method**: веб показывает граф по полям `KnowledgeView` (числа строк — из `counts`, пометки — из `state` и `placement`, вкладка и строка отбора — из `selection`), на 404 и 403 `KNOWLEDGE_FORBIDDEN` показывает существующий «Не найдено» без имени, на подтверждение шлёт ровно один `DELETE` и перечитывает граф, сохраняет флажок общей кнопкой и шлёт настройки одним `PUT`. Подписи, числа и тексты — unit-таблица `knowledge-view`; правила «изменено», адреса, `isKnowledgeHidden` и границы места — строки существующих таблиц; проводка экранов на ответах API — INT-1 – INT-4 на настоящей оболочке с границей MSW; ширина, тема, фокус, строка в карточке и настоящий API — Owner Checklist.
- **Early verification point**: первая проверка поведения — unit-таблицы Phase 1 в quality gate; до него каждая задача держит `typecheck` веба зелёным. Если таблица `knowledge-view` падает, исправляется функция, а не экран.
- **Output comparison**: нынешние тесты веба (`custom-agents-web`, `agent-platform-web`, `model-providers-web`, `enterprise-access-admin`, `data-table.test.tsx`, `confirm-dialog.test.tsx`) сохраняют свои утверждения; их зелёный прогон показывает, что общие компоненты, адреса и карточка решения не изменились для других экранов.
- **Proof obligations** (строки «Catches» скелета):
  - INT-1: «Сохранить» недоступна после единственного изменения — флажка; флажок не дошёл до `PUT`.
  - INT-2: числа строк и вкладок посчитаны по записям, а не взяты из `counts`; поля `state` / `placement` / `selection` потеряны по пути через клиент; 403 нарисован общей ошибкой; новый вид страницы закрыт старым разбором.
  - INT-3: строка убрана без перечитывания; по `DELETE` на каждую связь; неверное число в уведомлении.
  - INT-4: флажок уроков не дошёл до запроса; форма сохраняет только место.

## Risks and Countermeasures

- **Risk**: Флажок не сохраняется: редактор не считает его изменённым полем.
  - **Impact**: Высокое: автор думает, что включил самообучение, а запуски не учатся.
  - **Countermeasure**: Строка `selfLearning` в `workflowChanges` (Task 3.1), строка unit-таблицы и INT-1 (Task 4.2).
- **Risk**: Новый вид страницы `knowledge` без ветки молча открывает список (цепочки `if`, исчерпывающей проверки нет).
  - **Impact**: Экран знаний недостижим, `typecheck` зелёный.
  - **Countermeasure**: Строки разбора (Task 1.3), явные ветки в `main-view.tsx` и `library-section.tsx` (Task 2.1), INT-2 открывает оба адреса.
- **Risk**: Новые чтения ломают соседние тесты (`onUnhandledRequest: 'error'`): настройки знаний на вкладке «Системные», запись workflow в открытой карточке брифа.
  - **Impact**: Красный gate в файлах без связи с поведением.
  - **Countermeasure**: Обработчик по умолчанию `GET /api/admin/knowledge/settings` (Task 3.3); обработчик записи в `agent-platform-web.int.test.tsx` (Task 3.2).
- **Risk**: Текст записи — пришедший из результатов инструментов — выводится разметкой или попадает в лог.
  - **Impact**: Подмена интерфейса или утечка секрета в лог.
  - **Countermeasure**: Только текст React (Task 2.1), лог удаления с номерами (Task 2.2), процедуры Phase 2.
- **Risk**: Контракт `core` построен, но его тесты ещё не запускались; поле ответа может измениться до конца постройки `core`.
  - **Impact**: Экран разбирает ответ схемой, которой на сервере уже нет.
  - **Countermeasure**: Веб берёт формы только из `@agent-os/contracts` (без своих копий); изменение схемы `core` всплывёт в `typecheck` веба. Перед Task Q.1 — строка Progress Tracking: статус плана `core`.
- **Risk**: Тесты пишутся без прогона до quality gate.
  - **Impact**: Ошибки всплывают разом в конце.
  - **Countermeasure**: `typecheck` в каждой задаче; ревью тестов Task 4.1.

## Progress Tracking

| Пункт | Задача | Результат |
|---|---|---|
| Статус плана `core` и его quality gate перед gate этой части | Task Q.1 | |
| Итог gate: команды, число повторов, что исправлено | Task Q.1 | |
| Вердикт ревью тестов Task 4.1 и аудита | Task Q.2 | |
| Итоги процедур Phase 1–3 | Task Q.3 | |
| Ожидания соседних тестов, правленные в Task 2.3, 3.1, 3.2 (файл и строка) | Task 2.3, 3.1, 3.2 | |

## Notes

1. **Правила владельца.** Задача пишет тесты, но не запускает их; внутри задачи — одна проверка `pnpm --filter web typecheck` и чтение. Коммитов нет, git worktree, stash и reset нет. Единственный gate — Task Q.1. Ревью тестов — только Task 4.1 (экран знаний с отказами доступа и удаление); один аудит тестов части в Task Q.2. Сервер `api`, e2e- и verify-наборы бэкенда и `pnpm db:*` не запускаются. План `core` (`docs/features/self-learning/core/20261120-feature-self-learning-core.md`) эта часть не правит.
2. **Общие компоненты не меняются.** `DataTable`, `PageHeader`, `ConfirmDialog`, `AdminForm`, `StateBadge`, `ThreadNotice`, `ui/tabs` берутся как есть. Отличия от UXRD строятся так, как записал дизайн («Отличия от UXRD»): компактная плотность, без варианта «Две строки», фокус на `h1` после последней строки, заголовок вкладки браузера с родителем, ожидание и отказ удаления в диалоге.
3. **`blankWorkflow` и тестовое содержимое уже готовы.** Дизайн перечисляет `blankWorkflow` с `selfLearning: false` и `test/fixtures.ts` с `selfLearning` как правки этой части; их сделала задача `core` Task 1.3: `blankWorkflow` уже несёт `selfLearning: false`, `workflowContent` разбирается схемой с `default(false)`, строка `record-rules.test.ts` уже содержит поле. Здесь их никто не меняет; `fixtures.ts` получает только данные графа и настроек (Task 3.3, Task 4.1).
4. **Фокус в панели.** Дизайн пишет «`AdminScreen` переводит фокус на `h1`»; в коде `AdminScreen` не держит `h1`, а зовёт `focusShellTarget('page-title')` по ключу `[section, page.kind, pageKey]`, где `pageKey` есть только у вида `record`. Task 2.1 даёт ключ и виду `knowledge`.
5. **Нет исчерпывающих `switch` по видам страницы.** `main-view.tsx` и `library-section.tsx` выбирают экран цепочкой `if`; новый вид без ветки падает в список, а `tsc` молчит. Ветки — Task 2.1, доказательство — INT-2.
6. **Скелетон записи частный.** «Скелетон страницы записи» (дизайн, «Как экран выбирает») — функция `RecordSkeleton` без экспорта в `record-page.tsx`; Task 2.1 экспортирует её. Загрузка и ошибка записи в панели — существующий `RecordPlaceholder` (`components/admin/admin-header.tsx`). Дизайн не называет `record-page.tsx` среди меняемых файлов.
7. **`isNotFound` живёт в `admin-errors.ts`.** В `library-errors.ts` своей проверки 404 нет; `isKnowledgeHidden` (Task 1.1) зовёт `isNotFound` из `lib/admin/admin-errors.ts`, как уже делает `record-page.tsx`.
8. **`formatDay` и `formatDayTime` — новые.** В `format.ts` форматтер дня частный, в `library-row.tsx` — своя копия `closedOn`; `formatTime` за сегодня даёт только время. Task 1.2 делает обе функции и убирает копию.
9. **id записи уникален только внутри `type`.** Сущность и связь могут иметь один номер (`KnowledgeItemSchema`). Ключ строки — `${type}:${id}`, маршрут удаления выбирается по `type` (Task 1.2, Task 2.2).
10. **Обработчики MSW.** Дизайн не называет тестовую обвязку. Вкладку «Системные» рисует `custom-agents-web.int.test.tsx` — нужен обработчик настроек по умолчанию (Task 3.3); открытую карточку брифа `start_workflow` рисует только `agent-platform-web.int.test.tsx` — ему нужен обработчик записи (Task 3.2).
11. **`resetRow` — не экспорт обвязки.** Скелет пишет «with `resetRow()` between rows», а `test/admin-support.ts` такой функции не даёт: каждый файл интеграционных тестов держит свою (Phase 4).
12. **Кнопка MC-7 в общей шапке редактора.** `EditorHeaderActions` рисуется в обоих режимах; кнопка — только в режиме `system` у workflow (Task 2.3), вход автора — ссылка под флажком (Task 3.1).
13. **Флажок в `AdminForm`.** Поля флажка у `AdminForm` нет (дизайн это знает, KD-7): `Checkbox` из `ui/checkbox` кладёт значение через `form.set`. Строк `librarySettingsRules` в `form-rules.test.ts` нет; строки `knowledgeSettingsRules` — первые строки правил настроек в этой таблице.
14. **Статус документов.** `design-web.md` 1.1 пишет «На утверждении», UXRD 1.2 — «Черновик»; открытых вопросов в обоих нет. План строится на них как на утверждённых (владелец не ждёт утверждения документов в постройке).
15. **Логирование.** Только `src/lib/logger.ts` и `describeApiError`; чтения пишет `useResource`, отказ настроек — `AdminForm`, удаление — Task 2.2. Текст записей, имена сущностей и вопросы в лог не идут.
16. **Цвета и комфорт долгой сессии.** Только токены дизайн-системы (`--foreground`, `--muted-foreground`, `--info`, `--destructive`) и существующие классы на них; своих цветов, чистого белого и чёрного нет.
17. **Поиск по коду.** Пути и символы проверены проходом `code-explorer` и чтением (LSP `findReferences` в этом репозитории находит только ссылки внутри файла, потребители найдены текстовым поиском): маршруты `core` (`knowledge.controller.ts`, `admin-knowledge-settings.controller.ts`), схемы и константы `knowledge.ts` в исходнике и в `dist`, `LibraryErrorCode.KNOWLEDGE_FORBIDDEN`, все файлы веба из дизайна на месте.

## Owner Checklist (manual, not tasks)

Браузерной автоматики в этой среде нет; владелец проходит строки после gate на `pnpm --filter web build && pnpm --filter web start` против настоящего `api` (с построенной частью `core` и применённой миграцией).

- [ ] **Флажок и экран** (L1; AC-10.1, AC-13.1, DC-4): включить «Самообучение», сохранить; в Network `PUT` с `selfLearning: true`. Попросить чат запустить workflow — в карточке над кнопками MC-9; у workflow без флажка строки нет; решения в обеих карточках — как обычно. После конца запуска открыть «Что узнал workflow» — новые записи и строка 5. В панели у системного workflow и у workflow сотрудника, открытого ролям, кнопка «Что узнал workflow»; у агента её нет.
- [ ] **Удаление и фокус** (L1): клавиатурой — меню, «Удалить», фокус в диалоге на «Отмена»; Enter на «Удалить» — один `DELETE` в Network, фокус на меню следующей строки; «Отмена» на другой строке — фокус на меню своей строки.
- [ ] **Состояния** (L1, UC-5): выключить уроки в панели, уменьшить место, выключить самообучение у workflow; открыть экран после каждого шага — строки и пометки по таблице дизайна; при снятой модели эмбеддингов — строка «Отбор по смыслу выключен» с причиной, вкладка «Не помещаются».
- [ ] **360 px** (L1): экран знаний и форма AS-01 — нет прокрутки страницы вбок; вкладки и таблица прокручиваются внутри своих блоков; «Открыть workflow» строкой под заголовком; цели касания 44 px.
- [ ] **Тема** (L1): экран знаний в светлой и тёмной теме — цвета меток и строк состояния из токенов, нет чистого белого и чёрного; длинный список читается без усталости глаз.
- [ ] **Порядок Tab** (UXRD Accessibility): флажок → подсказка → ссылка «Что узнал workflow»; на экране знаний — шапка, строки, вкладки, таблица.

## Appendix: Traceability

### Reference Contract Values

| Design Doc (§ Section) | Contract Type | Required Observable Value (verbatim) | Covered By Task(s) |
|---|---|---|---|
| design-web.md (§ KD-3) | state-lifecycle-negative | Но «изменено» редактор считает по явному списку полей в `workflowChanges`, и без новой строки там форма после щелчка по флажку осталась бы «чистой», «Сохранить» — недоступной, а флажок не сохранился бы (DC-1). | Task 3.1, Task 4.2 |
| design-web.md (§ KD-2) | structure-order | Сегодня `/library/<id>/knowledge` открывает список библиотеки, а `/admin/library/<id>/knowledge` — раздел «Сотрудники»; новая ветка разбора стоит раньше разбора одного сегмента. | Task 1.3, Task 2.1 |
| design-web.md (§ Клиент API) | exact-value | **`isKnowledgeHidden(error)`** — истина для 404 и для 403 с кодом `KNOWLEDGE_FORBIDDEN`. Только по ней экран знаний решает показать «Не найдено». | Task 1.1, Task 2.1, Task 4.1 |
| design-web.md (§ KD-5) | structure-order | Подтверждение шлёт один `DELETE` в маршрут сущности или связи, показывает уведомление и перечитывает граф; строку убирает новый ответ сервера, а не правка на месте (DC-3). | Task 2.2, Task 4.1 |
| design-web.md (§ KD-5) | derived-display | Сколько связей уйдёт с сущностью, экран считает по загруженным связям-фактам, у которых один из концов — эта сущность: `DELETE` отвечает 204 без тела. | Task 1.2, Task 2.2 |
| design-web.md (§ Как экран выбирает, что показать) | derived-display | Числа строк состояния — поля `counts` как есть: {M} — `active`, {N} — `always`, {K} — `beyond`, {O} — `outdated`, {P} — `percent`, в том числе больше 100. | Task 1.2, Task 4.1 |
| design-web.md (§ C3 · Components: web) | structure-order | Порядок записей — тот, что прислал `core`; вкладка только отбирает записи, порядок не меняет. | Task 1.2, Task 2.1 |
| design-web.md (§ Как экран выбирает, что показать) | state-lifecycle-negative | При выключенном самообучении `core` ставит `placement` `null` всем записям, поэтому пометок «только по теме» и «не помещается» и пятой вкладки тогда нет. | Task 1.2 |
| design-web.md (§ Flow 3) | state-lifecycle-negative | Отказ или сеть → диалог остаётся открытым с MC-6 «Не удалось удалить: {причина}» (`deleteFailed`), строка на месте; веб пишет отказ в лог. | Task 2.2, Task 4.1 |
| design-web.md (§ KD-6) | state-lifecycle-negative | Пока ответа нет или чтение не удалось, строки нет, и карточка работает как раньше (DC-4). | Task 3.2 |
| design-web.md (§ KD-7) | exact-value | Поле места проверяется до отправки правилом `knowledgeSettingsRules` в `form-rules.ts` по константам границ из `contracts` — тем же путём, что «Лимит ходов» по `RECORD_MAX_TURNS_*` (DC-5). | Task 3.3 |
| design-web.md (§ Flow 4) | state-lifecycle-negative | форма перечитывает настройки и начинается заново с сохранённых значений (её ключ — `updatedAt`, как у `LibrarySettingsForm`). | Task 3.3, Task 4.2 |
| design-web.md (§ Логирование) | exact-value | Удаление: `library: knowledge delete` — `recordId`, `type` и `id` записи, итог или статус, код и причина отказа, `durationMs`. | Task 2.2 |
| design-web.md (§ Security Considerations) | exact-value | веб выводит его как текст, без разметки и ссылок. | Task 2.1 |

### Failure Mode Checklist

| Category | Where it applies | Covered By Task(s) |
|---|---|---|
| same-value | флажок вернули к сохранённому значению — форма «чистая»; сохранённый и снятый флажок — заметка MC-1 | Task 3.1 |
| no-op | «Отмена» в диалоге удаления — запроса нет; вкладка меняет только отбор строк | Task 2.2, Task 2.1 |
| empty input | пустой граф (два варианта MC-5), пустая вкладка, пустое поле места | Task 2.1, Task 1.2, Task 3.3 |
| invalid option | место вне границ или не целое | Task 3.3 |
| missing config | модель отбора не выбрана — строка «Отбор по смыслу выключен» с причиной | Task 1.2 |
| unavailable boundary | ошибка чтения записи или графа; чтение записи в карточке не удалось — строки нет | Task 2.1, Task 3.2 |
| external failure | отказ или сеть на `DELETE`; 400 на сохранении настроек | Task 2.2, Task 3.3 |
| permission | 404 и 403 `KNOWLEDGE_FORBIDDEN` — «Не найдено» без имени; вход только у автора и в панели | Task 1.1, Task 2.1, Task 2.3, Task 3.1 |
| shared-state dependency | после удаления числа вкладок и строки состояния — из нового ответа; два чтения экрана параллельно | Task 2.2, Task 2.1 |
| stale response | переход между двумя экранами знаний — ключ компонента — номер workflow, прежний ответ отбрасывает `useResource` | Task 2.1 |
| rollback-only visibility | отказ удаления — строка на месте, диалог открыт; отказ настроек — введённое остаётся | Task 2.2, Task 3.3 |
| secret exposure | текст записей не идёт в лог и не рисуется разметкой | Task 2.1, Task 2.2 |
| missing-sort-key ordering | порядок записей — от `core`, вкладка не сортирует | Task 1.2, Task 2.1 |

### UXRD Component → Task Mapping

| UXRD Element | States to Cover | Covered By Task(s) | Gap Status | Notes |
|---|---|---|---|---|
| SL-01 | новый workflow, сохранён включённым, снят у сохранённого, ссылка, панель | Task 3.1 | covered | |
| SL-02 | флажок включён, выключен, чтение не удалось, после решения | Task 3.2 | covered | проверка — Owner Checklist |
| KN-01 | Loading, Default, больше предела с отбором, отбор выключен, готовят, устаревшие, уроки выключены, самообучение выключено, обучения не было, пусто ×2, вкладка пуста, ошибка | Task 1.2, Task 2.1 | covered | компактная плотность, без «Двух строк» (Отличия от UXRD) |
| KN-01 «Входы» | ссылка автора, кнопка MC-7 в панели, нет у агента и коллеги | Task 3.1, Task 2.3 | covered | |
| KN-02 | подтверждение сущности со связями, без связей, другой записи; успех; отказ | Task 2.2 | covered | ожидание и отказ — в диалоге (Отличия от UXRD) |
| KN-03 | библиотека RV-02, панель AD-15 | Task 2.1 | covered | |
| AS-01 | загрузка, ошибка загрузки, сохранено, ошибка поля, отказ сервера | Task 3.3 | covered | |

### ADR Bindings

| ADR | Source Section | Axis | Binding Decision | Covered By Task(s) |
|---|---|---|---|---|
| docs/adr/ADR-0012-closed-api-and-server-issued-employee-id.md | Decision | data_flow | Сотрудника веб не передаёт ни в одном запросе | Task 1.1 |
| docs/adr/ADR-0016-library-records-and-visibility.md | Decision | security | «Не найдено» ничего не называет и не говорит, есть ли граф | Task 2.1 |

### Connection Map

Правая сторона — часть `core`: её исходный код написан и проходит проверку типов, тесты ещё не запускались (план `core` в постройке). Эта часть строится против кода `core` на диске; планов, которые строятся на этой части, нет.

| Boundary | Owner (left side) | Owner (right side) | Serialized Format | Consumer Parse Rule | Expected Signal | Covered By Task(s) |
|---|---|---|---|---|---|---|
| Граф workflow | `apps/api/src/knowledge/knowledge.controller.ts` (`GET`) | `apps/web/src/lib/library/library-api.ts` (`libraryApi.knowledge`), `knowledge-page.tsx` | JSON `KnowledgeView`; 404 `RECORD_NOT_FOUND`, 403 `KNOWLEDGE_FORBIDDEN` | `KnowledgeViewSchema`; `isKnowledgeHidden` | INT-2 | Task 1.1, Task 2.1 |
| Удаление записи | `apps/web/src/components/library/knowledge-list.tsx` | `knowledge.controller.ts` (`DELETE entities/:entityId`, `relations/:relationId`) | без тела; 204 | — | INT-3: один `DELETE`, одно перечитывание | Task 1.1, Task 2.2 |
| Настройки знаний | `apps/api/src/knowledge/admin-knowledge-settings.controller.ts` | `apps/web/src/lib/admin/admin-api.ts` (`adminApi.knowledge`), `knowledge-settings-form.tsx` | JSON `KnowledgeSettings`; тело `UpdateKnowledgeSettingsBody`; 400 `VALIDATION_FAILED` | `KnowledgeSettingsSchema` | INT-4 | Task 1.1, Task 3.3 |
| Флажок в содержимом | `apps/web/src/components/library/workflow-fields.tsx` | маршруты правки записи `apps/api/src/library/library.controller.ts` и панели | JSON `WorkflowContent` с `selfLearning` | `WorkflowContentSchema` | INT-1: тело `PUT` | Task 3.1 |
| Запись для карточки | `GET /api/library/:id` (`library.controller.ts`) | `apps/web/src/components/agents/decision-card.tsx` (`SelfLearningNote`) | JSON `RecordDetail` | `RecordDetailSchema` | Owner Checklist «Флажок и экран» | Task 3.2 |

## Update History

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-11-20 | Initial version; по проверке черновика: процедуры Phase 1 и Phase 3 исключают `src/test` и комментарии, строка числа связей ушла из таблицы Task 1.2 (её доказывает INT-3) |
