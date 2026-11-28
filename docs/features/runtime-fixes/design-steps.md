# Устойчивость хода агента — Design Document — steps

**Status:** На утверждении · **Date:** 2026-11-28 · **PRD:** [prd.md](./prd.md) · **UXRD:** нет · **Depends on:** нет

## Snapshot

**Overview.** Часть чинит две поломки хода агента. Первая: на «Прервать» и «Стоп» текст, который модель уже написала, пропадает. Теперь клиент модели держит текст идущего ответа в памяти, а транзакция, которая обрывает шаг, берёт этот текст и пишет его в историю обычным ответом агента. На «Прервать» это делает новый крючок прерывания runtime, на стоп — существующий крючок конца задачи. Вторая: переполнение окна модели заканчивает беседу сбоем. Теперь адаптер провайдера узнаёт переполнение по телу ошибки, а шаг ставит сессии отметку переполнения и поднимает `last_input_tokens` до порога, поэтому следующий шаг сжимает историю по прежнему правилу. Пока отметка стоит, сжатие показывает модели длинные результаты инструментов только началом, а второе переполнение заканчивает агента сбоем `context_overflow`. Ответ модели снимает отметку.

- **Не меняется**: журнал токенов (оборванный вызов по-прежнему даёт одну строку с оценкой), выбор сжатия в шаге агента, повторов запроса к провайдеру нет, правило черновика в вебе.
- **Главный риск**: переполнение узнаётся по постоянному тексту ошибки там, где у провайдера нет кода; смена текста вернёт прежний сбой ([Risks](#risks-and-mitigation)).
- **Открытые вопросы**: нет.

### Key Decisions

#### KD-1: Частичный ответ пишет транзакция, которая обрывает шаг

Текст должен лечь в историю один раз и раньше отметки прерывания или стопа, а при рестарте и лимите шага не лечь вовсе (AC-01.7). Транзакция прерывания или стопа первой держит строку задачи и поднимает её `attempt`. Поэтому шаг, который ещё мог бы закоммитить полный ответ, после неё уже отклонён, и у одного вызова в истории не бывает и полного, и частичного ответа. Запрос «Прервать» отвечает после этой транзакции, и веб, перечитав историю, сразу находит в ней запись (KD-3).

- **Стоп** уже вызывает крючки конца задачи: каждую задачу, которую стоп заканчивает, `endTask` проводит через `TaskEndHooks` в транзакции стопа после ограды. Агенты регистрируют такой крючок, и он действует только на конец `stopped`. Так же кончаются задачи при сбое родителя и при исчерпанном бюджете обучения (AC-01.3).
- **«Прервать»** — не конец задачи, и крючки конца его не видят. Runtime получает крючок прерывания по образцу `TaskEndHooks`: `TaskControl.interrupt` зовёт его в своей транзакции после ограды. У крючка ровно один зарегистрированный обработчик — частичный ответ агентов. Крючок нужен, потому что runtime ничего не знает об агентах и истории и не может писать их строки сам.
- Оба крючка зовут одну функцию агентов: она берёт у `ModelClient` текст задачи и, если он не пустой, пишет запись `model_answer` без вызовов инструментов через `History.append` в транзакции обрыва. Своего события запись не шлёт: ленту перечитать заставляет сигнал runtime той же транзакции — прерывание ставит задачу в `queued` и кладёт сообщение в её очередь, стоп пишет статус. «Ответ готов» запись не вызывает: его шлёт только шаг модели корня (live-feed [design-server.md](../live-feed/design-server.md)).
- Рестарт и лимит шага обрывают шаг без транзакции прерывания или стопа, поэтому текст там не пишется.

Отвергнуто:

- запись из оборванного шага — после ограды runtime отклоняет каждую его запись;
- запись из следующего шага на «Прервать» — он идёт после того, как веб перечитал историю, и текст пропал бы с экрана до его коммита; при стопе следующего шага нет;
- транзакция вызывающего вокруг `TaskControl.interrupt` — `TaskControl` оборвал бы шаг до её коммита, а runtime обрывает шаги только после коммита.

#### KD-2: `ModelClient` держит текст идущего ответа

Части ответа уже идут через `ModelClient` в ленту, а живой объект агента видит ответ только после конца вызова. Поэтому `ModelClient` держит текст каждого идущего вызова агента, чьи части идут в ленту, и отпускает его в конце вызова; крючок берёт текст по задаче. Вызов сжатия частей не шлёт и текста не держит. Части, которые придут между чтением текста и обрывом вызова, лента покажет в черновике, пока перечитывание не заменит его записью. Новой строки в журнале токенов нет: оборванный вызов пишет свою одну строку с оценкой, как раньше.

#### KD-3: Правило черновика в вебе не меняется

Веб сразу после «Прервать» и «Стоп» перечитывает историю. Частичный ответ к этому моменту уже в базе, потому что его пишет та же транзакция, на которую отвечает запрос. Перечитывание находит новую запись, черновик уходит, а на его месте встаёт запись с тем же текстом (AC-01.4).

#### KD-4: Переполнение узнаёт адаптер провайдера по телу ошибки и передаёт новой причиной `context_overflow`

Отказ провайдера уже разбирается по виду провайдера (`ProviderAdapter`), и тело ошибки уже читается для отказа в инструментах. Адаптер получает второе правило: сначала поля тела — код и тип, — а где их нет, постоянный текст ошибки провайдера (таблица в [«Как адаптер узнаёт переполнение»](#как-адаптер-узнаёт-переполнение)). Правило проверяется раньше правила инструментов. Узнанное переполнение становится причиной `context_overflow` в прежнем результате `model_error`, и нового варианта результата не нужно. Эмбеддинги получают ту же причину из общего разбора и сообщают её как `provider_error`, как уже делают с отказом в инструментах. Узнавать по одному статусу 400 нельзя: сжатие запускалось бы на любой неверный запрос.

#### KD-5: Отметка переполнения — одна булева отметка сессии поверх прежнего порога сжатия

- Переполнение вызова модели или сжатия, когда отметки нет, коммитит то, что шаг задолжал, ставит отметку и поднимает `last_input_tokens` до порога сжатия, если число ниже. Следующий шаг выбирает сжатие по прежнему правилу `compactionDue`.
- Пока отметка стоит, шаг сжатия показывает модели каждый результат инструмента длиннее `previewChars` (настройка `tool_result_settings`) его началом с пометкой, сколько символов отрезано. Обрезку делает существующая `cutText`, история не меняется, и сотрудник видит результаты целиком.
- Переполнение, когда отметка стоит, заканчивает агента итогом «упасть» с причиной `context_overflow` (AC-02.3).
- Ответ модели снимает отметку.

Одной отметки без подъёма `last_input_tokens` мало. Отметка стоит до ответа модели, поэтому сама она не отличает «сжатие должно» от «сжато, теперь вызов модели». Это различие уже держит порог: сжатие сбрасывает `last_input_tokens`, и следующий шаг идёт к модели. Пустая сводка сбрасывает его так же (agent-harness [design-core.md](../agent-harness/design-core.md), KD-7), поэтому после неё следующий шаг тоже вызывает модель, а её переполнение кончается сбоем. В логе сжатия после переполнения число входных токенов — порог, а не счёт провайдера.

Отвергнуто: сжатие и новый вызов внутри одного шага — в шаге стало бы три вызова модели, а обрыв между ними оставил бы полуготовое состояние. Показать результаты обёрткой `wrapperText` — она обещает чтение через `read_tool_result`, которое есть не у всех результатов.

## Terms

- **Ограда** — подъём `attempt` задачи транзакцией прерывания или стопа: после неё runtime отклоняет каждую запись оборванного шага.
- **Крючок прерывания** — функция верхнего слоя, которую runtime зовёт в транзакции прерывания после ограды.
- **Текст идущего ответа** — то, что модель успела написать в текущем вызове агента; живёт в памяти процесса до конца вызова.
- **Отметка переполнения** — булева отметка сессии: последнее переполнение ещё не закончилось ответом модели.
- **Превью результата** — по PRD ([Terms](./prd.md#terms)); здесь это начало текста длиной `previewChars` с пометкой `cutText`.

## Part

- **Prerequisite ADRs**: [ADR-0023](../../adr/ADR-0023-live-task-objects-one-stepping-process.md) — шаги и запросы API идут в одном процессе, поэтому транзакция прерывания видит память шага; [ADR-0025](../../adr/ADR-0025-settings-key-table.md) — `tool_result_settings` в таблице настроек.

**Out of scope**

- Журнал токенов и правило `isBilled` не меняются: оборванный вызов пишет одну строку с оценкой, и запись текста её не дублирует.
- Общий порог сжатия и запрос сводки остаются как есть.
- Обёртка больших результатов MCP (`storeFromChars`) и чтение их страниц не меняются.
- Длинные записи, которые не результаты инструментов (сообщения сотрудника и агентов, отчёты детей, сводки), сжатие с отметкой показывает целиком.
- Веб получает только тексты новой причины сбоя; правило черновика остаётся прежним (KD-3).
- Провайдеры без подтверждённого признака (таблица ниже) и Ollama, чей OpenAI-совместимый вход молча обрезает историю: переполнение не узнаётся, и ход падает, как сегодня.
- Ответ Anthropic с причиной остановки `model_context_window_exceeded` остаётся обрезанным ответом: установленный `@ai-sdk/anthropic` переводит её в общую `length`, ту же, что у `max_tokens`.

**Constraints**

- **Повторов запроса к провайдеру нет.** Вызов после сжатия идёт с другой историей; ни один запрос не повторяется.
- **Сторожевого таймера на молчание модели нет.** Часть не добавляет таймеров; зависший вызов обрывают «Прервать» и «Стоп».
- **Новых переменных окружения и настроек нет.** Обрезка берёт существующую `previewChars`.
- **Без эвристик на тексте сотрудника.** Правило переполнения читает только тело ошибки провайдера.

## Building-block Inventory

Follows the [code system](../../code-system/README.md).

| Building block | Pattern | Status | Note |
|---|---|---|---|
| Крючок прерывания в runtime | [step-handler.md](../../code-system/patterns/step-handler.md) | new | по образцу `TaskEndHooks`, один обработчик; крючки конца прерывания не видят — KD-1 |
| Крючок конца задачи частичного ответа в `agents` | [step-handler.md](../../code-system/patterns/step-handler.md) | reused | «Реакция на конец задачи», только конец `stopped`; регистрируется в `onModuleInit` модуля агентов |
| `ModelClient` | — | extended | держит текст идущего вызова агента до конца вызова |
| `ProviderAdapter` трёх видов и `classifyRejection` | [pure-decision.md](../../code-system/patterns/pure-decision.md) | extended | правило переполнения рядом с правилом отказа в инструментах |
| Шаг модели и шаг сжатия | [step-handler.md](../../code-system/patterns/step-handler.md) | extended | переполнение — коммит с отметкой или сбой; превью при отметке |

## Acceptance Criteria

### FR-01: частичный ответ

- From the PRD: AC-01.1, AC-01.2, AC-01.3, AC-01.4, AC-01.5, AC-01.6, AC-01.7.

### FR-02: переполнение окна

- From the PRD: AC-02.1, AC-02.3, AC-02.4.
- AC-02.2 уточняется: когда историю переполнили результаты инструментов, каждый из которых короче порога обёртки, или страницы `read_tool_result`, сжатие с отметкой показывает модели каждый результат длиннее `previewChars` его началом с пометкой обрезки и не переполняется. Сотрудник в ленте видит эти результаты целиком.
- AC-02.5 уточняется: платформа узнаёт переполнение провайдеров, чей признак подтверждён их документацией или их собственным кодом (таблица [«Как адаптер узнаёт переполнение»](#как-адаптер-узнаёт-переполнение)); остальные падают, как сегодня.
- Переполнение сжатия по порогу ведёт к сжатию с превью так же, как переполнение вызова модели (KD-5).

## Design

### Architecture (C1–C4)

Контейнеры и связи между ними не меняются: веб зовёт api, api зовёт провайдера модели и пишет в Postgres. Меняются компоненты внутри api.

#### C3 · Components: api

**api — частичный ответ на «Прервать» и «Стоп»**

```mermaid
---
title: "C3 · Components — api: частичный ответ"
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
    @keyframes lit_c3a{0%,18%{stroke:#991b1b;stroke-width:6px}20%,100%{stroke:#f4a5a5;stroke-width:2px}}
---
flowchart TB
    entry(["▶ «Прервать» или «Стоп»"])
    subgraph api["api"]
        ctl["1 · TaskControl<br/>ограда задачи"]
        hooks["2 · крючки runtime<br/>прерывания и конца"]
        hook["3 · частичный ответ<br/>agents"]
        mc["4 · ModelClient<br/>текст идущего ответа"]
    end
    db[("Postgres<br/>история")]
    entry --> ctl
    ctl e1@-->|"в транзакции"| hooks
    hooks e2@-->|"задача"| hook
    hook e3@-->|"текст задачи"| mc
    mc e4@-->|"текст"| hook
    hook e5@-->|"model_answer"| db
    classDef entry fill:#ffffff,stroke:#1f2937,stroke-width:1.5px,color:#1a1a1a
    classDef changed fill:#fde8e8,stroke:#dc2626,stroke-width:2px,color:#1a1a1a
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    classDef frame fill:none,stroke:#4b5563,stroke-width:1px,stroke-dasharray:4 3
    classDef w1 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3a 6s linear 0s infinite
    classDef w2 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3a 6s linear 1.2s infinite
    classDef w3 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3a 6s linear 2.4s infinite
    classDef w4 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3a 6s linear 3.6s infinite
    classDef w5 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3a 6s linear 4.8s infinite
    class entry entry
    class ctl,hooks,mc changed
    class hook new
    class db unchanged
    class api frame
    class e1 w1
    class e2 w2
    class e3 w3
    class e4 w4
    class e5 w5
```

`TaskControl.interrupt` зовёт крючок прерывания в своей транзакции после ограды. Стоп зовёт крючки конца для каждой задачи, которую заканчивает, тоже после ограды. Функция частичного ответа берёт у `ModelClient` текст задачи и, если он не пустой, пишет его записью `model_answer` через `History.append` в этой транзакции (KD-1). После коммита `TaskControl`, как и сегодня, обрывает шаг и отпускает живой объект. Следующий шаг прерванного агента пишет событие `interrupted` после этой записи. У остановленного агента отметки стопа выводятся при чтении после последней записи, а при продолжении пишутся по-настоящему, тоже после неё.

**api — переполнение окна**

```mermaid
---
title: "C3 · Components — api: переполнение"
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
    @keyframes lit_c3b{0%,12.86%{stroke:#991b1b;stroke-width:6px}14.29%,100%{stroke:#f4a5a5;stroke-width:2px}}
    @keyframes litr_c3b{0%,12.86%{stroke:#1d4ed8;stroke-width:6px}14.29%,100%{stroke:#9ec1f7;stroke-width:2px}}
---
flowchart TB
    entry(["▶ провайдер ответил<br/>ошибкой"])
    subgraph api["api"]
        ad["1 · ProviderAdapter<br/>узнаёт переполнение"]
        mc["2 · ModelClient<br/>model_error"]
        step["3 · шаг модели<br/>отметка переполнения"]
        base["4 · BaseAgent.step<br/>выбирает сжатие"]
        comp["5 · шаг сжатия<br/>превью при отметке"]
        msgs["6 · сообщения провайдера<br/>результаты превью"]
    end
    db[("Postgres<br/>сессия и история")]
    prov(["провайдер модели"])
    entry --> ad
    ad e1@-->|"context_overflow"| mc
    mc e2@-->|"причина"| step
    step e3@-->|"отметка и порог"| db
    db e4@-->|"сессия"| base
    base e5@-->|"сжать"| comp
    comp e6@-->|"история"| msgs
    msgs e7@-->|"сжатый запрос"| prov
    classDef entry fill:#ffffff,stroke:#1f2937,stroke-width:1.5px,color:#1a1a1a
    classDef changed fill:#fde8e8,stroke:#dc2626,stroke-width:2px,color:#1a1a1a
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    classDef frame fill:none,stroke:#4b5563,stroke-width:1px,stroke-dasharray:4 3
    classDef w1 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3b 8.4s linear 0s infinite
    classDef w2 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3b 8.4s linear 1.2s infinite
    classDef w3 stroke:#f4a5a5,stroke-width:2px,animation:lit_c3b 8.4s linear 2.4s infinite
    classDef r1 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3b 8.4s linear 3.6s infinite
    classDef r2 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3b 8.4s linear 4.8s infinite
    classDef r3 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3b 8.4s linear 6s infinite
    classDef r4 stroke:#9ec1f7,stroke-width:2px,animation:litr_c3b 8.4s linear 7.2s infinite
    class entry entry
    class ad,mc,step,comp,msgs changed
    class base,db,prov unchanged
    class api frame
    class e1 w1
    class e2 w2
    class e3 w3
    class e4 r1
    class e5 r2
    class e6 r3
    class e7 r4
```

`ProviderAdapter` каждого вида решает по статусу и телу ошибки, переполнение ли это; `classifyRejection` спрашивает его раньше правила инструментов. `ModelClient` возвращает `model_error` с причиной `context_overflow` и пишет в лог тело ошибки, как делает с каждым отказом. Шаг модели и шаг сжатия решают по отметке, что делать с переполнением (KD-5). `BaseAgent.step` выбирает сжатие прежним правилом `compactionDue`. Шаг сжатия с отметкой просит сборку сообщений обрезать результаты инструментов. Остальное у вызова то же, что у обычного шага сжатия: те же инструменты и тот же системный текст с тем набором блоков, который задаёт этот шаг (agent-guidance [design-server.md](../agent-guidance/design-server.md), KD-3; [step-prompt-block.md](../../code-system/patterns/step-prompt-block.md)).

#### Как адаптер узнаёт переполнение

Правило смотрит на ответы со статусом 400, тело которых разбирается как JSON; поля берутся из `error`, а где его нет, из корня тела. Каждая строка таблицы — одна проверка; совпадение любой значит переполнение. В таблице только признаки, которые подтверждает документация провайдера или его собственный код.

| Вид адаптера | Провайдер | Признак | Источник |
|---|---|---|---|
| `anthropic` | Anthropic | тип `invalid_request_error`, текст начинается с `prompt is too long` | [документация](https://platform.claude.com/docs/en/build-with-claude/context-windows) |
| `openai_compatible` | OpenAI, Groq | код `context_length_exceeded` | код OpenAI [codex](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/error.rs), код Groq [openbench](https://github.com/groq/openbench/blob/main/src/openbench/model/_providers/groq.py) |
| `openai_compatible` | OpenRouter | `metadata.error_type` равен `context_length_exceeded` | [документация](https://openrouter.ai/docs/api-reference/errors) |
| `openai_compatible` | Mistral | тип `invalid_request_prompt_too_long` | [документация](https://docs.mistral.ai/resources/error-glossary) |
| `openai_compatible` | llama.cpp | тип `exceed_context_size_error` | [исходный код сервера](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-common.cpp) |
| `openai_compatible` | vLLM | текст содержит `maximum context length` | [исходный код](https://github.com/vllm-project/vllm/blob/main/vllm/renderers/params.py) |

Адаптер `openai_compatible` один на всех OpenAI-совместимых провайдеров, поэтому его проверки срабатывают у каждого из них. Проверка текста vLLM ловит и ответ OpenAI без кода, где текст начинается с `This model's maximum context length`.

Не узнаются, и ход падает, как сегодня:

- Gemini — ни документация, ни код Google не показывают тела ошибки переполнения;
- DeepSeek — документация называет только общие 400 и 422; если тело содержит `maximum context length`, его узнает строка vLLM.

Табличный тест правила держит по одному записанному телу каждого провайдера из таблицы и по одному телу другой ошибки 400 на каждый вид.

### Runtime Flows

#### Flow 1: частичный ответ на «Прервать» или «Стоп»

**Starts when:** сотрудник жмёт «Прервать» или «Стоп», пока модель пишет ответ, for AC-01.1, AC-01.2, AC-01.3, AC-01.4, AC-01.5, AC-01.6.

```mermaid
---
title: "Flow 1 · частичный ответ"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  themeCSS: |
    @keyframes lit_s1{0%,11.25%{stroke:#991b1b;stroke-width:6px}12.5%,100%{stroke:#37474f;stroke-width:2px}}
    .messageLine0[data-id='i0'],.messageLine1[data-id='i0']{animation:lit_s1 9.6s linear 0s infinite}
    .messageLine0[data-id='i1'],.messageLine1[data-id='i1']{animation:lit_s1 9.6s linear 1.2s infinite}
    .messageLine0[data-id='i2'],.messageLine1[data-id='i2']{animation:lit_s1 9.6s linear 2.4s infinite}
    .messageLine0[data-id='i3'],.messageLine1[data-id='i3']{animation:lit_s1 9.6s linear 3.6s infinite}
    .messageLine0[data-id='i5'],.messageLine1[data-id='i5']{animation:lit_s1 9.6s linear 4.8s infinite}
    .messageLine0[data-id='i6'],.messageLine1[data-id='i6']{animation:lit_s1 9.6s linear 6s infinite}
    .messageLine0[data-id='i7'],.messageLine1[data-id='i7']{animation:lit_s1 9.6s linear 7.2s infinite}
    .messageLine0[data-id='i8'],.messageLine1[data-id='i8']{animation:lit_s1 9.6s linear 8.4s infinite}
---
sequenceDiagram
    participant W as web
    box api
        participant T as TaskControl
        participant H as частичный ответ
        participant M as ModelClient
        participant V as ViewOperations
    end
    participant DB@{ "type": "database" } as Postgres
    W->>T: «Прервать» или «Стоп»
    T->>H: крючок после ограды
    H->>M: текст задачи
    M-->>H: текст до этого места
    Note over H,DB: одна транзакция: ограда задачи и запись model_answer
    T->>M: оборвать шаг после коммита
    T-->>W: прервано или остановлено
    W->>V: перечитать историю
    V-->>W: записи с частичным ответом
```

Если модель не успела написать ни слова, крючок ничего не пишет (AC-01.5). Текст копят только части текста, а недописанный вызов инструмента в него не попадает, поэтому его нет ни в истории, ни в аудите (AC-01.6). После прерывания следующий шаг агента пишет закрытия открытых вызовов и событие `interrupted` уже после частичного ответа, и модель читает их в этом порядке (AC-01.2). При «Стоп» крючок конца срабатывает для каждой задачи дерева, которую стоп заканчивает. Рестарт сервера и лимит шага обрывают шаг без транзакции прерывания или стопа: текст не читается и пропадает в конце вызова (AC-01.7).

#### Flow 2: переполнение, сжатие с превью и новый вызов

**Starts when:** шаг модели вызывает модель, и провайдер отвечает переполнением, for AC-02.1, AC-02.2, AC-02.3, AC-02.4.

```mermaid
---
title: "Flow 2 · переполнение окна"
config:
  theme: base
  look: classic
  themeVariables:
    primaryColor: "#eef1f5"
    primaryBorderColor: "#4b5563"
    primaryTextColor: "#1a1a1a"
    lineColor: "#6b7280"
  themeCSS: |
    @keyframes lit_s2{0%,6.43%{stroke:#991b1b;stroke-width:6px}7.14%,100%{stroke:#37474f;stroke-width:2px}}
    .messageLine0[data-id='i0'],.messageLine1[data-id='i0']{animation:lit_s2 16.8s linear 0s infinite}
    .messageLine0[data-id='i1'],.messageLine1[data-id='i1']{animation:lit_s2 16.8s linear 1.2s infinite}
    .messageLine0[data-id='i2'],.messageLine1[data-id='i2']{animation:lit_s2 16.8s linear 2.4s infinite}
    .messageLine0[data-id='i3'],.messageLine1[data-id='i3']{animation:lit_s2 16.8s linear 3.6s infinite}
    .messageLine0[data-id='i5'],.messageLine1[data-id='i5']{animation:lit_s2 16.8s linear 4.8s infinite}
    .messageLine0[data-id='i6'],.messageLine1[data-id='i6']{animation:lit_s2 16.8s linear 6s infinite}
    .messageLine0[data-id='i7'],.messageLine1[data-id='i7']{animation:lit_s2 16.8s linear 7.2s infinite}
    .messageLine0[data-id='i8'],.messageLine1[data-id='i8']{animation:lit_s2 16.8s linear 8.4s infinite}
    .messageLine0[data-id='i10'],.messageLine1[data-id='i10']{animation:lit_s2 16.8s linear 9.6s infinite}
    .messageLine0[data-id='i11'],.messageLine1[data-id='i11']{animation:lit_s2 16.8s linear 10.8s infinite}
    .messageLine0[data-id='i13'],.messageLine1[data-id='i13']{animation:lit_s2 16.8s linear 12s infinite}
    .messageLine0[data-id='i14'],.messageLine1[data-id='i14']{animation:lit_s2 16.8s linear 13.2s infinite}
    .messageLine0[data-id='i17'],.messageLine1[data-id='i17']{animation:lit_s2 16.8s linear 14.4s infinite}
    .messageLine0[data-id='i18'],.messageLine1[data-id='i18']{animation:lit_s2 16.8s linear 15.6s infinite}
---
sequenceDiagram
    box api
        participant S as шаг агента
        participant M as ModelClient
    end
    participant DB@{ "type": "database" } as Postgres
    participant P as провайдер модели
    S->>M: вызов модели
    M->>P: запрос
    P-->>M: 400, переполнение
    M-->>S: model_error context_overflow
    Note over S,DB: коммит шага: его записи, отметка, порог в last_input_tokens
    S->>M: сжатие, результаты началом
    M->>P: запрос сводки
    P-->>M: сводка
    M-->>S: ответ со сводкой
    Note over S,DB: compaction, событие compacted, last_input_tokens сброшен
    S->>M: новый вызов модели
    M->>P: запрос со сжатой историей
    alt история помещается
        P-->>M: ответ
        M-->>S: ответ модели
        Note over S,DB: ответ записан, отметка снята
    else снова переполнение
        P-->>M: 400, переполнение
        M-->>S: model_error context_overflow
        Note over S,DB: событие failed с причиной context_overflow, сессия закрыта
    end
```

Шаг агента на схеме — три шага runtime подряд: шаг модели, шаг сжатия и снова шаг модели; каждый коммитит свои записи сам. Шаг с переполнением записывает то, что задолжал: вступление и доставленные сообщения, — и ход не считает. Отказ провайдера до ответа не оплачивается и строки в журнале токенов не даёт. Если переполнилось само сжатие с отметкой, агент падает с той же причиной, а сообщение о сбое — тот же `modelErrorMessage`. Ошибка, которую правило не узнало, идёт прежним путём `model_error` без сжатия (AC-02.4).

### Contract Definitions

- **Крючок прерывания** (runtime для верхних слоёв) — устроен как крючок конца задачи: верхний слой регистрирует его по имени в `onModuleInit`, второе имя останавливает старт. `TaskControl.interrupt` зовёт каждый крючок в транзакции прерывания после ограды, в своей точке сохранения. Вход: `taskId`, `rootId`, `ownerId` и тип задачи. Крючок не зовёт модель и сеть и пишет только в эту транзакцию. Исключение крючка откатывает только его записи, пишется в лог, а прерывание коммитится.
- **Частичный ответ в истории** — запись `model_answer` с полем `text` (непустой текст до обрыва) и пустым `toolCalls`, без новых полей. Веб и модель читают её как обычный ответ агента. Она стоит раньше события `interrupted` и раньше отметок стопа. Своего события она не шлёт: веб перечитывает ленту по сигналу runtime транзакции обрыва, а «ответ готов» шлёт только шаг модели корня (live-feed [design-server.md](../live-feed/design-server.md)).
- **`context_overflow`** — новое значение `AgentFailureReasonSchema`, которое вид агента отдаёт в `failureReason`. Агент падает с ним, когда история не помещается в окно модели даже после сжатия с превью.

**Тексты причины**

- `errors.json`, ключ `failureReason.context_overflow`: ru «история не помещается в окно модели даже после сжатия», en «the history doesn't fit the model's context window even after compaction».

**Runtime settings**

- `tool_result_settings.previewChars` — default `2000`; сколько символов результата инструмента модель видит в сжатии с отметкой. Настройка уже задаёт длину превью в обёртке больших результатов.

### Data Model

Сессия агента (таблица `conversations`) получает булеву отметку переполнения, по умолчанию снятую. Отметку меняют только коммиты шагов этой сессии. Миграция только схемная, существующих строк она не трогает: база разработчика создаётся заново (data-model [design-runtime.md](../data-model/design-runtime.md), KD-9).

### State Transitions and Invariants

- Переполнение без отметки ставит отметку и поднимает `last_input_tokens` до порога.
- Переполнение с отметкой заканчивает агента сбоем `context_overflow`.
- Ответ модели снимает отметку.

**Invariants**

1. Пока отметка стоит, шаг сжатия показывает результаты инструментов превью.
2. Подряд из-за переполнения ход делает не больше двух сжатий: одно по порогу, которое переполнилось, и одно с превью.
3. Частичный ответ пишет только транзакция прерывания или стопа, поэтому у одного вызова модели в истории не бывает и полного, и частичного ответа.

## Security Considerations

- **Authentication & Authorization**: новых точек входа нет. Частичный ответ пишется только в историю задачи, которую `TaskControl` уже проверил на владельца, а при стопе — в задачи её дерева.
- **Input Validation**: внешний ввод — тело ошибки провайдера; оно разбирается как JSON и сравнивается с полями и постоянными текстами, без исполнения и без хранения.
- **Sensitive Data Handling**: текст частичного ответа в лог не идёт: функция частичного ответа пишет идентификаторы задачи и длину текста. Тело ошибки провайдера, как и сейчас, идёт в лог целиком через маску ключей.

## Risks and Mitigation

- **Провайдер сменит текст ошибки** — платформа перестанет узнавать переполнение, беседа закончится `model_error`, как сегодня; вероятность низкая. Структурные поля проверяются первыми, а табличный тест держит записанные тела.
- **Другая ошибка 400 у OpenAI-совместимого провайдера содержит `maximum context length`** — одно лишнее сжатие, затем, возможно, сбой с неверной причиной; вероятность низкая. Признак — фраза об окне, а не отдельные слова.
- **Историю переполнили записи, которые не результаты инструментов** — сжатие с превью тоже переполнится, и агент упадёт с `context_overflow` (UC-3); вероятность средняя на огромных вставках сотрудника. Сотрудник видит понятную причину и сужает задачу.
- **Стоп или прерывание пришли после конца вызова, но до коммита шага** — шаг отклонён оградой, а текста в памяти уже нет, поэтому ответ пропадает, как сегодня; окно — время коммита шага.
- **Сводка в сжатии с превью упустит деталь из обрезанной части результата** — PRD, Assumptions and Risks; полный результат остаётся в ленте.

## Update History

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-11-28 | Первая версия |
| 1.1 | 2026-11-28 | Сверка с live-feed и agent-guidance: частичный ответ — обычная запись через `History.append` в транзакции обрыва, без «ответ готов», которое шлёт шаг модели корня; принудительное сжатие берёт инструменты и системный текст обычного шага сжатия |
| 1.2 | 2026-11-28 | Упрощение по решению владельца: стоп пишет частичный ответ существующим крючком конца задачи, а новый крючок runtime остался только для «Прервать», с одним обработчиком; текст больше не запечатывается при чтении. Отметка переполнения с тремя состояниями заменена одной булевой отметкой поверх `last_input_tokens`; выбор сжатия не меняется. Таблица признаков переполнения сокращена до подтверждённых первоисточниками: Gemini и DeepSeek не узнаются, новый текст vLLM убран, Mistral узнаётся по типу, OpenRouter по `metadata.error_type`. Сверка с live-feed 1.2: запись частичного ответа своего события не шлёт, ленту перечитывает сигнал runtime транзакции обрыва |
