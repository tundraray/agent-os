---
feature: model-providers
part: web
design: design-web.md
plan: 1 of 1
status: completed
temporary: true
---

# Work Plan: Провайдеры моделей — web

Created Date: 2026-11-20
Type: feature

## Snapshot

**Overview.** План строит в `apps/web` видимую сторону провайдеров моделей. Раздел панели «Модели» становится страницей из трёх блоков: модели по умолчанию, провайдеры (ключ, проверка подключения, удаление), каталог с провайдером и назначением. Везде, где человек выбирает модель, остаются только модели чата с именем провайдера, а модель неработающего провайдера помечается и сохранению не мешает. Сбои и отказы из-за провайдера получают свои слова в местах, которые уже показывают сбои. Подход гибридный: сначала основа без экранов — клиент API, перевод ошибок, чистые правила и необязательные добавки к общим компонентам, — затем экраны срезами (страница «Модели», диалог модели, выбор модели, причины), затем пять интеграционных тестов скелета и один quality gate. Основа идёт первой, потому что её берут все экраны; экраны идут срезами, потому что каждый срез проверяет свой тест.

- **Не меняется**: контракт `core` и всё в `apps/api` и `packages/*`; адреса оболочки; лента и поток событий; нынешнее поведение общих компонентов панели — они получают только необязательные свойства.
- **Главный риск**: ключ уходит в запрос, когда администратор его не менял, или задерживается в форме. Правило «ключ в теле — только введённый непустой» строит Task 3.4, доказывает INT-1 (Task 7.1), тест проходит ревью.
- **Открытые вопросы**: нет, сборку ничто не блокирует. Решения плана там, где дизайн расходится с UXRD 1.1 и с кодом, — в Notes, пункты 3–9.
- **Design items no task covers**: пометка модели в строке библиотеки (MC-12) — вне части по дизайну (у `RecordSummary` нет модели записи); таблица «L1-сценарии в браузере», UC-5 и UC-6 — ручная проверка владельца (Owner Checklist), браузера в этой среде нет.

## Implementation Phases

Каждая задача: реализация, тесты, которые она пишет (без запуска), и одна проверка — `pnpm --filter web typecheck` — плюс чтение по пунктам задачи. `packages/contracts` эта часть не меняет, его `dist` собран quality gate части `core`; если `tsc` не видит имени из `contracts`, перед проверкой один раз выполняется `pnpm turbo build --filter=web^...`. Коммитов нет, git worktree, stash и reset не используются, задачи идут по одной в порядке номеров в общем рабочем дереве. Проверок в конце фаз нет: Operational Verification Procedures всех фаз выполняются в Final Phase после единственного quality gate.

**Запрет на всю часть**: ни одна задача не запускает сервер `api`, e2e- и verify-наборы бэкенда и `pnpm db:*` — они пишут в базу разработчика. Тесты веба — Vitest, RTL и MSW без базы, и их тоже запускает только gate.

### Phase 1: Основа — клиент API, перевод ошибок, правила
**Purpose**: Дать экранам одно место для каждого запроса, каждого текста ошибки и каждого правила провайдеров и моделей.

#### Tasks

- [x] **Task 1.1: Клиент API провайдеров и моделей по умолчанию, `model` в любой ошибке, перевод новых кодов** — covers DD KD-2, Contract Definitions «Клиент API» (все четыре пункта), «`AdminErrorTarget`, `AdminErrorContext`», Building-block `adminApi.modelProviders`, `adminApi.modelDefaults`, `adminApi.models`, `describeAdminError`; Flow 1, 2, 3 (Failure handling — тексты); UXRD MC-2 (отказы сохранения), MC-4 (ошибки сервера), MC-5 (поздний отказ удаления), MC-7 (ошибки сервера); ADR-0012
  - Pattern: [web-api-client.md](../../../code-system/patterns/web-api-client.md), [logging.md](../../../code-system/patterns/logging.md).
  - `lib/admin/admin-api.ts`: `adminApi.modelProviders` — `list` (`GET /api/admin/model-providers`, `z.array(ModelProviderViewSchema)`), `create(CreateModelProviderBody)`, `update(name, UpdateModelProviderBody)`, `remove(name)` (204), `check(name)` (`POST …/:name/check`, `ModelProviderCheckSchema`); имя в пути — `encodeURIComponent`. `adminApi.modelDefaults` — `get` и `save(UpdateModelDefaultsBody)` над `/api/admin/model-defaults`, ответ `ModelDefaultsSchema`. `adminApi.models.create` и `update` принимают тела `CreateCatalogModelBody` и `UpdateCatalogModelBody` как есть (объединение по `purpose`); разбор ответа `CatalogModelSchema` — уже сделан в `core` Task 1.2. Клиент сам ничего в тело не добавляет: правило ключа — у диалога (Task 3.4). Имена `adminApi.providers`, `ProviderView` и `components/admin/sign-in/*` — провайдеры входа, не трогаются (KD-2).
  - `lib/api/api-request.ts`: `errorDetailsOf` копирует строку `model` из тела любой ошибки, где она есть, а не только из тела по `StartRefusedErrorSchema` — так её читают отказ старта и `MODEL_DEFAULT_INVALID`.
  - `lib/admin/admin-errors.ts`: `AdminErrorTarget` + `modelName`; `AdminErrorContext` + `providerName?`. Новые случаи `describeAdminError`: `MODEL_PROVIDER_NAME_TAKEN` → поле `name`, «Провайдер с таким именем уже есть»; `MODEL_PROVIDER_NOT_FOUND` → форма, MC-4 «Не удалось сохранить: провайдера {имя} уже нет. Закройте окно — список обновится.»; `MODEL_PROVIDER_HAS_MODELS` → форма, MC-5 «Не удалось удалить: у провайдера есть модели в каталоге. Сначала уберите их.»; `MODEL_PROVIDER_INVALID` `provider_unknown` → MC-7 «Не удалось сохранить: провайдера {имя} больше нет. Закройте окно и откройте его снова.», `embeddings_not_supported` → MC-7 «Не удалось сохранить: провайдер этого типа не считает эмбеддинги»; `MODEL_DEFAULT_INVALID` → форма, MC-2 «Не удалось сохранить: модель {модель} другого назначения» (`not_chat`, `not_embedding`) или «…модели {модель} больше нет в каталоге» (`model_unknown`), модель — из `error.model` (подпись — `formatModel`). `MODEL_ID_TAKEN` переходит с цели `id` на `modelName`; если после этого у цели `id` нет случаев, она удаляется.
  - `lib/admin/admin-texts.ts`: тексты этих ошибок; общие тексты раздела MC-1 (заголовки блоков, «Добавить провайдера», «Добавить модель», «Сначала добавьте провайдера»).
  - Тестовые данные: `test/fixtures.ts` — `modelProviderView(overrides)` (по умолчанию `anthropic`, вид `anthropic`, ключ задан, `keyRequired: true`, `state: 'ready'`) и `modelDefaults(overrides)`; значения проходят схемы `contracts`. `test/msw-server.ts` — обработчики по умолчанию `GET /api/admin/model-providers` → `[modelProviderView()]` и `GET /api/admin/model-defaults` → обе модели `null`: эти чтения появляются в диалоге права, редакторе записи компании и разделе «Модели», а тесты идут с `onUnhandledRequest: 'error'`; готовый `anthropic` по умолчанию оставляет модели нынешних тестов доступными для выбора.
  - Target Files: `apps/web/src/lib/admin/admin-api.ts`, `apps/web/src/lib/api/api-request.ts`, `apps/web/src/lib/admin/admin-errors.ts`, `apps/web/src/lib/admin/admin-errors.test.ts`, `apps/web/src/lib/admin/admin-texts.ts`, `apps/web/src/test/fixtures.ts`, `apps/web/src/test/msw-server.ts`. Если `tsc` назовёт вызов цели `id` в компоненте (`model-dialog.tsx`), тот вызов переходит на `modelName` в этой задаче.
  - Не трогает: `adminApi.providers` и экраны входа; `packages/contracts`.
  - Dependencies: нет.
  - Тест: строки таблицы `admin-errors.test.ts` (`describeAdminError`): три кода `MODEL_PROVIDER_*`, две причины `MODEL_PROVIDER_INVALID`, три причины `MODEL_DEFAULT_INVALID` с моделью из тела, `MODEL_ID_TAKEN` → `modelName`. Ловит: текст не того места и модель без названия.
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: клиент не добавляет в тело ни одного поля сам; провайдеры входа не тронуты.

