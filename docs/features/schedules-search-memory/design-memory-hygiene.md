# Расписания, поиск по беседам и чистота памяти — Design Document — memory-hygiene

**Status:** На утверждении · **Date:** 2026-11-25 · **PRD:** [prd.md](./prd.md) · **UXRD:** [uxrd.md](./uxrd.md) · **Depends on:** нет

## Snapshot

**Overview.** Глубокий агент с самообучением ведёт память тремя инструментами: запомнить, прочитать, забыть. Часть добавляет к записи памяти историю: каждое изменение — новая неизменная версия с номером, а запись указывает на текущую. Агент правит запись по номеру версии, который видел, и правка от устаревшего номера отклоняется: агент получает текущий текст и решает заново. Перед записью платформа проверяет, не секрет ли это и не приказ ли модели, — по рекомендации дизайна отдельным коротким вызовом модели запуска; похожую запись она не пишет и называет причину. На экранах памяти человек открывает историю записи, возвращает прежнюю версию и стирает запись вместе с историей.

- **Не меняется**: оглавление памяти в промпте, области записей, правило «чью память видит запуск», маска известных секретов, дерево обучения памяти не пишет.
- **Главный риск**: проверка ошибается в обе стороны — отклоняет полезный факт или пропускает замаскированный приказ ([Risks](#risks-and-mitigation)).
- **Открытые вопросы**: способ проверки записи выбирает владелец ([Open Questions](#open-questions)).

### Key Decisions

#### KD-1: Запись — строка с описанием и указателем на текущую версию; текст живёт только в неизменных версиях

История нужна, чтобы видеть, кто испортил запись, и вернуть хорошую версию (FR-17, FR-18). Запись остаётся строкой `memories` с владельцем и описанием, а её тексты переезжают в новую таблицу `memory_versions`: номер растёт с 1, версия хранит вид изменения, текст, время и автора-человека и никогда не меняется. Строка указывает номер текущей версии. Это та же форма, что у агента и его версий ([immutable-versions.md](../../code-system/patterns/immutable-versions.md)): строка с указателем и неизменные версии, перевод указателя только с ожидаемой версии. Паттерн получает вторую область применения, и его Problem говорит теперь и о записи, которую правят несколько писателей. Текст хранится в одном месте, поэтому текст записи и текст её текущей версии разойтись не могут. Удаление агентом — версия вида «удалена» без текста: запись остаётся в таблице со своим описанием и историей и возвращается откатом. Повторное `remember` с тем же описанием тоже её возвращает (DC-3). Описание по-прежнему ключ записи у владельца и не меняется за всю её жизнь, поэтому возврат удалённой записи никогда не сталкивается с другой записью того же описания. Отвергнуто: текущий текст на строке и журнал копий рядом, как в bb — открытом проекте, откуда PRD взял идею проверки и истории памяти (`plugins/memory/server.ts`), — один факт в двух местах; отдельная таблица истории без указателя — правка по версии тогда держится на сравнении времени, а `updated_at` у `memories` не переживает округление до миллисекунд в JavaScript.

#### KD-2: Агент правит по номеру версии; `remember` без номера только создаёт

Правило FR-19 требует номер, который агент действительно видел. Номер приходит агенту в ответе `read_memory` и в ответе успешного `remember`, а оглавление остаётся прежним — строки описания без номеров. `remember` с номером заменяет текст, только если запись всё ещё на этой версии. `remember` без номера создаёт запись и отклоняется, если живая запись с таким описанием уже есть: это и есть «создание с описанием, которое кто-то занял». `forget` требует номер всегда. Отказ по устаревшему номеру — причина `memory_changed`, а в тексте ответа текущий номер и текст записи (AC-19.1). Агент, который правит без чтения, получает в отказе всё, что нужно для второго вызова. Два писателя от одной версии дают ровно одну новую версию: второй получает отказ, даже если их коммиты идут одновременно. Это инвариант схемы версий (KD-1), а не блокировка в коде. Отвергнуто: платформа сама помнит, какую версию видел запуск, — нужна новая память на запуск, которая теряется при сжатии истории, а строку оглавления без номера к версии не привязать; номер в строках оглавления — каждая правка меняла бы промпт всех запусков агента, а модель всё равно должна прочитать текст перед правкой.

#### KD-3: Одна служба меняет запись для агента и для человека

Правка агентом, удаление агентом и возврат человеком делают одно и то же: новая версия от ожидаемой и перевод указателя, иначе исход «запись уже на другой версии» с её текущим состоянием. Это правило живёт в одной службе пакета `agents`. Её зовут инструменты памяти в коммите шага и сервис памяти `apps/api` в своей транзакции, а служба своей транзакции не открывает ([repository-over-transaction.md](../../code-system/patterns/repository-over-transaction.md)). Служба лежит в `agents`, потому что инструменты не могут звать `apps/api`, а `apps/api` уже зависит от `agents`. Поиск похожего: `LibrarySave` и `activateVersion` ведут версии агента, `DocumentsRepository.updateText` сравнивает время прочтения документа блокнота; ни один не знает владельца и описания записи памяти, поэтому служба новая, а форма — паттерна версий.

#### KD-4: Секрет и приказ распознаёт суждение модели запуска (рекомендация; решает владелец)

Решить, что текст — пароль или приказ модели, значит понять его смысл, а это работа модели; код только исполняет её вердикт. Пример PRD «игнорируй предыдущие инструкции и …» по-русски, и список шаблонов bb его не ловит: там английские слова приказа, два префикса токенов и присваивания с именем заглавными буквами. Сотрудники пишут по-русски и пересказывают по-разному, а список шаблонов пришлось бы дописывать на каждый новый пересказ. Поэтому `remember` перед записью делает один вызов модели запуска со структурным ответом ([tool-call-answer.md](../../code-system/patterns/tool-call-answer.md)): описание и текст идут в конверте данных, ответ — один вердикт «можно», «секрет» или «приказ». Вызов идёт в `prepare` инструмента, до транзакции коммита: транзакция не держит соединение, пока ждёт модель. `prepare` получает сигнал отмены и логгер шага, а раунд структурного ответа переезжает из `training/judge.ts` в общий модуль `agents`: это второй вызывающий, и паттерн велит вынести раунд, а не копировать его. Расход идёт по задаче запуска и квоте владельца на эту модель, как любой вызов модели в запуске, и виден в стоимости запуска. Если проверка не состоялась, запись не пишется (DC-1): отказ `AccessGate` даёт отказ вызова с его причиной, ошибка провайдера или негодный ответ — исход `tool_error`. Повтор шага после рестарта повторяет `prepare` и судит заново; в результат вызова и в журнал попадает только вердикт той попытки, чей коммит прошёл.

**Альтернатива — чистая функция по шаблонам, как в bb** ([pure-decision.md](../../code-system/patterns/pure-decision.md)). Она бесплатна, мгновенна и одинакова при каждом повторе, а проверяется одним табличным тестом. Но она ловит только те формы, что в неё вписаны: невидимые и управляющие символы, теги ролей, блок закрытого ключа, известные префиксы токенов, присваивание значения пароля, токена или ключа и фразы приказа на русском и английском. Перефразированный приказ и секрет без узнаваемой формы она пропускает. Если владелец выберет её, функция зовётся в `execute` до правки по версии. Причины `looks_like_secret` и `looks_like_instruction` те же, а исходов отказа шлюза и `tool_error` у проверки нет (DC-1 отпадает); `prepare` не расширяется, и раунд структурного ответа остаётся в `training/judge.ts`.

#### KD-5: Три новые причины отказа вызова; строку в беседе выбирает код причины

Веб показывает строку отказа по коду из закрытого набора `ToolRefusalReasonSchema`, а текст отказа, который читает модель, не показывает. Поэтому каждая строка MC-19 получает свой код: `looks_like_secret`, `looks_like_instruction`, `memory_changed`. Код `version_conflict` уже значит конфликт сохранения карточки библиотеки, и его строка в вебе говорила бы не то. Модель получает тот же код и текст для себя: что не записано и почему, а при `memory_changed` — текущий номер и текст записи в конверте данных.

#### KD-6: История не называет сотрудника, в чьём запуске агент менял запись; человека называет только его собственная правка

У версии есть автор-человек только тогда, когда её сделал человек: возврат на экране памяти. Версии агента автора не хранят, поэтому история записи области агента не может назвать сотрудника А (AC-17.3), и это держит схема, а не фильтр при показе. Экран памяти агента подписывает правку человека его именем, «Моя память» — «вы»: там правит только хозяин.

#### KD-7: «Удалить» на экране стирает запись вместе с историей; возврат — новая версия по тому же праву

Прежний маршрут удаления остаётся и теперь удаляет строку записи, а её версии уходят вместе с ней: секрет, прошедший проверку, исчезает из базы целиком (AC-17.4). Возврат — новый маршрут с тем же правом, что удаление: на экране агента его проверяет `LibraryService.memoryTarget`, в «Моей памяти» — сеанс. Возврат несёт номер версии, которую человек возвращает, и номер текущей версии, которую он видел вверху истории; устаревший номер даёт 409 `RECORD_VERSION_CONFLICT` (AC-19.2).

## Terms

- **Версия записи** — неизменная строка с текстом записи на один момент; номера идут с 1 без пропусков.
- **Текущая версия** — версия, на которую указывает запись; у неё наибольший номер.
- **Удаление агентом** — `forget`: новая версия вида «удалена», запись видна на экране и возвращается.
- **Стирание** — «Удалить» на экране: запись и все её версии исчезают из базы.
- **Проверка записи** — суждение модели перед `remember`: можно ли записать, или это похоже на секрет или приказ (KD-4).
- **Конверт данных** — обёртка `envelope`, в которой модель получает чужой текст как данные, а не как инструкции.
- **Коммит шага** — транзакция, в которой шаг инструментов пишет результаты вызовов и изменения, сделанные инструментами режима `in_commit`.
- **Дерево обучения** — задачи под корнем `trainer`: тренер и его повторы; память они читают, но не пишут.

## Part

- **Prerequisite ADRs**: [ADR-0022](../../adr/ADR-0022-one-database-and-nestjs-modules.md) — одна база, репозитории в `packages/db`, модули NestJS; [ADR-0023](../../adr/ADR-0023-live-task-objects-one-stepping-process.md) — объект агента читает память на каждом шаге; [ADR-0024](../../adr/ADR-0024-every-reference-is-a-foreign-key.md) — версии ссылаются на запись, автор-человек — на сотрудника внешними ключами.

Часть покрывает FR-16 – FR-19 и NFR-05 для экранов памяти и ни от чего не зависит. Этот дизайн — источник правды о записи, версиях и проверке памяти; часть `memory` фичи self-learning описывает остальное: области, оглавление, флажок, экраны.

**Out of scope**

- Оглавление памяти: строки «область: описание», их порядок от недавно изменённых и размер из `self_learning_settings` остаются; удалённая агентом запись в оглавление не попадает.
- Правило `memoryOf` и дерево обучения: `remember` и `forget` в дереве обучения отвечают исходом `recorded`, ничего не проверяют и не пишут; тренер видит только живые записи.
- Маска известных секретов: описание и текст по-прежнему маскируются до проверки и до записи.
- Правка текста записи человеком — её нет (PRD, Won't Have).
- Аргументы отклонённого вызова остаются в истории беседы, как любой ответ модели: проверка не пускает текст в память, а беседу не правит.

**Constraints**

- **PoC, без переноса данных.** Схема миграций, сжатая в одну, генерируется заново; записи не переносятся, база разработки создаётся заново. Записи появляются уже с историей.
- **Одна база.** Обе таблицы и их запросы — в `packages/db`, в одном файле репозитория группы `memories`. Репозиторий только читает и пишет строки в транзакции вызывающего; правило версий держит служба (KD-3).
- **Без настроек.** Проверка берёт модель запуска; ключа в `settings` и переменных окружения нет.
- **Мало тестов.** Пять сценариев на права, изоляцию, целостность, одновременную правку и главный путь ([Test Strategy](#test-strategy)).

## Building-block Inventory

Follows the [code system](../../code-system/README.md).

| Building block | Pattern | Status | Note |
|---|---|---|---|
| Таблицы `memories` и `memory_versions`, их репозиторий | [repository-over-transaction.md](../../code-system/patterns/repository-over-transaction.md), [immutable-versions.md](../../code-system/patterns/immutable-versions.md) | extended | `memory_versions` новая; таблицы истории для записей памяти в `packages/db` не было |
| Служба изменения записи | [immutable-versions.md](../../code-system/patterns/immutable-versions.md) | new | искали в `LibrarySave`, `AgentsRepository.activateVersion`, `DocumentsRepository.updateText` — все про другие записи (KD-3) |
| Проверка записи суждением модели | [tool-call-answer.md](../../code-system/patterns/tool-call-answer.md) | new | при рекомендации KD-4: раунд структурного ответа выносится из `training/judge.ts` в общий модуль; при альтернативе — чистая функция по [pure-decision.md](../../code-system/patterns/pure-decision.md) |
| `remember`, `read_memory`, `forget` | [tool-declaration.md](../../code-system/patterns/tool-declaration.md) | extended | номер версии в аргументах и ответах, `prepare` у `remember`, три причины отказа |
| Подготовка инструмента `prepare` | [step-handler.md](../../code-system/patterns/step-handler.md) | extended | при рекомендации KD-4: получает сигнал отмены и логгер шага |
| Блок памяти | [step-prompt-block.md](../../code-system/patterns/step-prompt-block.md) | extended | берёт только живые записи |
| `memoryOf`, маска секретов | [pure-decision.md](../../code-system/patterns/pure-decision.md), [logging.md](../../code-system/patterns/logging.md) | reused | — |
| Сервис и маршруты памяти `apps/api` | [auth-boundary.md](../../code-system/patterns/auth-boundary.md) | extended | история, возврат, стирание; права — `LibraryService.memoryTarget` без изменений |
| Таблица памяти, страница памяти агента, раздел «Моя память», `libraryApi`, `accessApi` | [web-api-client.md](../../code-system/patterns/web-api-client.md), [read-on-open.md](../../code-system/patterns/read-on-open.md) | extended | пункт «История», удалённые строки, новый текст удаления |
| Диалог истории | [version-history.md](../../design-system/components/version-history.md) | new | компонента в коде нет |
| Строка отказа в блоке вызова | [tool-call.md](../../design-system/components/tool-call.md) | reused | только тексты трёх причин в `errors.json` обоих языков |

## Acceptance Criteria

### FR-16: отказ записи с секретом или приказом

- From the PRD: AC-16.1, AC-16.2, AC-16.3.
- Только при суждении модели (рекомендация KD-4, вопрос в [Open Questions](#open-questions)): когда проверка не состоялась — `AccessGate` отказал, провайдер ответил ошибкой или модель дважды не дала вердикт, — запись не меняется, вызов кончается отказом с причиной шлюза или исходом `tool_error`, а запуск идёт дальше (DC-1).

### FR-17: история записи

- From the PRD: AC-17.1, AC-17.2, AC-17.3, AC-17.4.
- Когда агент вызывает `remember` без номера для записи, которую он же удалил, запись возвращается в оглавление новой версией «Создана», а прежние версии остаются в её истории (DC-3).
- Когда сотрудник запрашивает историю, возврат или стирание записи чужой «Моей памяти» по её id, история и возврат отвечают 404 `RECORD_NOT_FOUND`, стирание — 204, и запись не меняется (DC-4).

### FR-18: откат человеком

- From the PRD: AC-18.1, AC-18.2.
- Когда человек возвращает текущую версию, версию «удалена» или номер, которого нет в истории, возврат отвечает 400 `VALIDATION_FAILED`, и новой версии нет (DC-5).

### FR-19: правка по устаревшей версии

- From the PRD: AC-19.1, AC-19.2.
- Когда агент вызывает `remember` без номера, а живая запись с этим описанием уже есть, вызов кончается отказом `memory_changed` с её номером и текстом, и запись не меняется (DC-2).
- Когда агент вызывает `forget` с номером, который уже не текущий, вызов кончается отказом `memory_changed`, и запись остаётся живой (DC-6).

### NFR-05: ширина экрана

- Таблица памяти и диалог истории работают от 360 px без прокрутки страницы вбок (UXRD, Responsive Behavior); это проверяется в браузере при сборке экрана, а не тестом.

## Design

### Architecture (C1–C4)

Новых контейнеров нет. Запись и проверка идут в шаге агента внутри `api`, экраны памяти зовут маршруты того же `api`, всё хранится в Postgres. Новая связь одна: `remember` зовёт провайдера модели ради проверки записи.

#### C2 · Containers

```mermaid
---
title: "C2 · Containers — memory-hygiene"
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
  themeCSS: |
    @keyframes lit_c2{0%,12.86%{stroke:#991b1b;stroke-width:6px}14.29%,100%{stroke:#f4a5a5;stroke-width:2px}}
    @keyframes litr_c2{0%,12.86%{stroke:#1d4ed8;stroke-width:6px}14.29%,100%{stroke:#9ec1f7;stroke-width:2px}}
---
flowchart LR
    agentEntry(["▶ шаг агента<br/>вызывает remember"])
    personEntry(["▶ автор открывает<br/>историю записи"])
    subgraph product["Agent OS"]
        web["web<br/>экраны памяти"]
        api["api<br/>инструменты и маршруты памяти"]
        db[("Postgres<br/>записи и версии")]
    end
    provider(["провайдер модели"])
    agentEntry --> api
    personEntry --> web
    api e1@-->|"проверить запись"| provider
    provider e2@-->|"вердикт"| api
    api e3@-->|"новая версия"| db
    web e4@-->|"история"| api
    api e5@-->|"читает версии"| db
    db e6@-->|"версии"| api
    api e7@-->|"история"| web
    classDef entry fill:#ffffff,stroke:#1f2937,stroke-width:1.5px,color:#1a1a1a
    classDef changed fill:#fde8e8,stroke:#dc2626,stroke-width:2px,color:#1a1a1a
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    classDef w1 stroke:#f4a5a5,stroke-width:2px,animation:lit_c2 8.4s linear 0s infinite
    classDef w2 stroke:#f4a5a5,stroke-width:2px,animation:lit_c2 8.4s linear 1.2s infinite
    classDef w3 stroke:#f4a5a5,stroke-width:2px,animation:lit_c2 8.4s linear 2.4s infinite
    classDef r4 stroke:#9ec1f7,stroke-width:2px,animation:litr_c2 8.4s linear 3.6s infinite
    classDef r5 stroke:#9ec1f7,stroke-width:2px,animation:litr_c2 8.4s linear 4.8s infinite
    classDef r6 stroke:#9ec1f7,stroke-width:2px,animation:litr_c2 8.4s linear 6s infinite
    classDef r7 stroke:#9ec1f7,stroke-width:2px,animation:litr_c2 8.4s linear 7.2s infinite
    class agentEntry,personEntry entry
    class web,api,db changed
    class provider unchanged
    class e1 w1
    class e2 w2
    class e3 w3
    class e4 r4
    class e5 r5
    class e6 r6
    class e7 r7
    style product fill:none,stroke:#4b5563,stroke-dasharray:5 5
```

Провайдер модели тот же, что отвечает запуску: проверка — ещё один вызов модели запуска по той же задаче и квоте (KD-4).

#### C3 · Components: api

**api — агент пишет запись**

```mermaid
---
title: "C3 · Components — api, агент пишет запись"
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
  themeCSS: |
    @keyframes lit_c3w{0%,15%{stroke:#991b1b;stroke-width:6px}16.67%,100%{stroke:#f4a5a5;stroke-width:2px}}
---
flowchart TB
    entry(["▶ модель вызывает remember"])
    subgraph api["api"]
        tool["1 · remember<br/>инструмент памяти"]
        check["2 · проверка записи<br/>секрет или приказ"]
        change["3 · изменение записи<br/>правка по версии"]
    end
    provider(["провайдер модели"])
    db[("memories<br/>memory_versions")]
    entry --> tool
    tool e1@-->|"описание и текст"| check
    check e2@-->|"суждение"| provider
    provider e3@-->|"вердикт"| check
    check e4@-->|"можно"| tool
    tool e5@-->|"текст и номер"| change
    change e6@-->|"новая версия"| db
    classDef entry fill:#ffffff,stroke:#1f2937,stroke-width:1.5px,color:#1a1a1a
    classDef changed fill:#fde8e8,stroke:#dc2626,stroke-width:2px,color:#1a1a1a
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    classDef w1 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3w 7.2s linear 0s infinite
    classDef w2 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3w 7.2s linear 1.2s infinite
    classDef w3 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3w 7.2s linear 2.4s infinite
    classDef w4 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3w 7.2s linear 3.6s infinite
    classDef w5 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3w 7.2s linear 4.8s infinite
    classDef w6 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3w 7.2s linear 6s infinite
    class entry entry
    class tool,db changed
    class check,change new
    class provider unchanged
    class e1 w1
    class e2 w2
    class e3 w3
    class e4 w4
    class e5 w5
    class e6 w6
```

- **`remember`** спрашивает проверку в `prepare`, до коммита шага, а правку по версии делает в `execute`, в коммите вместе с результатом вызова. `forget` проверки не спрашивает: нового текста у него нет. `read_memory` читает текст и номер текущей версии живой записи.
- **Проверка записи** — один вызов модели запуска со структурным ответом. Она видит маскированные описание и текст внутри конверта данных и отвечает только вердиктом, без объяснения: объяснение могло бы процитировать секрет в лог.
- **Изменение записи** — служба KD-3. По ожидаемому номеру она добавляет версию и переводит указатель записи или отвечает, что запись уже на другой версии, с её текущим номером, видом и текстом.

**api — человек на экране памяти**

```mermaid
---
title: "C3 · Components — api, история, возврат и стирание"
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
  themeCSS: |
    @keyframes lit_c3h{0%,18%{stroke:#991b1b;stroke-width:6px}20%,100%{stroke:#f4a5a5;stroke-width:2px}}
    @keyframes litr_c3h{0%,18%{stroke:#1d4ed8;stroke-width:6px}20%,100%{stroke:#9ec1f7;stroke-width:2px}}
---
flowchart TB
    entry(["▶ автор возвращает версию"])
    web["web<br/>диалог истории"]
    subgraph api["api"]
        service["1 · сервис памяти<br/>права, история, возврат, стирание"]
        change["2 · изменение записи<br/>правка по версии"]
    end
    db[("memories<br/>memory_versions")]
    entry --> web
    web e1@-->|"вернуть версию"| service
    service e2@-->|"возврат по номеру"| change
    change e3@-->|"новая версия"| db
    db e4@-->|"версии"| service
    service e5@-->|"история"| web
    classDef entry fill:#ffffff,stroke:#1f2937,stroke-width:1.5px,color:#1a1a1a
    classDef changed fill:#fde8e8,stroke:#dc2626,stroke-width:2px,color:#1a1a1a
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    classDef w1 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3h 6s linear 0s infinite
    classDef w2 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3h 6s linear 1.2s infinite
    classDef w3 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3h 6s linear 2.4s infinite
    classDef r4 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3h 6s linear 3.6s infinite
    classDef r5 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3h 6s linear 4.8s infinite
    class entry entry
    class service,db changed
    class change new
    class web unchanged
    class e1 w1
    class e2 w2
    class e3 w3
    class e4 r4
    class e5 r5
```

**Сервис памяти** сначала проверяет право тем же способом, что сегодня удаление: на экране агента — `LibraryService.memoryTarget`, в «Моей памяти» — сотрудник сеанса. Затем он открывает транзакцию и зовёт службу изменения записи, а стирает запись сам, одним удалением строки через репозиторий. Историю он собирает из версий записи и имён людей-авторов; имени нет — берёт почту.

#### C3 · Components: web

```mermaid
---
title: "C3 · Components — web, история записи"
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
  themeCSS: |
    @keyframes litr_c3web{0%,18%{stroke:#1d4ed8;stroke-width:6px}20%,100%{stroke:#9ec1f7;stroke-width:2px}}
---
flowchart TB
    entry(["▶ «⋯» строки → История"])
    subgraph web["web"]
        table["1 · таблица памяти<br/>удалённые строки, меню"]
        dialog["2 · диалог истории<br/>версии и возврат"]
        client["3 · клиент API<br/>libraryApi, accessApi"]
    end
    api["api"]
    entry --> table
    table e1@-->|"открыть"| dialog
    dialog e2@-->|"история"| client
    client e3@-->|"GET история"| api
    api e4@-->|"версии"| client
    client e5@-->|"версии"| dialog
    classDef entry fill:#ffffff,stroke:#1f2937,stroke-width:1.5px,color:#1a1a1a
    classDef changed fill:#fde8e8,stroke:#dc2626,stroke-width:2px,color:#1a1a1a
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    classDef r1 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3web 6s linear 0s infinite
    classDef r2 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3web 6s linear 1.2s infinite
    classDef r3 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3web 6s linear 2.4s infinite
    classDef r4 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3web 6s linear 3.6s infinite
    classDef r5 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3web 6s linear 4.8s infinite
    class entry entry
    class table,client changed
    class dialog new
    class api unchanged
    class e1 r1
    class e2 r2
    class e3 r3
    class e4 r4
    class e5 r5
```

- **Таблица памяти** (`MemoryTable`) одна на оба экрана, поэтому история и удалённые строки появляются на экране агента и в «Моей памяти» сразу. Экраны передают ей свои функции истории, возврата и удаления, как сегодня передают удаление.
- **Диалог истории** построен по компоненту [история записи](../../design-system/components/version-history.md). После возврата он показывает пришедшую историю и перечитывает таблицу. На 409 он перечитывает историю и ставит предупреждение конфликта (UXRD MH-03). Подпись автора: на экране агента — имя из ответа, в «Моей памяти» — «вы».
- **Блок вызова** в беседе показывает строку отказа MC-19 по коду причины (KD-5); компонент прежний, новые только тексты.

### Runtime Flows

#### Flow 1: агент запоминает через проверку и версию

**Starts when:** модель запуска с памятью вызывает `remember` или `forget`, для AC-16.1, AC-16.2, AC-16.3, AC-17.1, AC-17.2, AC-19.1.

```mermaid
---
title: "Flow 1 · агент пишет запись"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  themeCSS: |
    @keyframes lit_fl1{0%,10%{stroke:#991b1b;stroke-width:6px}11.11%,100%{stroke:#37474f;stroke-width:2px}}
    @keyframes litr_fl1{0%,10%{stroke:#1d4ed8;stroke-width:6px}11.11%,100%{stroke:#37474f;stroke-width:2px}}
    .messageLine0[data-id='i0'],.messageLine1[data-id='i0']{animation:litr_fl1 10.8s linear 0s infinite}
    .messageLine0[data-id='i1'],.messageLine1[data-id='i1']{animation:litr_fl1 10.8s linear 1.2s infinite}
    .messageLine0[data-id='i2'],.messageLine1[data-id='i2']{animation:litr_fl1 10.8s linear 2.4s infinite}
    .messageLine0[data-id='i3'],.messageLine1[data-id='i3']{animation:litr_fl1 10.8s linear 3.6s infinite}
    .messageLine0[data-id='i5'],.messageLine1[data-id='i5']{animation:litr_fl1 10.8s linear 4.8s infinite}
    .messageLine0[data-id='i7'],.messageLine1[data-id='i7']{animation:lit_fl1 10.8s linear 6s infinite}
    .messageLine0[data-id='i9'],.messageLine1[data-id='i9']{animation:litr_fl1 10.8s linear 7.2s infinite}
    .messageLine0[data-id='i11'],.messageLine1[data-id='i11']{animation:lit_fl1 10.8s linear 8.4s infinite}
    .messageLine0[data-id='i12'],.messageLine1[data-id='i12']{animation:litr_fl1 10.8s linear 9.6s infinite}
---
sequenceDiagram
    participant M as модель
    box платформа
        participant S as шаг инструментов
        participant DB@{ "type": "database" } as Postgres
    end
    S->>M: промпт шага с оглавлением
    M-->>S: вызов remember с номером версии
    S->>M: проверка записи отдельным вызовом
    M-->>S: вердикт
    alt похоже на секрет или приказ
        S->>M: отказ с причиной, запись не тронута
    else запись уже на другой версии
        S->>DB: правка по номеру не проходит
        Note over S,DB: ничего не записано
        S->>M: отказ memory_changed, текущий номер и текст
    else номер совпал
        S->>DB: новая версия и результат вызова одним коммитом
        S->>M: сохранено, новый номер версии
    end
```

Отказ проверки и отказ по версии тоже уходят в коммит шага — как результат вызова, без изменения записи. `forget` идёт той же дорогой без проверки: совпавший номер даёт версию «удалена», и со следующего шага запись пропадает из оглавления и из `read_memory`. Два запуска, которые одновременно правят запись от одной версии, получают по одному из последних двух исходов: один пишет, другой получает его текст. Рестарт до коммита повторяет шаг: проверка судит заново, а правка идёт от того же номера, потому что прошлая попытка ничего не записала.

#### Flow 2: человек возвращает прежнюю версию

**Starts when:** автор агента или хозяин «Моей памяти» открывает историю записи и нажимает «Вернуть эту версию», для AC-17.1, AC-18.1, AC-19.2.

```mermaid
---
title: "Flow 2 · возврат версии человеком"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  themeCSS: |
    @keyframes lit_fl2{0%,7.5%{stroke:#991b1b;stroke-width:6px}8.33%,100%{stroke:#37474f;stroke-width:2px}}
    @keyframes litr_fl2{0%,7.5%{stroke:#1d4ed8;stroke-width:6px}8.33%,100%{stroke:#37474f;stroke-width:2px}}
    .messageLine0[data-id='i0'],.messageLine1[data-id='i0']{animation:litr_fl2 14.4s linear 0s infinite}
    .messageLine0[data-id='i1'],.messageLine1[data-id='i1']{animation:litr_fl2 14.4s linear 1.2s infinite}
    .messageLine0[data-id='i2'],.messageLine1[data-id='i2']{animation:litr_fl2 14.4s linear 2.4s infinite}
    .messageLine0[data-id='i3'],.messageLine1[data-id='i3']{animation:litr_fl2 14.4s linear 3.6s infinite}
    .messageLine0[data-id='i4'],.messageLine1[data-id='i4']{animation:lit_fl2 14.4s linear 4.8s infinite}
    .messageLine0[data-id='i5'],.messageLine1[data-id='i5']{animation:lit_fl2 14.4s linear 6s infinite}
    .messageLine0[data-id='i7'],.messageLine1[data-id='i7']{animation:lit_fl2 14.4s linear 7.2s infinite}
    .messageLine0[data-id='i8'],.messageLine1[data-id='i8']{animation:lit_fl2 14.4s linear 8.4s infinite}
    .messageLine0[data-id='i11'],.messageLine1[data-id='i11']{animation:litr_fl2 14.4s linear 9.6s infinite}
    .messageLine0[data-id='i12'],.messageLine1[data-id='i12']{animation:litr_fl2 14.4s linear 10.8s infinite}
    .messageLine0[data-id='i13'],.messageLine1[data-id='i13']{animation:litr_fl2 14.4s linear 12s infinite}
    .messageLine0[data-id='i14'],.messageLine1[data-id='i14']{animation:litr_fl2 14.4s linear 13.2s infinite}
---
sequenceDiagram
    participant H as автор
    participant W as web
    box платформа
        participant A as api
        participant DB@{ "type": "database" } as Postgres
    end
    H->>W: «История» в меню записи
    W->>A: GET история записи
    A->>DB: проверяет право и читает версии
    A->>W: версии, текущая сверху
    H->>W: «Вернуть эту версию»
    W->>A: POST возврат с номером и текущим номером
    alt запись на той же версии
        A->>DB: новая версия «Возвращена»
        A->>W: история с новой версией сверху
    else запись изменилась
        Note over A,DB: ничего не записано
        A->>W: 409 RECORD_VERSION_CONFLICT
        W->>A: перечитывает историю
        A->>DB: читает версии
        A->>W: история с новой версией агента
    end
```

Возврат удалённой агентом записи идёт так же: её текущая версия — «удалена», и возврат любой версии с текстом снова делает запись живой. Следующий шаг любого запуска видит возвращённое описание в оглавлении и текст в `read_memory` (AC-18.1).

#### Flow 3: человек стирает запись

**Starts when:** тот, кто может удалять запись на её экране, подтверждает «Удалить», для AC-17.4.

```mermaid
---
title: "Flow 3 · стирание записи с историей"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  themeCSS: |
    @keyframes lit_fl3{0%,22.5%{stroke:#991b1b;stroke-width:6px}25%,100%{stroke:#37474f;stroke-width:2px}}
    .messageLine0[data-id='i0'],.messageLine1[data-id='i0']{animation:lit_fl3 4.8s linear 0s infinite}
    .messageLine0[data-id='i1'],.messageLine1[data-id='i1']{animation:lit_fl3 4.8s linear 1.2s infinite}
    .messageLine0[data-id='i2'],.messageLine1[data-id='i2']{animation:lit_fl3 4.8s linear 2.4s infinite}
    .messageLine0[data-id='i3'],.messageLine1[data-id='i3']{animation:lit_fl3 4.8s linear 3.6s infinite}
---
sequenceDiagram
    participant H as автор
    participant W as web
    box платформа
        participant A as api
        participant DB@{ "type": "database" } as Postgres
    end
    H->>W: «Удалить» и подтверждение
    W->>A: DELETE запись
    A->>DB: проверяет право, удаляет запись со всеми версиями
    A->>W: 204
```

После 204 экран перечитывает список. Стирание необратимо: в базе не остаётся ни строки записи, ни её версий, поэтому ни экран, ни оглавление следующего запуска её не видят.

### Contract Definitions

#### Инструменты модели

Их получают те же запуски, что сегодня: глубокий агент с включённым самообучением и его сабагенты. Описания инструментов говорят модели: перед правкой прочитай запись и передай её номер; создавай без номера; на отказ `memory_changed` реши заново по присланному тексту. Аргументы `scope` и `description` и пределы длины прежние: описание до 150 символов, текст до 4 000. Журнал вызова пишет область, длины, номера версий, вердикт и исход, но не описание и не текст.

- **`remember`** — аргументы `scope`, `description`, `text` и необязательный `version`. Без `version` создаёт запись или возвращает удалённую агентом; с `version` заменяет текст, если запись всё ещё на этой версии. Возвращает `success` с описанием и номером новой версии. Отказы, после которых запись не меняется:
  - `looks_like_secret` или `looks_like_instruction` — проверка сочла описание или текст секретом или приказом модели;
  - `memory_changed` — запись уже на другой версии или, без `version`, уже живёт с этим описанием; текст ответа несёт её текущий номер и текст, а для удалённой записи — что она удалена;
  - только при суждении модели (KD-4, вопрос открыт): причина отказа `AccessGate` для проверки или исход `tool_error`, когда проверка не состоялась (DC-1).
- **`read_memory`** — аргументы `scope`, `description`. Возвращает номер текущей версии и текст живой записи внутри конверта данных. Записи нет или она удалена — исход `empty`.
- **`forget`** — аргументы `scope`, `description`, `version` (обязателен). Если живая запись на этой версии, добавляет версию «удалена» и возвращает `success`. Живой записи нет — `empty`; запись на другой версии — `memory_changed`, как у `remember`.

Ответ каждого инструмента модель получает в конверте данных. В дереве обучения `remember` и `forget` отвечают исходом `recorded`, без проверки и без записи.

**Причины отказа.** `ToolRefusalReasonSchema` в `packages/contracts` получает значения `looks_like_secret`, `looks_like_instruction`, `memory_changed`. Веб показывает по ним строки MC-19 (UXRD) из `errors.json` обоих языков с одинаковыми ключами.

#### Маршруты

Ответы и тела описаны схемами `packages/contracts`; ошибка — код и сообщение в общей форме ошибок API.

- **`GET /library/:id/memory`**, **`GET /memory`** — как прежде, но список включает удалённые агентом записи с отметкой `deleted`.
- **`GET /library/:id/memory/:memoryId/history`** — история записи области агента, `MemoryHistoryView`. 404 `RECORD_NOT_FOUND` — агент не виден или записи у него нет; 403 `MEMORY_FORBIDDEN` — агент виден, но смотрящий не автор и не администратор агента в панели.
- **`POST /library/:id/memory/:memoryId/revert`** — тело `RevertMemoryBody`; добавляет версию «Возвращена» с текстом выбранной версии и возвращает новую `MemoryHistoryView`. 409 `RECORD_VERSION_CONFLICT` — текущая версия уже не та, что в теле (AC-19.2); 400 `VALIDATION_FAILED` — тело не по схеме, или выбранная версия текущая, без текста или отсутствует (DC-5); те же 404 и 403.
- **`DELETE /library/:id/memory/:memoryId`** — стирает запись вместе с историей; 204, в том числе когда такой записи у агента нет. Те же 404 и 403.
- **`GET /memory/:memoryId/history`**, **`POST /memory/:memoryId/revert`**, **`DELETE /memory/:memoryId`** — то же для записей сотрудника сеанса. Чужая или несуществующая запись: история и возврат — 404 `RECORD_NOT_FOUND`, стирание — 204 без изменений (DC-4).

**`MemoryRecordView`** — строка списка.

- `id`, `description`, `text` — как прежде; у удалённой записи `text` — текст последней версии до удаления, экран его не показывает.
- `deleted` — запись удалена агентом и возвращается из истории.
- `updatedAt` — время текущей версии, в том числе удаления.

**`MemoryHistoryView`** — история одной записи.

- `description` — описание записи.
- `versions` — версии, новые сверху; первая — текущая. У каждой: `version` — номер с 1; `kind` — `created`, `changed`, `deleted` или `reverted`; `text` — текст версии, `null` у `deleted`; `changedAt`; `changedBy` — `null`, когда версию сделал агент, иначе имя человека, а без имени — его почта.

**`RevertMemoryBody`** — тело возврата.

- `version` — номер версии, текст которой возвращается.
- `expectedVersion` — номер текущей версии, который человек видел вверху истории.

**Error handling.** Коды берутся из ошибок библиотеки и не новы: `RECORD_NOT_FOUND` (404), `MEMORY_FORBIDDEN` (403), `RECORD_VERSION_CONFLICT` (409), `VALIDATION_FAILED` (400).

### Data Model

Пример. Агент «Разбор ошибок оплаты» в запуске Ани запоминает в области агента, что логи оплаты лежат в `billing-api`: появляются строка записи и версия 1 «создана». Неделю спустя запуск Бориса читает запись, получает номер 1 и заменяет текст: версия 2 «изменена». Тем временем запуск Веры, прочитавший ту же версию 1, пытается заменить текст и получает отказ с текстом версии 2. Автор агента видит в истории две версии с подписью «агент» и ни Ани, ни Бориса.

**`memories`** — запись: владелец (агент или сотрудник, ровно один), описание и номер текущей версии. Описание уникально у владельца, включая удалённые агентом записи. Удаление агента или сотрудника каскадом убирает его записи, как прежде.

**`memory_versions`** — версии записи: ссылка на запись, номер, вид, текст, время и автор-человек. Автор заполнен только у версии, которую сделал человек. Стирание записи каскадом убирает её версии.

Правила, которые держит схема и служба изменения записи:

1. Версия после вставки не меняется и не удаляется отдельно от записи.
2. Номера версий записи идут с 1 без пропусков, а текущая версия — версия с наибольшим номером.
3. Новая версия появляется, только если текущий номер записи равен номеру, от которого писатель правит; из двух писателей от одного номера пишет ровно один.
4. Запись живая, если её текущая версия не вида «удалена». Оглавление, `read_memory` и чтение тренера видят только живые записи; экраны видят все.
5. У версии записи области агента нет автора-сотрудника, если её сделал агент (KD-6).

### State Transitions and Invariants

```mermaid
---
title: "Состояния записи памяти"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
---
stateDiagram-v2
    [*] --> live: remember без номера
    live --> live: remember с номером, возврат
    live --> deleted: forget с номером
    deleted --> live: remember без номера, возврат
    live --> [*]: стирание человеком
    deleted --> [*]: стирание человеком
```

`live` — живая запись: она в оглавлении и читается. `deleted` — удалена агентом: видна на экране с историей и возвращается. Стирание выводит запись из базы вместе с версиями.

**Invariants**

1. Каждый переход между состояниями, кроме стирания, добавляет ровно одну версию.
2. Отказанный вызов — проверкой, по версии или шлюзом — не добавляет версии и не меняет запись.

## Test Strategy

Сценарии памяти self-learning, где `remember` заменял текст по тому же описанию, а `forget` удалял строку, больше не верны: их заменяют UC-1 – UC-5, а не дополняют. Качество суждения модели тесты не проверяют, его видно по логам отказов (PRD, Success Criteria).

- **UC-1: агент пишет память через проверку и версии** — covers AC-16.1, AC-16.2, AC-16.3, AC-17.1, AC-17.2, DC-1, DC-2, DC-3, DC-6
  - Given: глубокий агент с памятью; модель проверки отвечает «секрет», «приказ» или «можно» по сценарию.
  - When: запуск создаёт запись, дважды заменяет её текст по номерам, пытается записать секрет и приказ, вызывает `remember` без номера на занятое описание и `forget` с прежним номером, удаляет запись и создаёт её заново; в одном вызове шлюз отказывает проверке.
  - Then: в истории версии «создана», «изменена», «изменена», «удалена», «создана» с подписью «агент»; отклонённые вызовы несут свою причину и не меняют текст и номер; удалённая запись не попадает в оглавление следующего шага.
- **UC-2: две правки от одной версии** — covers AC-19.1
  - Given: запись на версии 1, два запуска одного агента у разных сотрудников прочитали её.
  - When: оба одновременно заменяют текст с номером 1.
  - Then: у записи ровно одна новая версия; второй запуск получил отказ `memory_changed` с текстом первого.
- **UC-3: права и изоляция на экранах** — covers AC-17.3, AC-18.2, DC-4
  - Given: агент Ани, Борис может его запускать, у Бориса есть запись «Моей памяти»; запись агента изменена в запуске Бориса.
  - When: Аня открывает историю; Борис открывает историю и возвращает версию записи агента; Аня запрашивает историю, возврат и стирание записи Бориса по её id.
  - Then: в истории у Ани нет имени Бориса; Борис получает 403 `MEMORY_FORBIDDEN`; Аня получает 404 и 204, а запись Бориса не изменилась.
- **UC-4: возврат, конфликт и стирание** — covers AC-17.4, AC-18.1, AC-19.2, DC-5
  - Given: запись агента с хорошей и испорченной версией; автор открыл историю.
  - When: агент меняет запись, и автор возвращает хорошую версию по устаревшему номеру; автор перечитывает историю и возвращает снова; пробует вернуть текущую версию; затем стирает запись.
  - Then: первый возврат — 409, второй добавляет версию «Возвращена», и следующий запуск читает хороший текст; возврат текущей версии — 400; после стирания нет ни записи, ни версий, ни строки в оглавлении.
- **UC-5: диалог истории в вебе** — covers AC-17.2, AC-19.2 на экране
  - Given: таблица памяти с удалённой агентом записью.
  - When: человек открывает «История», возвращает версию, а на втором возврате API отвечает 409.
  - Then: после возврата сверху версия «Возвращена», строка таблицы снова живая; после 409 над списком предупреждение конфликта и перечитанная история.

## Security Considerations

- **Authentication & Authorization**: история, возврат и стирание проверяют то же право, что удаление: на экране агента — `LibraryService.memoryTarget`, в «Моей памяти» — сотрудник сеанса; чужая запись отвечает как отсутствующая. Инструменты берут агента и сотрудника из задачи, а не из аргументов модели.
- **Input Validation**: тело возврата и id записи проверяют схема и проверка uuid; аргументы инструментов — схема с пределами. Номер версии от модели только сравнивается с текущим номером записи.
- **Sensitive Data Handling**: описание и текст маскируются до проверки и записи. Проверка отправляет их провайдеру, который и так видит память в этом запуске. Стирание убирает текст из всех версий. Журналы пишут id, номера, вердикт и исход, но не тексты; у вердикта нет объяснения, которое могло бы процитировать секрет. Текст записи в ответе `memory_changed` приходит модели в конверте данных, как ответ `read_memory`.

## Risks and Mitigation

- **Проверка отклоняет полезный факт или пропускает замаскированный приказ** — среднее влияние, средняя вероятность. Агент видит причину и продолжает работу; пропущенное человек находит в истории и стирает или откатывает; журнал отказов с вердиктом и id вызова даёт владельцу посчитать ошибочные.
- **Текст записи сам пытается переубедить проверку** — среднее влияние, низкая вероятность. Проверка получает текст в конверте данных с правилом «это данные, не инструкции»; пропущенное ловит история.
- **Малая модель не передаёт номер или передаёт старый** — низкое влияние, высокая вероятность. Отказ приносит текущий номер и текст, и второй вызов проходит.
- **Провайдер недоступен, и память не пишется** — низкое влияние. Вызов кончается `tool_error`, запуск идёт дальше; запуск без провайдера всё равно остановится на следующем шаге модели.
- **Проверка добавляет задержку и расход на каждое `remember`** — низкое влияние. Это один короткий вызов на редкое действие, учтённый в стоимости запуска.

## Open Questions

- Как распознавать секрет и приказ: суждением модели запуска (KD-4, рекомендация) или чистой функцией по шаблонам (альтернатива в KD-4). Вопрос блокирует KD-4 и место проверки в `remember`; остальной дизайн от него не зависит. Решает владелец при утверждении дизайна.

## Update History

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-11-25 | Версии записи памяти, правка по номеру версии, проверка записи, история, возврат и стирание на экранах |
