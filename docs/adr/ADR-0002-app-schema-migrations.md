# ADR-0002 Схема `app` и SQL-миграции node-pg-migrate

## Status

Superseded by [ADR-0003](ADR-0003-drizzle-data-layer.md)

Выбор инструмента заменён ADR-0003 (Drizzle); схема `app` сохраняется.

## Decision

Приложению нужен механизм, который версионно создаёт и меняет его собственные таблицы рядом с чужими таблицами Mastra и `AuditService`. Таблицы, которыми владеет приложение, живут в отдельной схеме Postgres `app`. Механизм миграций проекта — node-pg-migrate с миграциями в виде `.sql`-файлов и журналом `app.schema_migrations`. Таблицы `mastra_*` и `audit_events` в `public` этим механизмом не затрагиваются. Решение исключает Prisma Migrate, drizzle-kit, Kysely Migrator и таблицы с префиксом в схеме `public`.

### Decision Details

| Item | Content |
|------|---------|
| **Why now** | Runtime создаёт первые таблицы приложения; `chat-storage` будет вторым потребителем того же механизма |
| **Known unknowns** | Как запускать модуль опций миграций из TypeScript без сборки — type stripping Node 24 или вывод `nest build` (design-runtime.md, Appendix: Evidence, unknowns) |
| **Kill criteria** | В приложении появляется модель данных ORM (Prisma или Drizzle) как слой доступа к `app`, и миграции выгоднее генерировать из неё; или ручные миграции расходятся с кодом так, что тесты соответствия этого не ловят |

## Context

До `research-runtime` в проекте нет механизма миграций. Postgres делят Mastra, чей `PostgresStore` сам создаёт и меняет таблицы `mastra_*` в схеме `public`, и `AuditService`, который создаёт `audit_events` своим DDL при старте. Runtime добавляет первые собственные таблицы приложения, которые надо создавать и менять версионно, предсказуемо и без вмешательства в чужие таблицы ([design-runtime.md](../features/research-runtime/design-runtime.md), KD-2 и Migration Strategy).

Решение связывает не только эту фичу: `chat-storage` переносит беседы и сообщения из Mastra Memory в собственные таблицы и опирается на тот же механизм миграций ([prd.md](../features/research-runtime/prd.md), дорожная карта). Смена схемы или инструмента после этого означает перенос данных двух фич и переписывание истории миграций.

## Rationale

Главное требование к размещению — не трогать то, чем владеет Mastra. Отдельная схема `app` отделяет таблицы приложения от `mastra_*` в `public` по владельцу, а не по соглашению об именах.

Внутри схемы `app` инструмент выбран по тому, что ревьюится. Проект не держит модели данных ORM, поэтому источником истины остаётся написанный вручную SQL, а не вывод генератора; генерируемый клиент и shadow-база при этом не нужны. node-pg-migrate исполняет только файлы из каталога миграций, ведёт журнал в выбранной схеме и берёт advisory lock на запуск; это проверено spike на node-pg-migrate 9.0.0 и Postgres 16 (design-runtime.md, Appendix: Evidence).

### Options Considered

1. **Prisma Migrate**
   - Pros: Модель декларативная, клиент генерируется, а модели привязываются к схеме `app` через список `schemas` в datasource.
   - Cons: Рядом с SQL появляется второй язык схемы (Prisma Schema) и генерируемый клиент, которого проект не использует. `migrate dev` требует shadow-базу, то есть права создавать базы или отдельный URL.

2. **drizzle-kit**
   - Pros: Схема описывается на TypeScript, SQL генерируется, а `schemaFilter` и `tablesFilter` ограничивают `push` и `pull` схемой `app`.
   - Cons: `generate` строит SQL из TS-модели по разнице JSON-снимков, поэтому проверяемый SQL становится выводом, а не источником. Модель и снимки надо держать рядом с миграциями.

3. **Kysely Migrator**
   - Pros: Мигратор лёгкий и транзакционный.
   - Cons: Миграции — TS-модули, которым нужна сборка или загрузчик. Ради одного runner в проект приходит query builder.

4. **Таблицы с префиксом в схеме `public`**
   - Pros: Новая схема не нужна.
   - Cons: Таблицы приложения смешиваются с `mastra_*` и `audit_events`, и граница владения держится только на префиксе.

5. **Схема `app` и node-pg-migrate с `.sql` (выбран)**
   - Pros: Чужие таблицы вне досягаемости, а SQL остаётся источником истины и ревьюится как есть. Модель и shadow-база не нужны, журнал и блокировка запуска есть из коробки.
   - Cons: Миграции пишутся вручную, без генерации, и в проект приходит одна новая зависимость.

```mermaid
---
title: "Владение схемами Postgres"
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
    mig["node-pg-migrate<br/>файлы .sql"]
    app[("схема app<br/>research_, chat_")]
    mastra["Mastra PostgresStore"]
    pub[("схема public<br/>mastra_, audit_events")]
    mig -->|"применяет миграции"| app
    mastra -->|"своя схема таблиц"| pub
    classDef new fill:#e6f4ea,stroke:#16a34a,stroke-width:2px,color:#1a1a1a
    classDef unchanged fill:#eef1f5,stroke:#4b5563,stroke-width:1.5px,color:#1a1a1a
    class mig,app new
    class mastra,pub unchanged
```

## Consequences

### Positive Consequences

- Таблицы приложения и таблицы Mastra не пересекаются ни по схеме, ни по инструменту
- Каждая фича добавляет свои миграции в одну историю; порядок и однократность применения держит журнал
- Применённые миграции проверяются при старте приложения, до приёма запросов

### Negative Consequences

- Нет автогенерации миграций из модели; соответствие кода и схемы держат тесты (например, домены CHECK против enum контрактов)
- Ссылки из `app` на таблицы `public` (беседы Mastra) не делаются внешними ключами до переноса бесед в `chat-storage`

### Neutral Consequences

- `audit_events` остаётся со своим DDL в `AuditService`; перенос в механизм миграций — отдельное решение

## Implementation Guidance

- Каждая таблица, которой владеет приложение, создаётся миграцией в схеме `app`; DDL при старте сервиса для новых таблиц не используется
- Миграции только вперёд: исправление — новый файл, применённый файл не меняется
- Таблицы фичи несут её префикс (`research_`, `chat_`)
- Приложение при старте только проверяет применённость миграций и не мигрирует само
- Опции runner задаются в одном месте и общие для скрипта, тестов и проверки при старте

## Related Information

- [design-runtime.md](../features/research-runtime/design-runtime.md) — KD-2 (решение), Migration Strategy, AC-RT-3 (проверка при старте)
- [prd.md](../features/research-runtime/prd.md) — FR-10, дорожная карта (`chat-storage`)
- [ADR-0001](ADR-0001-durable-runtime-owner.md) — runtime, чьи таблицы первыми живут в схеме `app`
- [ADR-0003](ADR-0003-drizzle-data-layer.md) — Drizzle, заменивший выбор инструмента этого ADR
- [node-pg-migrate](https://salsita.github.io/node-pg-migrate/) — runner, SQL-миграции, advisory lock
- [Prisma — multi-schema](https://www.prisma.io/docs/orm/prisma-schema/data-model/multi-schema) и [shadow database](https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/shadow-database) — список `schemas`; shadow-база для `migrate dev`
- [drizzle-kit generate](https://orm.drizzle.team/docs/drizzle-kit-generate) и [drizzle.config](https://orm.drizzle.team/docs/drizzle-config-file) — генерация по JSON-снимкам; `schemaFilter` и `tablesFilter` для `push` и `pull`