- [x] **Task 1.2: Готовность модели, варианты выбора, правила форм провайдера и модели** — covers DD KD-5, Terms «Готовность модели», «Как раздел «Модели» выбирает, что показать» (строка сортировки), Contract Definitions `modelUnavailableReason`, Building-block `modelUnavailableReason`, `modelProviderRules`, правила модели в `form-rules.ts`; Security Considerations (Input Validation); UXRD KD-1 (слова «Тип» и «Назначение»), MC-3 (названия типов), MC-4 (ошибки полей), MC-7 (ошибки полей), MC-8 (подписи вариантов); AC-13.3 и AC-14.1 (правило отбора)
  - Pattern: [pure-decision.md](../../../code-system/patterns/pure-decision.md).
  - `lib/admin/model-providers.ts` (new), чистые функции без React:
    - `modelUnavailableReason(modelId, providers)` — провайдера `modelProvider(modelId)` нет в списке → `provider_missing`; `state` `disabled` → `provider_disabled`; `key_missing` → `provider_key_missing`; иначе `null`. Правила «какой вид требует ключ» в вебе нет: его решает `state` от `core`.
    - Варианты выбора: `modelOptions(models, purpose, readinessOf)` — модели одного назначения с готовностью, по имени провайдера, затем по названию; у каждой — `value`, название, провайдер, у эмбеддингов размерность, подпись закрытого поля «{название} · {провайдер}» (у эмбеддингов «· {размерность}») и имя для скринридера «{название}, провайдер {провайдер}». Её берут MP-01, диалог права, редактор записи компании и поле «Модель» редактора.
    - Слова: `PROVIDER_KIND_TEXT` («Anthropic», «Google Gemini», «OpenAI-совместимый» с подсказками MC-4 по типу), `DEFAULT_PROVIDER_NAME` (`anthropic` → `anthropic`, `gemini` → `google`, у OpenAI-совместимого нет), короткие причины MC-8 по `ModelUnavailableReason` («провайдер выключен», «нет провайдера», «нет ключа»).
  - `lib/admin/form-rules.ts`: `modelProviderRules` — имя (пусто → «Введите имя»; не по `ModelProviderNameSchema` → «Имя — {правило имени словами}»), адрес (не пустой и не URL `http`/`https` → «Введите полный адрес, например https://api.example.com/v1»), ключ (непустой и короче `MODEL_PROVIDER_API_KEY_MIN_LENGTH` или длиннее `MODEL_PROVIDER_API_KEY_MAX_LENGTH` → «Ключ — от 8 до 512 символов»). Границы — только константы и схемы `contracts`. `modelRules` переписывается под форму MP-06: провайдер (нет → «Выберите провайдера»), назначение, имя у провайдера (пусто или с пробелами → «Введите имя модели»), название, цены по назначению, размерность у эмбеддингов (не целое в `EMBEDDING_DIMENSIONS_MIN`…`EMBEDDING_DIMENSIONS_MAX` → «Размерность — целое число больше нуля»). Проверка id целиком и текст `modelIdFormat` удаляются (`admin-texts.ts`).
  - Target Files: `apps/web/src/lib/admin/model-providers.ts`, `apps/web/src/lib/admin/model-providers.test.ts` (new), `apps/web/src/lib/admin/form-rules.ts`, `apps/web/src/lib/admin/form-rules.test.ts`, `apps/web/src/lib/admin/admin-texts.ts`. Вызов `modelRules` в `components/admin/models/model-dialog.tsx` до Task 4.1 компилируется на старой форме только если типы совпадают; если `tsc` назовёт его, задача оставляет диалог компилирующимся минимальной правкой (имя у провайдера = нынешнее поле id), а форму MP-06 строит Task 4.1.
  - Dependencies: Task 1.1 (`admin-texts.ts`).
  - Тесты: `model-providers.test.ts` (new), одна таблица на файл: готовность — провайдера нет, `disabled`, `key_missing`, работает; варианты — чат и эмбеддинги разделены, порядок по провайдеру и названию, подпись эмбеддинга с размерностью (это UC-3 дизайна). Строки `form-rules.test.ts`: имя `Google`, `-x`, 33 знака — ошибка, `local-2` — нет; ключ 7 и 513 знаков — ошибка, 8 и 512 — нет; адрес `vllm.corp` — ошибка; провайдер не выбран, имя модели с пробелом, размерность `0` и `1,5` — ошибки. Строки `model id Foo/x` и `model id x` удаляются вместе с правилом id.
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: ни одного своего числа границ; правило ключа вида — только `state`.

#### Operational Verification Procedures

Выполняются в Final Phase (Task Q.3).

1. `grep -rn "/api/admin/model-providers\|/api/admin/model-defaults" apps/web/src --include=*.ts --include=*.tsx` вне `lib/admin/admin-api.ts`, `test/` и `*.test.*` — пусто.
2. `grep -rnE "\b(8|32|512|4096)\b" apps/web/src/lib/admin/form-rules.ts apps/web/src/lib/admin/model-providers.ts` — нет чисел границ, только константы `contracts`.

### Phase 2: Добавки к общим компонентам
**Purpose**: Дать таблице, полю секрета, переключателю и формам панели ровно те необязательные свойства, которые нужны разделу; нынешние экраны не меняются.

#### Tasks

- [x] **Task 2.1: Строка итога под строкой таблицы; недоступный пункт меню** — covers DD KD-3 (`result`, `disabled` в меню), Contract Definitions `DataTableRow.result`, `DataTableAction.disabled` в меню, Building-block `DataTable`, `ActionsMenu`, «Доступность и ширина» (строка итога переносится и не прокручивается с таблицей); UXRD MP-07 (вид строки), Responsive Behavior (строка итога)
  - Pattern: спецификация [data-table.md](../../../design-system/components/data-table.md), состояние «Итог действия».
  - `components/admin/data-table.tsx`: `DataTableRow.result?` — состояние (идёт, успех, отказ), видимый текст, у успеха — текст метки «Хорошо» и время, текст объявления. Под строкой — строка Caption с отступом ячейки во всю ширину таблицы: идёт — `LoaderCircle` и текст, успех — `StateBadge` «Хорошо» и время, отказ — `CircleX` и текст `--destructive`. Текст переносится, не усекается и не прокручивается вместе с таблицей. Начало и итог объявляются областью `status` вежливо. Без `result` строка та же, что сегодня.
  - `ActionsMenu`: `DropdownMenuItem` получает `disabled` из `action.disabled`; меню целиком по-прежнему недоступно только при `pending`. Режим кнопок не меняется.
  - Цвета — только токены дизайн-системы.
  - Target Files: `apps/web/src/components/admin/data-table.tsx`.
  - Не трогает: `data-table.test.tsx` и вызовы `DataTable` в других разделах — их поведение прежнее.
  - Dependencies: нет.
  - Тестов своих нет: строка итога и пункт меню — ручная проверка UC-5 (Owner Checklist); недоступный пункт меню дизайн записал как слабый риск (Risks).
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: без `result` и `disabled` разметка строки и меню не изменилась.

- [x] **Task 2.2: Концовка ключа и подсказка поля секрета; подтверждение выключения; общий выпадающий список панели** — covers DD KD-3 (`lastFour`, `hint`, `confirmOff`, `AdminSelectField`), KD-4 (поле секрета), Contract Definitions `SecretField`, `SavingSwitch.confirmOff`, `AdminSelectField`, Building-block `SecretField`, `SavingSwitch`, `AdminSelectField`, Security Considerations (поле не отдаёт значение менеджерам паролей); UXRD KD-3, Accessibility «Имена» (концовка читается «ключ заканчивается на {символы}»)
  - Pattern: спецификации [secret-field.md](../../../design-system/components/secret-field.md) (часть 7 «Концовка»), [settings-form.md](../../../design-system/components/settings-form.md) («Предупреждение», «Сохранение на месте»); [write-only-secret.md](../../../code-system/patterns/write-only-secret.md).
  - `components/admin/secret-field.tsx`: необязательные `lastFour` — «…{символы}» Mono `--muted-foreground` сразу после метки «Задан» и в имени для скринридера «ключ заканчивается на {символы}»; `hint` — подсказка под полем, описание поля (`aria-describedby`). Значение поля нигде, кроме самого поля, не показывается; поле отказывается от менеджеров паролей, как сегодня. Без новых свойств поле прежнее.
  - `components/admin/saving-switch.tsx`: `confirmOff?` рядом с `confirmOn` — выключение зовёт его вместо сохранения, переключатель остаётся включённым; вызывающий спрашивает подтверждение и сохраняет сам.
  - `components/admin/admin-form.tsx`: `AdminSelectField` — подпись, значение или `null` с текстом пустого значения, варианты (значение, текст закрытого поля, содержимое пункта, недоступен ли), подсказка, предупреждение (блок settings-form «Предупреждение» под полем), недоступность и ошибка поля. Подсказка и предупреждение — описание поля, не `alert`. На shadcn `select`, как соседние поля `AdminForm`. Частный `SelectField` диалога права и `ModelField` редактора не переписываются.
  - Target Files: `apps/web/src/components/admin/secret-field.tsx`, `apps/web/src/components/admin/saving-switch.tsx`, `apps/web/src/components/admin/admin-form.tsx`.
  - Не трогает: нынешние вызовы `SecretField` (`register-server-form.tsx`, `server-page.tsx`, `provider-page.tsx`) и `SavingSwitch` (`role-page.tsx`, `server-page.tsx`, `providers-table.tsx`).
  - Dependencies: нет.
  - Тестов своих нет: поле секрета в форме провайдера доказывает INT-1; список — INT-3.
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: значение секрета не попадает ни в имя для скринридера, ни в подсказку, ни в лог.

#### Operational Verification Procedures

Выполняются в Final Phase (Task Q.3).

1. `git diff --stat -- apps/web/src/components/admin/servers apps/web/src/components/admin/sign-in apps/web/src/components/admin/roles` — пусто: нынешние пользователи общих компонентов не правились.

### Phase 3: Страница «Модели»
**Purpose**: Администратор видит модели по умолчанию, провайдеров и каталог на одной странице; после любого изменения страница перечитывает все три ресурса.

#### Tasks

- [x] **Task 3.1: `ModelsScreen` и блок каталога с провайдером и назначением** — covers DD KD-1, C3 «открытие раздела «Модели»», «Данные экранов» (раздел «Модели»), «Как раздел «Модели» выбирает, что показать» (строки «Модель каталога без провайдера», «Провайдеров нет», «Модель выбрана по умолчанию» — удаление модели, сортировка каталога), Contract Definitions `ModelsScreen`, Building-block `ModelsScreen`, `CatalogSection`, «Доступность и ширина» (`h1` с фокусом, `h2`, подпись «Каталог моделей», кнопка под `h2` ниже 768 px), Логирование (чтения раздела); UXRD KD-2, Screen 1 «Раскладка», MP-03, MC-1, MC-7 (колонки, «Нет провайдера», пустой каталог, фраза к удалению модели по умолчанию); AC-05.1, AC-05.4 (видимая сторона), AC-13.1 (строка каталога)
  - Pattern: [read-on-open.md](../../../code-system/patterns/read-on-open.md), [shell-route.md](../../../code-system/patterns/shell-route.md); спецификации [data-table.md](../../../design-system/components/data-table.md), [state-badge.md](../../../design-system/components/state-badge.md).
  - `components/admin/models/models-screen.tsx` (new): `ModelsScreen` без свойств — `PageHeader` с `h1` «Модели» без кнопки, фокус на `h1` при открытии; три `useResource` с меткой `admin` (`adminApi.modelDefaults.get`, `adminApi.modelProviders.list`, `adminApi.models.list`) и одна `reloadAll()`, которая перечитывает все три. Блоки идут один под другим через 32 px; место для MP-01 и MP-02 — над каталогом, их ставят Task 3.2 и Task 3.3.
  - `components/admin/admin-screen.tsx`: раздел `models` рисует `ModelsScreen` вместо `CatalogSection`; адрес `/admin/models` прежний.
  - `components/admin/models/catalog-section.tsx` становится блоком: получает ресурс каталога, список провайдеров, модели по умолчанию и `reloadAll`; своё чтение и `PageHeader` уходят. `h2` «Каталог моделей» с кнопкой «Добавить модель» (`outline` `sm`, `Plus`); пока провайдеров нет — кнопка `aria-disabled` с описанием «Сначала добавьте провайдера». Колонки: «Модель» (название, id Mono второй строкой), «Провайдер» (имя; провайдера нет в списке — метка «Нет провайдера», состояние «Нужно действие»), «Назначение» («Чат» или «Эмбеддинги · {размерность}»), четыре цены (у эмбеддингов «Вход» — `inputUsdPerMTok` через `formatPriceUsd`, «Выход» и обе цены кэша — «—», вложенной строки нет; сегодня `core` Task 1.2 ставит «—» во все четыре, и «Вход» это исправляет — AC-05.1). Порядок — по id. Пусто: провайдеры есть — enterprise-access MC-30; провайдеров нет — MC-7 «Каталог пуст» / «Сначала добавьте провайдера, потом его модели.». Подтверждение «Убрать из каталога» у модели по умолчанию добавляет фразу MC-7 её назначения. Любое изменение блока (удаление, сохранение диалога) зовёт `reloadAll`; 404 `MODEL_NOT_FOUND` при удалении — как сегодня, затем `reloadAll`. `ModelDialog` получает `reloadAll` вместо своего `reload`; его форму меняет Task 4.1.
  - Ошибка чтения каталога — состояние Error таблицы с «Повторить» (`resourceTableState`).
  - Target Files: `apps/web/src/components/admin/models/models-screen.tsx` (new), `apps/web/src/components/admin/admin-screen.tsx`, `apps/web/src/components/admin/models/catalog-section.tsx`, `apps/web/src/components/admin/models/model-dialog.tsx` (только свойство `reload`).
  - Не трогает: `components/shell/enterprise-access-admin.int.test.tsx` — его часть каталога (подпись «Модели», поле «ID модели») устареет и удаляется в Task 7.2; до gate тесты не запускаются.
  - Dependencies: Task 1.1, Task 1.2.
  - Тестов своих нет: каталог и перечитывание доказывают INT-1 и INT-3; «Нет провайдера» и фраза MC-7 — ручная проверка UC-6.
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: у блоков нет своих чтений; каждое изменение раздела кончается `reloadAll`.

- [x] **Task 3.2: Модели по умолчанию (MP-01)** — covers DD KD-1 (перемонтирование формы), «Как раздел «Модели» выбирает, что показать» (строки «У модели чата по умолчанию `null`», «Выбранная модель не работает», «Работающих моделей назначения нет»), «Отличия от UXRD» (ошибка чтения каталога или провайдеров — ошибка и в MP-01), Flow 2 (Outcome и `MODEL_DEFAULT_INVALID`), Building-block `ModelDefaultsForm`, «Доступность и ширина» (предупреждения — описание поля), Логирование (`admin: model defaults save`); UXRD MP-01, MC-2, MC-8 (подпись эмбеддинга с размерностью, метка «Выключено»); AC-13.3, AC-06.1, AC-06.2, AC-02.1 и AC-07.2 (предупреждения), AC-09.1 (видимая сторона)
  - Pattern: [settings-row.md](../../../code-system/patterns/settings-row.md) по образцу `components/admin/library/library-settings-form.tsx`; спецификация [settings-form.md](../../../design-system/components/settings-form.md), вариант «Форма страницы».
  - `components/admin/models/model-defaults-form.tsx` (new): `h2` «Модели по умолчанию»; форма не шире 640 px; `AdminForm` без «Отмены» с двумя `AdminSelectField` — «Модель чата» и «Модель эмбеддингов», варианты — `modelOptions` (Task 1.2) по готовности `modelUnavailableReason`, подсказки MC-2. Выбранная модель, которая не работает, стоит в поле с меткой «Выключено» и короткой причиной MC-8 и не предлагается другим; под полем — предупреждение MC-2 с причиной («провайдер {провайдер} выключен», «провайдера {провайдер} нет», «у провайдера {провайдер} нет ключа»). Не выбрана — «Не выбрана» и предупреждение MC-2. Выбрать не из чего — поле недоступно, подсказка MC-2 «…добавьте модель ниже». Ждёт все три чтения: загрузка — Loading таблицы; ошибка любого из трёх — «Не удалось загрузить модели по умолчанию» и «Повторить», которое перечитывает упавшее.
  - Сохранение — `adminApi.modelDefaults.save({ chatModel, embeddingModel })`, затем `reloadAll`; уведомление «Модели по умолчанию сохранены». Отказ — ошибка формы `describeAdminError` (MC-2 с моделью из `error.model`), выбор остаётся. Форма перемонтируется ключом из сохранённых значений: изменение в другом блоке не стирает несохранённый выбор.
  - Поля получают постоянные `id` (`MODEL_DEFAULT_FIELD_ID.chat`, `.embedding`), экспортированные для «Выбрать по умолчанию» диалога модели (Task 4.1).
  - `ModelsScreen` ставит форму первым блоком.
  - Target Files: `apps/web/src/components/admin/models/model-defaults-form.tsx` (new), `apps/web/src/components/admin/models/models-screen.tsx`.
  - Dependencies: Task 3.1, Task 2.2.
  - Тестов своих нет: отбор вариантов — таблица Task 1.2 (AC-13.3); сохранение MP-01 — ручная строка «Модель и умолчание» (Owner Checklist); тексты отказа — таблица Task 1.1.
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: предупреждение не мешает сохранению; правила готовности не продублированы.

- [x] **Task 3.3: Таблица провайдеров: ключ, включение, удаление, проверка подключения (MP-02, MP-05, MP-07)** — covers DD KD-3 (окно «Нельзя удалить» на `AlertDialog`, `confirmOff`), KD-5, «Как раздел «Модели» выбирает, что показать» (строки ключа, адреса, `catalogModels`, выключение провайдера модели по умолчанию), «Данные экранов» (проверка — состояние таблицы, без перечитывания), «Отличия от UXRD» (отказ переключателя под переключателем, фокус после удаления последнего — `h1`, MC-6 «Не удалось проверить», 404 проверки), Flow 1 (проверка и её Failure handling), Flow 3, Building-block `ModelProvidersTable`, Логирование (`admin: model provider enable`, `admin: model provider remove`, `admin: model provider check`), «Доступность и ширина» (имена переключателя и меню, фокус); UXRD MP-02, MP-05, MP-07, MC-3, MC-5, MC-6, Accessibility (фокус, объявления); AC-12.2, AC-12.3, AC-01.3, AC-14.3 (переключатель), AC-16.1, AC-15.1 (видимая сторона)
  - Pattern: спецификации [data-table.md](../../../design-system/components/data-table.md) (вариант «Строка с действиями», «Итог действия»), [settings-form.md](../../../design-system/components/settings-form.md) («Сохранение на месте»), [state-badge.md](../../../design-system/components/state-badge.md); образец — `components/admin/sign-in/providers-table.tsx`.
  - `components/admin/models/model-providers-table.tsx` (new): `h2` «Провайдеры» с «Добавить провайдера» (диалог — Task 3.4); `DataTable` в порядке ответа, подпись «Провайдеры», `actionsAs="menu"`. Колонки MC-3: «Провайдер» — имя Mono, второй строкой Caption — `baseUrl` Mono или «адрес по умолчанию» `--muted-foreground`; «Тип» — `PROVIDER_KIND_TEXT`; «Ключ» — `apiKeySet` → «…{apiKeyLast4}» Mono с именем «ключ заканчивается на {символы}»; не задан и `keyRequired` — метка «Нужен ключ» (состояние «Нужно действие», имя «ключ не задан, модели не работают»); не задан и ключ не нужен — «без ключа» `--muted-foreground`; «Моделей» — `catalogModels`, табличные цифры; «Включён» — `SavingSwitch` «Включён: {имя}», `adminApi.modelProviders.update(name, { enabled })`, затем `reloadAll`. Пусто — «Провайдеров пока нет» и подсказка MC-3; ошибка чтения — «Не удалось загрузить провайдеров» и «Повторить».
  - Выключение провайдера, чья модель выбрана по умолчанию (по `modelProvider` моделей по умолчанию): `confirmOff` открывает `ConfirmDialog` MC-3 «Выключить провайдера «{имя}»?» с одной или обеими фразами о моделях по умолчанию и «Выключить»; «Отмена» оставляет переключатель включённым, фокус — на переключатель.
  - Меню «Действия: {имя}»: «Изменить» (Task 3.4), «Проверить подключение», «Удалить».
  - Удаление: `catalogModels > 0` — без запроса окно на `AlertDialog` «Нельзя удалить «{имя}»» / «Моделей этого провайдера в каталоге: {N}. Сначала уберите их из каталога.» и одна кнопка «Понятно», фокус — на «⋯» строки. Моделей нет — `ConfirmDialog` MC-5 «Удалить провайдера «{имя}»?» / «Ключ провайдера удалится вместе с ним. Вернуть нельзя.»; успех — уведомление «Провайдер удалён» и `reloadAll`. Поздний 409 `MODEL_PROVIDER_HAS_MODELS` — окно остаётся открытым с текстом MC-5 (Task 1.1), раздел зовёт `reloadAll`. 404 — `reloadAll`, строка уходит, фокус — по правилу таблицы, последний ушёл — на `h1`.
  - Проверка подключения: состояние итогов по имени провайдера живёт в этом компоненте (сторов нет), пока страница открыта; `adminApi.modelProviders.check(name)` → `DataTableRow.result`: идёт — «Проверяем подключение…» и пункт меню недоступен; `works` — «Работает · {время}»; `key_rejected` / `unreachable` — «Ключ отклонён: {message}» / «Адрес недоступен: {message}», без `message` — без двоеточия; сеть — «Не удалось проверить: нет связи с сервером»; другой отказ — «Не удалось проверить: {сообщение сервера}»; 404 — `reloadAll`, строка уходит с итогом. Объявления MC-6 с именем провайдера. Текст провайдера выводится как текст. Лог `admin: model provider check` — имя, `result`, `durationMs`; `message` в лог не идёт. Фокус остаётся на «⋯». Функцию проверки по имени таблица отдаёт диалогу (Task 3.4).
  - `ModelsScreen` ставит таблицу вторым блоком.
  - Target Files: `apps/web/src/components/admin/models/model-providers-table.tsx` (new), `apps/web/src/components/admin/models/models-screen.tsx`, `apps/web/src/lib/admin/admin-texts.ts` (тексты MC-3, MC-5, MC-6).
  - Dependencies: Task 3.1, Task 2.1, Task 2.2.
  - Тестов своих нет: удаление — INT-2; проверка и подтверждение выключения — ручная проверка UC-5, UC-6 (Owner Checklist).
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: при `catalogModels > 0` путь удаления не зовёт `remove`; итог проверки не перечитывает раздел.

- [x] **Task 3.4: Диалог провайдера (MP-04): добавление, изменение, ключ только при вводе** — covers DD KD-4, Contract Definitions `adminApi.modelProviders` (`create` и `update` — `apiKey` только переданный), Flow 1 (добавление, Outcome, Failure handling формы), Building-block `ModelProviderDialog`, `modelProviderRules`, Security Considerations (Sensitive Data Handling), Логирование (`admin: model provider create`, `admin: model provider save`), «Доступность и ширина» (фокус после закрытия и после проверки из уведомления); UXRD KD-3, KD-4, MP-04, MC-4; AC-12.1, AC-12.2, AC-01.1 (видимая сторона), DC-1
  - Pattern: [write-only-secret.md](../../../code-system/patterns/write-only-secret.md); спецификации [settings-form.md](../../../design-system/components/settings-form.md) («Форма диалога»), [secret-field.md](../../../design-system/components/secret-field.md).
  - `components/admin/models/model-provider-dialog.tsx` (new): `AdminForm` варианта `dialog`.
    - Новый — «Новый провайдер»: «Тип» — радиогруппа трёх типов с подсказками MC-4, выбран Anthropic; «Имя» Mono — тип подставляет `DEFAULT_PROVIDER_NAME`, пока администратор не правил поле сам; «Адрес (необязательно)» Mono с подсказкой по типу; «Ключ (необязательно)» — `SecretField` «Не задан» с подсказкой по типу. Тело — `name`, `kind`, `baseUrl` только непустой, `apiKey` только непустой.
    - Изменение — «Провайдер {имя}»: строкой текста «{имя} · {тип}» и «Имя и тип не меняются…»; «Адрес» — поле; «Ключ» — `SecretField` с `isSet`, `lastFour` и `hint`. Тело `PATCH` — только изменённое: `baseUrl` (пустой — `null`, адрес вида), `apiKey` только если введено непустое значение. «Заменить» и пустое поле — ключа в теле нет, прежний ключ остаётся. `apiKey: null` веб не отправляет. `AdminForm.hasChange` истинно, только если адрес отличается от сохранённого или введён непустой ключ: пустой `PATCH` схема `UpdateModelProviderBodySchema` отклоняет 400, поэтому без изменений «Сохранить» не шлёт запроса.
    - `secretFields: ['apiKey']` — форма стирает ключ после успеха; на отказ ключ остаётся в поле, пока диалог открыт (UXRD MP-04). Ключ не попадает ни в адрес, ни в уведомление, ни в лог.
    - Правила — `modelProviderRules` (Task 1.2); отказы — `describeAdminError` с `providerName` (Task 1.1): занятое имя — у поля «Имя», 404 — ошибка формы, после закрытия `reloadAll`.
    - Успех — `reloadAll`, диалог закрыт, фокус — на кнопку, которая его открыла; уведомление «Провайдер {имя} добавлен» / «…сохранён» с действием «Проверить подключение» (у изменения — только если менялись адрес или ключ). Действие зовёт проверку таблицы (Task 3.3) и ставит фокус на «⋯» строки.
  - `model-providers-table.tsx`: «Добавить провайдера» и «Изменить» открывают диалог.
  - Target Files: `apps/web/src/components/admin/models/model-provider-dialog.tsx` (new), `apps/web/src/components/admin/models/model-providers-table.tsx`, `apps/web/src/lib/admin/admin-texts.ts` (тексты MC-4).
  - Dependencies: Task 3.3, Task 1.2.
  - Тестов своих нет: INT-1 (Task 7.1).
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: в каждом пути построения тела ключ есть только при непустом введённом значении; поле ключа не получает сохранённого значения ни в каком виде; `hasChange` не пропускает пустой `PATCH`.

#### Operational Verification Procedures

Выполняются в Final Phase (Task Q.3).

1. `grep -rn "apiKey" apps/web/src --include=*.ts --include=*.tsx` вне `test/` и `*.test.*` — только `model-provider-dialog.tsx` (тело запроса) и типы; `grep -rn "logger\." apps/web/src/components/admin/models` — ни один вызов не получает значение формы ключа.
2. `grep -rnE "#[0-9a-fA-F]{3,6}\b|bg-white|bg-black|text-white|text-black|oklch\(" apps/web/src/components/admin/models` — пусто.

### Phase 4: Диалог модели
**Purpose**: Администратор добавляет модель провайдера с назначением: модель чата — с ценами, как сегодня, модель эмбеддингов — с ценой ввода и размерностью.

#### Tasks

- [x] **Task 4.1: Диалог модели по назначению (MP-06)** — covers DD Flow 2 (добавление и Failure handling), Contract Definitions `adminApi.models` (`create` шлёт id целиком), Building-block `ModelDialog`, правила модели, `AdminSelectField`, «Доступность и ширина» (фокус после «Выбрать по умолчанию»), Логирование (`admin: model create`, `admin: model save`); UXRD Screen 3, MP-06, MC-7; AC-13.1, AC-13.2, AC-05.1, AC-05.2, AC-05.3 (видимая сторона), DC-2
  - Pattern: спецификация [settings-form.md](../../../design-system/components/settings-form.md) («Форма диалога»).
  - `components/admin/models/model-dialog.tsx`, добавление: «Провайдер» — `AdminSelectField` всех провайдеров по имени, подпись «{имя} · {тип}», единственный выбран сразу; «Назначение» — радиогруппа «Чат» / «Эмбеддинги», выбран «Чат»; у провайдера вида `anthropic` варианта «Эмбеддинги» нет и под радиогруппой подсказка «У Anthropic нет моделей эмбеддингов.», выбор такого провайдера возвращает «Чат»; «Имя модели у провайдера» Mono с подсказкой MC-7 и Caption «ID: {провайдер}/{имя}»; «Название»; цены по назначению: чат — четыре цены и «Другие цены для длинных запросов», как сегодня; эмбеддинги — «Вход» под «$ за 1 млн токенов» и «Размерность» с подсказкой MC-7. Смена назначения убирает поля другого назначения вместе с введённым. Тело: чат — `{ id, name, purpose: 'chat', prices, longContext }`; эмбеддинги — `{ id, name, purpose: 'embedding', inputUsdPerMTok, dimensions }`, без цен вывода и кэша.
  - Изменение: строкой текста «{ID} · {назначение}», у эмбеддингов «· {размерность}»; меняются только «Название» и цены своего назначения; `PATCH` эмбеддинга — `name` и `inputUsdPerMTok`. Временное состояние `core` Task 1.2 (`valuesOf` с пустыми ценами у эмбеддингов, создание всегда `purpose: 'chat'`) уходит.
  - Отказы — `describeAdminError` с `providerName`: 409 `MODEL_ID_TAKEN` — у поля «Имя модели у провайдера»; 422 `MODEL_PROVIDER_INVALID` — ошибка формы MC-7; введённое остаётся.
  - Успех добавления — `reloadAll`; уведомление «Модель добавлена»; если модель по умолчанию её назначения не выбрана — действие «Выбрать по умолчанию», которое ставит фокус в поле MP-01 по `MODEL_DEFAULT_FIELD_ID` (Task 3.2). Закрытие диалога — фокус на кнопку, которая его открыла.
  - `catalog-section.tsx` передаёт диалогу провайдеров и модели по умолчанию.
  - Target Files: `apps/web/src/components/admin/models/model-dialog.tsx`, `apps/web/src/components/admin/models/catalog-section.tsx`, `apps/web/src/lib/admin/admin-texts.ts` (тексты MC-7 диалога).
  - Dependencies: Task 3.2, Task 1.2.
  - Тестов своих нет: INT-3 (Task 7.2); правила полей — строки Task 1.2.
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: у эмбеддинга в теле нет ни одной цены, кроме `inputUsdPerMTok`; id собирается из провайдера и имени, а не вводится целиком.

#### Operational Verification Procedures

Выполняются в Final Phase (Task Q.3).

1. `grep -rn "modelIdFormat\|ID модели" apps/web/src` — пусто (старое поле и правило удалены).

### Phase 5: Выбор модели
**Purpose**: Везде, где человек выбирает модель, — только модели чата с провайдером; модель неработающего провайдера помечена и не мешает сохранению; запись без своей модели названа моделью по умолчанию.

#### Tasks

- [x] **Task 5.1: Подпись модели: название из списка, запись без своей модели; пометка на странице записи** — covers DD KD-6, Contract Definitions `formatModel`, Building-block `formatModel`, `ModelHint`, C3 «выбор модели в редакторе» (`RecordPage`), таблица мест («`ModelHint` страницы записи»); UXRD MP-08 («Запись без своей модели»), MC-8, MC-12 (страница записи); AC-14.3 (страница записи), AC-06.1 (подпись)
  - `lib/agents/format.ts`: `formatModel(model, names?)` — `names` необязателен: `models` (модели с названиями) и `defaultModel` (модель чата по умолчанию: id, `null` — не выбрана, нет поля — неизвестна). Своя модель — название из `models`, иначе короткое имя Claude или id, как сегодня. `null`: `defaultModel` — id → «Модель по умолчанию · {подпись модели по умолчанию}»; `null` → «Модель по умолчанию — не выбрана»; неизвестна → «Модель по умолчанию». Нынешние вызовы без `names` не меняются, кроме прописной «М» у `null`.
  - `components/library/definition-view.tsx`: необязательное свойство `modelNames` уходит в каждый `formatModel` (модель агента, координатора, исполнителей).
  - `components/library/record-page.tsx`: в просмотре передаёт `DefinitionView` `modelNames` — `models` из `accessApi.models`, `defaultModel` из `choices`. `ModelHint` сегодня монтируется только при `missingModel` из `record.missingRights`, а там сервер перечисляет лишь модели без права (`apps/api/src/library/record-view.ts`); поэтому просмотр монтирует `ModelHint` и для своей модели записи (`content.model` агента, модель координатора workflow), если её строка в `accessApi.models` несёт `unavailableReason`. Такая модель — строка MC-12 «{Причина} — {вид} не запустится» (причина — слова MC-9 по модели, Task 6.1 даёт функцию; до неё — короткая причина MC-8 из `lib/admin/model-providers.ts`, Task 6.1 переводит вызов на `providerReasonText`); нет права — тексты как сегодня. Модель `null` пометки не получает.
  - Target Files: `apps/web/src/lib/agents/format.ts`, `apps/web/src/lib/agents/format.test.ts` (new), `apps/web/src/components/library/definition-view.tsx`, `apps/web/src/components/library/record-page.tsx`.
  - Dependencies: Task 1.2.
  - Тест: `format.test.ts` (new), одна таблица `formatModel`: id Claude → короткое имя; id в списке → название; id вне списка → id; `null` без `names`, с моделью по умолчанию из списка, с `defaultModel: null`. (Шапка скелета называет этот файл «existing» — его нет, он создаётся здесь.)
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: вызовы без `names` дают прежний текст; `ModelHint` монтируется и без `missingModel`, когда модель записи не работает из-за провайдера.

- [x] **Task 5.2: Поле «Модель» и баннер редактора: модели чата с провайдером, пометка неработающей, вариант «Модель по умолчанию»** — covers DD KD-5, KD-6, C3 «выбор модели в редакторе» (`ModelField`, `ModelBanner`, координатор и исполнители), Flow 4, Contract Definitions `EditorChoices.models`, `EditorChoices.defaultModel`, Building-block `ModelField`, `ModelBanner`, `EditorChoices`, `blankAgent`, `blankWorkflow`, `blankExecutor`; спецификация record-editor часть 4; UXRD MP-08, MC-8, MC-12 (баннер), Accessibility «Имена» (вариант списка); AC-14.1, AC-14.3, AC-06.1, DC-3
  - Pattern: спецификации [record-editor.md](../../../design-system/components/record-editor.md) (часть 4), [state-badge.md](../../../design-system/components/state-badge.md).
  - `components/library/agent-fields.tsx`: `EditorChoices.models` — модели с `model`, `name` и `unavailableReason` (у сотрудника — строки `MyModel` как есть, провайдер — `modelProvider(model)`). `ModelField`: варианты — `modelOptions` чата (Task 1.2) с готовностью `null`, название и Caption провайдера справа, на узкой ширине провайдер под названием; закрытое поле «{название} · {провайдер}». Модель записи с `unavailableReason` — первая, недоступна, метка «Выключено» с короткой причиной MC-8, имя «{название}, провайдер {провайдер}, {причина}». Запись с моделью `null` — первый вариант «Модель по умолчанию · {название}» / «Модель по умолчанию — не выбрана» (`formatModel` с `names`, Task 5.1); выбор другой модели даёт записи свою. Модель без права — как сегодня («у вас недоступна», отказ при сохранении). `ModelBanner` знает два вида: без права — как сегодня; провайдер не работает — MC-12 «{Причина} — {вид} не запустится» и «Заменить на {модель}», где замена — `choices.defaultModel`, если она работает, иначе первый предложенный вариант (Notes, пункт 7); нет работающих вариантов — баннер без замены. Сохранение с неработающей моделью не блокируется.
  - `blankAgent`, `blankWorkflow` (`workflow-fields.tsx`) и `blankExecutor` кладут `defaultModel` как есть, `null` тоже. Координатор и исполнители берут тот же `ModelField` (`workflow-fields.tsx`, `executor-panel.tsx`) — правки там только если `tsc` их назовёт.
  - `record-page.tsx`: `EditorChoices.models` — `models.data?.models` с `unavailableReason`.
  - `components/admin/library/system-record-page.tsx`: строит `EditorChoices.models` как `{ model, name }` и без поля не компилируется — пока ставит `unavailableReason: null`; настоящую готовность по списку провайдеров даёт Task 5.3.
  - Тесты, которые читают подписи поля: `components/shell/custom-agents-web.int.test.tsx` — перед правкой `grep` строк поля «Модель», вариантов и баннера; ожидания, которые меняет новая подпись, правятся в этой задаче.
  - Target Files: `apps/web/src/components/library/agent-fields.tsx`, `apps/web/src/components/library/workflow-fields.tsx`, `apps/web/src/components/library/executor-panel.tsx`, `apps/web/src/components/library/record-page.tsx`, `apps/web/src/components/admin/library/system-record-page.tsx` (временное `unavailableReason: null`), `apps/web/src/components/shell/custom-agents-web.int.test.tsx` (только ожидания подписей).
  - Dependencies: Task 5.1.
  - Тестов своих нет: INT-4 (Task 7.3); отбор вариантов — таблица Task 1.2.
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: модель записи не подменяется при открытии и сохранении; модель эмбеддингов в варианты не попадает.

- [x] **Task 5.3: Диалог права, редактор записи компании, «Мой доступ»** — covers DD KD-5 (панель — по списку провайдеров), C3 «выбор модели в редакторе» (`SystemRecordPage`), «Данные экранов» (редактор системной записи, диалог права), таблица мест (`GrantForm`, `ModelsSection`), Building-block `GrantForm`, `ModelsSection`; UXRD MP-08 («Мой доступ», диалог права), MC-8; AC-14.2, AC-14.1 (панель), AC-14.3 («Мой доступ»)
  - `components/admin/grants/grant-dialog.tsx`: второе чтение `adminApi.modelProviders.list`; список «Модель» — `modelOptions` чата с готовностью `null` (эмбеддингов и моделей неработающих провайдеров нет), подпись — название и провайдер. Частный `SelectField` не переписывается: меняются только `options`.
  - `components/admin/library/system-record-page.tsx`: третье чтение `adminApi.modelProviders.list`; `EditorChoices.models` — модели чата каталога с `unavailableReason` от `modelUnavailableReason`.
  - `components/account/models-section.tsx`: под названием модели Caption с `modelProvider(model)`; `unavailableReason` не `null` — метка «не работает», состояние «Выключено»; строка остаётся.
  - Тесты, которые читают эти места: `components/account/models-section.test.tsx` и диалог права в `components/shell/enterprise-access-admin.int.test.tsx` — перед правкой `grep` текстов вариантов и строк; ожидания, которые меняет подпись провайдера, правятся здесь. Обработчик `GET /api/admin/model-providers` по умолчанию уже есть (Task 1.1).
  - Target Files: `apps/web/src/components/admin/grants/grant-dialog.tsx`, `apps/web/src/components/admin/library/system-record-page.tsx`, `apps/web/src/components/account/models-section.tsx`, `apps/web/src/components/account/models-section.test.tsx`, `apps/web/src/components/shell/enterprise-access-admin.int.test.tsx` (только ожидания диалога права).
  - Dependencies: Task 5.2, Task 1.1.
  - Тестов своих нет: диалог права — INT-4, строка диалога права.
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: правило готовности в панели — только `modelUnavailableReason`.

#### Operational Verification Procedures

Выполняются в Final Phase (Task Q.3).

1. `grep -rn "unavailableReason\|modelUnavailableReason" apps/web/src --include=*.tsx` вне тестов — только `agent-fields.tsx`, `record-page.tsx`, `system-record-page.tsx`, `grant-dialog.tsx`, `models-section.tsx` и блоки раздела «Модели»; ни одного своего разбора `state` провайдера вне `lib/admin/model-providers.ts`.

### Phase 6: Причины сбоев и отказов
**Purpose**: Сбой и отказ из-за провайдера называют модель и то, что случилось, во всех местах, которые уже показывают сбои; отказ первого сообщения стоит у поля сообщения.

#### Tasks

- [x] **Task 6.1: Слова причин провайдера в строке события, отчёте и блоке ошибки ответа** — covers DD KD-7 (`providerReasonText`, `CHAT_FAILURE_REASONS`), Contract Definitions `providerReasonText`, `failureReasonText`, Building-block `providerReasonText`, `chatFailureText`, `failureReasonText`, строка события сбоя провайдера, таблица мест (строка события, отчёт, блок ошибки ответа), «Отличия от UXRD» (отчёт без названия модели; блок ответа называет модель по id); UXRD MP-09 (строки 2 и 4), MC-9, MC-10, MC-11; AC-09.2, AC-09.3, AC-09.4, AC-09.5, AC-04.2 (видимая сторона), DC-4
  - Pattern: спецификации [agent-status.md](../../../design-system/components/agent-status.md), [agent-report.md](../../../design-system/components/agent-report.md).
  - `lib/agents/format.ts`: `providerReasonText(reason, model?)` — слова MC-9 по шести `provider_*` с подписью модели, без модели — те же слова без названия. Лежит рядом с `failureReasonText`, а не в `access-texts.ts`: `access-texts.ts` уже импортирует `format.ts`, и обратный импорт дал бы круг (Notes, пункт 6). `failureReasonText(reason, model?)` берёт её; шесть записей `provider_*` в `NAMED_FAILURE_REASON` (временные слова `core` Task 1.2) удаляются — одно место для MC-9. Подсказка второй строкой MC-10: «Исправить это может администратор Agent OS. Потом напишите, чтобы продолжить.», у `provider_unavailable` — «Напишите, чтобы попробовать снова. Если сбой повторится, сообщите администратору Agent OS.».
  - `components/agents/event-line.tsx`: строка сбоя провайдера по образцу `QuotaFailureLine` — название модели из `accessApi.modelsForFeed`, «Сбой: {причина} · {время}» и подсказка второй строкой; объявление «Работа завершена сбоем: {причина}». `components/agents/agent-report.tsx` — «Причина: {причина}» без модели, правок нет, если `failureReasonText` без модели даёт MC-9.
  - `lib/access/access-texts.ts`: `CHAT_FAILURE_REASONS` + шесть `provider_*` (иначе сбой корня рисуется строкой события, а не блоком ответа — `to-feed.ts` решает по `isChatFailureReason`); `chatFailureText` — MC-11 «{Причина}. Обратитесь к администратору Agent OS.», у `provider_unavailable` — «Провайдер модели {модель} не отвечает. Попробуйте перегенерировать позже.».
  - `record-page.tsx`: `ModelHint` берёт `providerReasonText` (Task 5.1 оставила короткую причину MC-8); `agent-fields.tsx`: баннер MC-12 — так же.
  - Target Files: `apps/web/src/lib/agents/format.ts`, `apps/web/src/lib/agents/format.test.ts`, `apps/web/src/components/agents/event-line.tsx`, `apps/web/src/components/agents/agent-report.tsx` (только если `tsc` назовёт), `apps/web/src/lib/access/access-texts.ts`, `apps/web/src/lib/access/access-texts.test.ts`, `apps/web/src/components/library/record-page.tsx`, `apps/web/src/components/library/agent-fields.tsx`.
  - Dependencies: Task 5.2.
  - Тесты: строки таблицы `format.test.ts` — `failureReasonText` по шести причинам с моделью и без, подсказка у `provider_unavailable`; строки первой таблицы `access-texts.test.ts` — `chatFailureText` по шести причинам. Ловит: слова не той причины и пропавшую причину в списке блока ответа.
  - Проверка: `pnpm --filter web typecheck`. Ревьюер читает: слова MC-9 есть ровно в одном месте.

- [x] **Task 6.2: Отказ старта: блок вызова, «Запустить с нуля», первое сообщение у поля сообщения** — covers DD KD-7 (`startRefused`, `describeRefusal` библиотеки, первое сообщение), Building-block `startRefused`, `describeRefusal` библиотеки, таблица мест (блок вызова, поле сообщения), Acceptance Criteria DC-5; UXRD MP-09 (строки 1 и 3), MC-11 (у поля сообщения), MC-12 (отказ в блоке вызова), Accessibility (отказ первого сообщения — `alert`); AC-02.1, AC-09.1 (видимая сторона)
  - `lib/library/library-errors.ts`: `startRefused` — у первого сообщения (`where: 'first_message'`): `model_not_configured` → место `composer`, MC-11 «Модель для чата не настроена. Обратитесь к администратору Agent OS.»; `provider_missing`, `provider_disabled`, `provider_key_missing` с моделью → `composer`, MC-11 «{Причина}. Обратитесь к администратору Agent OS.»; прежние причины — как сегодня. У «Запустить с нуля» — четыре причины → MC-12 «{Причина} — {вид} не запустился», у `model_not_configured` причина — «Модель не настроена». `describeRefusal` — четыре причины `start_agent` и `start_workflow` → MC-12 «{Причина} — {вид} не запустился» и «Открыть», модель — из `refusalDetail.model`. Причины — `providerReasonText` (Task 6.1) и «модель не настроена» MC-9.
  - Поле сообщения уже показывает `notice` отказа под полем и возвращает текст в поле (`thread.aui.tsx` `useSendFailure`, `feed-store.ts` `deliver`). Строка под полем (`data-slot="aui_composer-send-failure"`) сегодня без роли; она получает `role="alert"` (UXRD Accessibility: отказ первого сообщения — `alert`). Перед правкой — `grep -rn "getByRole('alert')\|findByRole('alert')\|getAllByRole('alert')" apps/web/src/components/shell`: тест беседы, где второй `alert` сделает запрос неоднозначным, уточняется в этой задаче.
  - `refusalText` (`access-texts.ts`) не меняется: четыре причины приходят только от `start_agent` и `start_workflow`, а их блок вызова идёт через `describeRefusal` (`tool-fallback.aui.tsx`, `LIBRARY_TOOLS`).
  - Target Files: `apps/web/src/lib/library/library-errors.ts`, `apps/web/src/lib/library/library-errors.test.ts`, `apps/web/src/components/assistant-ui/elements/thread.aui.tsx` (роль строки под полем); тест оболочки из `grep` выше — только если запрос `alert` стал неоднозначным.
  - Dependencies: Task 6.1.
  - Тесты: строки таблицы `library-errors.test.ts` — первое сообщение: `model_not_configured` без модели, `provider_disabled` с моделью; «Запустить с нуля»: `provider_key_missing`; `describeRefusal`: `provider_missing`, `model_not_configured`. Ловит: общий текст «Сообщение не отправилось» вместо причины и отказ старта без «Открыть».
  - Проверка: `pnpm --filter web typecheck`.

#### Operational Verification Procedures

Выполняются в Final Phase (Task Q.3).

1. `grep -rn "не принял описание инструментов\|отклонил ключ" apps/web/src --include=*.ts --include=*.tsx` вне тестов — только `lib/agents/format.ts`.

### Phase 7: Интеграционные тесты
**Purpose**: Заполнить пять скелетов `model-providers-web.int.test.tsx` и убрать из старого теста часть каталога, которую заменяет INT-3. Тесты пишутся, не запускаются: первый прогон — quality gate.

Правило заполнения: строка теста заполняется, только когда каждая строка, роль и элемент её проверок уже есть в коде (Phases 1–6), включая отрицательные проверки. Шапка скелета написана по дизайну 1.0: где она расходится с текстом задачи (имена файлов unit-таблиц, «existing» у `format.test.ts`, строка `openai/x`), верна задача.

#### Tasks

- [x] **Task 7.1: INT-1 и INT-2 — ключ провайдера и удаление** — covers DD Test Strategy UC-1, UC-E1, KD-1, KD-4, Flow 3; AC-12.1, AC-12.2, AC-01.1, DC-1 → INT-1; AC-12.3, AC-01.3 → INT-2
  - INT-1 по пунктам скелета: оба `POST` и `PATCH` — по телам из `trackRequests`; отсутствие `apiKey` — отсутствие ключа объекта, не пустая строка и не `null`; полный ключ — строкой-литералом — нет ни в DOM после закрытия, ни в `logRecords`; после каждой из трёх записей — по одному `GET` трёх ресурсов.
  - INT-2: строки A и B скелета с `resetRow()`; в строке A запросов `DELETE` нет и в окне одна кнопка; в строке B — один `DELETE /api/admin/model-providers/local`, окно открыто с текстом MC-5, по одному новому `GET` трёх ресурсов.
  - Target Files: `apps/web/src/components/shell/model-providers-web.int.test.tsx`.
  - Dependencies: Task 3.4.
  - Ревью тестов: да (ключ).
  - Проверка: `pnpm --filter web typecheck`.

- [x] **Task 7.2: INT-3 — диалог модели; часть каталога уходит из старого теста** — covers DD Test Strategy UC-2, Flow 2, Fact Disposition P15; AC-13.1, AC-13.2, AC-05.1, AC-05.2, AC-05.3, DC-2 → INT-3
  - INT-3 по пунктам скелета: у `anthropic` нет варианта «Эмбеддинги»; тела двух `POST` — литералами; строки каталога «Эмбеддинги · 768» и «Чат»; два 422 — тексты MC-7, введённое на месте. Список каталога в MSW — фикстура обоих назначений.
  - `components/shell/enterprise-access-admin.int.test.tsx`: часть каталога INT-2 (строка 8 «catalogue (AD-11)» в описании и её код — таблица «Модели», добавление по id целиком, 409 `MODEL_ID_TAKEN` у «ID модели», удаление модели) удаляется вместе с константами и импортами, у которых не остаётся пользователей. Остальное INT-2 (аккаунты, роли, права) не меняется.
  - Target Files: `apps/web/src/components/shell/model-providers-web.int.test.tsx`, `apps/web/src/components/shell/enterprise-access-admin.int.test.tsx`.
  - Dependencies: Task 4.1, Task 7.1 (тот же файл).
  - Ревью тестов: да (переписанный тест каталога).
  - Проверка: `pnpm --filter web typecheck`.

- [x] **Task 7.3: INT-4 и INT-5 — выбор модели, причины в беседе** — covers DD Test Strategy UC-4, UC-E2, Flow 4; AC-14.1, AC-14.2, AC-14.3, DC-3 → INT-4; AC-09.2–AC-09.5, AC-04.2, AC-02.1, AC-09.1, DC-4, DC-5 → INT-5 (проводка; слова — строки таблиц Task 6.1, 6.2)
  - INT-4 по пунктам скелета, включая короткую строку модели без права (метка «у вас недоступна», 422 `model_not_allowed` у поля); диалог права открывается из роли.
  - INT-5: строка A — блок ошибки ответа с литералами MC-11 для `provider_disabled` и `provider_unavailable`, строки события нет; строка B — 409 `START_REFUSED` `model_not_configured` на первое сообщение новой беседы: текст в поле, MC-11 под полем, блока ответа нет. Модель называется по id («Haiku»), как записано в дизайне.
  - Target Files: `apps/web/src/components/shell/model-providers-web.int.test.tsx`.
  - Dependencies: Task 5.3, Task 6.2, Task 7.2 (тот же файл).
  - Проверка: `pnpm --filter web typecheck`.

#### Operational Verification Procedures

Интеграционные тесты фазы — сами проверки точек стыка веба с ответами API; их прогон — quality gate (Task Q.1).

### Final Phase: Quality Assurance (Required)
**Purpose**: Один quality gate части, ревью тестов риск-задач, аудит тестов и проверки фаз.

#### Tasks

- [x] **Task Q.1: Quality gate** — `pnpm --filter web lint`, `pnpm --filter web typecheck`, `pnpm --filter web test` (unit и интеграционные тесты веба), `pnpm knip`. Каждая команда запускается отдельно: `pnpm check` одной командой останавливается на первой упавшей задаче. Падения исправляются, gate повторяется целиком. e2e- и verify-наборы бэкенда не запускаются.
- [x] **Task Q.2: Ревью тестов и аудит** — `integration-test-reviewer` по Task 7.1 (ключ) и Task 7.2 (переписанный тест каталога); один `test-auditor` по тестам части; исправления — до повторного Task Q.1. Итог аудита — Notes, пункт 15.
- [x] **Task Q.3: Процедуры фаз** — Operational Verification Procedures Phase 1–6 по порядку; итог в Progress Tracking.
- [x] Каждый AC FR-12, FR-13, FR-14, FR-16 и видимая сторона AC `core` из дизайна доказаны тестом карты скелета (AC proof map) или строкой unit-таблицы и проходят; только ручные — в Owner Checklist.
- [x] Тесты в бюджете части: пять INT скелета (три по умолчанию и два сверх — их «Catches» в шапке скелета), unit-таблицы `model-providers.test.ts`, `format.test.ts`, строки `form-rules`, `admin-errors`, `access-texts`, `library-errors`; правленые ожидания `custom-agents-web`, `enterprise-access-admin`, `models-section`. Ничего сверх (одна добавленная строка INT-4 — строка существующего теста, Notes пункт 15).
- [ ] **Браузерные проверки — не выполнены.** Строки Owner Checklist никто не прошёл: браузерной автоматики в среде не было. Остаются за владельцем.

#### Operational Verification Procedures

1. Task Q.1 зелёный: все четыре команды без ошибок.
2. Процедуры Phase 1–6 (Task Q.3) дали ожидаемый результат.
3. `grep -rn "provider_" apps/web/src/lib/agents/format.ts` — причины `provider_*` только в `providerReasonText`, `NAMED_FAILURE_REASON` их не держит.

## Verification Strategy

- **Correctness definition and method**: веб шлёт ровно те тела, которые называет экран (ключ — только введённый, модель — id из провайдера и имени, поля своего назначения), после каждого изменения раздела перечитывает три ресурса, предлагает в выборе только модели чата работающих провайдеров, не подменяет модель записи и называет причину провайдера в нужном месте. Правила, варианты, перевод ошибок и слова причин — unit-таблицы; проводка экранов, форм и клиента на ответах API — INT-1–INT-5 на настоящей оболочке с границей MSW; ширина, тема, фокус и сеть настоящего браузера — Owner Checklist.
- **Early verification point**: первая проверка поведения — unit-таблицы Task 1.1 и Task 1.2 в quality gate; до неё каждая задача держит `typecheck` веба зелёным. Если таблица правил падает, исправляется правило, а не экраны.
- **Output comparison**: нынешние тесты веба (`enterprise-access-admin` без части каталога, `custom-agents-web`, `data-table.test.tsx`, `confirm-dialog.test.tsx`, `models-section.test.tsx`) сохраняют свои утверждения, кроме подписей с провайдером; их зелёный прогон показывает, что общие компоненты и другие разделы панели не изменились.
- **Proof obligations** (строки «Catches» скелета):
  - INT-1: ключ уходит в `PATCH`, где его не меняли (`apiKey: ""` стирает сохранённый ключ), или виден в диалоге; блок не перечитан после изменения в соседнем.
  - INT-2: «Удалить» шлёт `DELETE` провайдеру, у которого таблица знает модели, или показывает сырую ошибку; окно подтверждения закрывается на 409.
  - INT-3: старый диалог с id целиком, тело модели эмбеддингов с ценами чата или имя без провайдера; список каталога не разбирает строку эмбеддинга.
  - INT-4: запись на выключенном провайдере нельзя сохранить или она сохраняется с подменённой моделью; модели эмбеддингов в выборе модели чата.
  - INT-5: сбой провайдера нарисован строкой события вместо блока ответа; отказ первого сообщения стёр текст поля или встал туда, где у беседы нет строки.

## Risks and Countermeasures

- **Risk**: Ключ уходит в запрос, когда администратор его не менял, или остаётся в форме после сохранения.
  - **Impact**: Высокое: прежний ключ стёрт или ключ виден дольше нужного.
  - **Countermeasure**: Правило тела в одном месте (Task 3.4), `secretFields` формы, чтение ревьюером каждого пути тела; INT-1 и его ревью (Task Q.2); строка Network в Owner Checklist.
- **Risk**: Новое чтение `GET /api/admin/model-providers` в диалоге права и редакторе записи компании ломает существующие тесты (`onUnhandledRequest: 'error'`) или прячет их модели.
  - **Impact**: Массовые падения на gate без связи с поведением.
  - **Countermeasure**: Обработчик по умолчанию с готовым `anthropic` в `msw-server.ts` (Task 1.1) раньше первых чтений (Task 5.3).
- **Risk**: Подписи с провайдером и переписанный каталог ломают ожидания соседних тестов, которые `typecheck` не видит.
  - **Impact**: Красный gate в файлах, которые задача не трогала.
  - **Countermeasure**: Task 5.2 и 5.3 правят ожидания `custom-agents-web`, `enterprise-access-admin`, `models-section.test.tsx` в том же шаге после `grep`; часть каталога старого теста удаляет Task 7.2.
- **Risk**: Блоки раздела расходятся после изменения.
  - **Impact**: Число моделей, «Нет провайдера» или предупреждение MP-01 показывают старое.
  - **Countermeasure**: Одна `reloadAll` в `ModelsScreen` (Task 3.1), каждое изменение блоков зовёт её; INT-1 считает чтения.
- **Risk**: `ActionsMenu` начинает применять `disabled`.
  - **Impact**: Слабое: таблиц с меню и `disabled` в коде нет.
  - **Countermeasure**: Ручная проверка UC-5 (Owner Checklist).
- **Risk**: Тесты пишутся без прогона до quality gate.
  - **Impact**: Ошибки всплывают разом в конце.
  - **Countermeasure**: `typecheck` в каждой задаче; ревью тестов Task 7.1 и 7.2.

## Progress Tracking

| Пункт | Задача | Результат |
|---|---|---|
| Итог gate: команды, число повторов, что исправлено | Task Q.1 | Зелёный: `pnpm --filter web lint` чист, `pnpm --filter web typecheck` чист, тесты `web` — 62 файла, 598 тестов, `pnpm knip` чист; проверка типов `contracts`, `agents`, `api` чиста; unit `contracts` 68, `agents` 229; e2e `model-providers` повторены: `agents` 7/7, `api` 6/6. `lint` нашёл два дефекта, которых не видела проверка типов, — исправлены (Notes, пункт 15) |
| Вердикты ревью тестов Task 7.1, 7.2 и аудита | Task Q.2 | Аудит: оставить всё; одну повторённую таблицу из шести строк текстов причин провайдера можно слить; ничего не удалено |
| Итоги процедур Phase 1–6 | Task Q.3 | Все проходят (прогон при закрытии плана, 2026-11-20). Phase 1: адресов провайдеров и моделей по умолчанию вне `admin-api.ts` нет; число 4096 в `form-rules.ts` — граница общего токена серверов, не правило модели. Phase 2: `git diff` по `servers`, `sign-in`, `roles` пуст. Phase 3: `apiKey` вне диалога — только типы, тексты, правило формы и флаг `apiKeySet`; ни один `logger.` не получает ключ; своих цветов нет. Phase 4: `modelIdFormat` и «ID модели» исчезли. Phase 5: `unavailableReason` — только в названных файлах и блоках «Модели». Phase 6: тексты причин — только в `lib/agents/format.ts` |

## Notes

1. **Правила владельца.** Задача пишет тесты, но не запускает их; внутри задачи — одна проверка `pnpm --filter web typecheck` и чтение. Коммитов нет, git worktree, stash и reset нет, задачи идут по одной. Единственный gate — Task Q.1. Ревью тестов — только Task 7.1 (ключ) и Task 7.2 (переписанный тест каталога); один аудит тестов части в Task Q.2. Сервер `api`, e2e- и verify-наборы бэкенда и `pnpm db:*` не запускаются.
2. **Общие компоненты.** Таблица, поле секрета, переключатель и формы панели получают только необязательные свойства (Phase 2); нынешние экраны не меняются. Окно «Нельзя удалить» — обычный `AlertDialog` из `ui`, `ConfirmDialog` не меняется.
3. **Дизайн устарел в статусе и вопросах.** `design-web.md` ещё пишет «На утверждении» и держит Open Questions 1–5 к `core`; все пять решены так, как дизайн предлагал (имена `ModelProvider…`, тело `POST /api/admin/models` по назначению, `model` в 422 `MODEL_DEFAULT_INVALID`, причины и поля в `contracts`; пометки в строке библиотеки нет). Вопросы 6 и 7 к UXRD закрыла UXRD 1.1. План считает их решёнными.
4. **«Нужен ключ» — по `keyRequired`.** Таблица дизайна решает метку по типу провайдера; `ModelProviderView` несёт `keyRequired` (design-core 1.2), и метка — `keyRequired && !apiKeySet`. Своей копии правила «какой тип требует ключ» в вебе нет.
5. **Запись без своей модели — по UXRD 1.1.** Поле «Модель» и страница записи пишут «Модель по умолчанию · {название}» с названием текущей модели чата по умолчанию (`choices.defaultModel`), пока её нет — «Модель по умолчанию — не выбрана» (MC-8). Дизайн (KD-6, Open Question 6) писал «Модель по умолчанию»; так остаётся только там, где модель по умолчанию неизвестна (вызовы `formatModel` без `names`). Отказ первого сообщения у поля сообщения UXRD 1.1 приняла сама: строки 1 и 2 таблицы «Отличия от UXRD» больше не отличия.
6. **`providerReasonText` — в `lib/agents/format.ts`.** Дизайн кладёт её в `access-texts.ts`, но `access-texts.ts` и `library-errors.ts` уже импортируют `formatModel` из `format.ts`, а `failureReasonText` живёт в `format.ts`; функция рядом с ней не создаёт круга импортов. Её берут все пять мест, как в KD-7.
7. **Замена в баннере MC-12.** Дизайн и UXRD пишут «Заменить на {модель}», не называя, какую. План берёт ту же цель, что нынешний баннер модели без права, — `choices.defaultModel`, — а если она `null` или сама не работает, первый предложенный вариант; нет вариантов — баннер без замены.
8. **Шапка скелета и код.** Шапка написана по дизайну 1.0: `lib/agents/format.test.ts` назван «existing», а его нет — его создаёт Task 5.1; строки `openai/x is rejected` в `form-rules.test.ts` нет — правило «только `anthropic/`» уже заменено в `core` Task 1.1 на `ModelIdSchema`, и уходят строки `model id Foo/x` и `model id x` вместе с полем id (Task 1.2); `refusalText` в списке unit-строк не меняется (Task 6.2). Где комментарий скелета расходится с текстом задачи, верна задача.
9. **Временные состояния `core` Task 1.2**, которые эта часть заканчивает: `formatModel(null)` → «модель по умолчанию» (Task 5.1); шесть `provider_*` в `NAMED_FAILURE_REASON` без модели (Task 6.1 переносит в `providerReasonText`); диалог модели всегда `purpose: 'chat'` и пустые цены у эмбеддинга (Task 4.1); «—» у цен эмбеддинга в каталоге остаётся по UXRD (Task 3.1); запись с моделью `null` без выбранного варианта (Task 5.2).
10. **Только текст.** Текст ответа провайдера при проверке (`message`), имена провайдеров и моделей выводятся как текст, без разметки (Security Considerations).
11. **Цвета и комфорт долгой сессии.** Только токены дизайн-системы и существующие классы на них; своих цветов, чистого белого и чёрного нет.
12. **Логирование.** Только `src/lib/logger.ts` и `describeApiError`: метод, путь, статус, код, причина; ни тела запроса, ни ключа, ни `message` проверки.
13. **Удаляется то, что теряет вызывающего.** Чтение и `PageHeader` внутри `CatalogSection`, поле «ID модели», правило id целиком и `modelIdFormat`, цель `id` ошибок панели (если у неё не остаётся случаев), шесть `provider_*` в `NAMED_FAILURE_REASON`, часть каталога в `enterprise-access-admin.int.test.tsx` уходят в задачах, которые их заменяют.
14. **Поиск по коду.** Пути и символы проверены проходом `code-explorer` и чтением: все файлы дизайна на месте; потребители найдены текстовым поиском и прочитаны (LSP `findReferences` в этом репозитории находит только ссылки внутри файла).
15. **Итог постройки (2026-11-20).** Все 17 задач выполнены, gate зелёный (Progress Tracking).
    - Каждый новый тест прошёл с первого прогона.
    - `lint` нашёл два дефекта, которых не видела проверка типов: изменение объекта состояния в обработчике сохранения диалога модели и вызов `performance.now()` в теле компонента. Оба исправлены.
    - Три добавки сверх плана: булево `servesEmbeddings` в `ModelProviderView`, заполняемое из таблицы видов провайдера, — у веба нет своей копии правила; фокус на заголовок страницы после удаления провайдера; одна строка INT-4 — редактор записи компании предлагает только модели чата (что без фильтра она падает, не проверялось).
    - Аудит тестов: оставить всё; одну повторённую таблицу из шести строк текстов причин провайдера можно слить; ничего не удалено.
    - **Браузерные проверки не выполнял никто** — браузерной автоматики в среде не было. Owner Checklist остаётся открытым.

## Owner Checklist (manual, not tasks)

Браузерной автоматики в этой среде нет, и на 2026-11-20 ни одна строка не пройдена; владелец проходит строки после gate на `pnpm --filter web build && pnpm --filter web start` против настоящего `api` (провайдеры и модели по умолчанию в базе разработчика пусты, пока не выполнен `seed:access`).

- [ ] **Провайдер и ключ** (UC-1, L1): добавить Gemini с ключом, проверить из уведомления; изменить адрес, не трогая ключ. В Network тело `POST` с `apiKey`, тело `PATCH` без него; полного ключа нет ни в DOM, ни в одном ответе сети; строка итога «Работает».
- [ ] **Проверка подключения** (UC-5; AC-16.1, AC-15.1): верный ключ, неверный ключ, неверный адрес — «Работает · {время}», «Ключ отклонён: …», «Адрес недоступен: …»; объявления MC-6; пункт меню недоступен, пока проверка идёт; итог переносится и не уезжает с таблицей.
- [ ] **Модель и умолчание** (AC-13.3, AC-06.1): добавить модель эмбеддингов, «Выбрать по умолчанию», сохранить — фокус в «Модель эмбеддингов», `PUT` с её id, форма показывает сохранённое; новая запись в редакторе стоит на модели чата по умолчанию.
- [ ] **Предупреждения и подтверждения** (UC-6; AC-05.4, AC-06.2): модель без провайдера — «Нет провайдера»; выключение провайдера модели по умолчанию — MC-3, «Отмена» оставляет переключатель и фокус на нём; после выключения — «Выключено» и предупреждение MP-01; удаление модели по умолчанию — фраза MC-7; чат отвечает блоком MC-11.
- [ ] **Сбой в беседе**: неверный ключ у провайдера модели чата, отправить сообщение — блок «…отклонил ключ…», ответа провайдера нет ни на экране, ни в консоли.
- [ ] **Фокус и порядок Tab** (UXRD Accessibility): сверху вниз по блокам; после закрытия диалогов — на открывшую кнопку; после «Нельзя удалить» — на «⋯»; после удаления — следующая строка или `h1`.
- [ ] **360 px, светлая и тёмная тема**: «Модели», оба диалога и выбор модели без прокрутки страницы вбок; кнопки «Добавить …» под заголовками блоков; цели касания 44 px; цвета меток из токенов, без чистого белого и чёрного.

## Appendix: Traceability

### Reference Contract Values

| Design Doc (§ Section) | Contract Type | Required Observable Value (verbatim) | Covered By Task(s) |
|---|---|---|---|
| design-web.md (§ KD-4) | state-lifecycle-negative | При сохранении `ModelProviderDialog` кладёт `apiKey` в тело, только если введено непустое значение; иначе поля в теле нет, и `PATCH` оставляет прежний ключ (UXRD KD-3). | Task 3.4, Task 7.1 |
| design-web.md (§ KD-4) | exact-value | `apiKey: null` («убрать ключ») веб не отправляет: в UXRD такого действия нет. | Task 3.4 |
| design-web.md (§ KD-1) | state-lifecycle-negative | Форма моделей по умолчанию перемонтируется только тогда, когда сохранённые значения изменились, поэтому изменение в другом блоке не стирает её несохранённый выбор. | Task 3.2 |
| design-web.md (§ Данные экранов) | structure-order | любой `POST`, `PATCH`, `PUT`, `DELETE` раздела, затем все три чтения (KD-1) | Task 3.1–3.4, Task 4.1, Task 7.1 |
| design-web.md (§ Данные экранов) | exact-value | `POST /api/admin/model-providers/:name/check`; итог — состояние таблицы, без перечитывания | Task 3.3 |
| design-web.md (§ Как раздел «Модели» выбирает, что показать) | structure-order | Каталог веб сортирует по id, провайдеров показывает в порядке ответа (по имени), варианты выбора модели — по имени провайдера, затем по названию. | Task 1.2, Task 3.1, Task 3.3 |
| design-web.md (§ Как раздел «Модели» выбирает, что показать) | derived-display | `catalogModels` провайдера больше нуля · «Удалить» открывает окно «Нельзя удалить» MC-5 без запроса | Task 3.3, Task 7.1 |
| design-web.md (§ Клиент API) | exact-value | **`adminApi.modelProviders`** — `list`, `create`, `update(name, …)`, `remove(name)`, `check(name)` над маршрутами `/api/admin/model-providers`; имя в пути кодируется `encodeURIComponent`. | Task 1.1 |
| design-web.md (§ Клиент API) | exact-value | **`ApiRequestError.model`** — `api-request.ts` копирует строку `model` из тела любой ошибки, а не только `START_REFUSED` | Task 1.1 |
| design-web.md (§ Компоненты и функции) | state-lifecycle-negative | **`DataTableAction.disabled` в меню** — пункт меню недоступен; меню целиком по-прежнему недоступно только при `pending`. | Task 2.1 |
| design-web.md (§ Компоненты и функции) | state-lifecycle-negative | **`SavingSwitch.confirmOff`** — необязательно: выключение зовёт его вместо сохранения, переключатель остаётся включённым; вызывающий спрашивает подтверждение и сохраняет сам. | Task 2.2, Task 3.3 |
| design-web.md (§ Компоненты и функции) | exact-value | **`modelUnavailableReason(modelId, providers)`** — `null` или `provider_missing`, `provider_disabled`, `provider_key_missing` (KD-5). | Task 1.2 |
| design-web.md (§ Flow 3) | state-lifecycle-negative | `ConfirmDialog` остаётся открытым с текстом MC-5 «Не удалось удалить…», а раздел перечитывает три ресурса. | Task 3.3, Task 7.1 |
| design-web.md (§ Flow 4) | state-lifecycle-negative | Сохранение с этой моделью прошло, запись сохранила модель. | Task 5.2, Task 7.3 |
| design-web.md (§ Логирование) | exact-value | Проверка: `admin: model provider check` — имя провайдера, `result` и `durationMs`; текст `message` в лог не идёт | Task 3.3 |
| design-web.md (§ Security Considerations) | state-lifecycle-negative | `AdminForm.secretFields` стирает его после успеха; поле не отдаёт значение менеджерам паролей | Task 2.2, Task 3.4 |
| design-web.md (§ Acceptance Criteria) | exact-value | Первое сообщение беседы без модели чата по умолчанию оставляет текст в поле и показывает под ним MC-11 «Модель для чата не настроена…» (DC-5). | Task 6.2, Task 7.3 |
| design-web.md (§ Acceptance Criteria) | exact-value | Сбой агента с причиной провайдера показывает слова MC-9, а в беседе — блок ошибки ответа с текстом MC-11, а не строку события (DC-4). | Task 6.1, Task 7.3 |
| design-web.md (§ Acceptance Criteria) | exact-value | Добавление модели шлёт id `{провайдер}/{имя у провайдера}`; тело модели эмбеддингов несёт только цену ввода и размерность, тело модели чата — цены, как сегодня (DC-2). | Task 4.1, Task 7.2 |
| design-core.md (§ ModelProviderView) | derived-display | Веб решает, показать ли «Нужен ключ», по `keyRequired` и `apiKeySet` и своей копии правила не держит. | Task 3.3 |

### Failure Mode Checklist

| Category | Where it applies | Covered By Task(s) |
|---|---|---|
| same-value | изменение провайдера без нового ключа — ключа в теле нет; изменение в другом блоке не стирает несохранённый выбор MP-01 | Task 3.4, Task 3.2 |
| no-op | «Удалить» у провайдера с моделями — без запроса; «Отмена» подтверждения выключения — переключатель на месте | Task 3.3 |
| empty input | провайдеров нет (кнопка «Добавить модель» недоступна, пустой каталог MC-7); модель по умолчанию не выбрана; запись с моделью `null` | Task 3.1, Task 3.2, Task 5.1, Task 5.2 |
| invalid option | имя провайдера, длина ключа, адрес, размерность; эмбеддинги у Anthropic не предлагаются | Task 1.2, Task 4.1 |
| missing config | модель чата по умолчанию не выбрана — предупреждение MP-01 и отказ первого сообщения у поля | Task 3.2, Task 6.2 |
| unavailable boundary | провайдер выключен, не заведён, без ключа — пометка и сохранение; проверка без связи; чтение раздела упало | Task 5.2, Task 3.3, Task 3.2 |
| external failure | ключ отклонён, провайдер не отвечает, инструменты не приняты — слова причин | Task 6.1 |
| shared-state dependency | три ресурса раздела зависят друг от друга — `reloadAll`; итог проверки живёт в таблице | Task 3.1, Task 3.3 |
| secret exposure | ключ в теле без ввода, в форме после сохранения, в DOM, в логе | Task 2.2, Task 3.4, Task 7.1 |
| rollback-only visibility | поздний 409 удаления — окно открыто, провайдер на месте; отказ формы — введённое остаётся; отказ первого сообщения — текст в поле | Task 3.3, Task 3.4, Task 4.1, Task 6.2 |
| missing-sort-key ordering | каталог по id; варианты по провайдеру, затем по названию | Task 1.2, Task 3.1 |

### UXRD Component → Task Mapping

| UXRD Element | States to Cover | Covered By Task(s) | Gap Status | Notes |
|---|---|---|---|---|
| MP-01 | загрузка, ошибка, не выбрана, выбрать не из чего, выбранная не работает, сохранено, отказ | Task 3.2 | covered | |
| MP-02 | загрузка, ошибка, пусто, без ключа, выключен, подтверждение выключения, отказ переключателя, проверка | Task 3.3 | covered | отказ переключателя — под переключателем (Отличия от UXRD) |
| MP-03 | колонки, «Нет провайдера», пусто двух видов, кнопка недоступна, фраза удаления | Task 3.1 | covered | |
| MP-04 | новый, изменение, ключ задан, ошибки полей, отказ, провайдера уже нет | Task 3.4 | covered | |
| MP-05 | нельзя удалить, подтверждение, поздний отказ | Task 3.3 | covered | |
| MP-06 | чат, эмбеддинги, Anthropic, ошибки полей, отказ, изменение, «Выбрать по умолчанию» | Task 4.1 | covered | |
| MP-07 | идёт, работает, ключ отклонён, адрес недоступен, нет связи, другой отказ, провайдера нет | Task 2.1, Task 3.3 | covered | |
| MP-08 | варианты с провайдером, модель не работает, запись без своей модели, «Мой доступ», диалог права | Task 1.2, Task 5.1, Task 5.2, Task 5.3 | covered | |
| MP-09 | отказ старта в блоке вызова, сбой посреди работы, первое сообщение, позже в беседе, пометка на странице записи | Task 6.1, Task 6.2, Task 5.1 | partial | пометка в строке библиотеки — вне части (дизайн, Open Question 4) |

### ADR Bindings

| ADR | Source Section | Axis | Binding Decision | Covered By Task(s) |
|---|---|---|---|---|
| docs/adr/ADR-0012-closed-api-and-server-issued-employee-id.md | Decision | data_flow | Сотрудника веб не передаёт ни в одном запросе | Task 1.1 |
| docs/adr/ADR-0015-access-gate-and-model-catalogue.md | Decision | placement | Каталог, права и модели по умолчанию веб читает у `access`, своих правил прав не держит | Task 1.1, Task 5.3 |
| docs/adr/ADR-0018-model-id-provider-prefix.md | Decision | contract_schema | Провайдер — первая часть id модели (`modelProvider` из `contracts`); id в диалоге собирается из провайдера и имени | Task 1.2, Task 4.1 |

### Connection Map

Обе стороны построены: часть `core` закрыта (quality gate 2026-11-20); правая сторона каждой строки — её код. Планов, которые строятся на этой части, нет.

| Boundary | Owner (left side) | Owner (right side) | Serialized Format | Consumer Parse Rule | Expected Signal | Covered By Task(s) |
|---|---|---|---|---|---|---|
| Провайдеры моделей | `apps/api/src/agents/admin-model-providers.controller.ts` | `apps/web/src/lib/admin/admin-api.ts` (`adminApi.modelProviders`) | JSON `ModelProviderView[]`, `ModelProviderView`, `ModelProviderCheck`; ошибки `ApiErrorSchema` с `count` у `MODEL_PROVIDER_HAS_MODELS` | `ModelProviderViewSchema`, `ModelProviderCheckSchema` | INT-1, INT-2 | Task 1.1, Task 3.3, Task 3.4 |
| Тело провайдера | `apps/web/src/components/admin/models/model-provider-dialog.tsx` | `admin-model-providers.controller.ts` | JSON `CreateModelProviderBody`, `UpdateModelProviderBody` (`apiKey` — только введённый) | `CreateModelProviderBodySchema`, `UpdateModelProviderBodySchema` | INT-1: тела `POST` и `PATCH` | Task 3.4 |
| Каталог | `apps/api/src/access/admin-models.controller.ts` | `adminApi.models`, `catalog-section.tsx`, `model-dialog.tsx` | JSON `CatalogModel[]` (объединение по `purpose`); тело `CreateCatalogModelBody`, `UpdateCatalogModelBody`; 422 `MODEL_PROVIDER_INVALID` | `CatalogModelSchema` | INT-3 | Task 3.1, Task 4.1 |
| Модели по умолчанию | `apps/api/src/access/admin-model-defaults.controller.ts` | `adminApi.modelDefaults`, `model-defaults-form.tsx` | JSON `ModelDefaults`; тело `UpdateModelDefaultsBody`; 422 `MODEL_DEFAULT_INVALID` с `model` | `ModelDefaultsSchema`; `model` — `ApiRequestError.model` | INT-1 (чтение после записей); ручная строка «Модель и умолчание» | Task 1.1, Task 3.2 |
| «Мой доступ» и выбор модели | `apps/api/src/access/my-access.controller.ts` | `accessApi.models`, `record-page.tsx`, `agent-fields.tsx`, `models-section.tsx` | JSON `MyModels` с `unavailableReason` | `MyModelsSchema` | INT-4 | Task 5.1, Task 5.2, Task 5.3 |
| Модель по умолчанию новой записи | `apps/api/src/library/library.controller.ts` (`GET /api/library/choices`) | `record-page.tsx`, `system-record-page.tsx` | JSON `LibraryChoices`, `defaultModel` может быть `null` | `LibraryChoicesSchema` | INT-4; ручная строка «Модель и умолчание» | Task 5.1, Task 5.2 |
| Сбой агента | `packages/agents` (`failureReason` в ленте) через `apps/api` | `apps/web/src/lib/feed/to-feed.ts`, `event-line.tsx`, `agent-report.tsx`, `thread.aui.tsx` | JSON события ленты, `reason` | `AgentFailureReasonSchema`; `isChatFailureReason` | INT-5, строка A | Task 6.1 |
| Отказ старта | `apps/api/src/chat/chat.errors.ts`; исход `refused` `start_agent` / `start_workflow` | `apps/web/src/lib/library/library-errors.ts`, `tool-fallback.aui.tsx` | JSON 409 `START_REFUSED` с `reason`, `model`; `refusalReason`, `refusalDetail.model` | `StartRefusedErrorSchema`, `ToolRefusalReasonSchema` | INT-5, строка B; строки таблицы Task 6.2 | Task 1.1, Task 6.2 |

## Update History

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-11-20 | Initial version; по проверке черновика: `ModelHint` для модели неработающего провайдера, временное `unavailableReason` в `system-record-page.tsx` (Task 5.2), цена ввода эмбеддинга в каталоге, `hasChange` против пустого `PATCH`, `role="alert"` у строки под полем сообщения |
| 1.1 | 2026-11-20 | Final Phase отмечена по итогу gate (браузерные проверки — не выполнены), Progress Tracking, Notes пункт 15; статус completed |
